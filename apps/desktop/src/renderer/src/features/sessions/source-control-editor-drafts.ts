import type {SourceControlSave} from "@agenthub/schemas";
import {toast} from "../../stores/toast";
import {useSettingsStore} from "../../stores/settings";
export interface SourceFileDraft {version:1;rootPath:string;path:string;fileVersion:string;content:string;resolution:NonNullable<SourceControlSave["resolution"]>;changed:boolean}
interface DraftCache {memory:Map<string,SourceFileDraft>;pending:Set<string>;beforeUnload?:(event:BeforeUnloadEvent)=>void}
const host=typeof window==="undefined"?undefined:window as Window&{__nautiloScmDraftsV1?:DraftCache};
const cache:DraftCache=host?.__nautiloScmDraftsV1??{memory:new Map(),pending:new Set()};
const memory=cache.memory;
if(host){
  host.__nautiloScmDraftsV1=cache;
  if(cache.beforeUnload)host.removeEventListener("beforeunload",cache.beforeUnload);
  cache.beforeUnload=event=>{
    let retained=true;for(const id of [...cache.pending]){const value=memory.get(id);if(value&&!rememberSourceDraft(value,true))retained=false;}
    if(!retained){event.preventDefault();event.returnValue="";toast.error(useSettingsStore.getState().locale==="zh-CN"?"还有未能持久保存的文件草稿，请先保存文件或复制草稿后关闭。":"Some file drafts could not be stored. Save or copy them before closing.");}
  };
  host.addEventListener("beforeunload",cache.beforeUnload);
}
if(host) host.addEventListener("storage",event=>{
  if(event.key?.startsWith("nautilo.scm.file-draft.v1.") && !cache.pending.has(event.key)) memory.delete(event.key);
});
export function flushSourceDrafts():boolean {
  for(const id of [...cache.pending]){
    const value=memory.get(id);
    if(value && !rememberSourceDraft(value,true)) return false;
  }
  return true;
}
const key=(root:string,path:string)=>`nautilo.scm.file-draft.v1.${encodeURIComponent(root)}.${encodeURIComponent(path)}`;
export function readSourceDraft(root:string,path:string):SourceFileDraft|undefined{
  const id=key(root,path),cached=memory.get(id);if(cached)return{...cached};
  try{const value=JSON.parse(localStorage.getItem(id)??"null") as SourceFileDraft|null;if(value?.version===1&&value.rootPath===root&&value.path===path&&typeof value.fileVersion==="string"&&typeof value.content==="string"&&value.content.length<=4*1024*1024&&value.changed&&["edited","ours","theirs","base","delete"].includes(value.resolution)){memory.set(id,value);return{...value};}}catch{/* A bad draft cannot replace native file data. */}return undefined;
}
export function rememberSourceDraft(value:SourceFileDraft,persist=false):boolean{
  const id=key(value.rootPath,value.path);if(!value.changed){memory.delete(id);cache.pending.delete(id);try{localStorage.removeItem(id);}catch{}return true;}memory.set(id,{...value});cache.pending.add(id);
  if(persist)try{localStorage.setItem(id,JSON.stringify(value));cache.pending.delete(id);}catch{return false;}return true;
}
export function sourceDrafts(root:string):SourceFileDraft[]{
  const prefix=`nautilo.scm.file-draft.v1.${encodeURIComponent(root)}.`,paths=new Set([...memory.values()].filter(value=>value.rootPath===root&&value.changed).map(value=>value.path));
  try{for(let index=0;index<localStorage.length;index++){const id=localStorage.key(index);if(id?.startsWith(prefix))paths.add(decodeURIComponent(id.slice(prefix.length)));}}catch{/* In-memory drafts remain recoverable. */}
  return [...paths].map(path=>readSourceDraft(root,path)).filter((draft):draft is SourceFileDraft=>!!draft?.changed);
}
