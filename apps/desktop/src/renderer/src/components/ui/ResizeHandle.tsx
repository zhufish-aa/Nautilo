import {useEffect,useRef,useState} from "react";
import "./resize-handle.css";

export function useRememberedWidth(key:string,fallback:number,min:number,max:number){
  const clamp=(value:number):number=>Math.round(Math.max(min,Math.min(Math.max(min,max),value)));
  const [width,setWidth]=useState(()=>{try{const saved=Number(localStorage.getItem(key));if(saved>0&&Number.isFinite(saved))return saved;}catch{/* Keep the default width. */}return fallback;});
  const save=(value:number):void=>{const next=clamp(value);setWidth(next);try{localStorage.setItem(key,String(next));}catch{/* The current size still works. */}};
  return{width:clamp(width),resize:(value:number)=>setWidth(clamp(value)),save};
}

/** The handle overlaps a border, leaving the pane's usable width unchanged. */
export function ResizeHandle({label,value,min,max,onChange,onCommit,edge="right",reset}: {
  label:string;value:number;min:number;max:number;onChange:(value:number)=>void;onCommit:(value:number)=>void;
  edge?:"left"|"right";reset:number;
}):JSX.Element{
  const drag=useRef<{x:number;value:number;cursor:string;select:string}>();
  const latest=useRef(value);latest.current=value;
  const commit=useRef(onCommit);commit.current=onCommit;
  const clamp=(value:number):number=>Math.round(Math.max(min,Math.min(Math.max(min,max),value)));
  const finish=():void=>{if(!drag.current)return;document.body.style.cursor=drag.current.cursor;document.body.style.userSelect=drag.current.select;drag.current=undefined;};
  useEffect(()=>{const blur=():void=>{if(drag.current)commit.current(latest.current);finish();};window.addEventListener("blur",blur);return()=>{window.removeEventListener("blur",blur);finish();};},[]);
  const next=(x:number):number=>clamp(drag.current!.value+(x-drag.current!.x)*(edge==="left"?-1:1));
  return <div role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={Math.max(min,max)} aria-valuenow={value}
    className="pane-resize-handle" data-edge={edge} title={label}
    onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.focus();event.currentTarget.setPointerCapture?.(event.pointerId);drag.current={x:event.clientX,value,cursor:document.body.style.cursor,select:document.body.style.userSelect};document.body.style.cursor="col-resize";document.body.style.userSelect="none";}}
    onPointerMove={event=>{if(drag.current){const width=next(event.clientX);latest.current=width;onChange(width);}}}
    onPointerUp={event=>{if(!drag.current)return;onCommit(next(event.clientX));finish();event.currentTarget.releasePointerCapture?.(event.pointerId);}}
    onPointerCancel={()=>{if(drag.current)onCommit(latest.current);finish();}} onLostPointerCapture={()=>{if(drag.current)onCommit(latest.current);finish();}}
    onDoubleClick={()=>onCommit(clamp(reset))}
    onKeyDown={event=>{const sign=edge==="left"?-1:1,step=event.shiftKey?64:16;const width=event.key==="ArrowRight"?value+step*sign:event.key==="ArrowLeft"?value-step*sign:event.key==="Home"?min:event.key==="End"?max:undefined;if(width!==undefined){event.preventDefault();onCommit(clamp(width));}}}/>;
}
