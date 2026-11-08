import {useEffect,useMemo,useRef,useState} from "react";
import type {SourceControlHunk} from "@agenthub/schemas";

/** Render visible patch rows so large diffs do not block the conversation. */
export function SourceControlDiffView({patch,scope,hunks=[],patchToken,source="worktree",disabled=false,locale="zh-CN",onApply}:{
  patch:string;scope:string;hunks?:SourceControlHunk[];patchToken?:string;source?:"worktree"|"index";disabled?:boolean;locale?:string;
  onApply?:(selection:{hunkIds?:string[];lines?:number[]})=>void;
}):JSX.Element {
  const lines=useMemo(()=>patch.split("\n"),[patch]);
  const zh=locale==="zh-CN",partial=!!patchToken&&hunks.length>0&&!!onApply;
  const [selected,setSelected]=useState<Set<number>>(()=>new Set());
  const anchor=useRef<number>();
  const changed=useMemo(()=>{const result=new Set<number>();if(partial)for(const hunk of hunks)for(let row=hunk.startLine+1;row<=Math.min(lines.length,hunk.endLine);row++)if(lines[row-1][0]==="+"||lines[row-1][0]==="-")result.add(row);return result;},[lines,hunks,partial]);
  useEffect(()=>{setSelected(new Set());anchor.current=undefined;},[scope,patchToken]);
  const surface=useRef<HTMLPreElement>(null);
  const [viewport,setViewport]=useState({top:0,height:500});
  const widest=useRef(0);
  useEffect(()=>{surface.current?.scrollTo?.(0,0);widest.current=0;setViewport(previous=>({...previous,top:0}));},[scope]);
  useEffect(()=>{
    const element=surface.current;if(!element)return;
    const measure=():void=>setViewport(previous=>({...previous,height:element.clientHeight||500}));
    measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[]);
  const start=Math.max(0,Math.min(lines.length-1,Math.floor(viewport.top/20)-15));
  const end=Math.min(lines.length,start+Math.ceil(viewport.height/20)+30);
  const visible=lines.slice(start,end);
  widest.current=Math.max(widest.current,...visible.map(line=>line.length));
  return <>{partial&&<div className="scm-patch-selection"><span>{zh?`已选择 ${selected.size} 行更改`:`${selected.size} changed lines selected`}</span><div><button type="button" disabled={disabled||!selected.size} onClick={()=>setSelected(new Set())}>{zh?"清除":"Clear"}</button><button type="button" disabled={disabled||!selected.size} onClick={()=>onApply?.({lines:[...selected].sort((a,b)=>a-b)})}>{source==="index"?(zh?"取消暂存选中行":"Unstage selected lines"):(zh?"暂存选中行":"Stage selected lines")}</button></div></div>}
  <pre ref={surface} className="scm-diff-code" tabIndex={0} aria-label="Diff" onScroll={event=>{const top=event.currentTarget.scrollTop;setViewport(previous=>previous.top===top?previous:{...previous,top});}}>
    <div className="scm-diff-rows" style={{height:lines.length*20,minWidth:`${Math.min(200000,widest.current)+3}ch`}}>
      {visible.map((line,index)=>{const row=start+index+1,hunk=partial?hunks.find(hunk=>hunk.startLine===row):undefined;return <div key={row} data-line={row} data-selected={selected.has(row)||undefined} className={`scm-patch-row ${line.startsWith("+")&&!line.startsWith("+++")?"scm-line-added":line.startsWith("-")&&!line.startsWith("---")?"scm-line-removed":line.startsWith("@@")?"scm-line-hunk":""}`} style={{top:(row-1)*20}}>
        {partial&&<span className="scm-patch-gutter">{changed.has(row)&&<input type="checkbox" disabled={disabled} checked={selected.has(row)} aria-label={zh?`选择更改行 ${row}`:`Select changed line ${row}`} onChange={event=>{const checked=event.currentTarget.checked,shift=(event.nativeEvent as MouseEvent).shiftKey,previous=anchor.current;setSelected(current=>{const next=new Set(current);if(shift&&previous!==undefined){for(const line of changed)if(line>=Math.min(previous,row)&&line<=Math.max(previous,row)){if(checked)next.add(line);else next.delete(line);}}else if(checked)next.add(row);else next.delete(row);return next;});anchor.current=row;}}/>}</span>}
        <span className="scm-patch-line-value">{line||" "}</span>{hunk&&<button type="button" className="scm-hunk-action" disabled={disabled} aria-label={`${source==="index"?(zh?"取消暂存区块":"Unstage hunk"):(zh?"暂存区块":"Stage hunk")} ${hunk.startLine}`} onClick={()=>onApply?.({hunkIds:[hunk.id]})}>{source==="index"?(zh?"取消暂存区块":"Unstage hunk"):(zh?"暂存区块":"Stage hunk")}</button>}
      </div>;})}
    </div>
  </pre></>;
}
