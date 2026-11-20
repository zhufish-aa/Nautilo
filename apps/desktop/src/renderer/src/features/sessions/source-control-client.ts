import type {SourceControlCommit,SourceControlDiff,SourceControlRepository,SourceControlScope,SourceControlStatus,SourceControlMutation,SourceControlSave,SourceControlSaveResult} from "@agenthub/schemas";
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
  const mutations=new Map<string,Promise<unknown>>();
  const generations=new Map<string,number>();
  const rootKey=(root:string)=>/^[a-z]:[\\/]/i.test(root)?root.replaceAll("\\","/").replace(/\/$/,"").toLowerCase():root.replace(/\/$/,"");
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
    const root=rootKey(JSON.parse(key)[2]),generation=generations.get(root)??0;
    const result=read().then(value=>{
      const size=JSON.stringify(value).length*2;
      if((generations.get(root)??0)===generation&&size<=16*1024*1024){const old=previews.get(key);bytes-=old?.size??0;previews.set(key,{value,size});bytes+=size;while(previews.size>24||bytes>16*1024*1024){const oldest=previews.entries().next().value;if(!oldest)break;bytes-=oldest[1].size;previews.delete(oldest[0]);}}
      return value;
    }).finally(()=>{if(pending.get(key)===result)pending.delete(key);});
    pending.set(key,result);return result;
  };
  const diffKey=(scope:SourceControlScope,repository:SourceControlRepository,selection:Selection)=>JSON.stringify(["diff",scopeKey(scope),repository.rootPath,repository.changes.find(file=>file.path===selection.path)?.version??repository.token,selection.path,selection.source]);
  const commitKey=(scope:SourceControlScope,root:string,hash:string)=>JSON.stringify(["commit",scopeKey(scope),root,hash]);
  const commitDiffKey=(scope:SourceControlScope,root:string,hash:string,path:string)=>JSON.stringify(["commitDiff",scopeKey(scope),root,hash,path]);
  const invalidate=(root:string,paths?:string[])=>{
    generations.set(rootKey(root),(generations.get(rootKey(root))??0)+1);
    for(const key of pending.keys()){const parts=JSON.parse(key);if(parts[0]==="diff"&&rootKey(parts[2])===rootKey(root)&&(!paths||paths.includes(parts[4])))pending.delete(key);}
    for(const [key,item] of previews){const parts=JSON.parse(key);if(parts[0]==="diff"&&rootKey(parts[2])===rootKey(root)&&(!paths||paths.includes(parts[4]))){bytes-=item.size;previews.delete(key);}}
    for(const entry of snapshots.values())if(entry.value?.available&&rootKey(entry.value.rootPath)===rootKey(root)){entry.revision++;entry.flight=undefined;}
  };
  const serialize=<T>(root:string,action:()=>Promise<T>):Promise<T>=>{
    const key=rootKey(root),previous=mutations.get(key)??Promise.resolve();
    const next=previous.catch(()=>{}).then(action);
    mutations.set(key,next);
    void next.finally(()=>{if(mutations.get(key)===next)mutations.delete(key);}).catch(()=>{});
    return next;
  };
  return {
    peekStatus:(scope:SourceControlScope)=>snapshot(scope).value,
    rememberStatus(scope:SourceControlScope,value:SourceControlStatus){const entry=snapshot(scope);entry.revision++;entry.flight=undefined;return remember(entry,value);},
    status(scope:SourceControlScope):Promise<SourceControlStatus>{
      const entry=snapshot(scope);if(entry.flight)return entry.flight;
      let revision=entry.revision;
      const wait=entry.value?.available?mutations.get(rootKey(entry.value.rootPath)):undefined;
      const read=()=>{revision=entry.revision;return request<SourceControlStatus>("scm.status",scope);};
      const flight=(wait?wait.catch(()=>{}).then(read):read()).then(value=>entry.revision===revision?remember(entry,value):entry.value??value).finally(()=>{if(entry.flight===flight)entry.flight=undefined;});
      entry.flight=flight;return flight;
    },
    mutate(scope:SourceControlScope,root:string,input:Omit<SourceControlMutation,keyof SourceControlScope>){
      return serialize(root,async()=>{
        invalidate(root,input.paths);
        try{const result=await request<{status:SourceControlRepository;output?:string}>("scm.mutate",{...scope,...input});
          remember(snapshot(scope),result.status);return result;
        }finally{invalidate(root,input.paths);}
      });
    },
    save(root:string,input:SourceControlSave):Promise<SourceControlSaveResult>{
      return serialize(root,async()=>{try{return await request<SourceControlSaveResult>("scm.save",input);}finally{invalidate(root,[input.path]);}});
    },
    peekDiff:(scope:SourceControlScope,repository:SourceControlRepository,selection:Selection)=>peek<SourceControlDiff>(diffKey(scope,repository,selection)),
    diff:(scope:SourceControlScope,repository:SourceControlRepository,selection:Selection)=>memo(diffKey(scope,repository,selection),async()=>{const value=await request<SourceControlDiff>("scm.diff",{...scope,...selection});if(value.path!==selection.path||value.source!==selection.source||value.rootPath&&rootKey(value.rootPath)!==rootKey(repository.rootPath))throw Error("Repository changed. Refresh and retry.");return value;}),
    peekCommit:(scope:SourceControlScope,root:string,hash:string)=>peek<SourceControlCommit>(commitKey(scope,root,hash)),
    peekCommitDiff:(scope:SourceControlScope,root:string,hash:string,path:string)=>peek<SourceControlDiff>(commitDiffKey(scope,root,hash,path)),
    commit:(scope:SourceControlScope,root:string,hash:string)=>memo(commitKey(scope,root,hash),async()=>{const value=await request<SourceControlCommit>("scm.commit",{...scope,hash});if(value.rootPath!==root||value.hash!==hash)throw Error("Repository changed. Refresh and retry.");return value;}),
    commitDiff:(scope:SourceControlScope,root:string,hash:string,path:string)=>memo(commitDiffKey(scope,root,hash,path),async()=>{const value=await request<SourceControlDiff>("scm.commitDiff",{...scope,hash,path});if(value.rootPath!==root||value.commitHash!==hash||value.path!==path)throw Error("Commit diff changed. Refresh and retry.");return value;})
  };
}

export const sourceControlClient=createSourceControlClient();
