import type {SourceControlCommit,SourceControlDiff,SourceControlRepository,SourceControlScope,SourceControlStatus} from "@agenthub/schemas";
import {requestCore} from "../../lib/bridge";

type Request = <T>(method:string,input:unknown)=>Promise<T>;
type Snapshot = {value?:SourceControlStatus;flight?:Promise<SourceControlStatus>;revision:number};
type Selection = {path:string;source:"worktree"|"index"};
const scopeKey=(scope:SourceControlScope)=>JSON.stringify([scope.sessionId??null,scope.projectId??null]);

/** Memory only: file contents and repository paths never enter persistent UI storage. */
export function createSourceControlClient(request:Request=requestCore) {
  const snapshots=new Map<string,Snapshot>();
  const previews=new Map<string,{value:SourceControlDiff|SourceControlCommit;size:number}>();
  const pending=new Map<string,Promise<unknown>>();
  let bytes=0;
  const snapshot=(scope:SourceControlScope):Snapshot=>{
    const key=scopeKey(scope);let entry=snapshots.get(key);
    if(!entry){entry={revision:0};snapshots.set(key,entry);}
    if(snapshots.size>16)for(const [old,item] of snapshots){if(old!==key&&!item.flight){snapshots.delete(old);break;}}
    return entry;
  };
  const remember=(entry:Snapshot,value:SourceControlStatus):SourceControlStatus=>{
    if(!entry.value||JSON.stringify(entry.value)!==JSON.stringify(value))entry.value=value;
    return entry.value;
  };
  const peek=<T>(key:string):T|undefined=>{
    const item=previews.get(key);if(!item)return;
    previews.delete(key);previews.set(key,item);return item.value as T;
  };
  const memo=<T extends SourceControlDiff|SourceControlCommit>(key:string,read:()=>Promise<T>):Promise<T>=>{
    const cached=peek<T>(key);if(cached)return Promise.resolve(cached);
    const flight=pending.get(key);if(flight)return flight as Promise<T>;
    const result=read().then(value=>{
      const size=JSON.stringify(value).length*2;
      if(size<=16*1024*1024){previews.set(key,{value,size});bytes+=size;while(previews.size>24||bytes>16*1024*1024){const oldest=previews.entries().next().value;if(!oldest)break;bytes-=oldest[1].size;previews.delete(oldest[0]);}}
      return value;
    }).finally(()=>{if(pending.get(key)===result)pending.delete(key);});
    pending.set(key,result);return result;
  };
  const diffKey=(scope:SourceControlScope,repository:SourceControlRepository,selection:Selection)=>JSON.stringify(["diff",scopeKey(scope),repository.rootPath,repository.token,selection.path,selection.source]);
  const commitKey=(scope:SourceControlScope,root:string,hash:string)=>JSON.stringify(["commit",scopeKey(scope),root,hash]);
  const commitDiffKey=(scope:SourceControlScope,root:string,hash:string,path:string)=>JSON.stringify(["commitDiff",scopeKey(scope),root,hash,path]);
  return {
    peekStatus:(scope:SourceControlScope)=>snapshot(scope).value,
    rememberStatus(scope:SourceControlScope,value:SourceControlStatus){const entry=snapshot(scope);entry.revision++;entry.flight=undefined;return remember(entry,value);},
    status(scope:SourceControlScope):Promise<SourceControlStatus>{
      const entry=snapshot(scope);if(entry.flight)return entry.flight;
      const revision=entry.revision;
      const flight=request<SourceControlStatus>("scm.status",scope).then(value=>entry.revision===revision?remember(entry,value):entry.value??value).finally(()=>{if(entry.flight===flight)entry.flight=undefined;});
      entry.flight=flight;return flight;
    },
    peekDiff:(scope:SourceControlScope,repository:SourceControlRepository,selection:Selection)=>peek<SourceControlDiff>(diffKey(scope,repository,selection)),
    diff:(scope:SourceControlScope,repository:SourceControlRepository,selection:Selection)=>memo(diffKey(scope,repository,selection),async()=>{const value=await request<SourceControlDiff>("scm.diff",{...scope,...selection});if(value.path!==selection.path||value.source!==selection.source||value.rootPath&&value.rootPath!==repository.rootPath)throw Error("Repository changed. Refresh and retry.");return value;}),
    peekCommit:(scope:SourceControlScope,root:string,hash:string)=>peek<SourceControlCommit>(commitKey(scope,root,hash)),
    peekCommitDiff:(scope:SourceControlScope,root:string,hash:string,path:string)=>peek<SourceControlDiff>(commitDiffKey(scope,root,hash,path)),
    commit:(scope:SourceControlScope,root:string,hash:string)=>memo(commitKey(scope,root,hash),async()=>{const value=await request<SourceControlCommit>("scm.commit",{...scope,hash});if(value.rootPath!==root||value.hash!==hash)throw Error("Repository changed. Refresh and retry.");return value;}),
    commitDiff:(scope:SourceControlScope,root:string,hash:string,path:string)=>memo(commitDiffKey(scope,root,hash,path),async()=>{const value=await request<SourceControlDiff>("scm.commitDiff",{...scope,hash,path});if(value.rootPath!==root||value.commitHash!==hash||value.path!==path)throw Error("Commit diff changed. Refresh and retry.");return value;})
  };
}

export const sourceControlClient=createSourceControlClient();
