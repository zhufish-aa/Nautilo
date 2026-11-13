import {useEffect,useState} from "react";
import {CalendarDays,ChevronDown,Code2,Files,GitCommitHorizontal,Loader2,RefreshCw,Search,UserRound} from "lucide-react";
import type {SourceControlCommit,SourceControlDiff,SourceControlRepository,SourceControlScope} from "@agenthub/schemas";
import {sourceControlClient} from "./source-control-client";
import {SourceControlFileIcon,SourceControlFileName,SourceControlPreview,SourceControlSplit} from "./SourceControlPreview";

import {useCommitHistory} from "./use-commit-history";

type HistoryFocus={hash?:string;path?:string;search?:string};
export function SourceControlHistory({repository,scope,enabled,paged,zh,locale,saved,onFocusChange}:{saved?:HistoryFocus;onFocusChange?:(value:HistoryFocus)=>void;repository:SourceControlRepository;scope:SourceControlScope;enabled:boolean;paged:boolean;zh:boolean;locale:string}):JSX.Element{
  const history = useCommitHistory(repository, scope, paged, zh, saved?.search);
  const [selectedHash,setHash] = useState<string|undefined>(saved?.hash);
  const hash = (selectedHash===saved?.hash && !!selectedHash || history.items.some(item=>item.hash===selectedHash)) ? selectedHash : history.items[0]?.hash;
  const [commit,setCommit]=useState<SourceControlCommit>(),[path,setPath]=useState<string|undefined>(saved?.path),[diff,setDiff]=useState<SourceControlDiff>();
  const [loading,setLoading]=useState(false),[error,setError]=useState(""),[diffLoading,setDiffLoading]=useState(false),[diffError,setDiffError]=useState("");
  useEffect(()=>{onFocusChange?.({hash,path,search:history.search});},[hash,path,history.search,onFocusChange]);
  const [retry,setRetry]=useState(0);
  const [expandedHash,setExpandedHash]=useState<string>();
  useEffect(()=>{
    if(!hash||!enabled){setCommit(undefined);setDiff(undefined);setLoading(false);setError("");return;}let cancelled=false;const cached=sourceControlClient.peekCommit(scope,repository.rootPath,hash);setLoading(!cached);setError("");setCommit(cached);
    void sourceControlClient.commit(scope,repository.rootPath,hash).then(value=>{if(cancelled)return;if(value.rootPath!==repository.rootPath||value.hash!==hash)throw new Error(zh?"仓库已改变，请刷新后重试":"Repository changed. Refresh and retry.");setCommit(value);setPath(previous=>value.files.some(file=>file.path===previous)?previous:value.files[0]?.path);}).catch(error=>{if(!cancelled)setError(String(error));}).finally(()=>{if(!cancelled)setLoading(false);});
    return()=>{cancelled=true;};
  },[scope.sessionId,scope.projectId,repository.rootPath,hash,enabled,retry]);
  useEffect(()=>{
    if(!commit||commit.hash!==hash||!path||!enabled)return;let cancelled=false;const cached=sourceControlClient.peekCommitDiff(scope,repository.rootPath,commit.hash,path);setDiffLoading(!cached);setDiffError("");if(cached)setDiff(cached);
    void sourceControlClient.commitDiff(scope,repository.rootPath,commit.hash,path).then(value=>{if(cancelled)return;if(value.rootPath!==repository.rootPath||value.commitHash!==commit.hash||value.path!==path)throw new Error(zh?"提交差异不匹配，请重试":"Commit diff changed. Please retry.");setDiff(value);}).catch(error=>{if(!cancelled)setDiffError(String(error));}).finally(()=>{if(!cancelled)setDiffLoading(false);});return()=>{cancelled=true;};
  },[scope.sessionId,scope.projectId,repository.rootPath,hash,commit?.hash,path,enabled,retry]);
  const active=commit&&commit.hash===hash&&commit.rootPath===repository.rootPath?commit:hash?sourceControlClient.peekCommit(scope,repository.rootPath,hash):undefined;
  const currentDiff=(active&&path?sourceControlClient.peekCommitDiff(scope,repository.rootPath,active.hash,path):undefined)??(diff?.commitHash===active?.hash&&diff?.path===path?diff:undefined);
  return <SourceControlSplit zh={zh} history sidebar={<><section className="scm-history-section">
    <div className="scm-list-heading">
      <span>{zh?"最近提交":"Recent commits"}</span><span>{history.items.length}</span>
      {paged && history.changed && <button className="scm-history-update" type="button" onClick={history.refresh}><RefreshCw size={12}/>{zh?"有更新，刷新":"Refresh updates"}</button>}
    </div>
    {paged && <div className="scm-file-search"><Search size={14}/><input type="search" aria-label={zh?"搜索提交记录":"Search commit history"} placeholder={zh?"搜索提交说明或哈希…":"Message or commit hash…"} value={history.search} onChange={event=>history.setSearch(event.target.value)} onKeyDown={event=>{if(event.key==="Escape")history.setSearch("");}}/></div>}
    <div className="scm-history-list" aria-busy={history.loading || history.loadingMore}>
      {history.loading && <div className="scm-empty" role="status">{zh?"正在读取提交…":"Loading commits…"}</div>}
      {!history.loading && !history.error && !history.items.length && <div className="scm-empty">{history.search.trim()?(zh?"没有匹配的提交":"No matching commits"):(zh?"还没有提交记录":"No commits yet")}</div>}
      {history.items.map(item=><button type="button" className="scm-history-row" data-selected={hash===item.hash} key={item.hash} aria-label={`${zh?"查看提交":"View commit"} ${item.hash.slice(0,8)}`} aria-pressed={hash===item.hash} onClick={()=>setHash(item.hash)} title={item.subject}><span className="scm-history-avatar"><UserRound size={13}/></span><span><strong>{item.subject}</strong><small><span>{item.author} · {new Date(item.committedAt).toLocaleString(locale,{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false} )}</span><code>{item.hash.slice(0,7)}</code></small></span></button>)}
      {history.error && <div className="scm-error" role="alert">{history.error}<button type="button" onClick={history.refresh}>{zh?"刷新记录":"Refresh history"}</button></div>}
      {history.hasMore && !history.error && <button className="scm-history-more" type="button" disabled={history.loadingMore} onClick={()=>void history.loadMore()}>{history.loadingMore?(zh?"正在加载…":"Loading…"):(zh?"加载更多":"Load more")}</button>}
    </div></section>
    {active&&<section className="scm-history-section scm-history-files-section"><div className="scm-list-heading"><span>{zh?"变更文件":"Changed files"}</span><span>{active.files.length}</span></div><div className="scm-history-files">{active.files.length===0?<div className="scm-empty">{zh?"此提交没有文件变更":"This commit has no file changes"}</div>:active.files.map(file=><button type="button" className="scm-history-file" key={file.path} data-selected={path===file.path} aria-label={`${zh?"查看提交文件":"View committed file"} ${file.path}`} onClick={()=>setPath(file.path)}><SourceControlFileIcon path={file.path}/><SourceControlFileName path={file.path} originalPath={file.originalPath}/><span className="scm-file-status scm-status-badge" data-state={file.status}>{file.status}</span>{!file.binary&&(file.additions!==undefined||file.deletions!==undefined)&&<span className="scm-file-stat"><span>+{file.additions??0}</span><span>−{file.deletions??0}</span></span>}</button>)}</div></section>}
  </>}>
    {!enabled?<div className="scm-empty">{zh?"后台更新后即可查看提交中的文件与差异。":"Update the backend to inspect committed files and diffs."}</div>:error?<div className="scm-error" role="alert">{error}<button type="button" onClick={()=>setRetry(value=>value+1)}>{zh?"重试":"Retry"}</button></div>:loading&&!active?<div className="scm-empty" role="status"><Loader2 size={20} className="animate-spin"/>{zh?"正在读取提交详情":"Loading commit details"}</div>:active?<>
      <div className="scm-commit-details"><h3>{active.subject}</h3><div><span title={active.authorEmail}><UserRound size={13}/>{active.author}</span><span><CalendarDays size={13}/><time dateTime={active.committedAt}>{new Date(active.committedAt).toLocaleString(locale)}</time></span><span><Code2 size={13}/><code title={active.hash}>{active.hash.slice(0,8)}</code></span><span><Files size={13}/>{zh?`${active.files.length} 个文件`:`${active.files.length} files`}</span>{active.body&&<button type="button" className="scm-commit-message-toggle" aria-expanded={expandedHash===active.hash} onClick={()=>setExpandedHash(previous=>previous===active.hash?undefined:active.hash)}><ChevronDown size={12}/>{zh?"完整提交说明":"Full commit message"}</button>}</div>{active.body&&expandedHash===active.hash&&<p className="scm-commit-message">{active.body}</p>}{active.parents.length>1&&<small>{zh?"合并提交 · 与首个父提交比较":"Merge commit · compared with its first parent"}</small>}</div>
      <div className="scm-history-preview">{diffError?<div className="scm-error" role="alert">{diffError}<button type="button" onClick={()=>setRetry(value=>value+1)}>{zh?"重试":"Retry"}</button></div>:<SourceControlPreview path={path} diff={currentDiff} loading={diffLoading} zh={zh} locale={locale}/>}</div>
    </>:<div className="scm-empty"><GitCommitHorizontal size={26}/>{zh?"选择一条提交查看详情":"Select a commit to view its details"}</div>}
  </SourceControlSplit>;
}
