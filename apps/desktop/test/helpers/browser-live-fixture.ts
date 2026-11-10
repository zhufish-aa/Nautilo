import {app,BrowserWindow} from "electron";
import {createHmac} from "node:crypto";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {TaskBrowser} from "../../src/main/task-browser";
const root=__dirname;
app.setPath("userData",root);app.setPath("sessionData",root);app.setAppLogsPath(root);
const report:{steps:any[];completed?:boolean;error?:unknown}={steps:[]};
const save=()=>writeFileSync(join(root,"live-result.json"),JSON.stringify(report,null,2));
process.on("uncaughtException",error=>{report.error=error.stack;save();app.exit(1);});
void app.whenReady().then(async()=>{
  const browser=new TaskBrowser(),key="isolated-live-acceptance",id="Acceptance";
  const port=await browser.start(()=>key),owner=new BrowserWindow({show:false,opacity:0,skipTaskbar:true});
  await owner.loadURL("about:blank");browser.attachWindow(owner);
  let sequence=0;
  const token=createHmac("sha256",key).update(`nautilo-browser-v1/${port}/${id}`).digest("base64url");
  const tool=async(name:string,args:any)=>{
    const started=Date.now(),number=++sequence;
    const response=await fetch(`http://127.0.0.1:${port}/mcp/${id}`,{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:number,method:"tools/call",params:{name,arguments:args}})});
    const raw=(await response.json()).result,result=raw.structuredContent ?? JSON.parse(raw.content.at(-1).text);
    report.steps.push({number,name,elapsed_ms:Date.now()-started,ok:result.ok !== false,url:result.url,error:result.error});save();
    if(result.ok === false)throw Error(JSON.stringify(result));return result;
  };
  try {
    await tool("browser_run",{steps:[{action:"goto",url:"https://www.baidu.com"}],snapshot:false});
    const first=await tool("browser_read",{format:"refs",limit:100});
    const textbox=first.refs.find((ref:any)=>["textbox","searchbox"].includes(ref.role));
    if(!textbox)throw Error("Baidu has no visible search textbox in the snapshot");
    await tool("browser_run",{steps:[{action:"fill",target:{ref:textbox.ref},text:"bilibili"},{action:"press",key:"Enter",expect:{url:{includes:"baidu.com/s"}}}],snapshot:false});
    const links=await tool("browser_eval",{script:"() => Array.from(document.querySelectorAll('#content_left h3 a')).map((a,nth)=>({nth,text:a.innerText})).filter(a=>/bilibili|哔哩哔哩/i.test(a.text)).slice(0,10)",expect:{$:{length_gte:1}},timeoutMs:15000});
    await tool("browser_run",{steps:[{action:"click",target:{css:"#content_left h3 a",nth:links.value[0].nth},expect:{popup:true,url:{includes:"bilibili.com"}},follow:"auto",timeoutMs:30000}],snapshot:false});
    const popular=await tool("browser_run",{steps:[{action:"goto",url:"https://www.bilibili.com/v/popular/all/"},{action:"eval",script:"() => { const videos=Array.from(document.querySelectorAll('a[href*=\"/video/\"]')).map(a=>({url:a.href,title:(a.getAttribute('title')||a.innerText||a.querySelector('img')?.getAttribute('alt')||'').trim().slice(0,100)})).filter((a,i,all)=>all.findIndex(b=>b.url === a.url) === i);return {count:videos.length,videos:videos.slice(0,20)}; }",expect:{count:{gte:10}},timeoutMs:30000}],snapshot:false});
    report.steps.at(-1).cards=popular.steps.at(-1).result.count;save();
    const video=popular.steps.at(-1).result.videos[0].url;
    await tool("browser_run",{steps:[{action:"goto",url:video},{action:"assert",expect:{selector:{css:"video",state:"attached"}},timeoutMs:30000}],snapshot:false});
    const playback=await tool("browser_eval",{script:"async () => {const v=document.querySelector('video');v.muted=true;if(v.paused)await v.play();return {t:v.currentTime,paused:v.paused};}",timeoutMs:15000});
    const verified=await tool("browser_eval",{script:"() => {const v=document.querySelector('video');return {t:v.currentTime,paused:v.paused,duration:v.duration};}",expect:{paused:false,t:{gt:playback.value.t+0.3}},timeoutMs:15000});
    report.steps.at(-1).playback={from:playback.value.t,to:verified.value.t,paused:verified.value.paused};save();
    await tool("browser_session",{action:"finish",keep:[verified.tab_id]});
    report.completed=true;
  } catch(error) {report.completed=false;report.error=error instanceof Error?error.message:String(error);try{(report as any).diagnostic=await tool("browser_read",{scope:"document",limit:4000});}catch{}}
  finally {save();await browser.close();owner.destroy();app.exit(report.completed?0:1);}
}).catch(error=>{report.error=error.stack;save();app.exit(1);});
