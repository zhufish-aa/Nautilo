import type { Session, WebContents, DownloadItem } from "electron";
import { mkdirSync } from "node:fs";
import { stat,copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename,isAbsolute,join } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserToolError } from "./browser-errors";
import { browserCommand } from "./browser-protocol";
import { browserTargetNode } from "./browser-dom";
import type { BrowserPageEvents } from "./browser-page-events";
type Download = {id:string;tabId:string;filename:string;url:string;state:string;received:number;total:number;path:string;item:DownloadItem;agent:boolean};
export class BrowserFiles {
  private downloads=new Map<string,Download>();
  constructor(profile:Session,private directory:string,private owns:(page:WebContents)=>string|undefined,private events:(tabId:string)=>BrowserPageEvents|undefined,private isAgent:(tabId:string)=>boolean) {
    mkdirSync(directory,{recursive:true});
    profile.on("will-download",(event,item,page)=>{
      const tabId=this.owns(page);
      if(!tabId){event.preventDefault();return;}
      const id=randomUUID(), filename=basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g,"_") || "download";
      const path=join(directory,id+"-"+filename);
      item.setSavePath(path);
      const entry:Download={id,tabId,filename,url:item.getURL(),state:"progressing",received:0,total:item.getTotalBytes(),path,item,agent:this.isAgent(tabId)};
      this.downloads.set(id,entry);
      this.events(tabId)?.add("download",{download_id:id,filename});
      item.on("updated",(_event,state)=>{entry.state=state;entry.received=item.getReceivedBytes();entry.total=item.getTotalBytes();});
      item.once("done",(_event,state)=>{entry.state=state;entry.received=item.getReceivedBytes();this.events(tabId)?.add("download_done",{download_id:id,state});});
    });
  }
  stopAgentDownloads(){for(const entry of this.downloads.values())if(entry.agent && ["progressing","interrupted"].includes(entry.state))entry.item.cancel();}
  private describe(item:Download){return {download_id:item.id,tab_id:item.tabId,filename:item.filename,url:item.url,state:item.state,received_bytes:item.received,total_bytes:item.total};}
  async command(page:WebContents,tabId:string,events:BrowserPageEvents,args:any,check:()=>void) {
    if(args.action === "list") return {ok:true,downloads:[...this.downloads.values()].filter(item=>item.tabId === tabId).map(item=>this.describe(item)),chooser:events.chooser?.data,
      page_errors:events.list(0,"page_error").filter(event=>Date.parse(event.at)>Date.now()-30000).slice(-5).map(event=>({at:event.at,...event.data}))};
    if(args.action === "arm_chooser" || args.action === "disarm_chooser")return events.fileChooser(args.action === "arm_chooser");
    check();
    if(args.action === "upload") {
      const files=args.paths;
      if(!Array.isArray(files) || !files.length || files.length>20 || files.some(path=>typeof path !== "string" || !isAbsolute(path)))throw new BrowserToolError("INVALID_FILES","Provide 1–20 absolute local file paths.",{},undefined,false);
      for(const file of files)if(!(await stat(file)).isFile())throw new BrowserToolError("INVALID_FILES","Upload path must identify a regular file.",{path:file},undefined,false);
      const target=args.target;
      if(target && Object.keys(target).some(key=>!["css","nth","frame"].includes(key)))throw new BrowserToolError("INVALID_TARGET","Upload targets support css, optional nth and frame.",{},undefined,false);
      const backendNodeId = target ? await browserTargetNode(page,{selector:target.css ?? 'input[type=file]',nth:target.nth,frame:target.frame,allowHidden:true}) : events.chooser?.data.backend_node_id ?? await browserTargetNode(page,{selector:'input[type=file]',allowHidden:true});
      const {node}=await browserCommand(page,"DOM.describeNode",{backendNodeId});
      const attributes=node.attributes ?? [];
      if(node.nodeName !== "INPUT" || !attributes.some((value:string,index:number)=>value === "type" && attributes[index+1]?.toLowerCase() === "file"))throw new BrowserToolError("FILE_INPUT_NOT_FOUND","The selected element is not a file input.");
      check();await browserCommand(page,"DOM.setFileInputFiles",{backendNodeId,files});
      if(events.chooser)await events.fileChooser(false);
      return {ok:true,uploaded:files.map(path=>({filename:basename(path)})),verified:false};
    }
    if(args.action === "download") {
      const url=new URL(args.url);
      if(!["http:","https:"].includes(url.protocol))throw new BrowserToolError("INVALID_URL","Downloads require an HTTP(S) URL.",{},undefined,false);
      const before=new Set(this.downloads.keys());page.downloadURL(url.href);
      const deadline=Date.now()+(args.timeoutMs ?? 15000);
      while(Date.now()<deadline){check();const item=[...this.downloads.values()].find(item=>!before.has(item.id) && item.tabId === tabId);if(item)return {ok:true,...this.describe(item),verified:false};await new Promise(resolve=>setTimeout(resolve,50));}
      throw new BrowserToolError("DOWNLOAD_FAILED","No download started before the timeout.",{timeout_ms:args.timeoutMs ?? 15000});
    }
    const item=this.downloads.get(args.download_id);
    if(!item || item.tabId !== tabId)throw new BrowserToolError("DOWNLOAD_NOT_FOUND","Download does not belong to this tab.",{},undefined,false);
    if(args.action === "cancel"){if(item.state === "progressing" || item.state === "interrupted")item.item.cancel();return {ok:true,...this.describe(item)};}
    if(args.action === "save") {
      if(typeof args.path !== "string" || !isAbsolute(args.path))throw new BrowserToolError("INVALID_PATH","save requires an absolute destination path.",{},undefined,false);
      const deadline=Date.now()+(args.timeoutMs ?? 30000);
      while(item.state === "progressing" && Date.now()<deadline){check();await new Promise(resolve=>setTimeout(resolve,100));}
      if(item.state !== "completed")throw new BrowserToolError("DOWNLOAD_FAILED","The download is not complete.",{state:item.state,received_bytes:item.received});
      check();
      try{await copyFile(item.path,args.path,constants.COPYFILE_EXCL);}catch(error){throw new BrowserToolError("SAVE_FAILED","The file could not be saved; existing files are not overwritten.",{reason:(error as NodeJS.ErrnoException).code},"Choose an existing parent directory and a new filename.");}
      return {ok:true,saved:true,path:args.path,...this.describe(item)};
    }
    throw new BrowserToolError("INVALID_REQUEST","Unknown browser_files action.",{},undefined,false);
  }
}
