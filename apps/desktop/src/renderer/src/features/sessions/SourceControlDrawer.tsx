import {useCallback,useEffect,useId,useMemo,useRef,useState,type KeyboardEvent} from "react";
import {ArrowDown,ArrowUp,Check,ChevronDown,ChevronUp,ExternalLink,FolderTree,GitBranch,GitCommitHorizontal,GitPullRequest,History,List,Loader2,MoreHorizontal,RefreshCw,RotateCcw,Search,SquarePen} from "lucide-react";
import type {SourceControlDiff,SourceControlMutation,SourceControlRepository,SourceControlScope,SourceControlStatus} from "@agenthub/schemas";
import {requestCore} from "../../lib/bridge";
import {useCoreFeatures} from "../../lib/use-core-features";
import {useI18n} from "../../lib/i18n";
import {Button} from "../../components/ui/Button";
import {Dialog} from "../../components/ui/Dialog";
import {SelectField} from "../../components/ui/Select";
import {useFilePreviewStore} from "../../stores/file-preview";
import {useProjectsStore} from "../../stores/projects";
import {WorkspaceDrawer} from "./WorkspaceDrawer";
import {loadNativeDiff,SourceControlFileIcon,SourceControlFileName,SourceControlPreview,SourceControlSplit} from "./SourceControlPreview";
import {SourceControlHistory} from "./SourceControlHistory";
import {SourceControlEditor} from "./SourceControlEditor";
import {flushSourceDrafts,sourceDrafts} from "./source-control-editor-drafts";
import {sourceControlClient} from "./source-control-client";
import {FileCheckbox,SourceControlChangeList,staged,unstaged} from "./SourceControlChangeList";
import "./source-control.css";

