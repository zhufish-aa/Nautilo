import type {WebContents} from "electron";
import {randomUUID} from "node:crypto";
import {browserCommand} from "./browser-protocol";
import {browserDeadline,browserError,BrowserToolError} from "./browser-errors";
import {showBrowserPointer} from "./browser-pointer";

type ScrollInput={x?:number;y?:number;deltaX?:number;deltaY?:number;timeoutMs?:number};

/** Runs in an isolated world. Store the intended scroller across protocol resets. */
function scrollState(input:any) {
  const world=globalThis as unknown as {__nautiloScrollPlans?:Map<string,any>};
  const plans=world.__nautiloScrollPlans??=new Map<string,any>();
  const viewport=()=>({width:innerWidth,height:innerHeight,scrollX,scrollY,
    pageHeight:document.scrollingElement?.scrollHeight??innerHeight,devicePixelRatio,coordinateUnit:"css-pixels"});
  const describe=(node:Element)=>({tag:node.tagName.toLowerCase(),selector:node.id?"#"+CSS.escape(node.id):node.tagName.toLowerCase(),
    document:node===document.scrollingElement});
  const limits=(node:Element)=>{const width=Math.max(0,node.scrollWidth-node.clientWidth),rtl=getComputedStyle(node).direction==="rtl";
    return {minX:rtl?-width:0,maxX:rtl?0:width,maxY:Math.max(0,node.scrollHeight-node.clientHeight)};};
  if(input.action === "dispose"){plans.delete(input.id);return {};}
  if(input.action === "prepare") {
    const width=innerWidth,height=innerHeight,dx=input.deltaX??0,dy=input.deltaY??Math.round(height*.8);
    let x=input.x??width*.92,y=input.y??height*.72,safe=false;
    if(![x,y,dx,dy].every(Number.isFinite) || x<0 || y<0 || x>=width || y>=height)throw Error("Invalid scroll point or distance");
    const hitAt=(px:number,py:number)=>{let hit=document.elementFromPoint(px,py);while(hit?.shadowRoot){const child=hit.shadowRoot.elementFromPoint(px,py);if(!child || child===hit)break;hit=child;}return hit;};
    if(input.x===undefined && input.y===undefined) {
      for(const [px,py] of [[.92,.72],[.08,.72],[.92,.35],[.08,.35],[.5,.15]]) {
        const hit=hitAt(width*px,height*py);
        if(hit && !hit.closest('video,audio,canvas,iframe,embed,object,input,textarea,select,[contenteditable=true],[role=slider],[class*="player"],[data-nautilo-presence]')){x=width*px;y=height*py;safe=true;break;}
      }
    } else safe=true;
    const nodes:Element[]=[];let node=hitAt(x,y);
    while(node){const css=getComputedStyle(node);if((/(auto|scroll|overlay)/.test(css.overflowY) && node.scrollHeight>node.clientHeight) || (/(auto|scroll|overlay)/.test(css.overflowX) && node.scrollWidth>node.clientWidth))nodes.push(node);
      node=node.parentElement??(node.getRootNode() as ShadowRoot).host??null;}
    const documentNode=document.scrollingElement;if(documentNode && !nodes.includes(documentNode))nodes.push(documentNode);
    const entries=nodes.map(element=>({element,x:element.scrollLeft,y:element.scrollTop}));
    const canMove=(entry:any)=>{const range=limits(entry.element);return dx>0&&entry.x<range.maxX-1 || dx<0&&entry.x>range.minX+1 || dy>0&&entry.y<range.maxY-1 || dy<0&&entry.y>1;};
    const target=entries.find(canMove)??entries[0];
    const plan={entries,target,dx,dy,point:{x,y},safe,before:viewport(),atBoundary:!entries.some(canMove)};
    if(plans.size>=8)plans.delete(plans.keys().next().value!);plans.set(input.id,plan);
  }
  const plan=plans.get(input.id);if(!plan)throw Error("Scroll observation is no longer available; the document may have navigated");
  if(input.action === "fallback" && plan.target?.element.isConnected) {
    const target=plan.target,range=limits(target.element);
    // Absolute baseline prevents a second full relative scroll after a late ack.
    target.element.scrollTo({left:Math.max(range.minX,Math.min(range.maxX,target.x+plan.dx)),
      top:Math.max(0,Math.min(range.maxY,target.y+plan.dy)),behavior:"instant" as ScrollBehavior});
  }
  const changes=plan.entries.filter((entry:any)=>entry.element.isConnected).map((entry:any)=>({target:describe(entry.element),
    before:{x:entry.x,y:entry.y},after:{x:entry.element.scrollLeft,y:entry.element.scrollTop}}));
  const changed=changes.find((change:any)=>plan.dx*(change.after.x-change.before.x)>.5 || plan.dy*(change.after.y-change.before.y)>.5);
  return {...viewport(),point:plan.point,safe:plan.safe,deltaX:plan.dx,deltaY:plan.dy,
    moved:!!changed,at_boundary:plan.atBoundary,scroll_target:changed?.target??(plan.target?describe(plan.target.element):undefined),
    scroll_before:changed?.before??(plan.target?{x:plan.target.x,y:plan.target.y}:undefined),
    scroll_after:changed?.after??(plan.target?{x:plan.target.element.scrollLeft,y:plan.target.element.scrollTop}:undefined)};
}

