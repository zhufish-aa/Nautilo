import type { Session } from "electron";
import WebSocket from "ws";
import { BrowserToolError, browserDeadline } from "./browser-errors";

function localEndpoint(value:unknown) {
  if(typeof value !== "string")throw new BrowserToolError("INVALID_ENDPOINT","Provide the browser's local HTTP debugging address.",{},undefined,false);
  const url=new URL(value);
  if(url.protocol !== "http:" || !["localhost","127.0.0.1","[::1]"].includes(url.hostname) || !url.port || url.username || url.password)
    throw new BrowserToolError("INVALID_ENDPOINT","Only a local HTTP debugging endpoint with an explicit port is accepted.",{},undefined,false);
  return url;
}
async function targets(endpoint:URL) {
  try {
    const response=await fetch(new URL("/json/list",endpoint),{signal:AbortSignal.timeout(4000),redirect:"error"});
    if(!response.ok)throw Error("Discovery failed");
    const list=await response.json();
    if(!Array.isArray(list))throw Error("Invalid discovery response");
    return list.filter(item=>item.type === "page" && /^https?:\/\//.test(item.url) && typeof item.webSocketDebuggerUrl === "string");
  } catch {
    throw new BrowserToolError("BROWSER_CONNECTION_FAILED","无法连接该浏览器的调试地址。请使用已开启远程调试的本机浏览器，或直接在 Nautilo 中登录。",{},"Connect a browser that exposes a local debugging endpoint, or use browser_session login.");
  }
}

/** Explicit, origin-limited import. CDP decrypts its own cookies; no profile files
 * are read or modified, and no cookie value enters an MCP/UI response. */
export async function browserLogin(profile:Session,command:string,args:any) {
  const endpoint=localEndpoint(args.endpoint),list=await targets(endpoint);
  if(command === "inspect")return {ok:true,sites:list.map(item=>({target_id:item.id,title:item.title,url:item.url,origin:new URL(item.url).origin})).slice(0,100)};
  if(command !== "import")throw new BrowserToolError("INVALID_REQUEST","Use inspect or import.",{},undefined,false);
  if(!Array.isArray(args.origins) || !args.origins.length || args.origins.length>20)throw new BrowserToolError("INVALID_ORIGINS","Choose 1–20 website origins to import.",{},undefined,false);
  const origins:string[]=args.origins.map((value:unknown)=>{
    const url=new URL(String(value));if(!["http:","https:"].includes(url.protocol) || url.username || url.password)throw new BrowserToolError("INVALID_ORIGINS","Website origins must use HTTP(S).");return url.origin;
  });
  const source=list.find(item=>args.target_id ? item.id === args.target_id : origins.includes(new URL(item.url).origin));
  if(!source)throw new BrowserToolError("TARGET_NOT_FOUND","Open a selected website in the source browser first.");
  const socketURL=new URL(source.webSocketDebuggerUrl);
  if(socketURL.protocol !== "ws:" || !["localhost","127.0.0.1","[::1]"].includes(socketURL.hostname) || socketURL.port !== endpoint.port)
    throw new BrowserToolError("INVALID_ENDPOINT","Discovery returned a non-local debugging socket.",{},undefined,false);
  const socket=new WebSocket(socketURL,{maxPayload:1024*1024,handshakeTimeout:4000});
  try {
    await browserDeadline(new Promise<void>((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);}),4500,"connect browser login", "probe");
    const cookies:any[]=await browserDeadline(new Promise((resolve,reject)=>{
      socket.once("close",()=>reject(Error("Browser disconnected")));
      socket.on("message",raw=>{try{const result=JSON.parse(String(raw));if(result.id === 1){result.error ? reject(Error(result.error.message)) : resolve(result.result.cookies);}}catch{reject(Error("Invalid browser response"));}});
      socket.send(JSON.stringify({id:1,method:"Network.getCookies",params:{urls:origins}}));
    }),5000,"read selected login cookies","read");
    let imported=0,skipped=0;
    for(const cookie of cookies) {
      const domain=String(cookie.domain).replace(/^\./,"").toLowerCase();
      const origin=origins.map(value=>new URL(value)).find(url=>url.hostname === domain || url.hostname.endsWith("."+domain));
      if(!origin || cookie.partitionKey || (cookie.expires>0 && cookie.expires*1000<Date.now())){skipped++;continue;}
      try {
        await profile.cookies.set({url:(cookie.secure?"https:":origin.protocol)+"//"+origin.host+(cookie.path || "/"),name:cookie.name,value:cookie.value,
          domain:cookie.domain.startsWith(".")?cookie.domain:undefined,path:cookie.path || "/",secure:!!cookie.secure,httpOnly:!!cookie.httpOnly,
          expirationDate:cookie.expires>0?cookie.expires:undefined,sameSite:({Strict:"strict",Lax:"lax",None:"no_restriction"} as const)[cookie.sameSite as "Strict"|"Lax"|"None"] ?? "unspecified"});
        imported++;
      } catch {skipped++;}
    }
    await profile.cookies.flushStore();
    return {ok:true,imported_cookies:imported,skipped_cookies:skipped,origins,authentication:"unverified",source_browser_unchanged:true};
  } finally {socket.close();setTimeout(()=>socket.terminate(),300).unref();}
}
