import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from "react";
import {ArrowDown,ArrowUp,Check,ExternalLink,GitBranch,GitCommitHorizontal,GitPullRequest,History,Loader2,MoreHorizontal,RefreshCw,RotateCcw,Search,SquarePen} from "lucide-react";
import type {SourceControlChange,SourceControlDiff,SourceControlMutation,SourceControlRepository,SourceControlScope,SourceControlStatus} from "@agenthub/schemas";
import {requestCore} from "../../lib/bridge";
import {useCoreFeatures} from "../../lib/use-core-features";
import {useI18n} from "../../lib/i18n";
import {Button} from "../../components/ui/Button";
import {Dialog} from "../../components/ui/Dialog";
import {SelectField} from "../../components/ui/Select";
import {useFilePreviewStore} from "../../stores/file-preview";
import {useProjectsStore} from "../../stores/projects";
import {WorkspaceDrawer} from "./WorkspaceDrawer";
import {SourceControlFileIcon,SourceControlFileName,SourceControlPreview,SourceControlSplit} from "./SourceControlPreview";
import {SourceControlHistory} from "./SourceControlHistory";
import {SourceControlEditor} from "./SourceControlEditor";
import {flushSourceDrafts,sourceDrafts} from "./source-control-editor-drafts";
import {sourceControlClient} from "./source-control-client";
import {SourceControlChangeList} from "./SourceControlChangeList";
import "./source-control.css";

