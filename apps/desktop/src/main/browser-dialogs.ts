import { BrowserWindow,protocol,type WebContents } from "electron";
import { randomUUID } from "node:crypto";

const scheme="nautilo-page-dialog";
// Web-page dialogs have no app IPC/preload. The only bridge is a scoped,
// unguessable protocol capability whose response is the dialog's own value.
protocol.registerSchemesAsPrivileged([{scheme,privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,bypassCSP:true}}]);
type Request={type:string;message:string;default_value:string;resolve:(accept:boolean,text?:string)=>void};
type DialogPage={wc:WebContents;open:(request:Request)=>void};
const pages=new Map<string,DialogPage>(),profiles=new WeakSet<Electron.Session>();

export function registerBrowserDialogs(wc:WebContents,open:DialogPage["open"]) {
  const key=randomUUID();pages.set(key,{wc,open});
  wc.once("destroyed",()=>pages.delete(key));
  if(!profiles.has(wc.session)) {
    profiles.add(wc.session);
    wc.session.protocol.handle(scheme,request=>new Promise<Response>(resolve=>{
      const url=new URL(request.url),page=pages.get(url.hostname);
      const answer=(value:unknown)=>resolve(new Response(JSON.stringify(value),{headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Cache-Control":"no-store"}}));
      const type=url.pathname.slice(1);
      if(!page || page.wc.isDestroyed() || !["alert","confirm","prompt"].includes(type)){answer(null);return;}
      const message=(url.searchParams.get("message")??"").slice(0,4000),defaultValue=(url.searchParams.get("default")??"").slice(0,4000);
      page.open({type,message,default_value:defaultValue,resolve:(accept,text)=>answer(type === "prompt"?(accept?text??defaultValue:null):type === "confirm"?accept:null)});
    }));
  }
  const source=`(()=>{
    const endpoint=${JSON.stringify(scheme+"://"+key+"/")};
    for(const type of ['alert','confirm','prompt']){
      Object.defineProperty(window,type,{configurable:true,writable:true,value:function(message,initial=''){
        const xhr=new XMLHttpRequest();
        xhr.open('GET',endpoint+type+'?message='+encodeURIComponent(String(message??''))+'&default='+encodeURIComponent(String(initial??'')),false);
        xhr.send();if(type!=='alert')return JSON.parse(xhr.responseText);
      }});
    }
  })()`;
  return source;
}

export function showBrowserDialog(page:WebContents,request:Request) {
  const key=randomUUID();
  const win=new BrowserWindow({width:440,height:request.type === "prompt"?235:205,resizable:false,minimizable:false,maximizable:false,autoHideMenuBar:true,title:"网页对话框",show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  let answered=false;
  const finish=(accept:boolean,text?:string)=>{if(answered)return;answered=true;request.resolve(accept,text);if(!win.isDestroyed())win.destroy();};
  const escape=(text:string)=>text.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]!));
  const html=`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:22px;color:#171719;background:#fafafb;font:14px/1.6 'Noto Sans SC','Microsoft YaHei UI',system-ui,sans-serif}p{max-height:65px;overflow:auto;margin:0 0 14px;white-space:pre-wrap}input{width:100%;padding:8px 10px;border:1px solid #d8d8df;border-radius:8px;font:inherit}footer{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}button{padding:7px 18px;border:1px solid #d8d8df;border-radius:8px;background:white;font:inherit;cursor:pointer}button[type=submit]{background:#202024;color:white;border-color:#202024}</style><form><p>${escape(request.message)}</p>${request.type === "prompt"?`<input autofocus name="answer" value="${escape(request.default_value)}">`:""}<footer>${request.type !== "alert"?'<button type="button" id="cancel">取消</button>':""}<button type="submit">确定</button></footer></form><script>const send=(accept)=>location.href='nautilo-dialog-result://${key}/?accept='+accept+'&text='+encodeURIComponent(document.querySelector('input')?.value??'');document.querySelector('form').onsubmit=e=>{e.preventDefault();send(true)};document.querySelector('#cancel')?.addEventListener('click',()=>send(false));document.addEventListener('keydown',e=>{if(e.key==='Escape')send(false)});</script>`;
  win.webContents.on("will-navigate",(event,url)=>{
    event.preventDefault();const result=new URL(url);if(result.protocol === "nautilo-dialog-result:" && result.hostname === key)finish(result.searchParams.get("accept") === "true",result.searchParams.get("text")??"");
  });
  win.webContents.setWindowOpenHandler(()=>({action:"deny"}));
  win.once("ready-to-show",()=>win.show());win.once("closed",()=>finish(false));
  const destroy=()=>finish(false);page.once("destroyed",destroy);
  win.once("closed",()=>page.removeListener("destroyed",destroy));
  void win.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent(html)).catch(()=>finish(false));
  return ()=>{if(!win.isDestroyed())win.destroy();};
}
