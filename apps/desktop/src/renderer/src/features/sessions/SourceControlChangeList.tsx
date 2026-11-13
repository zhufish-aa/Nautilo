import {useState} from "react";
import {ChevronDown,Loader2,Minus,Plus} from "lucide-react";
import type {SourceControlChange} from "@agenthub/schemas";
import {SourceControlFileIcon,SourceControlFileName} from "./SourceControlPreview";

type Selection={path:string;source:"worktree"|"index"};
export type ChangeGroup={id:string;label:string;source:Selection["source"];files:SourceControlChange[]};
export function SourceControlChangeList({groups,selection,disabled,pending,editing,zh,onSelect,onStage}:{
  groups:ChangeGroup[];selection?:Selection;disabled:boolean;pending:ReadonlyMap<string,boolean>;editing:boolean;zh:boolean;
  onSelect:(selection:Selection)=>void;onStage:(paths:string[],include:boolean)=>void;
}):JSX.Element{
  const [collapsed,setCollapsed]=useState<Set<string>>(()=>new Set());
  return <div className="scm-change-groups" onKeyDown={event=>{
    if(!(event.target instanceof HTMLElement)||!event.target.closest(".scm-file-select"))return;
    const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".scm-file-select:not(:disabled)"));
    const index=buttons.indexOf(event.target.closest<HTMLButtonElement>(".scm-file-select")!);
    const next=event.key==="ArrowDown"?Math.min(index+1,buttons.length-1):event.key==="ArrowUp"?Math.max(index-1,0):event.key==="Home"?0:event.key==="End"?buttons.length-1:undefined;
    if(next!==undefined&&buttons[next]){event.preventDefault();buttons[next].focus();buttons[next].click();buttons[next].scrollIntoView?.({block:"nearest"});}
  }}>
    {groups.filter(group=>group.files.length>0).map(group=><section className="scm-change-group" data-group={group.id} key={group.id} aria-label={group.label}>
      <div className="scm-group-heading">
        <button type="button" aria-expanded={!collapsed.has(group.id)} onClick={()=>setCollapsed(previous=>{const next=new Set(previous);if(next.has(group.id))next.delete(group.id);else next.add(group.id);return next;})}>
          <ChevronDown size={14}/><span>{group.label}</span><span className="scm-group-count">{group.files.length}</span>
        </button>
        {group.id!=="conflicts"&&<button className="scm-group-action" type="button" disabled={disabled} title={group.source==="index"?(zh?"全部取消暂存":"Unstage group"):(zh?"全部暂存":"Stage group")} aria-label={`${group.source==="index"?(zh?"取消暂存":"Unstage"):(zh?"暂存":"Stage")} ${group.label}`} onClick={()=>onStage(group.files.map(file=>file.path),group.source!=="index")}>
          {group.source==="index"?<Minus size={14}/>:<Plus size={14}/>}<span>{group.source==="index"?(zh?"取消暂存":"Unstage"):(zh?"暂存":"Stage")}</span>
        </button>}
      </div>
      {!collapsed.has(group.id)&&group.files.map(file=>{
        const status=file.conflict?"!":file.untracked?"A":group.source==="index"?file.indexStatus:file.worktreeStatus;
        return <div className="scm-file-row" key={file.path} data-selected={selection?.path===file.path&&selection.source===group.source} aria-busy={pending.has(file.path)||undefined}>
          <input className="scm-file-checkbox" type="checkbox" aria-label={`${zh?"选择提交文件":"Include file in commit"} ${file.path}`} checked={pending.get(file.path)??group.source==="index"} disabled={disabled||file.conflict||pending.has(file.path)} onChange={()=>onStage([file.path],group.source!=="index")}/>
          <button type="button" className="scm-file-select" aria-label={`${zh?"查看文件差异":"View file diff"} ${file.path}`} aria-pressed={selection?.path===file.path&&selection.source===group.source} disabled={editing} onClick={()=>onSelect({path:file.path,source:group.source})}>
            <SourceControlFileIcon path={file.path}/><SourceControlFileName path={file.path} originalPath={file.originalPath}/>
            <span className="scm-file-status scm-status-letter" data-state={file.conflict?"conflict":status}>{pending.has(file.path)?<Loader2 size={13} className="animate-spin"/>:status}</span>
          </button>
        </div>;
      })}
    </section>)}
  </div>;
}
