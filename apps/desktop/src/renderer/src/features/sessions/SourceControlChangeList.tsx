import {useLayoutEffect,useMemo,useRef,useState,type CSSProperties} from "react";
import {ChevronDown,Folder,FolderOpen,Minus,Plus} from "lucide-react";
import type {SourceControlChange} from "@agenthub/schemas";
import {VirtualList} from "../../components/ui/VirtualList";
import {SourceControlFileIcon,SourceControlFileName} from "./SourceControlPreview";

type Selection={path:string;source:"worktree"|"index"};
export type ChangeGroup={id:string;label:string;source:Selection["source"];files:SourceControlChange[]};
type Entry={file:SourceControlChange;group:ChangeGroup};
type Directory={name:string;path:string;folders:Map<string,Directory>;files:Entry[];contents:Entry[]};

export const staged=(file:SourceControlChange):boolean=>!file.conflict&&![".","?"].includes(file.indexStatus);
export const unstaged=(file:SourceControlChange):boolean=>!file.conflict&&(file.untracked||file.worktreeStatus!==".");
const selectable=(file:SourceControlChange):boolean=>!file.conflict&&!file.directory;

export function FileCheckbox({mixed=false,...props}:{mixed?:boolean;checked:boolean;disabled?:boolean;label:string;onChange:(checked:boolean)=>void}):JSX.Element {
  const ref=useRef<HTMLInputElement>(null);
  useLayoutEffect(()=>{if(ref.current)ref.current.indeterminate=mixed;},[mixed]);
  return <input ref={ref} className="scm-file-checkbox" type="checkbox" aria-label={props.label} aria-checked={mixed?"mixed":props.checked} checked={props.checked} disabled={props.disabled} onChange={event=>props.onChange(event.currentTarget.checked)}/>;
}

function buildFolders(groups:ChangeGroup[]):Directory {
  const root:Directory={name:"",path:"",folders:new Map(),files:[],contents:[]};
  for(const group of groups) for(const file of group.files){
    const entry={file,group};
    let directory=root;
    for(const name of file.path.split(/[\\/]/u).slice(0,-1)){
      let child=directory.folders.get(name);
      if(!child){
        child={name,path:directory.path?directory.path+"/"+name:name,folders:new Map(),files:[],contents:[]};
        directory.folders.set(name,child);
      }
      directory=child;
      directory.contents.push(entry);
    }
    directory.files.push(entry);
  }
  return root;
}