export async function scrollBrowserPage(page:WebContents,input:ScrollInput,check:()=>void,wheelAvailable:boolean,onWheelFailure:()=>void) {
  const id=randomUUID(),started=Date.now(),timeout=Math.max(100,Math.min(input.timeoutMs??5000,120000));
  const state=async(action:string)=>{
    check();
    const remaining=timeout-(Date.now()-started);
    if(remaining<=0)throw new BrowserToolError("SCROLL_NO_EFFECT","Scrolling did not complete within its deadline.",{timeout_ms:timeout},"Inspect the page and scroll target before retrying.",false);
    return browserDeadline(page.executeJavaScriptInIsolatedWorld(1001,[{code:`(${scrollState.toString()})(${JSON.stringify({...input,id,action})})`}]),Math.min(800,remaining),"observe page scroll","read") as Promise<any>;
  };
  let wheelError:ReturnType<typeof browserError>|undefined;
  let dispatched=false;
  try {
    let observed=await state("prepare");
    if(observed.deltaX===0 && observed.deltaY===0)return {...observed,method:"none",noop:true};
    if(!observed.at_boundary && wheelAvailable && observed.safe) {
      await showBrowserPointer(page,observed.point.x,observed.point.y,"scroll");
      try {
        check();
        const budget=Math.min(1000,Math.max(100,timeout-(Date.now()-started)));
        dispatched=true;
        await browserCommand(page,"Input.dispatchMouseEvent",{type:"mouseWheel",...observed.point,
          deltaX:observed.deltaX,deltaY:observed.deltaY},budget);
      } catch(error) {
        check();wheelError=browserError(error);
        if(!["browser_operation_timeout","protocol_reset"].includes(wheelError.code))throw error;
        onWheelFailure();
      }
      for(const delay of [80,120,150]) {
        await new Promise(resolve=>setTimeout(resolve,delay));observed=await state("read");
        if(observed.moved)return {...observed,method:"wheel",wheel_dispatched:dispatched,wheel_error:wheelError};
      }
    }
    check();observed=await state("fallback");
    for(const delay of [0,80,120]) {
      if(delay)await new Promise(resolve=>setTimeout(resolve,delay));observed=await state("read");
      if(observed.moved)return {...observed,method:"dom-scroll",wheel_dispatched:dispatched,wheel_error:wheelError,
        wheel_skipped:!wheelAvailable?"channel_unavailable":!observed.safe?"interactive_region":undefined};
    }
    throw new BrowserToolError("SCROLL_NO_EFFECT","The requested scroll did not change the page or target scroll position.",
      {...observed,wheel_error:wheelError,elapsed_ms:Date.now()-started,dispatched},
      observed.at_boundary?"The scroll target is at its boundary; choose another direction or scroll region.":"The scroll channel or page may be intercepting input. Inspect the scroll target before continuing; this action was not reported as completed.",false);
  } finally {
    if(!page.isDestroyed())void page.executeJavaScriptInIsolatedWorld(1001,[{code:`globalThis.__nautiloScrollPlans?.delete(${JSON.stringify(id)})`}]).catch(()=>{});
  }
}