type Selection={path:string;source:"worktree"|"index"};
type TransferView = {
  tab?:"changes"|"history"; query?:string; selection?:Selection; editingTarget?:{rootPath:string;path:string};
  history?:{hash?:string;path?:string;search?:string};
};
const draftKey=(root:string)=>`nautilo.scm.commit.${encodeURIComponent(root)}`;
export function SourceControlDrawer({open,onClose,...scope}:SourceControlScope&{open:boolean;onClose:()=>void}):JSX.Element|null{
  return open?<SourceControlWorkspace key={scope.sessionId??scope.projectId} onClose={onClose} scope={scope}/>:null;
}
function SourceControlWorkspace({scope,onClose}:{scope:SourceControlScope;onClose:()=>void}):JSX.Element{
  const {locale}=useI18n(),zh=locale==="zh-CN",features=useCoreFeatures(),paneId=useId();
  const transferKey="nautilo.scm.transfer."+JSON.stringify([scope.sessionId,scope.projectId]);
  const [initial]=useState<TransferView>(()=>{try{return JSON.parse(localStorage.getItem(transferKey)??"{}")??{};}catch{return {};}});
  const historyFocus=useRef(initial.history);
  useEffect(()=>{localStorage.removeItem(transferKey);},[transferKey]);
  useEffect(()=>{void loadNativeDiff().catch(()=>{/* The preview can retry the lazy import when opened. */});},[]);
  const [status,setStatus]=useState<SourceControlStatus|undefined>(()=>sourceControlClient.peekStatus(scope)),[error,setError]=useState(""),[loadError,setLoadError]=useState(""),[loading,setLoading]=useState(()=>!sourceControlClient.peekStatus(scope)),[refreshing,setRefreshing]=useState(false);
  const [busy,setBusy]=useState<SourceControlMutation["action"]>(),busyRef=useRef(false),inFlight=useRef(false),disposed=useRef(false),epoch=useRef(0);
  const [selection,setSelection]=useState<Selection|undefined>(initial.selection),[loadedDiff,setDiff]=useState<SourceControlDiff>(),[diffError,setDiffError]=useState(""),[diffLoading,setDiffLoading]=useState(false);
  const [checkedPaths,setCheckedPaths]=useState<Set<string>>(()=>new Set());
  const [tree,setTree]=useState(()=>{try{return localStorage.getItem("nautilo.scm.files.view")==="tree";}catch{return false;}});
  const [checkedOnly,setCheckedOnly]=useState(false);
  const [dockExpanded,setDockExpanded]=useState(false);
  const [message,setMessage]=useState(""),[draftRoot,setDraftRoot]=useState<string>(),[tab,setTab]=useState<"changes"|"history">(initial.tab??"changes"),[query,setQuery]=useState(initial.query??"");
  const messageRef=useRef(message);messageRef.current=message;
  const [createBranch,setCreateBranch]=useState(false),[branchName,setBranchName]=useState(""),[remote,setRemote]=useState(""),[pushRemote,setPushRemote]=useState(""),remoteScope=useRef<string>();
  const [notice,setNotice]=useState(""),[discard,setDiscard]=useState<{path:string;fileToken:string;token:string}>();
  const commitInput=useRef<HTMLTextAreaElement>(null);
  const [editingTarget,setEditingTarget]=useState<TransferView["editingTarget"]>(initial.editingTarget),[editorSaving,setEditorSaving]=useState(false),editorBusy=useRef(false);
  const locked=!!busy||editorSaving;
  const menu=useRef<HTMLDetailsElement>(null),openPreview=useFilePreviewStore(state=>state.open);
  const repository=status?.available?status:undefined,current=useRef(repository);current.current=repository;
  useEffect(()=>{setCheckedPaths(previous=>previous.size?new Set():previous);},[repository?.rootPath,repository?.branch]);
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
      const result=await sourceControlClient.mutate(scope,current.current?.rootPath??status?.workingDirectory??JSON.stringify(scope),{action,token:current.current?.token??"",...extra});sourceControlClient.rememberStatus(scope,result.status);current.current=result.status;
      if(action==="commit"){try{const key=draftKey(result.status.rootPath);if(window.localStorage.getItem(key)===extra.message)window.localStorage.removeItem(key);}catch{/* Keep an unsubmitted draft. */}}
      if(disposed.current)return result.status;setStatus(result.status);
      if(action==="commit"){if(extra.paths)setCheckedPaths(new Set());if(messageRef.current===extra.message)setMessage("");setNotice(zh?"所选更改已提交":"Selected changes committed");}
      else if(action==="create-branch"){setCreateBranch(false);setBranchName("");setNotice(zh?"已创建并切换分支":"Branch created and checked out");}
      else if(action==="push")setNotice(zh?"已推送当前分支":"Current branch pushed");else if(action==="pull")setNotice(zh?"已拉取更新":"Updates pulled");else if(action==="fetch")setNotice(zh?"远程状态已更新":"Remote state refreshed");
      if(action==="discard")setDiscard(undefined);if(action==="init"&&scope.projectId)void useProjectsStore.getState().rescanProject(scope.projectId).catch(()=>{});
      window.dispatchEvent(new Event("nautilo:source-control-changed"));
      return result.status;
    }catch(error){if(!disposed.current){const text=String(error);await refresh(true);if(!disposed.current)setError(text);}}
    finally{busyRef.current=false;if(!disposed.current)setBusy(undefined);}
  };
  const checkFiles=(paths:readonly string[],checked:boolean):void=>setCheckedPaths(previous=>{
    const next=new Set(previous);
    for(const path of paths){if(checked)next.add(path);else next.delete(path);}
    return next;
  });
  const chooseTree=(enabled:boolean):void=>{
    setTree(enabled);
    try{localStorage.setItem("nautilo.scm.files.view",enabled?"tree":"list");}catch{/* The current view still works. */}
  };
  const selectedFile=repository?.changes.find(file=>file.path===selection?.path);
  const diff=loadedDiff&&(!loadedDiff.rootPath||loadedDiff.rootPath===repository?.rootPath)
    &&!(loadedDiff.path===selection?.path&&loadedDiff.source!==selection.source)?loadedDiff:undefined;
  const previewReady=!!selection&&diff?.path===selection.path&&diff.source===selection.source;
  const stagedFiles=repository?.changes.filter(staged)??[],conflicts=repository?.changes.filter(file=>file.conflict)??[];
  const selectable=repository?.changes.filter(file=>!file.conflict&&!file.directory)??[];
  const filesToCommit=selectable.filter(file=>checkedPaths.has(file.path)).map(file=>file.path);
  const filteringChecked=checkedOnly&&filesToCommit.length>0;
  useEffect(()=>{if(!filesToCommit.length)setCheckedOnly(false);},[filesToCommit.length]);
  useEffect(()=>{if(message.includes("\n"))setDockExpanded(true);},[message]);
  const allChecked=selectable.length>0&&filesToCommit.length===selectable.length;
  const merging=repository?.operation==="merge",directCommit=features.sourceControl===2;
  const readyToCommit=conflicts.length===0&&(!repository?.operation||merging)&&!!message.trim();
  const canCommit=readyToCommit&&(merging||directCommit&&filesToCommit.length>0);
  const commitSelection=()=>mutate("commit",merging?{message}:{message,paths:filesToCommit});
  const operationName=repository?.operation?({merge:zh?"合并":"Merge",rebase:zh?"变基":"Rebase","cherry-pick":zh?"拣选提交":"Cherry-pick",revert:zh?"还原提交":"Revert"})[repository.operation]:"";
  const operationHint=repository?.operation==="merge"&&conflicts.length===0?(zh?"合并已就绪，提交以完成合并。":"Merge ready. Commit to finish the merge."):conflicts.length>0?(zh?`${operationName}进行中，请处理 ${conflicts.length} 个冲突文件。`:`${operationName} in progress. Resolve ${conflicts.length} conflicted files.`):(zh?`${operationName}进行中，请在终端继续或完成当前步骤。`:`${operationName} in progress. Continue the operation in the terminal.`);
  const remoteChoices=repository&&(repository.upstreamRemote==="."||repository.pushRemote===".")?[".",...repository.remotes]:repository?.remotes??[];
  const baseGroups=useMemo(()=>{
    const normalizedQuery=query.toLocaleLowerCase();
    const filtered=repository?.changes.filter(file=>file.path.toLocaleLowerCase().includes(normalizedQuery))??[];
    return [
      {id:"conflicts",label:zh?"冲突":"Conflicts",source:"worktree" as const,files:filtered.filter(file=>file.conflict)},
      {id:"worktree",label:zh?"工作区":"Working tree",source:"worktree" as const,files:filtered.filter(file=>!file.conflict&&!file.untracked&&unstaged(file))},
      {id:"untracked",label:zh?"未跟踪":"Untracked",source:"worktree" as const,files:filtered.filter(file=>file.untracked)},
      {id:"index",label:zh?"仅暂存区有更改":"Index changes only",source:"index" as const,files:filtered.filter(file=>staged(file)&&!unstaged(file))}
    ];
  },[repository?.changes,query,zh]);
  const groups=filteringChecked?baseGroups.map(group=>({...group,files:group.files.filter(file=>checkedPaths.has(file.path))})):baseGroups;
  const retainedDrafts=repository?sourceDrafts(repository.rootPath).filter(draft=>!repository.changes.some(file=>file.path===draft.path)&&draft.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())):[];
  const submit=():void=>{if(canCommit&&!locked)void commitSelection();};
  const commitAndPush=async():Promise<void>=>{if(!canCommit||locked||!pushRemote)return;const committed=await commitSelection();if(committed)await mutate("push",{remote:pushRemote});};
  const prepareMove=()=>{
    if(!flushSourceDrafts())throw Error(zh?"文件草稿暂时无法保存，可以先复制或保存再移动窗口。":"File draft could not be saved before moving this window.");
    if(draftRoot)localStorage.setItem(draftKey(draftRoot),message);
    localStorage.setItem(transferKey,JSON.stringify({tab,query,selection,editingTarget,history:historyFocus.current}));
  };
  const focusCommitShortcut=(event: KeyboardEvent<HTMLElement>):void=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){event.preventDefault();setTab("changes");window.setTimeout(()=>commitInput.current?.focus(),0);}};
  const commitLabel=merging?(zh?"完成合并":"Finish merge"):zh?`提交所选 (${filesToCommit.length})`:`Commit selected (${filesToCommit.length})`;
  const expandLabel=dockExpanded?(zh?"收起提交说明":"Collapse commit message"):(zh?"展开提交说明":"Expand commit message");
  const commitDock=<div className="scm-commit-dock" data-expanded={dockExpanded||undefined} onBlur={event=>{
    if(!message.includes("\n")&&!event.currentTarget.contains(event.relatedTarget))setDockExpanded(false);
  }}>
    <button type="button" className="scm-selection-chip" aria-pressed={filteringChecked} disabled={!filesToCommit.length}
      title={zh?"只显示已选文件":"Show selected files"} onClick={()=>setCheckedOnly(value=>!value)}>
      {filesToCommit.length?(zh?`已选 ${filesToCommit.length} 项`:`${filesToCommit.length} selected`):(zh?"未选文件":"No files selected")}
    </button>
    <textarea ref={commitInput} aria-label={zh?"提交说明":"Commit message"} placeholder={zh?"填写提交说明…":"Commit message…"}
      rows={dockExpanded?4:1} value={message} maxLength={16000} onChange={event=>setMessage(event.target.value)}
      onFocus={()=>{if(message.includes("\n"))setDockExpanded(true);}} onKeyDown={event=>{
        if((event.ctrlKey||event.metaKey)&&event.key==="Enter"){event.preventDefault();if(event.shiftKey)void commitAndPush();else submit();}
      }}/>
    <div className="scm-commit-actions">
      <Button variant="primary" size="sm" disabled={locked||!canCommit} aria-label={commitLabel} title={zh?"Ctrl+Enter 提交":"Ctrl+Enter to commit"} onClick={submit}>
        {busy==="commit"?<Loader2 size={14} className="animate-spin"/>:<Check size={14}/>} {merging?commitLabel:(zh?"提交":"Commit")}
      </Button>
      <Button variant="outline" size="sm" disabled={locked||!canCommit||!pushRemote||!repository?.branch}
        aria-label={zh?"提交并推送":"Commit and push"} title={zh?"提交并推送 · Ctrl+Shift+Enter":"Commit and push · Ctrl+Shift+Enter"} onClick={()=>{void commitAndPush();}}>
        <ArrowUp size={14}/><span className="sr-only">{zh?"提交并推送":"Commit and push"}</span>
      </Button>
    </div>
    <button type="button" className="workspace-panel-icon scm-dock-toggle" aria-label={expandLabel} title={expandLabel} aria-expanded={dockExpanded}
      onClick={()=>{setDockExpanded(!dockExpanded);if(!dockExpanded)commitInput.current?.focus();}}>{dockExpanded?<ChevronDown size={14}/>:<ChevronUp size={14}/>}</button>
    {features.sourceControl===1&&!merging&&<span className="scm-dock-note">{zh?"请更新 Git 后台后再直接提交文件。":"Update the Git backend to commit selected files."}</span>}
    {conflicts.length>0&&<span className="scm-dock-note scm-commit-conflict">{zh?`${conflicts.length} 个文件有冲突，请先解决`:`Resolve ${conflicts.length} conflicted files first`}</span>}
  </div>;
  const headerStatus=<span className="scm-header-status" role="status" aria-live="polite">{busy ? <><Loader2 size={13} className="animate-spin"/><span>{({stage:zh?"正在暂存":"Staging",unstage:zh?"正在取消暂存":"Unstaging",commit:zh?"正在提交":"Committing",fetch:zh?"正在获取远程更新":"Fetching",pull:zh?"正在拉取":"Pulling",push:zh?"正在推送":"Pushing"} as Partial<Record<SourceControlMutation["action"],string>>)[busy]??(zh?"正在更新仓库":"Updating repository")}</span></> : notice ? <><Check size={13}/><span title={notice}>{notice}</span></> : null}</span>;
  return <WorkspaceDrawer open nativePanel={{kind:"source-control",...scope}} beforeMove={prepareMove} moveDisabled={locked} onClose={()=>{if(!editorBusy.current)onClose();}} title={zh?"源码管理":"Source control"} defaultWidth={1120} minWidth={560} adjacentMinWidth={scope.sessionId ? 384 : 0} resizable storageKey="nautilo.scm.panel.width" className="scm-drawer"
    headerContent={repository?<div className="scm-navigation" onKeyDown={focusCommitShortcut}><div className="scm-view-tabs" role="tablist" aria-label={zh?"源码管理视图":"Source control views"} onKeyDown={event=>{if(editorBusy.current)return;const next=event.key==="ArrowLeft"||event.key==="ArrowRight"?(tab==="changes"?"history":"changes"):event.key==="Home"?"changes":event.key==="End"?"history":undefined;if(next){event.preventDefault();setEditingTarget(undefined);setTab(next);event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();}}}>{(["changes","history"] as const).map(value=><button key={value} type="button" role="tab" disabled={editorSaving} data-view={value} id={`${paneId}-${value}-tab`} aria-controls={`${paneId}-${value}`} tabIndex={tab===value?0:-1} aria-selected={tab===value} onClick={()=>{setEditingTarget(undefined);setTab(value);}}>{value==="changes"?<GitCommitHorizontal size={15}/>:<History size={15}/>} {value==="changes"?(zh?"更改":"Changes"):(zh?"提交记录":"History")}{value==="changes"&&<span>{repository.changes.length}</span>}</button>)}</div>
          <span className="scm-root sr-only" title={repository.rootPath}>{repository.rootPath}</span>
          {headerStatus}
          <div className="scm-branch-select" title={[repository.branch??repository.head, repository.upstream].filter(Boolean).join("\n")}><GitBranch size={13}/><SelectField aria-label={zh?"当前分支":"Current branch"} value={repository.branch??"__detached__"} disabled={locked||!!repository.operation} options={[
            ...(repository.detached?[{value:"__detached__",label:`HEAD · ${repository.head?.slice(0,8)??""}`,disabled:true}]:[]),...(!repository.branches.some(branch=>branch.name===repository.branch)&&repository.branch?[{value:repository.branch,label:repository.branch}]:[]),
            ...repository.branches.map(branch=>({value:branch.name,label:branch.name,hint:branch.worktree&&!branch.current?(zh?"已在另一工作目录中打开":"Open in another worktree"):branch.upstream,disabled:!!branch.worktree&&!branch.current}))
          ]} onValueChange={branch=>{if(branch!==repository.branch)void mutate("switch-branch",{branch});}}/></div>
          <div className="scm-remote-actions" role="group" aria-label={zh?"同步远程":"Remote synchronization"}>
            <button type="button" disabled={locked||!remote} aria-label={zh?"获取":"Fetch"} title={zh?`获取 ${remote||"远程"} 的更新`:`Fetch ${remote}`} onClick={()=>{void mutate("fetch",{remote});}}>{busy==="fetch"?<Loader2 size={15} className="animate-spin"/>:<RefreshCw size={15}/>}<span>{zh?"获取":"Fetch"}</span></button>
            <button type="button" disabled={locked||!remote||!repository.upstream||!!repository.operation} aria-label={zh?"拉取":"Pull"} title={zh?"拉取（仅快进）":"Pull (fast-forward only)"} onClick={()=>{void mutate("pull",{remote});}}>{busy==="pull"?<Loader2 size={15} className="animate-spin"/>:<ArrowDown size={15}/>}<span>{zh?"拉取":"Pull"}</span>{repository.behind>0&&<b>{repository.behind}</b>}</button>
            <button type="button" disabled={locked||!pushRemote||!repository.branch||!repository.head||!!repository.operation} aria-label={repository.upstream?(zh?"推送":"Push"):(zh?"发布":"Publish")} title={zh?`推送到 ${pushRemote||"远程"}`:`Push to ${pushRemote}`} onClick={()=>{void mutate("push",{remote:pushRemote});}}>{busy==="push"?<Loader2 size={15} className="animate-spin"/>:<ArrowUp size={15}/>}<span>{repository.upstream?(zh?"推送":"Push"):(zh?"发布":"Publish")}</span>{repository.ahead>0&&<b>{repository.ahead}</b>}</button>
          </div>
          <details ref={menu} className="scm-menu" onKeyDown={event=>{if(event.key==="Escape"&&menu.current){event.stopPropagation();menu.current.open=false;menu.current.querySelector<HTMLElement>("summary")?.focus();}}}><summary className="workspace-panel-icon" aria-label={zh?"远程与分支操作":"Remote and branch actions"} title={zh?"更多操作":"More actions"}><MoreHorizontal size={17}/></summary><div className="scm-menu-content">
            {!repository.operation&&stagedFiles.length>0&&<button type="button" disabled={locked||!readyToCommit} onClick={()=>{void mutate("commit",{message});}}><Check size={14}/>{zh?`提交暂存区 (${stagedFiles.length})`:`Commit staged changes (${stagedFiles.length})`}</button>}
            <button type="button" disabled={locked||!!repository.operation} onClick={()=>{if(menu.current)menu.current.open=false;setCreateBranch(true);}}><GitBranch size={14}/>{zh?"新建分支":"New branch"}</button><div className="scm-menu-divider"/>
            <label><span>{zh?"拉取来源":"Pull source"}</span><SelectField aria-label={zh?"远程仓库":"Remote repository"} value={remote} options={remoteChoices.map(name=>({value:name,label:name==="."?(zh?"本地仓库":"Local repository"):name}))} onValueChange={setRemote} disabled={locked||remoteChoices.length===0}/></label>
            <button type="button" disabled={locked||!remote} onClick={()=>{void mutate("fetch",{remote});}}><RefreshCw size={14}/>{zh?"获取远程状态":"Fetch"}</button><button type="button" disabled={locked||!remote||!repository.upstream} onClick={()=>{void mutate("pull",{remote});}}><ArrowDown size={14}/>{zh?"拉取":"Pull"}{repository.behind>0&&<small>{repository.behind}</small>}</button>
            <label><span>{zh?"推送目标":"Push destination"}</span><SelectField aria-label={zh?"推送目标":"Push destination"} value={pushRemote} options={remoteChoices.map(name=>({value:name,label:name==="."?(zh?"本地仓库":"Local repository"):name}))} onValueChange={setPushRemote} disabled={locked||remoteChoices.length===0}/></label>
            <button type="button" disabled={locked||!pushRemote||!repository.branch||!repository.head} onClick={()=>{void mutate("push",{remote:pushRemote});}}><ArrowUp size={14}/>{repository.upstream?(zh?"推送":"Push"):(zh?"发布分支":"Publish branch")}{repository.ahead>0&&<small>{repository.ahead}</small>}</button>
            <p title={repository.rootPath}>{repository.rootPath}</p>
          </div></details>
        </div>:<div className="scm-title"><GitBranch size={16}/><h2>Git</h2>{headerStatus}</div>}
    headerActions={<button type="button" className="workspace-panel-icon" disabled={locked||loading||refreshing} aria-label={zh?"刷新仓库状态":"Refresh repository"} title={zh?"刷新":"Refresh"} onClick={()=>{void refresh(false,true);}}><RefreshCw size={15} className={loading||refreshing?"animate-spin":""}/></button>}>
    <div className="scm-workspace" onKeyDown={focusCommitShortcut}>
      {loading&&!status&&<div className="scm-empty" role="status"><Loader2 size={20} className="animate-spin"/>{zh?"正在读取仓库":"Loading repository"}</div>}
      {(error||loadError)&&!createBranch&&!discard&&<div className="scm-error" role="alert">{error||loadError}<button type="button" onClick={()=>{setError("");void refresh();}}>{zh?"重试":"Retry"}</button></div>}
      {status&&!status.available&&<div className="scm-empty"><GitBranch size={24}/><p>{zh?"当前目录尚未使用 Git":"This directory is not a Git repository"}</p><span>{status.workingDirectory}</span><Button variant="outline" disabled={locked} onClick={()=>{void mutate("init");}}>{zh?"初始化 Git 仓库":"Initialize Git repository"}</Button></div>}
      {repository&&<>
        {repository.operation&&<div className="scm-operation"><GitPullRequest size={15}/>{operationHint}</div>}
        <div className="scm-tab-panel" role="tabpanel" id={`${paneId}-${tab}`} aria-labelledby={`${paneId}-${tab}-tab`}>{tab==="history"?<SourceControlHistory saved={initial.history} onFocusChange={value=>{historyFocus.current=value;}} key={JSON.stringify([scope.sessionId,scope.projectId,repository.rootPath,repository.branch,repository.detached?repository.head:null])} paged={features.sourceControlHistoryPaging===1} repository={repository} scope={scope} enabled={features.sourceControlHistory===1} zh={zh} locale={locale}/>:<SourceControlSplit zh={zh} dock={commitDock} sidebar={<>
          <div className="scm-file-tools">
            <div className="scm-file-search"><Search size={14}/><input type="search" aria-label={zh?"筛选更改文件":"Filter changed files"} placeholder={zh?"筛选文件…":"Filter files…"} value={query} onChange={event=>setQuery(event.target.value)}/></div>
            <div className="scm-segment scm-file-view" role="group" aria-label={zh?"文件视图":"File view"}>
              <button type="button" aria-label={zh?"平铺列表":"Flat list"} title={zh?"平铺列表":"Flat list"} aria-pressed={!tree} onClick={()=>chooseTree(false)}><List size={15} aria-hidden/></button>
              <button type="button" aria-label={zh?"文件夹树":"Folder tree"} title={zh?"文件夹树":"Folder tree"} aria-pressed={tree} onClick={()=>chooseTree(true)}><FolderTree size={15} aria-hidden/></button>
            </div>
          </div>
          <div className="scm-list-heading"><label><FileCheckbox label={zh?"选择全部文件":"Select all files"} checked={allChecked} mixed={!allChecked&&filesToCommit.length>0} disabled={locked||!!repository.operation||selectable.length===0} onChange={checked=>setCheckedPaths(new Set(checked?selectable.map(file=>file.path):[]))}/><span>{zh?"文件":"Files"}</span></label><span>{zh?`已选 ${filesToCommit.length} / ${selectable.length}`:`${filesToCommit.length} / ${selectable.length} selected`}</span></div>
          <div className="scm-file-list" aria-label={zh?"更改文件":"Changed files"}>
            <SourceControlChangeList groups={groups} tree={tree} selection={selection} disabled={locked||!!repository.operation} checkedPaths={checkedPaths} editing={editorSaving} zh={zh} onSelect={value=>{setEditingTarget(undefined);setSelection(value);}} onCheck={checkFiles} onStage={(paths,stage)=>{void mutate(stage?"stage":"unstage",{paths});}}/>
            {!filteringChecked&&retainedDrafts.length>0&&<section className="scm-retained-drafts"><h3>{zh?"未保存草稿":"Unsaved drafts"}</h3>{retainedDrafts.map(draft=><button type="button" className="scm-history-file" key={draft.path} disabled={editorSaving||features.sourceControlEditing!==1} aria-label={`${zh?"恢复文件草稿":"Restore file draft"} ${draft.path}`} onClick={()=>{setSelection({path:draft.path,source:"worktree"});setEditingTarget({rootPath:repository.rootPath,path:draft.path});}}><SourceControlFileIcon path={draft.path}/><SourceControlFileName path={draft.path}/><span className="scm-file-status">{zh?"草稿":"Draft"}</span></button>)}</section>}
            {repository.changes.length===0&&retainedDrafts.length===0?<div className="scm-empty scm-clean"><Check size={22}/>{zh?"工作目录干净":"Working tree clean"}</div>:!groups.some(group=>group.files.length)&&(filteringChecked||retainedDrafts.length===0)?<div className="scm-empty">{zh?"没有匹配的文件":"No matching files"}</div>:null}
          </div>
        </>}>
          {editingTarget?.rootPath===repository.rootPath&&features.sourceControlEditing===1?<SourceControlEditor key={`${repository.rootPath}:${editingTarget.path}`} scope={scope} rootPath={repository.rootPath} path={editingTarget.path} zh={zh} onClose={()=>setEditingTarget(undefined)} onBusy={value=>{editorBusy.current=value;setEditorSaving(value);}} onSaved={(status,resolved)=>{epoch.current++;if(status){sourceControlClient.rememberStatus(scope,status);setStatus(status);}else void refresh(true);if(resolved)setEditingTarget(undefined);window.dispatchEvent(new Event("nautilo:source-control-changed"));}}/>:<SourceControlPreview path={diff?.path ?? selection?.path} pendingPath={!previewReady ? selection?.path : undefined} headerActions={selection&&previewReady&&<div className="scm-file-actions">
            {features.sourceControlEditing===1&&selectedFile&&!selectedFile.submodule&&(selectedFile.conflict||(typeof diff?.after==="string"||diff?.previewReason==="large")&&!diff.binary)&&<button type="button" className={selectedFile.conflict?"scm-text-action scm-resolve-action":"workspace-panel-icon"} disabled={locked||diffLoading} aria-label={selectedFile.conflict?(zh?"解决所选文件冲突":"Resolve selected file conflict"):(zh?"编辑所选文件":"Edit selected file")} title={selectedFile.conflict?(zh?"解决冲突":"Resolve conflict"):(zh?"编辑文件":"Edit file")} onClick={()=>setEditingTarget({rootPath:repository.rootPath,path:selection.path})}>{selectedFile.conflict?(zh?"解决冲突":"Resolve conflict"):<SquarePen size={14}/>}</button>}
            {selectedFile&&staged(selectedFile)&&unstaged(selectedFile)&&<div className="scm-segment"><button type="button" aria-label={zh?"查看工作区更改":"View working tree changes"} aria-pressed={selection.source==="worktree"} onClick={()=>setSelection({...selection,source:"worktree"})}>{zh?"工作区":"Working tree"}</button><button type="button" aria-label={zh?"查看暂存区更改":"View staged changes"} aria-pressed={selection.source==="index"} onClick={()=>setSelection({...selection,source:"index"})}>{zh?"暂存区":"Index"}</button></div>}
            <button type="button" className="workspace-panel-icon" aria-label={zh?"打开所选文件":"Open selected file"} title={zh?"打开文件":"Open file"} onClick={()=>openPreview({path:`${repository.rootPath.replace(/[\\/]+$/u,"")}/${selection.path}`})}><ExternalLink size={14}/></button>
            {selection.source==="worktree"&&selectedFile&&!selectedFile.untracked&&!selectedFile.conflict&&!selectedFile.submodule&&diff?.fileToken&&<button type="button" className="workspace-panel-icon" disabled={locked||diffLoading} aria-label={zh?"放弃所选文件的未暂存更改":"Discard unstaged changes"} title={zh?"放弃未选更改":"Discard unselected changes"} onClick={()=>setDiscard({path:selection.path,fileToken:diff.fileToken!,token:repository.token})}><RotateCcw size={14}/></button>}
          </div>} fileToggle={previewReady&&selectedFile&&<FileCheckbox label={zh?"勾选当前文件":"Include current file"} checked={checkedPaths.has(selectedFile.path)} disabled={locked||!!repository.operation||selectedFile.conflict||selectedFile.directory} onChange={checked=>checkFiles([selectedFile.path],checked)}/>}
            diff={diff} loading={diffLoading} error={diffError} disabled={locked||!previewReady} zh={zh} locale={locale} onApply={choice=>{if(selection&&diff&&previewReady)void mutate(selection.source==="index"?"unstage-hunks":"stage-hunks",{paths:[selection.path],patchToken:diff.patchToken,...choice});}}/>}
        </SourceControlSplit>}</div>
      </>}
    </div>
    <Dialog open={createBranch} onOpenChange={value=>{if(!busy)setCreateBranch(value);}} title={zh?"新建分支":"New branch"} description={zh?"从当前提交创建分支，并保留工作目录中的更改。":"Create a branch from the current commit, keeping working tree changes."} footer={<><Button variant="ghost" disabled={locked} onClick={()=>setCreateBranch(false)}>{zh?"取消":"Cancel"}</Button><Button disabled={locked||!branchName.trim()} onClick={()=>{void mutate("create-branch",{branch:branchName.trim()});}}>{zh?"创建并切换":"Create and switch"}</Button></>}><input className="scm-branch-name" aria-label={zh?"分支名称":"Branch name"} autoFocus value={branchName} onChange={event=>setBranchName(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&branchName.trim()&&!busy){event.preventDefault();void mutate("create-branch",{branch:branchName.trim()});}}}/>{(error||loadError)&&<p role="alert" className="scm-error">{error||loadError}</p>}</Dialog>
    <Dialog open={!!discard} onOpenChange={value=>{if(!value&&!busy)setDiscard(undefined);}} title={zh?"放弃未选更改":"Discard unselected changes"} description={zh?"将此文件恢复到已选版本，未选入提交的编辑会被移除。":"Restore this file to its selected version. Unselected edits will be removed."} footer={<><Button variant="ghost" disabled={locked} onClick={()=>setDiscard(undefined)}>{zh?"取消":"Cancel"}</Button><Button disabled={locked} onClick={()=>{if(discard)void mutate("discard",{paths:[discard.path],fileToken:discard.fileToken,token:discard.token});}}>{zh?"放弃更改":"Discard changes"}</Button></>}><p className="break-all text-sm text-ink-2">{discard?.path}</p>{(error||loadError)&&<p role="alert" className="scm-error">{error||loadError}</p>}</Dialog>
  </WorkspaceDrawer>;
}
