import {useId,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from "react";
import {ChevronDown,FoldVertical,Folder,FolderOpen,Minus,Plus,UnfoldVertical} from "lucide-react";
import type {SourceControlChange} from "@agenthub/schemas";
import {VirtualList} from "../../components/ui/VirtualList";
import {SourceControlFileIcon,SourceControlFileName} from "./SourceControlPreview";

type Selection={path:string;source:"worktree"|"index"};
export type ChangeSection="tracked"|"untracked";
type Directory={name:string;path:string;folders:Map<string,Directory>;files:SourceControlChange[];contents:SourceControlChange[]};

export const staged=(file:SourceControlChange):boolean=>!file.conflict&&![".","?"].includes(file.indexStatus);
export const unstaged=(file:SourceControlChange):boolean=>!file.conflict&&(file.untracked||file.worktreeStatus!==".");
export const canSelectChange=(file:SourceControlChange):boolean=>!file.conflict&&!file.directory;

export function FileCheckbox({mixed=false,...props}:{mixed?:boolean;checked:boolean;disabled?:boolean;label:string;onChange:(checked:boolean)=>void}):JSX.Element {
  const ref=useRef<HTMLInputElement>(null);
  useLayoutEffect(()=>{if(ref.current)ref.current.indeterminate=mixed;},[mixed]);
  return <input ref={ref} className="scm-file-checkbox" type="checkbox" aria-label={props.label} aria-checked={mixed?"mixed":props.checked} checked={props.checked} disabled={props.disabled} onChange={event=>props.onChange(event.currentTarget.checked)}/>;
}

function buildFolders(files:SourceControlChange[]):Directory {
  const root:Directory={name:"",path:"",folders:new Map(),files:[],contents:[]};
  for(const file of files){
    let directory=root;
    for(const name of file.path.split(/[\\/]/u).slice(0,-1)){
      let child=directory.folders.get(name);
      if(!child){
        child={name,path:directory.path?directory.path+"/"+name:name,folders:new Map(),files:[],contents:[]};
        directory.folders.set(name,child);
      }
      directory=child;
      directory.contents.push(file);
    }
    directory.files.push(file);
  }
  return root;
}

export function SourceControlChangeList({groups,tree,revealMatches,selection,disabled,checkedPaths,editing,zh,summary,summaryDetails,children,onToggle,onSelect,onCheck,onStage}:{
  groups:{id:ChangeSection;files:SourceControlChange[];open:boolean}[];tree:boolean;revealMatches:boolean;selection?:Selection;
  disabled:boolean;checkedPaths:ReadonlySet<string>;editing:boolean;zh:boolean;summary:string;summaryDetails:string;children?:ReactNode;
  onToggle:(id:ChangeSection,open:boolean)=>void;
  onSelect:(selection:Selection)=>void;onCheck:(paths:readonly string[],checked:boolean)=>void;
  onStage:(paths:string[],stage:boolean)=>void;
}):JSX.Element{
  const [collapsed,setCollapsed]=useState<Set<string>>(()=>new Set());
  const listId=useId();
  const folderKeys:string[]=[];
  const toggle=(key:string):void=>setCollapsed(previous=>{
    const next=new Set(previous);
    if(next.has(key))next.delete(key);else next.add(key);
    return next;
  });
  const sections=groups.filter(group=>group.files.length>0).map(group=>{
    const rows:Array<{key:string;size:number;render:()=>JSX.Element}>=[];
    const label=group.id==="tracked"?(zh?"已跟踪变更":"Tracked changes"):(zh?"未追踪文件":"Untracked files");
    const paths=group.files.filter(canSelectChange).map(file=>file.path);
    const checkedCount=paths.filter(path=>checkedPaths.has(path)).length;
    const open=revealMatches||group.open;
    const bodyId=`${listId}-${group.id}`;

    const addFile=(file:SourceControlChange,depth=0):void=>{
      const source=staged(file)&&!unstaged(file)?"index":"worktree";
      const status=file.conflict?"!":file.untracked?"U":source==="index"?file.indexStatus:file.worktreeStatus;
      const selected=selection?.path===file.path;
      rows.push({key:`file:${file.path}`,size:tree?32:48,render:()=> <div className="scm-file-row" data-selected={selected} data-tree={tree||undefined} data-nested={depth>0||undefined} data-status={status} style={tree?{"--scm-indent":`${9+Math.min(depth,5)*12}px`} as CSSProperties:undefined}>
        <FileCheckbox label={`${zh?"选择提交文件":"Include file in commit"} ${file.path}`} checked={checkedPaths.has(file.path)} disabled={disabled||!canSelectChange(file)} onChange={checked=>onCheck([file.path],checked)}/>
        <button type="button" data-list-action className="scm-file-select" aria-label={`${zh?"查看文件差异":"View file diff"} ${file.path}`} aria-pressed={selected} disabled={editing} onFocus={()=>{if(!selected)onSelect({path:file.path,source});}} onClick={()=>{if(!selected)onSelect({path:file.path,source});}}>
          <SourceControlFileIcon path={file.path}/><SourceControlFileName path={file.path} originalPath={file.originalPath}/>
          <span className="scm-file-status scm-status-badge" data-state={file.conflict?"conflict":status}>{status}</span>
        </button>
      </div>});
    };

    const addFolder=(folder:Directory,depth:number,visible:boolean):void=>{
      let end=folder;
      const names=[folder.name];
      while(!end.files.length&&end.folders.size===1){
        end=end.folders.values().next().value!;
        names.push(end.name);
      }
      const key=`${group.id}:folder:${end.path}`;
      folderKeys.push(key);
      const expanded=revealMatches||!collapsed.has(key);
      if(visible)rows.push({key,size:34,render:()=>{
        const eligible=end.contents.filter(canSelectChange);
        const filePaths=eligible.map(file=>file.path);
        const stagedPaths=eligible.filter(staged).map(file=>file.path);
        const unstagedPaths=eligible.filter(unstaged).map(file=>file.path);
        const count=filePaths.filter(path=>checkedPaths.has(path)).length;
        return <div className="scm-folder-row" data-nested={depth>0||undefined} style={{"--scm-indent":`${9+Math.min(depth,5)*12}px`} as CSSProperties}>
          <FileCheckbox label={`${zh?"选择目录":"Select folder"} ${end.path}`} checked={!!filePaths.length&&count===filePaths.length} mixed={count>0&&count<filePaths.length} disabled={disabled||!filePaths.length} onChange={checked=>onCheck(filePaths,checked)}/>
          <button type="button" className="scm-folder-toggle" data-list-action aria-expanded={expanded} aria-disabled={revealMatches} aria-label={end.path} onClick={()=>{if(!revealMatches)toggle(key);}} title={end.path}>
            <ChevronDown size={12} aria-hidden/>{expanded?<FolderOpen size={15} aria-hidden/>:<Folder size={15} aria-hidden/>}
            <span className="scm-folder-name">{names.map((name,index)=><span key={index}>{index>0&&<i>/</i>}{name}</span>)}</span>
          </button>
          <span className="scm-group-count">{end.contents.length}</span>
          <div className="scm-folder-actions">
            {!!unstagedPaths.length&&<button type="button" disabled={disabled} aria-label={`${zh?"暂存目录":"Stage folder"} ${end.path}`} title={zh?"暂存目录":"Stage folder"} onClick={()=>onStage(unstagedPaths,true)}><Plus size={13} aria-hidden/></button>}
            {!!stagedPaths.length&&<button type="button" disabled={disabled} aria-label={`${zh?"取消暂存目录":"Unstage folder"} ${end.path}`} title={zh?"取消暂存目录":"Unstage folder"} onClick={()=>onStage(stagedPaths,false)}><Minus size={13} aria-hidden/></button>}
          </div>
        </div>;
      }});
      for(const child of end.folders.values())addFolder(child,depth+1,visible&&expanded);
      if(visible&&expanded)for(const file of end.files)addFile(file,depth+1);
    };

    if(tree){
      const root=buildFolders(group.files);
      for(const folder of root.folders.values())addFolder(folder,0,true);
      for(const file of root.files)addFile(file);
    }else{
      for(const file of group.files)addFile(file);
    }
    return <section key={group.id} className="scm-change-section" data-group={group.id} aria-label={label}>
      <div className="scm-group-heading">
        <FileCheckbox label={zh?`选择${label}`:`Select ${label}`} checked={paths.length>0&&checkedCount===paths.length} mixed={checkedCount>0&&checkedCount<paths.length} disabled={disabled||!paths.length} onChange={checked=>onCheck(paths,checked)}/>
        <button type="button" aria-expanded={open} aria-controls={bodyId} aria-disabled={revealMatches} onClick={()=>{if(!revealMatches)onToggle(group.id,!open);}}>
          <ChevronDown size={14} aria-hidden/><span>{label}</span><span className="scm-group-count">{group.files.length}</span>
        </button>
        {checkedCount>0&&<span className="scm-group-selected">{zh?`已选 ${checkedCount}`:`${checkedCount} selected`}</span>}
      </div>
      <div id={bodyId} className="scm-change-section-body" data-open={open} aria-hidden={!open} ref={node=>{if(node)node.inert=!open;}}>
        <VirtualList rows={rows} className="scm-change-groups" label={label} keyboard/>
      </div>
    </section>;
  });
  const allFoldersOpen=folderKeys.every(key=>!collapsed.has(key));
  const allFoldersClosed=folderKeys.every(key=>collapsed.has(key));
  const expandLabel=zh?"展开全部目录":"Expand all folders";
  const collapseLabel=zh?"折叠全部目录":"Collapse all folders";
  return <>
    <div className="scm-list-heading" data-changes>
      <span title={summaryDetails}>{summary}</span>
      {tree&&<div className="scm-tree-actions">
        <button type="button" aria-label={expandLabel} title={expandLabel} disabled={revealMatches||allFoldersOpen} onClick={()=>setCollapsed(previous=>{const next=new Set(previous);for(const key of folderKeys)next.delete(key);return next;})}><UnfoldVertical size={14} aria-hidden/></button>
        <button type="button" aria-label={collapseLabel} title={collapseLabel} disabled={revealMatches||allFoldersClosed} onClick={()=>setCollapsed(previous=>new Set([...previous,...folderKeys]))}><FoldVertical size={14} aria-hidden/></button>
      </div>}
    </div>
    <div className="scm-file-list" aria-label={zh?"更改文件":"Changed files"}>{sections}{children}</div>
  </>;
}