type Selection={path:string;source:"worktree"|"index"};
type TransferView = {
  tab?:"changes"|"history"; query?:string; selection?:Selection; editingTarget?:{rootPath:string;path:string};
  history?:{hash?:string;path?:string;search?:string};
};
const staged=(file:SourceControlChange):boolean=>!file.conflict&&![".","?"].includes(file.indexStatus);
const unstaged=(file:SourceControlChange):boolean=>!file.conflict&&(file.untracked||file.worktreeStatus!==".");
const draftKey=(root:string)=>`nautilo.scm.commit.${encodeURIComponent(root)}`;
function FileCheckbox({mixed=false,...props}:{mixed?:boolean;checked:boolean;disabled?:boolean;label:string;onChange:(checked:boolean)=>void}):JSX.Element{
  const ref=useRef<HTMLInputElement>(null);useLayoutEffect(()=>{if(ref.current)ref.current.indeterminate=mixed;},[mixed]);
  return <input ref={ref} className="scm-file-checkbox" type="checkbox" aria-label={props.label} aria-checked={mixed?"mixed":props.checked} checked={props.checked} disabled={props.disabled} onChange={event=>props.onChange(event.currentTarget.checked)}/>;
}
export function SourceControlDrawer({open,onClose,...scope}:SourceControlScope&{open:boolean;onClose:()=>void}):JSX.Element|null{
  return open?<SourceControlWorkspace key={scope.sessionId??scope.projectId} onClose={onClose} scope={scope}/>:null;
}
function SourceControlWorkspace({scope,onClose}:{scope:SourceControlScope;onClose:()=>void}):JSX.Element{
  const {locale}=useI18n(),zh=locale==="zh-CN",features=useCoreFeatures(),paneId=useId();
  const transferKey="nautilo.scm.transfer."+JSON.stringify([scope.sessionId,scope.projectId]);
  const [initial]=useState<TransferView>(()=>{try{return JSON.parse(localStorage.getItem(transferKey)??"{}")??{};}catch{return {};}});
  const historyFocus=useRef(initial.history);
  useEffect(()=>{localStorage.removeItem(transferKey);},[transferKey]);
  const [status,setStatus]=useState<SourceControlStatus|undefined>(()=>sourceControlClient.peekStatus(scope)),[error,setError]=useState(""),[loadError,setLoadError]=useState(""),[loading,setLoading]=useState(()=>!sourceControlClient.peekStatus(scope)),[refreshing,setRefreshing]=useState(false);
  const [busy,setBusy]=useState<SourceControlMutation["action"]>(),busyRef=useRef(false),inFlight=useRef(false),disposed=useRef(false),epoch=useRef(0);
  const [selection,setSelection]=useState<Selection|undefined>(initial.selection),[loadedDiff,setDiff]=useState<SourceControlDiff>(),[diffError,setDiffError]=useState(""),[diffLoading,setDiffLoading]=useState(false);
  const [message,setMessage]=useState(""),[draftRoot,setDraftRoot]=useState<string>(),[tab,setTab]=useState<"changes"|"history">(initial.tab??"changes"),[query,setQuery]=useState(initial.query??"");
  const messageRef=useRef(message);messageRef.current=message;
  const [createBranch,setCreateBranch]=useState(false),[branchName,setBranchName]=useState(""),[remote,setRemote]=useState(""),[pushRemote,setPushRemote]=useState(""),remoteScope=useRef<string>();
  const [notice,setNotice]=useState(""),[discard,setDiscard]=useState<{path:string;fileToken:string;token:string}>();
  const commitInput=useRef<HTMLTextAreaElement>(null);
  const [editingTarget,setEditingTarget]=useState<TransferView["editingTarget"]>(initial.editingTarget),[editorSaving,setEditorSaving]=useState(false),editorBusy=useRef(false);
  const stageQueue=useRef<Array<{paths:string[];include:boolean}>>([]),stagePending=useRef(new Map<string,boolean>()),stageRunning=useRef(false);
  const [pendingPaths,setPendingPaths]=useState<ReadonlyMap<string,boolean>>(()=>new Map());
  const locked=!!busy||editorSaving||pendingPaths.size>0;
  const stagingLocked=editorSaving||!!busy&&!['stage','unstage'].includes(busy);
  const menu=useRef<HTMLDetailsElement>(null),openPreview=useFilePreviewStore(state=>state.open);
  const repository=status?.available?status:undefined,current=useRef(repository);current.current=repository;
  const refresh=useCallback(async(force=false,visible=false):Promise<void>=>{
    if(inFlight.current&&!force||disposed.current)return;const expected=epoch.current;inFlight.current=true;
    if(visible)setRefreshing(true);
    try{const result=await sourceControlClient.status(scope);if(!disposed.current&&expected===epoch.current){setStatus(result);setLoadError("");}}
    catch(error){if(!disposed.current&&expected===epoch.current)setLoadError(String(error));}
    finally{inFlight.current=false;if(!disposed.current){setLoading(false);if(visible)setRefreshing(false);}}
  },[scope.sessionId,scope.projectId]);
  useEffect(()=>{
    disposed.current=false;let timer:number|undefined,active=true;
    const poll=async():Promise<void>=>{if(!active)return;if(!document.hidden&&document.hasFocus()&&!busyRef.current&&!editorBusy.current)await refresh();if(active)timer=window.setTimeout(()=>{void poll();},3500);};
    void refresh().finally(()=>{if(active)timer=window.setTimeout(()=>{void poll();},3500);});
    const focus=():void=>{if(!document.hidden&&!busyRef.current&&!editorBusy.current)void refresh();};window.addEventListener("focus",focus);document.addEventListener("visibilitychange",focus);
    return()=>{active=false;disposed.current=true;window.clearTimeout(timer);window.removeEventListener("focus",focus);document.removeEventListener("visibilitychange",focus);};
  },[refresh]);
  useEffect(()=>{if(!notice)return;const timer=window.setTimeout(()=>setNotice(""),4000);return()=>window.clearTimeout(timer);},[notice]);
  useEffect(()=>{
    if(!repository)return;
    if(draftRoot!==repository.rootPath){setDraftRoot(repository.rootPath);try{setMessage(window.localStorage.getItem(draftKey(repository.rootPath))??"");}catch{setMessage("");}}
    const choices=repository.upstreamRemote==="."||repository.pushRemote==="."?[".",...repository.remotes]:repository.remotes;
    const preferred=repository.upstreamRemote&&choices.includes(repository.upstreamRemote)?repository.upstreamRemote:choices.includes("origin")?"origin":choices[0]??"";
    const preferredPush=repository.pushRemote&&choices.includes(repository.pushRemote)?repository.pushRemote:preferred;
    const scopeKey=JSON.stringify([repository.rootPath,repository.branch,repository.upstreamRemote,repository.pushRemote]);
    if(remoteScope.current!==scopeKey){remoteScope.current=scopeKey;setRemote(preferred);setPushRemote(preferredPush);}else{setRemote(previous=>choices.includes(previous)?previous:preferred);setPushRemote(previous=>choices.includes(previous)?previous:preferredPush);}
    setSelection(previous=>{
      if(editingTarget?.rootPath===repository.rootPath)return previous?.path===editingTarget.path?previous:{path:editingTarget.path,source:"worktree"};
      const file=repository.changes.find(file=>file.path===previous?.path)??repository.changes.find(file=>file.conflict)??repository.changes[0];if(!file)return undefined;
      const source=previous?.path===file.path&&previous.source==="index"&&staged(file)?"index":unstaged(file)||file.conflict?"worktree":"index";
      return previous?.path===file.path&&previous.source===source?previous:{path:file.path,source};
    });
  },[repository]);
  useEffect(()=>{if(!draftRoot||draftRoot!==repository?.rootPath)return;try{window.localStorage.setItem(draftKey(draftRoot),message);}catch{/* Keep the current draft. */}},[message,draftRoot]);
  useEffect(()=>{
    if(!selection||!repository||tab!=="changes"||editingTarget?.rootPath===repository.rootPath||!repository.changes.some(file=>file.path===selection.path)){setDiff(undefined);setDiffError("");setDiffLoading(false);return;}let cancelled=false;
    const cached=sourceControlClient.peekDiff(scope,repository,selection);if(cached)setDiff(cached);setDiffLoading(!cached);setDiffError("");
    void sourceControlClient.diff(scope,repository,selection).then(value=>{if(!cancelled)setDiff(value);}).catch(error=>{if(!cancelled)setDiffError(String(error));}).finally(()=>{if(!cancelled)setDiffLoading(false);});return()=>{cancelled=true;};
  },[scope.sessionId,scope.projectId,selection?.path,selection?.source,repository?.rootPath,repository?.token,tab,editingTarget?.rootPath,editingTarget?.path]);
  const mutate=async(action:SourceControlMutation["action"],extra:Partial<SourceControlMutation>={}):Promise<SourceControlRepository|undefined>=>{
    if(!current.current&&action!=="init"||busyRef.current||editorBusy.current)return;epoch.current++;busyRef.current=true;setBusy(action);setError("");setNotice("");if(menu.current)menu.current.open=false;
    try{
      const result=await requestCore<{status:SourceControlRepository;output?:string}>("scm.mutate",{...scope,action,token:current.current?.token??"",...extra});sourceControlClient.rememberStatus(scope,result.status);current.current=result.status;
      if(action==="commit"){try{const key=draftKey(result.status.rootPath);if(window.localStorage.getItem(key)===extra.message)window.localStorage.removeItem(key);}catch{/* Keep an unsubmitted draft. */}}
      if(disposed.current)return result.status;setStatus(result.status);
      if(action==="commit"){if(messageRef.current===extra.message)setMessage("");setNotice(zh?"所选更改已提交":"Selected changes committed");}
      else if(action==="create-branch"){setCreateBranch(false);setBranchName("");setNotice(zh?"已创建并切换分支":"Branch created and checked out");}
      else if(action==="push")setNotice(zh?"已推送当前分支":"Current branch pushed");else if(action==="pull")setNotice(zh?"已拉取更新":"Updates pulled");else if(action==="fetch")setNotice(zh?"远程状态已更新":"Remote state refreshed");
      if(action==="discard")setDiscard(undefined);if(action==="init"&&scope.projectId)void useProjectsStore.getState().rescanProject(scope.projectId).catch(()=>{});
      window.dispatchEvent(new Event("nautilo:source-control-changed"));
      return result.status;
    }catch(error){if(!disposed.current){const text=String(error);await refresh(true);if(!disposed.current)setError(text);}}
    finally{busyRef.current=false;if(!disposed.current)setBusy(undefined);}
  };
  const stageFiles=async(paths:string[],include:boolean):Promise<void>=>{
    if(editorBusy.current||busyRef.current&&!stageRunning.current)return;
    const next=paths.filter(path=>!stagePending.current.has(path));if(!next.length)return;
    for(const path of next)stagePending.current.set(path,include);
    setPendingPaths(new Map(stagePending.current));stageQueue.current.push({paths:next,include});
    if(stageRunning.current)return;stageRunning.current=true;
    try{
      while(stageQueue.current.length){
        const job=stageQueue.current.shift()!;
        const result=await mutate(job.include?'stage':'unstage',{paths:job.paths});
        for(const path of job.paths)stagePending.current.delete(path);
        if(!result){stageQueue.current=[];stagePending.current.clear();}
        if(!disposed.current)setPendingPaths(new Map(stagePending.current));
      }
    }finally{stageRunning.current=false;}
  };
  const selectedFile=repository?.changes.find(file=>file.path===selection?.path);
  const diff=(repository&&selection?sourceControlClient.peekDiff(scope,repository,selection):undefined)??(loadedDiff&&loadedDiff.path===selection?.path&&loadedDiff.source===selection?.source&&(!loadedDiff.rootPath||loadedDiff.rootPath===repository?.rootPath)?loadedDiff:undefined);
  const stagedFiles=repository?.changes.filter(staged)??[],conflicts=repository?.changes.filter(file=>file.conflict)??[];
  const selectable=repository?.changes.filter(file=>!file.conflict)??[],allChecked=selectable.length>0&&selectable.every(file=>staged(file)&&!unstaged(file));
  const canCommit=(stagedFiles.length>0||repository?.operation==="merge")&&conflicts.length===0&&(!repository?.operation||repository.operation==="merge")&&!!message.trim();
  const operationName=repository?.operation?({merge:zh?"合并":"Merge",rebase:zh?"变基":"Rebase","cherry-pick":zh?"拣选提交":"Cherry-pick",revert:zh?"还原提交":"Revert"})[repository.operation]:"";
  const operationHint=repository?.operation==="merge"&&conflicts.length===0?(zh?"合并已就绪，提交以完成合并。":"Merge ready. Commit to finish the merge."):conflicts.length>0?(zh?`${operationName}进行中，请处理 ${conflicts.length} 个冲突文件。`:`${operationName} in progress. Resolve ${conflicts.length} conflicted files.`):(zh?`${operationName}进行中，请在终端继续或完成当前步骤。`:`${operationName} in progress. Continue the operation in the terminal.`);
  const remoteChoices=repository&&(repository.upstreamRemote==="."||repository.pushRemote===".")?[".",...repository.remotes]:repository?.remotes??[];
  const filtered=repository?.changes.filter(file=>file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()))??[];
  const groups=[
    {id:"conflicts",label:zh?"冲突":"Conflicts",source:"worktree" as const,files:filtered.filter(file=>file.conflict)},
    {id:"worktree",label:zh?"工作区":"Working tree",source:"worktree" as const,files:filtered.filter(file=>!file.conflict&&!file.untracked&&unstaged(file))},
    {id:"untracked",label:zh?"未跟踪":"Untracked",source:"worktree" as const,files:filtered.filter(file=>file.untracked)},
    {id:"index",label:zh?"已暂存":"Staged",source:"index" as const,files:filtered.filter(staged)}
  ];
  const retainedDrafts=repository?sourceDrafts(repository.rootPath).filter(draft=>!repository.changes.some(file=>file.path===draft.path)&&draft.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())):[];
  const submit=():void=>{if(canCommit&&!busy)void mutate("commit",{message});};
  const commitAndPush=async():Promise<void>=>{if(!canCommit||locked||!pushRemote)return;const committed=await mutate("commit",{message});if(committed)await mutate("push",{remote:pushRemote});};
  const prepareMove=()=>{
    if(!flushSourceDrafts())throw Error(zh?"文件草稿暂时无法保存，可以先复制或保存再移动窗口。":"File draft could not be saved before moving this window.");
    if(draftRoot)localStorage.setItem(draftKey(draftRoot),message);
    localStorage.setItem(transferKey,JSON.stringify({tab,query,selection,editingTarget,history:historyFocus.current}));
  };
  return <WorkspaceDrawer open nativePanel={{kind:"source-control",...scope}} beforeMove={prepareMove} moveDisabled={locked} onClose={()=>{if(!editorBusy.current)onClose();}} title={zh?"源码管理":"Source control"} defaultWidth={1120} minWidth={560} adjacentMinWidth={scope.sessionId ? 384 : 0} resizable storageKey="nautilo.scm.panel.width" className="scm-drawer"
    headerContent={<div className="scm-title"><GitBranch size={16}/><h2>Git</h2>{repository&&<span className="scm-root" title={repository.rootPath}>{repository.rootPath.split(/[\\/]/u).at(-1)}</span>}</div>}
    headerActions={<button type="button" className="workspace-panel-icon" disabled={locked||loading||refreshing} aria-label={zh?"刷新仓库状态":"Refresh repository"} title={zh?"刷新":"Refresh"} onClick={()=>{void refresh(false,true);}}><RefreshCw size={15} className={loading||refreshing?"animate-spin":""}/></button>}>
    <div className="scm-workspace" onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){event.preventDefault();setTab("changes");window.setTimeout(()=>commitInput.current?.focus(),0);}}}>
      {loading&&!status&&<div className="scm-empty" role="status"><Loader2 size={20} className="animate-spin"/>{zh?"正在读取仓库":"Loading repository"}</div>}
      {(error||loadError)&&!createBranch&&!discard&&<div className="scm-error" role="alert">{error||loadError}<button type="button" onClick={()=>{setError("");void refresh();}}>{zh?"重试":"Retry"}</button></div>}
      {status&&!status.available&&<div className="scm-empty"><GitBranch size={24}/><p>{zh?"当前目录尚未使用 Git":"This directory is not a Git repository"}</p><span>{status.workingDirectory}</span><Button variant="outline" disabled={locked} onClick={()=>{void mutate("init");}}>{zh?"初始化 Git 仓库":"Initialize Git repository"}</Button></div>}
      {repository&&<>
        <div className="scm-navigation"><div className="scm-view-tabs" role="tablist" aria-label={zh?"源码管理视图":"Source control views"} onKeyDown={event=>{if(editorBusy.current)return;const next=event.key==="ArrowLeft"||event.key==="ArrowRight"?(tab==="changes"?"history":"changes"):event.key==="Home"?"changes":event.key==="End"?"history":undefined;if(next){event.preventDefault();setEditingTarget(undefined);setTab(next);event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();}}}>{(["changes","history"] as const).map(value=><button key={value} type="button" role="tab" disabled={editorSaving} data-view={value} id={`${paneId}-${value}-tab`} aria-controls={`${paneId}-${value}`} tabIndex={tab===value?0:-1} aria-selected={tab===value} onClick={()=>{setEditingTarget(undefined);setTab(value);}}>{value==="changes"?<GitCommitHorizontal size={15}/>:<History size={15}/>} {value==="changes"?(zh?"更改":"Changes"):(zh?"提交记录":"History")}{value==="changes"&&<span>{repository.changes.length}</span>}</button>)}</div>
          <div className="scm-branch-select" title={repository.branch??repository.head}><GitBranch size={13}/><SelectField aria-label={zh?"当前分支":"Current branch"} value={repository.branch??"__detached__"} disabled={locked||!!repository.operation} options={[
            ...(repository.detached?[{value:"__detached__",label:`HEAD · ${repository.head?.slice(0,8)??""}`,disabled:true}]:[]),...(!repository.branches.some(branch=>branch.name===repository.branch)&&repository.branch?[{value:repository.branch,label:repository.branch}]:[]),
            ...repository.branches.map(branch=>({value:branch.name,label:branch.name,hint:branch.worktree&&!branch.current?(zh?"已在另一工作目录中打开":"Open in another worktree"):branch.upstream,disabled:!!branch.worktree&&!branch.current}))
          ]} onValueChange={branch=>{if(branch!==repository.branch)void mutate("switch-branch",{branch});}}/></div>
          <div className="scm-remote-actions" aria-label={zh?"同步远程":"Remote synchronization"}>
            <button type="button" disabled={locked||!remote} title={zh?`获取 ${remote||"远程"} 的更新`:`Fetch ${remote}`} onClick={()=>{void mutate("fetch",{remote});}}>{busy==="fetch"?<Loader2 size={15} className="animate-spin"/>:<RefreshCw size={15}/>}<span>{zh?"获取":"Fetch"}</span></button>
            <button type="button" disabled={locked||!remote||!repository.upstream||!!repository.operation} title={zh?"拉取（仅快进）":"Pull (fast-forward only)"} onClick={()=>{void mutate("pull",{remote});}}>{busy==="pull"?<Loader2 size={15} className="animate-spin"/>:<ArrowDown size={15}/>}<span>{zh?"拉取":"Pull"}</span>{repository.behind>0&&<b>{repository.behind}</b>}</button>
            <button type="button" disabled={locked||!pushRemote||!repository.branch||!repository.head||!!repository.operation} title={zh?`推送到 ${pushRemote||"远程"}`:`Push to ${pushRemote}`} onClick={()=>{void mutate("push",{remote:pushRemote});}}>{busy==="push"?<Loader2 size={15} className="animate-spin"/>:<ArrowUp size={15}/>}<span>{repository.upstream?(zh?"推送":"Push"):(zh?"发布":"Publish")}</span>{repository.ahead>0&&<b>{repository.ahead}</b>}</button>
          </div>
          <details ref={menu} className="scm-menu" onKeyDown={event=>{if(event.key==="Escape"&&menu.current){event.stopPropagation();menu.current.open=false;menu.current.querySelector<HTMLElement>("summary")?.focus();}}}><summary className="workspace-panel-icon" aria-label={zh?"远程与分支操作":"Remote and branch actions"} title={zh?"更多操作":"More actions"}><MoreHorizontal size={17}/></summary><div className="scm-menu-content">
            <button type="button" disabled={locked||!!repository.operation} onClick={()=>{if(menu.current)menu.current.open=false;setCreateBranch(true);}}><GitBranch size={14}/>{zh?"新建分支":"New branch"}</button><div className="scm-menu-divider"/>
            <label><span>{zh?"拉取来源":"Pull source"}</span><SelectField aria-label={zh?"远程仓库":"Remote repository"} value={remote} options={remoteChoices.map(name=>({value:name,label:name==="."?(zh?"本地仓库":"Local repository"):name}))} onValueChange={setRemote} disabled={locked||remoteChoices.length===0}/></label>
            <button type="button" disabled={locked||!remote} onClick={()=>{void mutate("fetch",{remote});}}><RefreshCw size={14}/>{zh?"获取远程状态":"Fetch"}</button><button type="button" disabled={locked||!remote||!repository.upstream} onClick={()=>{void mutate("pull",{remote});}}><ArrowDown size={14}/>{zh?"拉取":"Pull"}{repository.behind>0&&<small>{repository.behind}</small>}</button>
            <label><span>{zh?"推送目标":"Push destination"}</span><SelectField aria-label={zh?"推送目标":"Push destination"} value={pushRemote} options={remoteChoices.map(name=>({value:name,label:name==="."?(zh?"本地仓库":"Local repository"):name}))} onValueChange={setPushRemote} disabled={locked||remoteChoices.length===0}/></label>
            <button type="button" disabled={locked||!pushRemote||!repository.branch||!repository.head} onClick={()=>{void mutate("push",{remote:pushRemote});}}><ArrowUp size={14}/>{repository.upstream?(zh?"推送":"Push"):(zh?"发布分支":"Publish branch")}{repository.ahead>0&&<small>{repository.ahead}</small>}</button>
            <p title={repository.rootPath}>{repository.rootPath}</p>
          </div></details>
        </div>
        <div className="scm-sync-status" role="status" aria-live="polite"><span>{busy?<><Loader2 size={13} className="animate-spin"/>{({stage:zh?"正在暂存":"Staging",unstage:zh?"正在取消暂存":"Unstaging",commit:zh?"正在提交":"Committing",fetch:zh?"正在获取远程更新":"Fetching",pull:zh?"正在拉取":"Pulling",push:zh?"正在推送":"Pushing"} as Partial<Record<SourceControlMutation["action"],string>>)[busy]??(zh?"正在更新仓库":"Updating repository")}</>:notice?<><Check size={13}/>{notice}</>:<>{repository.changes.length===0?<Check size={13}/>:<GitCommitHorizontal size={13}/>} {repository.changes.length===0?(zh?"工作目录干净":"Working tree clean"):zh?`${repository.changes.length} 个更改文件`:`${repository.changes.length} changed files`}</>}</span><span title={repository.upstream}>{repository.upstream??(zh?"未设置上游":"No upstream")}</span></div>
        {repository.operation&&<div className="scm-operation"><GitPullRequest size={15}/>{operationHint}</div>}
        <div className="scm-tab-panel" role="tabpanel" id={`${paneId}-${tab}`} aria-labelledby={`${paneId}-${tab}-tab`}>{tab==="history"?<SourceControlHistory saved={initial.history} onFocusChange={value=>{historyFocus.current=value;}} key={JSON.stringify([scope.sessionId,scope.projectId,repository.rootPath,repository.branch,repository.detached?repository.head:null])} paged={features.sourceControlHistoryPaging===1} repository={repository} scope={scope} enabled={features.sourceControlHistory===1} zh={zh} locale={locale}/>:<SourceControlSplit zh={zh} sidebar={<>
          <div className="scm-file-search"><Search size={14}/><input type="search" aria-label={zh?"筛选更改文件":"Filter changed files"} placeholder={zh?"筛选文件…":"Filter files…"} value={query} onChange={event=>setQuery(event.target.value)}/></div>
          <div className="scm-list-heading"><label><FileCheckbox label={zh?"选择全部文件":"Select all files"} checked={allChecked} mixed={!allChecked&&stagedFiles.length>0} disabled={stagingLocked||selectable.length===0} onChange={checked=>{const files=selectable.filter(file=>checked?unstaged(file):staged(file));if(files.length)void stageFiles(files.map(file=>file.path),checked);}}/><span>{zh?"文件":"Files"}</span></label><span>{zh?`已选 ${stagedFiles.length} / ${selectable.length}`:`${stagedFiles.length} / ${selectable.length} selected`}</span></div>
          <div className="scm-file-list" aria-label={zh?"更改文件":"Changed files"}>
            <SourceControlChangeList groups={groups} selection={selection} disabled={stagingLocked} pending={pendingPaths} editing={editorSaving} zh={zh} onSelect={value=>{setEditingTarget(undefined);setSelection(value);}} onStage={(paths,include)=>{void stageFiles(paths,include);}}/>
            {retainedDrafts.length>0&&<section className="scm-retained-drafts"><h3>{zh?"未保存草稿":"Unsaved drafts"}</h3>{retainedDrafts.map(draft=><button type="button" className="scm-history-file" key={draft.path} disabled={editorSaving||features.sourceControlEditing!==1} aria-label={`${zh?"恢复文件草稿":"Restore file draft"} ${draft.path}`} onClick={()=>{setSelection({path:draft.path,source:"worktree"});setEditingTarget({rootPath:repository.rootPath,path:draft.path});}}><SourceControlFileIcon path={draft.path}/><SourceControlFileName path={draft.path}/><span className="scm-file-status">{zh?"草稿":"Draft"}</span></button>)}</section>}
            {repository.changes.length===0&&retainedDrafts.length===0?<div className="scm-empty scm-clean"><Check size={22}/>{zh?"工作目录干净":"Working tree clean"}</div>:filtered.length===0&&retainedDrafts.length===0?<div className="scm-empty">{zh?"没有匹配的文件":"No matching files"}</div>:null}
          </div>
          <div className="scm-commit-box"><div className="scm-commit-heading"><strong>{zh?"提交":"Commit"}</strong><span>{zh?`${stagedFiles.length} 个暂存文件`:`${stagedFiles.length} staged files`}</span></div><textarea ref={commitInput} aria-label={zh?"提交说明":"Commit message"} placeholder={zh?"填写提交说明…":"Commit message…"} rows={3} value={message} maxLength={16000} onChange={event=>setMessage(event.target.value)} onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key==="Enter"){event.preventDefault();if(event.shiftKey)void commitAndPush();else submit();}}}/><div className="scm-commit-actions"><Button variant="primary" size="sm" disabled={locked||!canCommit} title={zh?"Ctrl+Enter 提交":"Ctrl+Enter to commit"} onClick={submit}>{busy==="commit"?<Loader2 size={14} className="animate-spin"/>:<Check size={14}/>} {repository.operation==="merge"&&stagedFiles.length===0?(zh?"完成合并":"Finish merge"):zh?`提交所选 (${stagedFiles.length})`:`Commit selected (${stagedFiles.length})`}</Button><Button variant="outline" size="sm" disabled={locked||!canCommit||!pushRemote||!repository.branch} title={zh?"Ctrl+Shift+Enter":"Ctrl+Shift+Enter"} onClick={()=>{void commitAndPush();}}><ArrowUp size={14}/>{zh?"提交并推送":"Commit and push"}</Button></div>{conflicts.length>0&&<span className="scm-commit-conflict">{zh?`${conflicts.length} 个文件有冲突，请先解决`:`Resolve ${conflicts.length} conflicted files first`}</span>}</div>
        </>}>
          {editingTarget?.rootPath===repository.rootPath&&features.sourceControlEditing===1?<SourceControlEditor key={`${repository.rootPath}:${editingTarget.path}`} scope={scope} rootPath={repository.rootPath} path={editingTarget.path} zh={zh} onClose={()=>setEditingTarget(undefined)} onBusy={value=>{editorBusy.current=value;setEditorSaving(value);}} onSaved={(status,resolved)=>{epoch.current++;if(status){sourceControlClient.rememberStatus(scope,status);setStatus(status);}else void refresh(true);if(resolved)setEditingTarget(undefined);window.dispatchEvent(new Event("nautilo:source-control-changed"));}}/>:<SourceControlPreview path={selection?.path} headerActions={selection&&<div className="scm-file-actions">
            {features.sourceControlEditing===1&&selectedFile&&!selectedFile.submodule&&(selectedFile.conflict||(typeof diff?.after==="string"||diff?.previewReason==="large")&&!diff.binary)&&<button type="button" className={selectedFile.conflict?"scm-text-action scm-resolve-action":"workspace-panel-icon"} disabled={locked||diffLoading} aria-label={selectedFile.conflict?(zh?"解决所选文件冲突":"Resolve selected file conflict"):(zh?"编辑所选文件":"Edit selected file")} title={selectedFile.conflict?(zh?"解决冲突":"Resolve conflict"):(zh?"编辑文件":"Edit file")} onClick={()=>setEditingTarget({rootPath:repository.rootPath,path:selection.path})}>{selectedFile.conflict?(zh?"解决冲突":"Resolve conflict"):<SquarePen size={14}/>}</button>}
            {selectedFile&&staged(selectedFile)&&unstaged(selectedFile)&&<div className="scm-segment"><button type="button" aria-label={zh?"查看未选更改":"View unselected changes"} aria-pressed={selection.source==="worktree"} onClick={()=>setSelection({...selection,source:"worktree"})}>{zh?"未选更改":"Unselected"}</button><button type="button" aria-label={zh?"查看已选更改":"View selected changes"} aria-pressed={selection.source==="index"} onClick={()=>setSelection({...selection,source:"index"})}>{zh?"已选更改":"Selected"}</button></div>}
            <button type="button" className="workspace-panel-icon" aria-label={zh?"打开所选文件":"Open selected file"} title={zh?"打开文件":"Open file"} onClick={()=>openPreview({path:`${repository.rootPath.replace(/[\\/]+$/u,"")}/${selection.path}`})}><ExternalLink size={14}/></button>
            {selection.source==="worktree"&&selectedFile&&!selectedFile.untracked&&!selectedFile.conflict&&!selectedFile.submodule&&diff?.fileToken&&<button type="button" className="workspace-panel-icon" disabled={locked||diffLoading} aria-label={zh?"放弃所选文件的未暂存更改":"Discard unstaged changes"} title={zh?"放弃未选更改":"Discard unselected changes"} onClick={()=>setDiscard({path:selection.path,fileToken:diff.fileToken!,token:repository.token})}><RotateCcw size={14}/></button>}
          </div>} diff={diff} loading={diffLoading} error={diffError} disabled={locked} zh={zh} locale={locale} onApply={choice=>{if(selection&&diff)void mutate(selection.source==="index"?"unstage-hunks":"stage-hunks",{paths:[selection.path],patchToken:diff.patchToken,...choice});}}/>}
        </SourceControlSplit>}</div>
      </>}
    </div>
    <Dialog open={createBranch} onOpenChange={value=>{if(!busy)setCreateBranch(value);}} title={zh?"新建分支":"New branch"} description={zh?"从当前提交创建分支，并保留工作目录中的更改。":"Create a branch from the current commit, keeping working tree changes."} footer={<><Button variant="ghost" disabled={locked} onClick={()=>setCreateBranch(false)}>{zh?"取消":"Cancel"}</Button><Button disabled={locked||!branchName.trim()} onClick={()=>{void mutate("create-branch",{branch:branchName.trim()});}}>{zh?"创建并切换":"Create and switch"}</Button></>}><input className="scm-branch-name" aria-label={zh?"分支名称":"Branch name"} autoFocus value={branchName} onChange={event=>setBranchName(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&branchName.trim()&&!busy){event.preventDefault();void mutate("create-branch",{branch:branchName.trim()});}}}/>{(error||loadError)&&<p role="alert" className="scm-error">{error||loadError}</p>}</Dialog>
    <Dialog open={!!discard} onOpenChange={value=>{if(!value&&!busy)setDiscard(undefined);}} title={zh?"放弃未选更改":"Discard unselected changes"} description={zh?"将此文件恢复到已选版本，未选入提交的编辑会被移除。":"Restore this file to its selected version. Unselected edits will be removed."} footer={<><Button variant="ghost" disabled={locked} onClick={()=>setDiscard(undefined)}>{zh?"取消":"Cancel"}</Button><Button disabled={locked} onClick={()=>{if(discard)void mutate("discard",{paths:[discard.path],fileToken:discard.fileToken,token:discard.token});}}>{zh?"放弃更改":"Discard changes"}</Button></>}><p className="break-all text-sm text-ink-2">{discard?.path}</p>{(error||loadError)&&<p role="alert" className="scm-error">{error||loadError}</p>}</Dialog>
  </WorkspaceDrawer>;
}
