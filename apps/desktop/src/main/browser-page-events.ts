import type { WebContents } from "electron";
import { browserCommand } from "./browser-protocol";
import { BrowserToolError } from "./browser-errors";
import { registerBrowserDialogs,showBrowserDialog } from "./browser-dialogs";

export type BrowserPageEvent = {id:number;type:string;at:string;data:Record<string,any>};
export class BrowserPageEvents {
  private sequence=0;
  private events:BrowserPageEvent[]=[];
  private rule?:{accept:boolean;prompt_text?:string;type?:string};
  dialog?:BrowserPageEvent;
  chooser?:BrowserPageEvent;
  private enabled=false;
  private dialogReply?: (accept:boolean,text?:string)=>void;
  private dismissUI?: ()=>void;
  private dialogSource:string;
  private injection?:Promise<void>;
  private watching=new Set<string>();
  private pending=new Set<string>();
  private lastNetwork=Date.now();
  private listener=(_event:unknown, method:string, params:any) => {
    if(this.watching.has(method))this.add("protocol",{method,params:JSON.stringify(params).length>16000?{truncated:true}:params});
    if(method === "Network.requestWillBeSent"){this.pending.add(params.requestId);this.lastNetwork=Date.now();}
    if(method === "Network.loadingFinished" || method === "Network.loadingFailed"){this.pending.delete(params.requestId);this.lastNetwork=Date.now();}
    if (method === "Page.javascriptDialogOpening") {
      this.dialog=this.add("dialog",{type:params.type,message:String(params.message).slice(0,4000),default_value:params.defaultPrompt,url:params.url});
      if (this.rule && (!this.rule.type || this.rule.type === params.type)) {
        const rule=this.rule; this.rule=undefined;
        void this.handleDialog(rule.accept,rule.prompt_text).catch(error=>this.add("dialog_error",{message:error.message}));
      }
    } else if (method === "Page.javascriptDialogClosed") { this.add("dialog_closed",{accepted:params.result});this.dialog=undefined; }
    else if (method === "Page.fileChooserOpened") this.chooser=this.add("filechooser",{backend_node_id:params.backendNodeId,mode:params.mode,frame_id:params.frameId});
    else if (method === "Page.frameNavigated" && !params.frame.parentId) this.add("navigation",{url:params.frame.url});
    else if (method === "Page.loadEventFired") this.add("load",{});
    else if (method === "Page.domContentEventFired") this.add("domcontentloaded",{});
    else if (method === "Network.responseReceived") this.add("response",{url:params.response.url,status:params.response.status,request_id:params.requestId});
  };
  constructor(private page:WebContents) {
    this.dialogSource=registerBrowserDialogs(page,request=>{
      this.dialog=this.add("dialog",{type:request.type,message:request.message,default_value:request.default_value,source:"nautilo-dialog"});
      if(this.watching.has("Page.javascriptDialogOpening"))this.add("protocol",{method:"Page.javascriptDialogOpening",params:{...this.dialog.data}});
      this.dialogReply=(accept,text)=>{request.resolve(accept,text);this.add("dialog_closed",{accepted:accept});this.dialog=undefined;this.dialogReply=undefined;this.dismissUI?.();this.dismissUI=undefined;};
      const rule=this.rule;
      if(rule && (!rule.type || rule.type === request.type)){this.rule=undefined;this.dialogReply(rule.accept,rule.prompt_text);}
      else this.dismissUI=showBrowserDialog(page,{...request,resolve:(accept,text)=>this.dialogReply?.(accept,text)});
    });
    page.debugger.on("message",this.listener);
    page.on("console-message",(_event,level,message,line,source)=>{
      if(level === 3)this.add("page_error",{message:String(message).slice(0,2000),line,source:String(source).slice(0,500)});
    });
    page.debugger.on("detach",()=>{this.enabled=false;this.dialogReply?.(false);this.dialog=undefined;this.chooser=undefined;this.injection=undefined;});
    // Electron destroys the native debugger with its WebContents. Accessing
    // page.debugger from 'destroyed' throws before cleanup can even run.
    page.once("destroyed",()=>{this.enabled=false;this.dialogReply?.(false);this.events=[];this.watching.clear();this.pending.clear();});
    page.on("dom-ready",()=>{void this.bindDialogs().catch(()=>{});});
  }
  cancelDialogs(){this.rule=undefined;this.dialogReply?.(false);}
  private async bindDialogs(){if(!this.page.isDestroyed() && this.page.getURL())await browserCommand(this.page,"Runtime.evaluate",{expression:this.dialogSource});}
  async installDialogs() {
    this.injection ??= (async()=>{
      await browserCommand(this.page,"Page.addScriptToEvaluateOnNewDocument",{source:this.dialogSource});
      await this.bindDialogs();
    })().catch(error=>{this.injection=undefined;throw error;});
    await this.injection;
  }
  add(type:string,data:Record<string,any>) {
    const event={id:++this.sequence,type,at:new Date().toISOString(),data};
    this.events.push(event);if(this.events.length>120)this.events.shift();
    return event;
  }
  get cursor(){return this.sequence;}
  async watch(method:string){
    if(!/^(Runtime|Log|Page|Network|DOM|Input)\.[A-Za-z]+$/.test(method))throw new BrowserToolError("INVALID_EXPECT","Use a page-scoped protocol event name.");
    this.watching.add(method);
    if(/^(Runtime|Log|Page|Network|DOM)\./.test(method))await browserCommand(this.page,method.split('.')[0]+".enable");
  }
  unwatch(method:string){this.watching.delete(method);}
  get network(){return {pending:this.pending.size,idle_ms:Date.now()-this.lastNetwork};}
  list(since=0,type?:string){return this.events.filter(event=>event.id>since && (!type || event.type === type));}
  async start() {
    if(this.enabled && this.page.debugger.isAttached())return;
    await browserCommand(this.page,"Page.enable");
    await browserCommand(this.page,"Network.enable");
    await this.installDialogs();
    this.enabled=true;
  }
  async handleDialog(accept:boolean,promptText?:string) {
    if(!this.dialog)throw new BrowserToolError("DIALOG_NOT_FOUND","No dialog is pending. Arm a handler before triggering it.");
    const pending=this.dialog;
    if(this.dialogReply){this.dialogReply(accept,promptText);return {handled:true,accepted:accept,dialog:pending.data};}
    await browserCommand(this.page,"Page.handleJavaScriptDialog",{accept,promptText});
    this.dialog=undefined;
    return {handled:true,accepted:accept,dialog:pending.data};
  }
  async dialogCommand(args:any) {
    await this.start();
    if(args.action === "list")return {ok:true,pending:this.dialog?.data,events:this.list(args.since ?? 0,"dialog"),cursor:this.cursor};
    if(args.action === "disarm"){this.rule=undefined;return {ok:true,armed:false};}
    if(!["arm","accept","dismiss"].includes(args.action))throw new BrowserToolError("INVALID_REQUEST","Use list, arm, accept, dismiss or disarm.",{},undefined,false);
    const accept=args.action === "dismiss" ? false : args.accept !== false;
    if(args.action === "arm") {
      this.rule={accept,prompt_text:args.prompt_text,type:args.type};
      if(this.dialog && (!args.type || this.dialog.data.type === args.type)){this.rule=undefined;return {ok:true,...await this.handleDialog(accept,args.prompt_text)};}
      return {ok:true,armed:true,once:true};
    }
    return {ok:true,...await this.handleDialog(accept,args.prompt_text)};
  }
  async fileChooser(armed:boolean) {
    await this.start();
    await browserCommand(this.page,"Page.setInterceptFileChooserDialog",{enabled:armed});
    if(!armed)this.chooser=undefined;
    return {ok:true,armed,pending:this.chooser?.data,cursor:this.cursor};
  }
}