export function SourceControlChangeList({groups,tree,selection,disabled,checkedPaths,editing,zh,onSelect,onCheck,onStage}:{
  groups:ChangeGroup[];tree:boolean;selection?:Selection;disabled:boolean;checkedPaths:ReadonlySet<string>;editing:boolean;zh:boolean;
  onSelect:(selection:Selection)=>void;onCheck:(paths:readonly string[],checked:boolean)=>void;
  onStage:(paths:string[],stage:boolean)=>void;
}):JSX.Element{
  const [collapsed,setCollapsed]=useState<Set<string>>(()=>new Set());
  const folders=useMemo(()=>tree?buildFolders(groups):undefined,[tree,groups]);
  const rows:Array<{key:string;size:number;render:()=>JSX.Element}>=[];
  const toggle=(key:string):void=>setCollapsed(previous=>{
    const next=new Set(previous);
    if(next.has(key))next.delete(key);else next.add(key);
    return next;
  });
  const addFile=({file,group}:Entry,depth=0):void=>{
    rows.push({key:`${group.id}:${file.path}`,size:tree?32:48,render:()=>{
      const status=file.conflict?"!":file.untracked?"U":group.source==="index"?file.indexStatus:file.worktreeStatus;
      const selected=selection?.path===file.path;
      return <div className="scm-file-row" data-selected={selected} data-group={group.id} data-tree={tree||undefined} data-nested={depth>0||undefined} style={tree?{"--scm-indent":`${9+Math.min(depth,5)*12}px`} as CSSProperties:undefined}>
        <FileCheckbox label={`${zh?"选择提交文件":"Include file in commit"} ${file.path}`} checked={checkedPaths.has(file.path)} disabled={disabled||!selectable(file)} onChange={checked=>onCheck([file.path],checked)}/>
        <button type="button" data-list-action className="scm-file-select" aria-label={`${zh?"查看文件差异":"View file diff"} ${file.path}`} aria-pressed={selected} disabled={editing} onFocus={()=>{if(!selected)onSelect({path:file.path,source:group.source});}} onClick={()=>{if(!selected)onSelect({path:file.path,source:group.source});}}>
          <SourceControlFileIcon path={file.path}/><SourceControlFileName path={file.path} originalPath={file.originalPath}/>
          <span className="scm-file-status scm-status-badge" data-state={file.conflict?"conflict":status}>{status}</span>
        </button>
      </div>;
    }});
  };
  const addFolder=(folder:Directory,depth:number):void=>{
    let end=folder;
    const names=[folder.name];
    while(!end.files.length&&end.folders.size===1){
      end=end.folders.values().next().value!;
      names.push(end.name);
    }
    const key=`folder:${end.path}`;
    const expanded=!collapsed.has(key);
    const eligible=end.contents.map(entry=>entry.file).filter(selectable);
    const filePaths=eligible.map(file=>file.path);
    const stagedPaths=eligible.filter(staged).map(file=>file.path);
    const unstagedPaths=eligible.filter(unstaged).map(file=>file.path);
    const count=filePaths.filter(path=>checkedPaths.has(path)).length;
    const lastName=names.at(-1);
    rows.push({key,size:34,render:()=> <div className="scm-folder-row" data-nested={depth>0||undefined} style={{"--scm-indent":`${9+Math.min(depth,5)*12}px`} as CSSProperties}>
      <FileCheckbox label={`${zh?"选择目录":"Select folder"} ${end.path}`} checked={!!filePaths.length&&count===filePaths.length} mixed={count>0&&count<filePaths.length} disabled={disabled||!filePaths.length} onChange={checked=>onCheck(filePaths,checked)}/>
      <button type="button" className="scm-folder-toggle" data-list-action aria-expanded={expanded} aria-label={end.path} onClick={()=>toggle(key)} title={end.path}>
        <ChevronDown size={12} aria-hidden/>{expanded?<FolderOpen size={15} aria-hidden/>:<Folder size={15} aria-hidden/>}
        <span className="scm-folder-name">{names.length>1&&<span>{names.slice(0,-1).join("/")}/</span>}<span>{lastName}</span></span>
      </button>
      <span className="scm-group-count">{end.contents.length}</span>
      <div className="scm-folder-actions">
        {!!unstagedPaths.length&&<button type="button" disabled={disabled} aria-label={`${zh?"暂存目录":"Stage folder"} ${end.path}`} title={zh?"暂存目录":"Stage folder"} onClick={()=>onStage(unstagedPaths,true)}><Plus size={13} aria-hidden/></button>}
        {!!stagedPaths.length&&<button type="button" disabled={disabled} aria-label={`${zh?"取消暂存目录":"Unstage folder"} ${end.path}`} title={zh?"取消暂存目录":"Unstage folder"} onClick={()=>onStage(stagedPaths,false)}><Minus size={13} aria-hidden/></button>}
      </div>
    </div>});
    if(!expanded)return;
    for(const child of end.folders.values())addFolder(child,depth+1);
    for(const entry of end.files)addFile(entry,depth+1);
  };
  if(folders){
    for(const folder of folders.folders.values())addFolder(folder,0);
    for(const entry of folders.files)addFile(entry);
  }else{
    for(const group of groups.filter(group=>group.files.length>0)){
      rows.push({key:group.id,size:34,render:()=> <div className="scm-group-heading" data-group={group.id}>
        <button type="button" data-list-action aria-expanded={!collapsed.has(group.id)} onClick={()=>toggle(group.id)}>
          <ChevronDown size={14}/><span>{group.label}</span><span className="scm-group-count">{group.files.length}</span>
        </button>
      </div>});
      if(!collapsed.has(group.id))for(const file of group.files)addFile({file,group});
    }
  }
  return <VirtualList rows={rows} className="scm-change-groups" label={zh?"更改文件":"Changed files"} keyboard/>;
}
