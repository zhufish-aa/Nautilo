import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {chmod,lstat,mkdir,open,readlink,realpath,rename,rmdir,unlink} from "node:fs/promises";
import {basename,dirname,isAbsolute,join,relative} from "node:path";
import {randomUUID} from "node:crypto";
import type {SourceControlFile,SourceControlFileVersion,SourceControlSave} from "@agenthub/schemas";
import type {SourceGitReader} from "./source-control-content.js";

const PREVIEW=4*1024*1024,WRITE_LIMIT=PREVIEW;
type Entry={mode:string;oid:string;stage:number};
type IO=SourceGitReader&{validPath:(path:string)=>void};
const missing=(error:unknown):boolean=>(error as NodeJS.ErrnoException).code==="ENOENT";
const absent=():SourceControlFileVersion=>({exists:false,binary:false,truncated:false});
function version(bytes:Buffer,mode:string,truncated:boolean):SourceControlFileVersion{
  let content:string|undefined,binary=bytes.includes(0);if(!binary)try{content=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);}catch{binary=true;}
  return{exists:true,binary,truncated,mode,...(!binary&&!truncated?{content}: {})};
}
async function parent(root:string,name:string,io:IO):Promise<string>{
  io.validPath(name);let ancestor=dirname(join(root,name)),tail:string[]=[];let resolved:string;
  for(;;)try{resolved=await realpath(ancestor);break;}catch(error){if(!missing(error)||ancestor===dirname(ancestor))throw error;tail.push(basename(ancestor));ancestor=dirname(ancestor);}
  for(const part of tail.reverse())resolved=join(resolved,part);
  const outside=relative(await realpath(root),resolved);if(outside===".."||outside.startsWith("..\\")||outside.startsWith("../")||isAbsolute(outside))throw new Error("文件路径已指向工作目录之外");return resolved;
}
function entries(raw:string,name:string):Entry[]{return raw.split("\0").filter(Boolean).flatMap(record=>{const tab=record.indexOf("\t"),fields=record.slice(0,tab).split(" ");if(tab<0||fields.length!==3||!/^(?:[a-f\d]{40}|[a-f\d]{64})$/iu.test(fields[1]))throw new Error("Git 暂存记录无效");const stage=Number(fields[2]);if(!Number.isInteger(stage)||stage<0||stage>3)throw new Error("Git 冲突阶段无效");return record.slice(tab+1)===name?[{mode:fields[0],oid:fields[1],stage}]:[];});}
async function capture(root:string,name:string,io:IO){
  const resolvedParent=await parent(root,name,io),raw=await io.checked(root,["ls-files","--stage","-z","--",name]),index=entries(raw,name);
  const head=await io.git(root,["rev-parse","--verify","--quiet","HEAD"],undefined,8192),branch=await io.git(root,["symbolic-ref","--quiet","HEAD"],undefined,8192),config=await io.checked(root,["config","--null","--list"]),gitDir=(await io.checked(root,["rev-parse","--absolute-git-dir"])).trim();
  const attributes=await io.checked(root,["check-attr","--all","-z","--",name]);
  const digest=createHash("sha256").update(JSON.stringify([root,name,raw,head.stdout,branch.stdout,config,attributes,resolvedParent]));
  for(const marker of ["MERGE_HEAD","CHERRY_PICK_HEAD","REVERT_HEAD","rebase-merge/head-name","rebase-apply/head-name"]){
    let file;try{file=await open(join(gitDir,marker),"r");const bytes=Buffer.alloc(65537),result=await file.read(bytes,0,bytes.length,0);if(result.bytesRead>65536)throw new Error("Git 操作状态过大");digest.update(marker).update(bytes.subarray(0,result.bytesRead));}catch(error){if(!missing(error))throw error;}finally{await file?.close();}
  }
  const context=digest.copy().digest("hex");let contentHash:string;
  let working:SourceControlFileVersion,permissions:number|undefined;const target=join(root,name);
  try{
    const info=await lstat(target);
    if(info.isSymbolicLink()){const value=await readlink(target);contentHash=createHash("sha256").update("link:"+value).digest("hex");digest.update("link:"+value);working=version(Buffer.from(value),"120000",false);}
    else if(info.isFile()){
      const chunks:Buffer[]=[];let size=0,total=0;const fileHash=createHash("sha256");for await(const chunk of createReadStream(target)){const bytes=chunk as Buffer;fileHash.update(bytes);const keep=bytes.subarray(0,Math.max(0,PREVIEW-size));if(keep.length)chunks.push(keep);size+=keep.length;total+=bytes.length;}
      const mode=process.platform==="win32"?(index.find(entry=>entry.stage===0||entry.stage===2)?.mode==="100755"?"100755":"100644"):info.mode&0o111?"100755":"100644";permissions=info.mode;
      contentHash=fileHash.digest("hex");digest.update(JSON.stringify(["file",contentHash,info.mode,mode]));working=version(Buffer.concat(chunks),mode,total>PREVIEW);
    }else if(info.isDirectory()&&index.some(entry=>entry.mode==="160000")){contentHash='submodule';digest.update("submodule");working={exists:true,binary:true,truncated:false,mode:"160000"};}
    else throw new Error("此项目不是可编辑文件");
  }catch(error){if(!missing(error))throw error;contentHash=createHash("sha256").update("missing").digest("hex");digest.update("missing");working=absent();}
  return{token:digest.digest("hex"),context,contentHash,entries:index,working,permissions};
}
async function entryVersion(root:string,entry:Entry|undefined,io:IO):Promise<SourceControlFileVersion>{
  if(!entry)return absent();if(entry.mode==="160000")return{exists:true,content:entry.oid,binary:false,truncated:false,mode:entry.mode};
  const result=await io.git(root,["cat-file","blob",entry.oid],undefined,PREVIEW,true);if(result.code!==0)throw new Error(result.stderr);return version(result.bytes,entry.mode,result.truncated);
}
export async function readSourceFile(root:string,name:string,io:IO,allowMissing=false):Promise<SourceControlFile>{
  const before=await capture(root,name,io);
  if(!before.entries.length&&!allowMissing){const raw=await io.checked(root,["status","--porcelain=v2","-z","--untracked-files=all","--",name]);if(!raw)throw new Error("请选择一个 Git 文件");}
  const base=await entryVersion(root,before.entries.find(entry=>entry.stage===1),io),ours=await entryVersion(root,before.entries.find(entry=>entry.stage===2),io),theirs=await entryVersion(root,before.entries.find(entry=>entry.stage===3),io),index=await entryVersion(root,before.entries.find(entry=>entry.stage===0),io);
  if((await capture(root,name,io)).token!==before.token)throw new Error("文件内容已改变，请重新读取；当前编辑尚未保存。");
  return{rootPath:root,path:name,token:before.token,conflict:before.entries.some(entry=>entry.stage!==0),editable:!before.working.binary&&!before.working.truncated&&!before.entries.some(entry=>!["100644","100755"].includes(entry.mode))&&!["120000","160000"].includes(before.working.mode??""),working:before.working,base,ours,theirs,index};
}
function preserveText(content:string,working:SourceControlFileVersion):string{
  const previous=working.content??"";if(previous.includes("\r\n")&&!previous.replaceAll("\r\n","").includes("\n"))content=content.replaceAll("\r\n","\n").replaceAll("\n","\r\n");if(previous.startsWith("\ufeff")&&!content.startsWith("\ufeff"))content="\ufeff"+content;return content;
}
async function unchanged(root:string,name:string,expected:string,io:IO):Promise<void>{if((await capture(root,name,io)).token!==expected)throw new Error("文件或 Git 版本已改变，尚未覆盖文件。请刷新后重试。草稿仍保留。");}
async function cleanCheckout(prefix:string,target:string,gitDir:string):Promise<void>{
  const outside=relative(gitDir,prefix);if(!outside.startsWith(".nautilo-scm-")||outside.includes("/")||outside.includes("\\")||isAbsolute(outside))return;
  try{await unlink(target)}catch{}let directory=dirname(target);while(directory===prefix||directory.startsWith(prefix+"/")||directory.startsWith(prefix+"\\")){try{await rmdir(directory)}catch{}if(directory===prefix)break;directory=dirname(directory);}
}
function gitPath(value:string):string{if(value.startsWith("\\\\?\\UNC\\"))value="\\\\"+value.slice(8);else if(value.startsWith("\\\\?\\"))value=value.slice(4);return value.replaceAll("\\","/");}
export async function writeSourceFile(root:string,input:SourceControlSave,io:IO):Promise<{staged:boolean;error?:string}>{
  io.validPath(input.path);if(!input.fileVersion)throw new Error("缺少文件版本");const file=await readSourceFile(root,input.path,io);if(file.token!==input.fileVersion)throw new Error("文件内容、Git 版本或配置已改变，请刷新后重新保存。草稿仍保留。");
  if([file.base,file.ours,file.theirs,file.index].some(version=>version.mode==="160000"))throw new Error("子模块冲突请在原生终端处理，不能作为普通文件保存。");
  const resolution=input.resolution??"edited";if(resolution!=="edited"&&!file.conflict)throw new Error("此文件已不再处于冲突状态，请刷新后重试。");
  const before=await capture(root,input.path,io);if(before.token!==input.fileVersion)throw new Error("文件已改变，请刷新后重试。草稿仍保留。");const target=join(root,input.path);
  let expectedHash:string;
  const stage=({ours:2,theirs:3,base:1} as Record<string,number>)[resolution];if(!["edited","delete","ours","theirs","base"].includes(resolution))throw new Error("未知合并结果");
  const selected=before.entries.find(entry=>stage!==undefined&&entry.stage===stage);
  if(resolution==="edited"){
    if(!file.editable)throw new Error("此文件无法作为文本编辑；请采用完整版本。");if(typeof input.content!=="string"||input.content.includes("\0")||Buffer.byteLength(input.content)>WRITE_LIMIT)throw new Error("编辑内容过大或包含二进制数据");
    const content=preserveText(input.content,file.working);if(Buffer.byteLength(content)>WRITE_LIMIT)throw new Error("编辑内容过大");expectedHash=createHash("sha256").update(content).digest("hex");const intended=await parent(root,input.path,io);await mkdir(dirname(target),{recursive:true});if(await realpath(dirname(target))!==intended)throw new Error("文件父目录已改变，请重试");
    const temporary=join(dirname(target),'.nautilo-save-'+randomUUID()+'.tmp');let handle;
    try{handle=await open(temporary,"wx");await handle.writeFile(content,"utf8");await handle.sync();await handle.close();handle=undefined;if(before.permissions!==undefined&&process.platform!=="win32")await chmod(temporary,before.permissions);await unchanged(root,input.path,input.fileVersion,io);await rename(temporary,target);}finally{await handle?.close();try{await unlink(temporary)}catch{}}
  }else{
    if(selected){const gitDir=await realpath((await io.checked(root,["rev-parse","--absolute-git-dir"])).trim()),prefix=join(gitDir,'.nautilo-scm-'+randomUUID()),prepared=join(prefix,input.path);await mkdir(prefix);
      try{await io.checked(root,["checkout-index","--stage="+stage,"--force","--prefix="+gitPath(prefix)+"/","--stdin","-z"],input.path+"\0");const info=await lstat(prepared);if(info.isSymbolicLink())expectedHash=createHash("sha256").update("link:"+await readlink(prepared)).digest("hex");else{const digest=createHash("sha256");for await(const bytes of createReadStream(prepared))digest.update(bytes);expectedHash=digest.digest("hex");}const intended=await parent(root,input.path,io);await mkdir(dirname(target),{recursive:true});if(await realpath(dirname(target))!==intended)throw new Error("文件父目录已改变，请重试");await unchanged(root,input.path,input.fileVersion,io);await rename(prepared,target);}finally{await cleanCheckout(prefix,prepared,gitDir);}
    }else{expectedHash=createHash("sha256").update("missing").digest("hex");await unchanged(root,input.path,input.fileVersion,io);try{await unlink(target)}catch(error){if(!missing(error))throw error;}}
  }
  try{const after=await capture(root,input.path,io);if(after.context!==before.context||after.contentHash!==expectedHash)return{staged:false,error:"文件已写入，但文件或 Git 状态又被其他程序修改；尚未暂存，请刷新并核对。"};}catch(error){return{staged:false,error:"文件已保存，但核对状态失败："+String(error)};}
  if(input.stage){try{if(selected)await io.checked(root,["update-index","--add","--cacheinfo",selected.mode,selected.oid,input.path]);else await io.checked(root,["add","-A","--pathspec-from-file=-","--pathspec-file-nul"],input.path+"\0");return{staged:true};}catch(error){return{staged:false,error:'文件已保存，但暂存失败：'+String(error)};}}return{staged:false};
}
