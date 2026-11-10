import type {SourceControlCommit,SourceControlCommitFile,SourceControlDiff} from "@agenthub/schemas";
import {sourceTreeText,type SourceGitReader} from "./source-control-content.js";
async function resolve(root:string,hash:string,io:SourceGitReader):Promise<string>{
  if(!/^(?:[\da-f]{40}|[\da-f]{64})$/iu.test(hash))throw new Error("请选择有效的提交记录");return(await io.checked(root,["rev-parse","--verify",hash+"^{commit}"])).trim();
}
async function base(root:string,parents:string[],io:SourceGitReader):Promise<string>{return parents[0]??(await io.checked(root,["hash-object","-t","tree","--stdin"],"")).trim();}
export async function readSourceCommit(root:string,hash:string,io:SourceGitReader,validPath:(path:string)=>void):Promise<SourceControlCommit>{
  hash=await resolve(root,hash,io);const metadata=(await io.checked(root,["show","-s","--format=%H%x00%P%x00%s%x00%b%x00%an%x00%ae%x00%cI",hash])).replace(/[\r\n]+$/u,"").split("\0");
  if(metadata.length!==7)throw new Error("Git 提交记录不完整");const[,parentList,subject,body,author,authorEmail,committedAt]=metadata,parents=parentList.split(" ").filter(Boolean),comparison=await base(root,parents,io);
  const names=(await io.checked(root,["diff","--no-ext-diff","--no-textconv","--name-status","-z","-M",comparison,hash,"--"])).split("\0"),files:SourceControlCommitFile[]=[];
  for(let cursor=0;cursor<names.length&&names[cursor];){const status=names[cursor++],first=names[cursor++];if(!first)throw new Error("Git 文件变更记录不完整");validPath(first);let name=first,originalPath:string|undefined;
    if(/[RC]/u.test(status[0])){originalPath=first;name=names[cursor++];if(!name)throw new Error("Git 重命名记录不完整");validPath(name);}files.push({path:name,originalPath,status:status[0],binary:false});}
  const stats=(await io.checked(root,["diff","--no-ext-diff","--no-textconv","--numstat","-z","-M",comparison,hash,"--"])).split("\0");
  for(let cursor=0;cursor<stats.length&&stats[cursor];){const record=stats[cursor++],first=record.indexOf("\t"),second=record.indexOf("\t",first+1);if(first<0||second<0)throw new Error("Git 变更统计不完整");const added=record.slice(0,first),removed=record.slice(first+1,second);let name=record.slice(second+1);if(!name){if(cursor+1>=stats.length)throw new Error("Git 重命名统计不完整");cursor++;name=stats[cursor++];}const file=files.find(file=>file.path===name);if(file){file.binary=added==="-"||removed==="-";if(!file.binary){file.additions=Number(added);file.deletions=Number(removed);}}}
  return{rootPath:root,hash,parents,subject,body,author,authorEmail,committedAt,files};
}
export async function readSourceCommitDiff(root:string,input:{hash:string;path:string},io:SourceGitReader,validPath:(path:string)=>void):Promise<SourceControlDiff>{
  validPath(input.path);const commit=await readSourceCommit(root,input.hash,io,validPath),file=commit.files.find(file=>file.path===input.path);if(!file)throw new Error("此文件不在所选提交的更改中");
  const comparison=await base(root,commit.parents,io),original=file.originalPath??file.path,result=await io.git(root,["diff","--no-ext-diff","--no-textconv","--no-color","--patch","-M",comparison,commit.hash,"--",original,file.path],undefined,1024*1024);
  if(result.code!==0)throw new Error(result.stderr);const before=await sourceTreeText(root,commit.parents[0],original,io),after=await sourceTreeText(root,commit.hash,file.path,io),previewReason=before.reason??after.reason;
  return{rootPath:root,path:file.path,source:"commit",commitHash:commit.hash,patch:result.stdout,binary:file.binary,truncated:result.truncated,...(previewReason?{previewReason}:{before:before.text,after:after.text})};
}
