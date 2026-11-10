import type {WebContents} from "electron";
import {browserDeadline} from "./browser-errors";

type Channel={id:string;sessionId?:string;parentSessionId?:string};
type NodeAddress={id:number;sessionId:string};
const states=new WeakMap<WebContents,FrameProtocol>();
/** Only auto-attached descendants of this page are eligible; never global targets. */
export function browserFrameProtocol(page:WebContents) {
  let state=states.get(page);if(!state){state=new FrameProtocol(page);states.set(page,state);}return state;
}
class FrameProtocol {
  private channels=new Map<string,Channel>();
  private objects=new Map<string,string>();
  private nodes=new Map<number,NodeAddress>();
  private reverse=new Map<string,number>();
  private nextNode=-1;
  private starting?:Promise<void>;
  constructor(private page:WebContents) {
    page.debugger.on("message",(_event,method,params,parentSessionId)=>{
      if(method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") {
        this.channels.set(params.sessionId,{id:params.targetInfo.targetId,sessionId:params.sessionId,parentSessionId:parentSessionId||undefined});
        void this.raw("Target.setAutoAttach",{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},params.sessionId).catch(()=>{});
        void this.raw("Page.enable",{},params.sessionId).catch(()=>{});
      }
      if(method === "Target.detachedFromTarget")this.channels.delete(params.sessionId);
    });
    page.debugger.on("detach",()=>{this.starting=undefined;this.channels.clear();this.objects.clear();this.nodes.clear();this.reverse.clear();});
  }
  private raw(method:string,params:Record<string,any>={},sessionId?:string):Promise<any> {
    return browserDeadline(this.page.debugger.sendCommand(method,params,sessionId),5000,method);
  }
  async frames():Promise<Channel[]> {
    this.starting ??= this.raw("Target.setAutoAttach",{autoAttach:true,waitForDebuggerOnStart:false,flatten:true}).then(async()=>{
      // Existing OOPIF attachments arrive as protocol events after the command reply.
      await new Promise(resolve=>setTimeout(resolve,0));
    }).catch(error=>{this.starting=undefined;throw error;});
    await this.starting;
    const result:Channel[]=[];
    const visit=(tree:any,sessionId?:string,parentSessionId?:string)=>{
      result.push({id:tree.frame.id,sessionId,parentSessionId});
      for(const child of tree.childFrames??[])visit(child,sessionId,sessionId);
    };
    const root=await this.raw("Page.getFrameTree");visit(root.frameTree);
    for(const channel of this.channels.values()) {
      const tree=await this.raw("Page.getFrameTree",{},channel.sessionId).catch(()=>undefined);
      if(tree)visit(tree.frameTree,channel.sessionId,channel.parentSessionId);
    }
    return [...new Map(result.map(frame=>[frame.id,frame])).values()];
  }
  route(method:string,params:Record<string,any>,sessionId?:string) {
    const address=this.nodes.get(params.backendNodeId);
    if(address){params={...params,backendNodeId:address.id};sessionId=address.sessionId;}
    else if(params.objectId && this.objects.has(params.objectId))sessionId=this.objects.get(params.objectId);
    return {params,sessionId};
  }
  private rememberObject(value:any,sessionId:string) {if(value?.objectId)this.objects.set(value.objectId,sessionId);}
  private nodeId(id:number,sessionId:string) {
    const key=sessionId+"/"+id;let value=this.reverse.get(key);
    if(value === undefined){value=this.nextNode--;this.reverse.set(key,value);this.nodes.set(value,{id,sessionId});}
    return value;
  }
  private async owner(channel:Channel) {
    const owner=await this.raw("DOM.getFrameOwner",{frameId:channel.id},channel.parentSessionId);
    return owner.backendNodeId as number;
  }
  async prepare(method:string,sessionId?:string) {
    if(method !== "DOM.scrollIntoViewIfNeeded" || !sessionId)return;
    const channel=this.channels.get(sessionId);if(!channel)return;
    await this.prepare(method,channel.parentSessionId);
    await this.raw("DOM.scrollIntoViewIfNeeded",{backendNodeId:await this.owner(channel)},channel.parentSessionId);
  }
  private async offset(sessionId?:string):Promise<{x:number;y:number}> {
    const channel=sessionId && this.channels.get(sessionId);if(!channel)return {x:0,y:0};
    const parent=await this.offset(channel.parentSessionId);
    const {model}=await this.raw("DOM.getBoxModel",{backendNodeId:await this.owner(channel)},channel.parentSessionId);
    return {x:parent.x+model.content[0],y:parent.y+model.content[1]};
  }
  async receive(method:string,result:any,sessionId?:string,params?:Record<string,any>) {
    if(method === "Runtime.releaseObject" && params?.objectId)this.objects.delete(params.objectId);
    if(!sessionId || !result)return result;
    this.rememberObject(result.object,sessionId);
    if(Array.isArray(result.result))for(const property of result.result)this.rememberObject(property.value,sessionId);
    else this.rememberObject(result.result,sessionId);
    if(result.node?.backendNodeId)result.node.backendNodeId=this.nodeId(result.node.backendNodeId,sessionId);
    if(result.backendNodeId)result.backendNodeId=this.nodeId(result.backendNodeId,sessionId);
    if(method === "DOM.getContentQuads" || method === "DOM.getBoxModel") {
      const offset=await this.offset(sessionId);
      const convert=(quad:number[])=>quad.map((value,index)=>value+(index%2?offset.y:offset.x));
      if(result.quads)result.quads=result.quads.map(convert);
      if(result.model)for(const key of ["content","padding","border","margin"])if(result.model[key])result.model[key]=convert(result.model[key]);
    }
    return result;
  }
}
