import {lazy,Suspense,useCallback,useEffect,useRef,useState} from "react";
import {AlertCircle,ArrowLeft,Check,FileDiff,Loader2,RefreshCw,RotateCcw,RotateCw,Save} from "lucide-react";
import type {SourceControlFile,SourceControlFileVersion,SourceControlRepository,SourceControlSaveResult,SourceControlScope} from "@agenthub/schemas";
import {requestCore} from "../../lib/bridge";
import {Button} from "../../components/ui/Button";
import {SelectField} from "../../components/ui/Select";
import {readSourceDraft,rememberSourceDraft,type SourceFileDraft} from "./source-control-editor-drafts";
const CodeEditor=lazy(()=>import("../../components/ui/DiffCodeEditor"));
type Side="ours"|"theirs"|"base"|"working";

export function SourceControlEditor({scope,rootPath,path,zh,onClose,onSaved,onBusy}:{
  scope:SourceControlScope;rootPath:string;path:string;zh:boolean;onClose:()=>void;
  onSaved:(status?:SourceControlRepository,resolved?:boolean)=>void;onBusy?:(busy:boolean)=>void;
}):JSX.Element{
  const [file,setFile]=useState<SourceControlFile>(),[draft,setDraft]=useState<SourceFileDraft|undefined>(()=>readSourceDraft(rootPath,path)),[comparison,setComparison]=useState<Side>("ours");
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[stale,setStale]=useState(false),[durable,setDurable]=useState(true);
  const [needsReload,setNeedsReload]=useState(false);
  const [undo,setUndo]=useState<SourceFileDraft[]>([]),surface=useRef<HTMLDivElement>(null),[wide,setWide]=useState(false);
  const [redo,setRedo]=useState<SourceFileDraft[]>([]);
  const disposed=useRef(false),draftRef=useRef(draft),loadingRef=useRef(false),busyRef=useRef(false),onBusyRef=useRef(onBusy),generation=useRef(0);
  draftRef.current=draft;onBusyRef.current=onBusy;
  const setCurrentDraft=(value:SourceFileDraft):void=>{draftRef.current=value;rememberSourceDraft(value);setDraft(value);};
  const flush=():void=>{const value=draftRef.current;if(value)setDurable(rememberSourceDraft(value,true));};
  const load=useCallback(async():Promise<void>=>{
    if(loadingRef.current||busyRef.current)return;loadingRef.current=true;setLoading(true);setError("");const ticket=++generation.current;
    try{
      const value=await requestCore<SourceControlFile>("scm.file",{...scope,path});if(disposed.current||ticket!==generation.current)return;
      if(value.rootPath!==rootPath||value.path!==path)throw new Error(zh?"文件已切换到其他工作目录，请重新打开。":"The file belongs to another worktree. Reopen it.");
      const saved=draftRef.current?.changed?draftRef.current:readSourceDraft(rootPath,path);
      setFile(value);setUndo([]);setRedo([]);setNeedsReload(false);if(!value.conflict||saved&&saved.fileVersion!==value.token)setComparison("working");
      if(saved){setCurrentDraft(saved);setStale(saved.fileVersion!==value.token);setNotice(zh?"已保留未保存的草稿":"Unsaved draft retained");}
      else{setCurrentDraft({version:1,rootPath,path,fileVersion:value.token,content:value.working.content??"",resolution:"edited",changed:false});setStale(false);}
    }catch(error){if(!disposed.current&&ticket===generation.current)setError(String(error));}
    finally{loadingRef.current=false;if(!disposed.current)setLoading(false);}
  },[scope.sessionId,scope.projectId,rootPath,path,zh]);
  useEffect(()=>{disposed.current=false;void load();return()=>{disposed.current=true;generation.current++;const value=draftRef.current;if(value)rememberSourceDraft(value,true);onBusyRef.current?.(false);};},[load]);
  useEffect(()=>{if(!draft)return;const timer=window.setTimeout(flush,250);return()=>window.clearTimeout(timer);},[draft]);
  useEffect(()=>{const element=surface.current;if(!element)return;const measure=():void=>setWide(element.clientWidth>=760);measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();},[file?.token]);
  const sideLabels:Record<Side,string>={ours:zh?"当前方（Git ours）":"Current side (Git ours)",theirs:zh?"传入方（Git theirs）":"Incoming side (Git theirs)",base:zh?"共同祖先":"Common ancestor",working:zh?"工作目录":"Working copy"};
  const reference:SourceControlFileVersion|undefined=file?.[comparison];
  const markers=draft?.resolution==="edited"&&/^(?:<{7,}|={7,}|>{7,}|\|{7,})(?:\s|$)/mu.test(draft.content);
  const rememberUndo=():void=>{if(draft)setUndo(previous=>[...previous.slice(-9),{...draft}]);setRedo([]);};
  const undoChoice=():void=>{const previous=undo.at(-1);if(!file||!draft||!previous)return;setRedo(items=>[...items.slice(-9),{...draft}]);setCurrentDraft(previous);setStale(previous.fileVersion!==file.token);setNeedsReload(false);setUndo(items=>items.slice(0,-1));};
  const redoChoice=():void=>{const next=redo.at(-1);if(!file||!draft||!next)return;setUndo(items=>[...items.slice(-9),{...draft}]);setCurrentDraft(next);setStale(next.fileVersion!==file.token);setNeedsReload(false);setRedo(items=>items.slice(0,-1));};
  const adopt=():void=>{
    if(!file||!draft||busy)return;rememberUndo();setError("");setNotice("");
    if(comparison==="working"){setCurrentDraft({...draft,content:file.working.content??"",resolution:"edited",changed:false,fileVersion:file.token});setStale(false);return;}
    const version=file[comparison];setCurrentDraft({...draft,content:version.content??"",resolution:comparison,changed:true});
  };
  const save=async(stage:boolean):Promise<void>=>{
    if(!file||!draftRef.current||busyRef.current||loadingRef.current||stale)return;busyRef.current=true;setBusy(true);onBusyRef.current?.(true);setError("");setNotice("");
    const sent={...draftRef.current};
    try{
      const result=await requestCore<SourceControlSaveResult>("scm.save",{...scope,path,fileVersion:sent.fileVersion,resolution:sent.resolution,...(sent.resolution==="edited"?{content:sent.content}:{}),stage});
      if(disposed.current)return;
      if(!result.saved)throw new Error(zh?"文件保存结果无效，请重新读取。":"Invalid save result. Reload the file.");
      if(result.file&&(result.file.rootPath!==rootPath||result.file.path!==path))throw new Error(zh?"保存结果属于其他工作目录，请重新读取。":"Save result belongs to another worktree. Reload the file.");
      if(result.file){setFile(result.file);setCurrentDraft({...sent,fileVersion:result.file.token,content:result.error?sent.content:result.file.working.content??sent.content,resolution:result.error?sent.resolution:"edited",changed:!!result.error});setStale(false);}
      else{setCurrentDraft({...sent,changed:true});setStale(true);setNeedsReload(true);}
      if(result.error&&/又被|核对状态失败/u.test(result.error)){setStale(true);setNeedsReload(!result.file);setComparison("working");}
      if(result.error){setError(result.error);setNotice(zh?"文件已保存，请处理标记或刷新错误":"File saved. Check staging or refresh errors.");}
      else{setNotice(stage?(zh?"已保存并加入此次提交":"Saved and included in this commit"):(zh?"文件已保存，尚未加入此次提交":"File saved. Not yet included in this commit."));setUndo([]);setRedo([]);}
      onSaved(result.status,stage&&result.staged&&result.file?.conflict===false&&!result.error);
    }catch(error){if(!disposed.current){setError(String(error));if(/已改变|不再处于冲突/u.test(String(error))){setStale(true);setNeedsReload(true);}}}
    finally{busyRef.current=false;onBusyRef.current?.(false);if(!disposed.current)setBusy(false);}
  };
  const discardDraft=():void=>{if(!file||!draft)return;rememberUndo();setCurrentDraft({...draft,fileVersion:file.token,content:file.working.content??"",resolution:"edited",changed:false});setStale(false);setNotice("");setError("");};
  const chosenVersion=draft&&(draft.resolution==="ours"||draft.resolution==="theirs"||draft.resolution==="base")?file?.[draft.resolution]:undefined;
  const deletes=draft?.resolution==="delete"||chosenVersion?.exists===false;
  const canEdit=!!file?.editable&&!deletes;
  const large=file?.working.truncated||chosenVersion?.truncated;
  const binary=file?.working.binary||chosenVersion?.binary;
  return <div className="scm-editor" onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="s"){event.preventDefault();void save(event.shiftKey);}}}>
    <div className="scm-editor-heading"><button type="button" className="workspace-panel-icon" aria-label={zh?"返回差异并保留草稿":"Back to diff, keep draft"} disabled={busy} onClick={()=>{flush();onClose();}}><ArrowLeft size={15}/></button><FileDiff size={15}/><span title={path}>{path}</span><small>{file?.conflict?(zh?"合并结果":"Merge result"):(zh?"编辑文件":"Edit file")}</small><button type="button" className="workspace-panel-icon" aria-label={zh?"刷新冲突版本并保留草稿":"Reload conflict versions, keep draft"} title={zh?"刷新对照版本，保留草稿":"Reload versions, keep draft"} disabled={busy||loading} onClick={()=>{void load();}}><RefreshCw size={14} className={loading?"animate-spin":""}/></button></div>
    {error&&<div className="scm-error" role="alert">{error}<button type="button" disabled={busy||loading} onClick={()=>{void load();}}>{zh?"刷新版本":"Reload versions"}</button></div>}
    {notice&&<div className="scm-notice" role="status"><Check size={13}/>{notice}</div>}
    {!durable&&<div className="scm-operation" role="status"><AlertCircle size={14}/>{zh?"草稿当前只保留在本次运行中，请及时保存文件。":"Draft is held in this app run only. Save the file soon."}</div>}
    {stale&&file&&draft&&<div className="scm-editor-stale" role="status"><span>{zh?"原文件或 Git 版本已有更新，草稿已保留。请核对最新对照后再保存。":"The file or Git version changed. Your draft is retained. Review the latest version before saving."}</span><button type="button" disabled={busy||loading} onClick={()=>{if(needsReload){void load();return;}setCurrentDraft({...draft,fileVersion:file.token,resolution:file.conflict?draft.resolution:"edited",changed:true});setStale(false);setError("");}}>{needsReload?(zh?"刷新对照，保留草稿":"Reload versions, keep draft"):(zh?"已核对，采用最新对照":"Use reviewed latest version")}</button></div>}
    {loading&&!file?<div className="scm-empty" role="status"><Loader2 size={20} className="animate-spin"/>{zh?"正在读取冲突版本":"Loading conflict versions"}</div>:file&&draft?<>
      <div className="scm-editor-controls"><label><span>{zh?"对照":"Compare"}</span><SelectField aria-label={zh?"合并对照版本":"Merge comparison version"} value={comparison} disabled={busy||loading} options={(file.conflict?["ours","theirs","base","working"]:["working"]) .map(value=>({value,label:sideLabels[value as Side]}))} onValueChange={value=>setComparison(value as Side)}/></label><Button size="sm" variant="ghost" disabled={busy||loading||comparison==="working"&&!file.editable} onClick={adopt}>{comparison==="working"||reference?.exists?(zh?"采用此版本":"Use this version"):(zh?"采用此方删除":"Use this side's deletion")}</Button>{undo.length>0&&<button type="button" className="workspace-panel-icon" disabled={busy} aria-label={zh?"撤销采用版本":"Undo version choice"} onClick={undoChoice}><RotateCcw size={14}/></button>}{redo.length>0&&<button type="button" className="workspace-panel-icon" disabled={busy} aria-label={zh?"重做采用版本":"Redo version choice"} onClick={redoChoice}><RotateCw size={14}/></button>}<span className="scm-editor-dirty">{draft.changed?(zh?"未保存的草稿":"Unsaved draft"):(zh?"与文件一致":"Matches file")}</span></div>
      {markers&&<div className="scm-editor-marker-warning"><AlertCircle size={13}/>{zh?"结果中仍有冲突标记，可先保存后继续编辑。":"Conflict markers remain. You can save and continue editing."}</div>}
      <div ref={surface} className="scm-editor-surface">
        {!canEdit?<div className="scm-empty"><FileDiff size={26}/><p>{deletes?(zh?"此结果将删除文件":"This result deletes the file"):large?(zh?"文件较大，采用完整版本以保留全部内容":"Large file. Use a complete version to preserve all contents."):binary?(zh?"二进制或其他编码文件，可采用完整版本":"Binary or other-encoding file. Choose a complete version."):(zh?"此文件不提供文本编辑":"Text editing is unavailable for this file")}</p><span>{draft.resolution!=="edited"?(zh?"保存时将采用所选原生版本。":"Saving uses the selected native version."):(zh?"选择对照版本，再采用完整版本；二进制和大文件由原生 Git 还原。":"Choose a side and use its complete version. Native Git restores binary and large files.")}</span></div>:<>
          {wide&&<div className="scm-code-labels"><span>{sideLabels[comparison]}{reference?.exists===false?(zh?" · 文件不存在":" · file absent"):""}</span><span>{zh?"合并结果（可编辑）":"Merge result (editable)"}</span></div>}
          <Suspense fallback={<div className="scm-empty" role="status"><Loader2 size={18} className="animate-spin"/>{zh?"正在加载编辑器":"Loading editor"}</div>}><CodeEditor key={`${rootPath}:${path}:${typeof reference?.content==="string"||reference?.exists===false?"diff":"plain"}`} before={reference?.content??(reference?.exists===false?"":undefined)} value={draft.content} filePath={path} readOnly={busy} sideBySide={wide} hideUnchanged={false} onChange={content=>{setRedo([]);setCurrentDraft({...draftRef.current!,content,resolution:"edited",changed:true});setNotice("");}}/></Suspense>
        </>}
      </div>
      <footer className="scm-editor-footer"><button type="button" className="scm-text-action" disabled={busy||!draft.changed} onClick={discardDraft}>{zh?"恢复文件内容":"Restore file content"}</button><span>{zh?"Ctrl+S 保存 · Ctrl+Shift+S 加入提交":"Ctrl+S save · Ctrl+Shift+S include in commit"}</span><Button variant="outline" size="sm" disabled={busy||loading||stale||!canEdit&&draft.resolution==="edited"} onClick={()=>{void save(false);}}><Save size={13}/>{zh?"保存文件":"Save file"}</Button><Button className="scm-resolve-submit" variant="primary" size="sm" disabled={busy||loading||stale||!canEdit&&draft.resolution==="edited"} onClick={()=>{void save(true);}}>{busy?<Loader2 size={13} className="animate-spin"/>:<Check size={13}/>} {deletes?(zh?"删除并标记已解决":"Delete and resolve"):file.conflict?(zh?"保存并标记已解决":"Save and resolve"):(zh?"保存并加入提交":"Save and include")}</Button></footer>
    </>:draft?.changed?<div className="scm-draft-recovery"><p>{zh?"文件暂不可用，未保存的草稿仍可复制。重新创建或恢复文件后，可刷新对照继续编辑。":"The file is unavailable. Your unsaved draft can still be copied. Restore the file, then reload to continue editing."}</p><textarea aria-label={zh?"保留的文件草稿":"Retained file draft"} value={draft.content} readOnly onFocus={event=>event.currentTarget.select()}/></div>:<div className="scm-empty">{zh?"无法读取此文件，请刷新后重试":"Unable to load this file. Reload to retry."}</div>}
  </div>;
}
