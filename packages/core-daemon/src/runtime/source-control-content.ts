import {lstat,open,readlink} from "node:fs/promises";
import {join} from "node:path";
import type {SourceControlChange,SourceControlDiff} from "@agenthub/schemas";
export interface SourceGitOutput {code:number;stdout:string;bytes:Buffer;stderr:string;truncated:boolean}
export interface SourceGitReader {
  git(root:string,args:string[],input?:string,limit?:number,raw?:boolean):Promise<SourceGitOutput>;
  checked(root:string,args:string[],input?:string):Promise<string>;
}
const LIMIT=1024*1024;
export function sourceNumstat(raw:string,validPath:(path:string)=>void):Map<string,{additions?:number;deletions?:number;binary:boolean}>{
  const records=raw.split("\0"),result=new Map<string,{additions?:number;deletions?:number;binary:boolean}>();
  for(let cursor=0;cursor<records.length&&records[cursor];){const record=records[cursor++],first=record.indexOf("\t"),second=record.indexOf("\t",first+1);if(first<0||second<0)throw new Error("Git 变更统计不完整");const added=record.slice(0,first),removed=record.slice(first+1,second);let name=record.slice(second+1);if(!name){if(cursor+1>=records.length)throw new Error("Git 重命名统计不完整");cursor++;name=records[cursor++];}validPath(name);const binary=added==="-"||removed==="-";result.set(name,binary?{binary}:{binary,additions:Number(added),deletions:Number(removed)});}return result;
}
interface TextVersion {text?:string;reason?:SourceControlDiff["previewReason"]}
function decode(bytes:Buffer,truncated=false):TextVersion {
  if(truncated)return{reason:"large"};if(bytes.includes(0))return{reason:"binary"};
  try{return{text:new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes)}}catch{return{reason:"encoding"}}
}
async function blob(root:string,mode:string,oid:string,io:SourceGitReader):Promise<TextVersion>{
  if(mode==="160000")return{reason:"submodule"};const result=await io.git(root,["cat-file","blob",oid],undefined,LIMIT,true);
  if(result.code!==0)throw new Error(result.stderr);return decode(result.bytes,result.truncated);
}
export async function sourceTreeText(root:string,revision:string|undefined,name:string,io:SourceGitReader):Promise<TextVersion>{
  if(!revision)return{text:""};const entries=await io.checked(root,["ls-tree","-z",revision,"--",name]);
  for(const entry of entries.split("\0").filter(Boolean)){const tab=entry.indexOf("\t"),[mode,,oid]=entry.slice(0,tab).split(" ");if(tab<0||!oid)throw new Error("Git 文件记录不完整");if(entry.slice(tab+1)===name)return blob(root,mode,oid,io);}
  return{text:""};
}
async function indexText(root:string,name:string,stage:string,io:SourceGitReader):Promise<TextVersion>{
  const entries=await io.checked(root,["ls-files","--stage","-z","--",name]);
  for(const entry of entries.split("\0").filter(Boolean)){const tab=entry.indexOf("\t"),[mode,oid,version]=entry.slice(0,tab).split(" ");if(tab<0||!version)throw new Error("Git 暂存记录不完整");if(entry.slice(tab+1)===name&&version===stage)return blob(root,mode,oid,io);}
  return{text:""};
}
async function workingText(root:string,name:string):Promise<TextVersion>{
  const target=join(root,name);let info;try{info=await lstat(target)}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return{text:""};throw error;}
  if(info.isSymbolicLink())return{text:await readlink(target)};if(!info.isFile())return{reason:"submodule"};
  const file=await open(target,"r");try{const bytes=Buffer.alloc(LIMIT+1);let size=0;while(size<bytes.length){const result=await file.read(bytes,size,bytes.length-size,size);if(!result.bytesRead)break;size+=result.bytesRead;}return decode(bytes.subarray(0,size),size>LIMIT);}finally{await file.close();}
}
export async function sourcePreviewIdentity(root:string,name:string,change:SourceControlChange,source:string,io:SourceGitReader,fileToken:(root:string,path:string)=>Promise<string>):Promise<string>{
  const head=await io.git(root,["rev-parse","--verify","--quiet","HEAD"],undefined,8192),index=await io.checked(root,["ls-files","--stage","-z","--",name,change.originalPath??name]);
  return JSON.stringify([head.stdout,index,source==="worktree"&&!change.submodule?await fileToken(root,name):""]);
}
export async function attachSourceContent(root:string,change:SourceControlChange,expected:string,diff:SourceControlDiff,io:SourceGitReader,fileToken:(root:string,path:string)=>Promise<string>):Promise<SourceControlDiff>{
  if(change.submodule)return{...diff,previewReason:"submodule"};
  let before:TextVersion,after:TextVersion;
  if(diff.source==="index"){const head=await io.git(root,["rev-parse","--verify","--quiet","HEAD"],undefined,8192);before=await sourceTreeText(root,head.code===0?head.stdout.trim():undefined,change.originalPath??diff.path,io);after=await indexText(root,diff.path,"0",io);}
  else{before=await indexText(root,diff.path,change.conflict?"2":"0",io);await fileToken(root,diff.path);after=await workingText(root,diff.path);}
  if(expected!==await sourcePreviewIdentity(root,diff.path,change,diff.source,io,fileToken))throw new Error("文件内容已改变，正在等待最新差异，请重试。");
  const previewReason=before.reason??after.reason;return previewReason?{...diff,previewReason}:{...diff,before:before.text,after:after.text};
}
