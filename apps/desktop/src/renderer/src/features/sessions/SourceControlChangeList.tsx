import {useState} from "react";
import {ChevronDown,Loader2,Minus,Plus} from "lucide-react";
import type {SourceControlChange} from "@agenthub/schemas";
import {VirtualList} from "../../components/ui/VirtualList";
import {SourceControlFileIcon,SourceControlFileName} from "./SourceControlPreview";

type Selection={path:string;source:"worktree"|"index"};
export type ChangeGroup={id:string;label:string;source:Selection["source"];files:SourceControlChange[]};
export function SourceControlChangeList({groups,selection,disabled,pending,editing,zh,onSelect,onStage}:{
  groups:ChangeGroup[];selection?:Selection;disabled:boolean;pending:ReadonlyMap<string,boolean>;editing:boolean;zh:boolean;
  onSelect:(selection:Selection)=>void;onStage:(paths:string[],include:boolean)=>void;
}):JSX.Element{
  const [collapsed,setCollapsed]=useState<Set<string>>(()=>new Set());
  const rows:Array<{key:string;size:number;render:()=>JSX.Element}>=[];
  for(const group of groups.filter(group=>group.files.length>0)) {
    rows.push({key:group.id,size:36,render:()=> <div className="scm-group-heading">
      <button type="button" data-list-action aria-expanded={!collapsed.has(group.id)} onClick={()=>setCollapsed(previous=>{const next=new Set(previous);if(next.has(group.id))next.delete(group.id);else next.add(group.id);return next;})}>
        <ChevronDown size={14}/><span>{group.label}</span><span className="scm-group-count">{group.files.length}</span>
      </button>
      {group.id!=="conflicts"&&<button className="scm-group-action" type="button" disabled={disabled} aria-label={`${zh?"切换暂存":"Toggle staging"} ${group.label}`} onClick={()=>onStage(group.files.map(file=>file.path),group.source!=="index")}>
        {group.source==="index"?<Minus size={14}/>:<Plus size={14}/>}<span>{group.source==="index"?(zh?"取消暂存":"Unstage"):(zh?"暂存":"Stage")}</span>
      </button>}
    </div>});
    if(collapsed.has(group.id))continue;
    for(const file of group.files) rows.push({key:`${group.id}:${file.path}`,size:54,render:()=>{
      const status=file.conflict?"!":file.untracked?"A":group.source==="index"?file.indexStatus:file.worktreeStatus;
      const selected=selection?.path===file.path&&selection.source===group.source;
      return <div className="scm-file-row" data-selected={selected} aria-busy={pending.has(file.path)||undefined}>
        <input className="scm-file-checkbox" type="checkbox" aria-label={`${zh?"选择提交文件":"Include file in commit"} ${file.path}`} checked={pending.get(file.path)??group.source==="index"} disabled={disabled||file.conflict||pending.has(file.path)} onChange={()=>onStage([file.path],group.source!=="index")}/>
        <button type="button" data-list-action className="scm-file-select" aria-label={`${zh?"查看文件差异":"View file diff"} ${file.path}`} aria-pressed={selected} disabled={editing} onFocus={()=>{if(!selected)onSelect({path:file.path,source:group.source});}} onClick={()=>onSelect({path:file.path,source:group.source})}>
          <SourceControlFileIcon path={file.path}/><SourceControlFileName path={file.path} originalPath={file.originalPath}/>
          <span className="scm-file-status scm-status-letter" data-state={file.conflict?"conflict":status}>{pending.has(file.path)?<Loader2 size={13} className="animate-spin"/>:status}</span>
        </button>
      </div>;
    }});
  }
  return <VirtualList rows={rows} className="scm-change-groups" label={zh?"更改文件":"Changed files"} keyboard/>;
}
