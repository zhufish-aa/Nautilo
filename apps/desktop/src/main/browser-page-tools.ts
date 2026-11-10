import {clipboard,type WebContents} from "electron";
import {BrowserToolError} from "./browser-errors";
import {browserCommand} from "./browser-protocol";
import {browserTargetNode,type BrowserTarget} from "./browser-dom";
import {evaluateBrowser,browserTimeout} from "./browser-expect";

export function fetchBrowser(page:WebContents,args:any,check:()=>void) {
  const timeout=browserTimeout(args.timeoutMs,15000);
  return evaluateBrowser(page,`async input=>{
    const url=new URL(input.url,location.href);
    if(!['http:','https:'].includes(url.protocol))throw Error('fetch requires HTTP(S)');
    const response=await fetch(url.href,{method:input.method??'GET',headers:input.headers,body:input.body,credentials:'include',signal:AbortSignal.timeout(input.timeout)});
    const reader=response.body?.getReader();let size=0,body='',truncated=false;const decoder=new TextDecoder();
    if(reader){while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>65536){truncated=true;await reader.cancel();break;}body+=decoder.decode(chunk.value,{stream:true});}body+=decoder.decode();}
    return {ok:true,status:response.status,url:response.url,headers:Object.fromEntries(response.headers),body:input.response === 'json'&&!truncated?JSON.parse(body):body,truncated};
  }`,{url:args.url,method:args.method,headers:args.headers,body:args.body,response:args.response,timeout},check,timeout+500);
}

let pastes:Promise<unknown>=Promise.resolve();
export function pasteBrowser(page:WebContents,args:any,check:()=>void) {
  const work=pastes.catch(()=>{}).then(async()=>{
    if((typeof args.text !== "string" && typeof args.html !== "string") || (args.text?.length??0)+(args.html?.length??0)>100000)
      throw new BrowserToolError("INVALID_PASTE","Provide text and/or HTML, up to 100 KB.",{},undefined,false);
    check();
    if(args.target) {
      const target=args.target;
      const node=await browserTargetNode(page,{selector:target.css,xpath:target.xpath,role:target.role,name:target.name,text:target.text,nth:target.nth,frame:target.frame} as BrowserTarget);
      await browserCommand(page,"DOM.focus",{backendNodeId:node});
    }
    // Native paste is trusted and carries both clipboard formats. Restore the
    // user's clipboard only if nothing else changed it while paste was sent.
    const original=new Map(clipboard.availableFormats().map(format=>[format,clipboard.readBuffer(format)]));
    clipboard.write({text:args.text??"",html:args.html});
    const supplied=new Map(clipboard.availableFormats().map(format=>[format,clipboard.readBuffer(format)]));
    try {
      check();page.focus();page.paste();await new Promise(resolve=>setTimeout(resolve,100));check();
      return {ok:true,dispatched:true,verified:false,formats:[...(args.text!==undefined?["text/plain"]:[]),...(args.html!==undefined?["text/html"]:[])]};
    } finally {
      const formats=clipboard.availableFormats();
      if(formats.length === supplied.size && formats.every(format=>supplied.get(format)?.equals(clipboard.readBuffer(format)))) {
        clipboard.clear();for(const [format,buffer] of original)clipboard.writeBuffer(format,buffer);
      }
    }
  });
  pastes=work;return work;
}
