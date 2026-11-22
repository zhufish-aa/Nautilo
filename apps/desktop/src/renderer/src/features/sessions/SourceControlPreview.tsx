import {lazy,Suspense,useCallback,useEffect,useMemo,useRef,useState,type ReactNode} from "react";
import {ArrowDown,ArrowUp,Atom,Braces,Cog,Expand,FileCode2,FileDiff,FileImage,FileJson,FileText,ListChecks,Loader2,Minimize2,Shield} from "lucide-react";
import type {DiffReviewNavigation,DiffReviewPosition} from "../../components/ui/DiffCodeEditor";
import type {SourceControlDiff} from "@agenthub/schemas";
import {ResizeHandle,useRememberedWidth} from "../../components/ui/ResizeHandle";
import {SourceControlDiffView} from "./SourceControlDiffView";

let previewModule:Promise<typeof import("./SourceControlNativePreview")>|undefined;
export const loadNativeDiff=()=>previewModule??=(import("./SourceControlNativePreview").catch(error=>{previewModule=undefined;throw error;}));
const NativeDiff=lazy(loadNativeDiff);
const CodeDiff=lazy(()=>import("../../components/ui/DiffCodeEditor"));

function sourceControlPath(path:string):{ name:string; directory:string }{
  const parts=path.split(/[\\/]/u);
  const name=parts.pop()??"";
  return {name,directory:`${parts.length>2?"…/":""}${parts.slice(-2).join("/")}`};
}
export function SourceControlSplit({sidebar,children,dock,zh,history=false}:{sidebar:ReactNode;children:ReactNode;dock?:ReactNode;zh:boolean;history?:boolean}):JSX.Element{
  const ref=useRef<HTMLDivElement>(null),[available,setAvailable]=useState(900);
  const max=Math.max(180,Math.min(480,available-304)),width=useRememberedWidth("nautilo.scm.files.width",280,180,max);
  useEffect(()=>{const element=ref.current;if(!element)return;const measure=():void=>{if(element.clientWidth)setAvailable(element.clientWidth);};measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();},[]);
  return <div ref={ref} className="scm-split" data-history={history||undefined}>
    <div className="scm-file-sidebar" style={{width:width.width}}>{sidebar}<ResizeHandle label={zh?"调整文件列表宽度":"Resize file list"} value={width.width} min={180} max={max} onChange={width.resize} onCommit={width.save} reset={280}/></div>
    <div className="scm-review-canvas"><div className="scm-diff-panel">{children}</div>{dock}</div>
  </div>;
}
type PreviewProps={
  diff?:SourceControlDiff;loading?:boolean;error?:string;zh:boolean;locale:string;disabled?:boolean;
  path?:string;pendingPath?:string;headerActions?:ReactNode;fileToggle?:ReactNode;
  onApply?:(selection:{hunkIds?:string[];lines?:number[]})=>void;
};
export function SourceControlPreview({diff,loading,error,zh,locale,disabled,onApply,path,pendingPath,headerActions,fileToggle}:PreviewProps):JSX.Element{
  const [lineSelectionFor,setLineSelectionFor]=useState<string>();
  const [context,setContext]=useState(()=>localStorage.getItem("nautilo.scm.diff.context")==="full");
  const navigation=useRef<DiffReviewNavigation|null>(null),[position,setPosition]=useState<DiffReviewPosition>({index:0,count:0});
  const [layout,setLayout]=useState<"auto"|"split"|"unified">(()=>{try{const value=localStorage.getItem("nautilo.scm.diff.layout");if(value==="split"||value==="unified")return value;}catch{/* Use available width. */}return "auto";});
  const codeSurface=useRef<HTMLDivElement>(null),[widePreview,setWidePreview]=useState(false);
  const identity=diff?`${diff.rootPath}:${diff.path}:${diff.source}:${diff.commitHash??""}`:"";
  const [fallbackFor,setFallbackFor]=useState<string>();
  const fallback=useCallback(()=>setFallbackFor(identity),[identity]);
  const view=lineSelectionFor===identity?"lines":"code";
  useEffect(()=>{
    setLineSelectionFor(current=>current===identity?current:undefined);
    setPosition({index:0,count:0});
  },[identity]);
  const textReady=typeof diff?.before==="string"&&typeof diff.after==="string";
  useEffect(()=>{
    const element=codeSurface.current;
    if(!element||layout!=="auto")return;
    const measure=():void=>setWidePreview(element.clientWidth>=760);
    measure();
    const observer=new ResizeObserver(measure);
    observer.observe(element);
    return()=>observer.disconnect();
  },[textReady,view,layout]);
  const sideBySide=layout==="split"||layout==="auto"&&widePreview;
  const volume=useMemo(()=>{
    if(!diff||diff.binary||diff.truncated)return;
    let additions=0,deletions=0,inHunk=false;
    for(const line of diff.patch.split("\n")){
      if(line.startsWith("diff --git "))inHunk=false;
      if(line.startsWith("@@ "))inHunk=true;
      if(inHunk&&line[0]==="+")additions++;
      if(inHunk&&line[0]==="-")deletions++;
    }
    const total=additions+deletions;
    if(total)return {additions,deletions,blocks:Math.round(5*additions/total)};
  },[diff]);
  const chooseLayout=(value:"split"|"unified"):void=>{setLayout(value);try{localStorage.setItem("nautilo.scm.diff.layout",value);}catch{/* Keep the current choice. */}};
  const partial=diff?.source!=="commit"&&!!diff?.patchToken&&!!diff?.hunks?.length&&!!onApply;
  const sourceLabel=diff?.source==="commit"?(zh?"提交中的更改":"Changes in this commit"):diff?.source==="index"?(zh?"暂存区的更改":"Staged changes"):(zh?"工作区的更改":"Working tree changes");
  const previewPath=path??diff?.path??"";
  const {name,directory}=sourceControlPath(previewPath);
  const directoryEnd=directory.lastIndexOf("/")+1;
  const lineAction=view==="lines"?(zh?"返回代码":"Back to code"):(zh?"按行选择":"Select lines");
  const contextLabel=context?(zh?"折叠未修改代码":"Collapse unchanged"):(zh?"展开完整文件":"Show full file");
  const toolbar=<div className="scm-preview-toolbar">
    <div className="scm-preview-heading">
      {fileToggle}
      <div className="scm-preview-file" title={`${previewPath}\n${sourceLabel}`}><SourceControlFileIcon path={previewPath}/>{directory&&<span className="scm-preview-directory"><span>{directory.slice(0,directoryEnd)}</span><span>{directory.slice(directoryEnd)}<span aria-hidden> /</span></span></span>}<strong>{name}</strong>{loading&&<Loader2 size={12} className="animate-spin"/>}</div>
      {volume&&<div className="scm-diff-volume" title={zh?`新增 ${volume.additions} 行，删除 ${volume.deletions} 行`:`${volume.additions} additions, ${volume.deletions} deletions`}>
        <span>+{volume.additions}</span><span>−{volume.deletions}</span>
        <span aria-hidden className="scm-volume-bars">{Array.from({length:5},(_,index)=><i key={index} data-add={index<volume.blocks||undefined}/>)}</span>
      </div>}
    </div>
      <div className="scm-preview-actions">{textReady&&view==="code"&&<div className="scm-segment" aria-label={zh?"差异显示方式":"Diff layout"}><button type="button" aria-pressed={sideBySide} onClick={()=>chooseLayout("split")}>{zh?"并排":"Split"}</button><button type="button" aria-pressed={!sideBySide} onClick={()=>chooseLayout("unified")}>{zh?"统一":"Unified"}</button></div>}
        {partial&&<button type="button" className="scm-text-action scm-line-toggle" title={lineAction} aria-pressed={view==="lines"} onClick={()=>setLineSelectionFor(view==="code"?identity:undefined)}><ListChecks size={13} aria-hidden/><span>{lineAction}</span></button>}
        {textReady&&view==="code"&&<div className="scm-preview-tools">
          <button type="button" className="workspace-panel-icon" disabled={!position.count} title={zh?"上一处更改":"Previous change"} aria-label={zh?"上一处更改":"Previous change"} onClick={()=>navigation.current?.move(-1)}><ArrowUp size={13}/></button>
          <span className="scm-change-position">{position.count?`${position.index}/${position.count}`:"0/0"}</span>
          <button type="button" className="workspace-panel-icon" disabled={!position.count} title={zh?"下一处更改":"Next change"} aria-label={zh?"下一处更改":"Next change"} onClick={()=>navigation.current?.move(1)}><ArrowDown size={13}/></button>
          <button type="button" className="workspace-panel-icon" aria-pressed={context} aria-label={contextLabel} title={contextLabel} onClick={()=>setContext(previous=>{try{localStorage.setItem("nautilo.scm.diff.context",previous?"changes":"full");}catch{/* Keep the current preference. */}return !previous;})}>{context?<Minimize2 size={14}/>:<Expand size={14}/>}</button>
        </div>}
        {pendingPath&&<span role="status" className="scm-pending-file" title={pendingPath}>{zh?"正在打开":"Opening"} {pendingPath.split("/").at(-1)}</span>}{headerActions}
      </div>
    </div>;
  if(error&&!diff)return <>{path&&toolbar}<div role="alert" className="scm-error">{error}</div></>;
  if(!diff)return <>{path&&toolbar}<div className="scm-empty" role={loading?"status":undefined}>{loading?<Loader2 size={20} className="animate-spin"/>:<FileDiff size={26}/>}<p>{loading?(zh?"正在读取差异":"Loading diff"):(zh?"选择文件查看更改":"Select a file to view changes")}</p></div></>;
  const reason=diff.previewReason;
  return <>{toolbar}{error&&<div role="alert" className="scm-error">{error}</div>}<span className="scm-diff-source sr-only">{sourceLabel}</span>
    {diff.binary||reason==="binary"?<div className="scm-empty"><FileDiff size={26}/><p>{zh?"二进制文件已更改":"Binary file changed"}</p><span>{zh?"可通过文件前的复选框选择提交。":"Use the file checkbox to include it in your commit."}</span></div>:
      reason==="directory"?<div className="scm-empty"><p>{zh?"未跟踪的目录或嵌套仓库":"Untracked directory or nested repository"}</p></div>:
      reason==="encoding"?<div className="scm-empty"><p>{zh?"此文件使用其他文本编码":"This file uses another text encoding"}</p><span>{zh?"请在原编辑器中查看；文件仍可选择提交。":"View it in its original editor. It can still be selected for commit."}</span></div>:
      reason==="large"?<div className="scm-empty"><p>{zh?"文件较大，已停止加载完整代码":"File is too large for a full code preview"}</p><span>{zh?"文件仍可选择提交，完整内容保留在本地。":"The local file is unchanged and can still be selected for commit."}</span></div>:
      textReady&&view==="code"?<div ref={codeSurface} className="scm-code-preview" aria-label={zh?"代码差异":"Code diff"}>
        {sideBySide&&<div className="scm-code-labels"><span>{diff.source==="commit"?(zh?"提交前":"Before commit"):diff.source==="index"?(zh?"上次提交":"Last commit"):(zh?"对比版本":"Base version")}</span><span>{diff.source==="commit"?(zh?"此次提交":"This commit"):diff.source==="index"?(zh?"暂存区":"Index"):(zh?"工作目录":"Working copy")}</span></div>}
        <Suspense fallback={<div className="scm-empty" role="status"><Loader2 size={18} className="animate-spin"/>{zh?"正在加载代码视图":"Loading code view"}</div>}>
          {fallbackFor===identity?<CodeDiff modelKey={identity} before={diff.before} value={diff.after!} filePath={diff.path} readOnly sideBySide={sideBySide} hideUnchanged={!context} appearance="source-control" navigationRef={navigation} onReviewPosition={setPosition}/>
            :<NativeDiff key={identity} before={diff.before!} value={diff.after!} filePath={diff.path} sideBySide={sideBySide} hideUnchanged={!context} zh={zh} navigationRef={navigation} onReviewPosition={setPosition} onFallback={fallback}/>}
        </Suspense>
      </div>:<>{diff.truncated&&<div className="scm-operation">{zh?"差异较大，仅显示前一部分。":"Large diff. Only the first part is shown."}</div>}<SourceControlDiffView patch={diff.patch|| (zh?"没有文本差异（文件模式或子模块状态已改变）":"No textual diff (file mode or submodule state changed)")} scope={identity} hunks={view==="lines"?diff.hunks:[]} patchToken={view==="lines"?diff.patchToken:undefined} source={diff.source==="index"?"index":"worktree"} disabled={disabled||loading} locale={locale} onApply={onApply}/></>}
  </>;
}
export function SourceControlFileName({path,originalPath}:{path:string;originalPath?:string}):JSX.Element{
  const {name,directory}=sourceControlPath(path);
  return <span className="scm-file-label" title={originalPath?`${originalPath} → ${path}`:path}><span className="scm-file-name">{name}</span>{directory&&<span className="scm-file-directory">{directory}</span>}</span>;
}
export function SourceControlFileIcon({path}:{path:string}):JSX.Element{
  const extension=path.split(".").at(-1)?.toLowerCase();let kind="code",icon=<FileCode2 size={16}/>;
  if(extension==="tsx"||extension==="jsx"){kind="react";icon=<Atom size={16}/>;}
  else if(extension==="rs"){kind="rust";icon=<><Cog size={16}/><b>R</b></>;}
  else if(extension==="css"||extension==="scss"){kind="css";icon=<><Shield size={16}/><b>3</b></>;}
  else if(extension==="json"){kind="json";icon=<FileJson size={16}/>;}
  else if(["js","ts","mjs","mts"].includes(extension??"")){kind="script";icon=<Braces size={16}/>;}
  else if(["png","jpg","jpeg","gif","svg","webp","ico"].includes(extension??"")){kind="image";icon=<FileImage size={16}/>;}
  else if(["md","txt","toml","yaml","yml"].includes(extension??"")){kind="text";icon=<FileText size={16}/>;}
  return <span className="scm-language-icon" data-kind={kind} aria-hidden>{icon}</span>;
}
