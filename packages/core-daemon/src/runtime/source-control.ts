import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {createReadStream,existsSync} from "node:fs";
import {lstat,open,readlink,realpath} from "node:fs/promises";
import {dirname,isAbsolute,join,relative} from "node:path";
import type {SourceControlChange,SourceControlDiff,SourceControlMutation,SourceControlRepository,SourceControlStatus,SourceControlSave,SourceControlSaveResult} from "@agenthub/schemas";
import {describeSourcePatch,selectSourcePatch,sourcePatchToken} from "./source-control-patch.js";
import {attachSourceContent,sourcePreviewIdentity,sourceNumstat} from "./source-control-content.js";
import {readSourceCommit,readSourceCommitDiff} from "./source-control-history.js";
import {readSourceHistory} from "./source-control-history-page.js";
import {readSourceFile,writeSourceFile} from "./source-control-file.js";

const LIMIT=1024*1024;
interface GitOutput {code:number;stdout:string;bytes:Buffer;stderr:string;truncated:boolean}
async function git(cwd:string,args:string[],input?:string,limit=4*LIMIT,raw=false):Promise<GitOutput>{
  return new Promise((resolve,reject)=>{
    const child=spawn("git",["--no-pager","--literal-pathspecs","-c","core.quotepath=false","-c","color.ui=false","-C",cwd,...args],{shell:false,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:"0",GCM_INTERACTIVE:"Never",GIT_OPTIONAL_LOCKS:"0"},stdio:[input===undefined?"ignore":"pipe","pipe","pipe"]});
    const output:Buffer[]=[],errors:Buffer[]=[];let size=0,errorSize=0,truncated=false;
    const timer=setTimeout(()=>{child.kill();reject(new Error("Git 操作超时，请检查仓库、凭据或钩子后重试。"));},120000);
    child.stdout!.on("data",(chunk:Buffer)=>{const bytes=chunk.subarray(0,Math.max(0,limit-size));if(bytes.length)output.push(bytes);size+=bytes.length;truncated ||= bytes.length<chunk.length;});
    child.stderr!.on("data",(chunk:Buffer)=>{const bytes=chunk.subarray(0,Math.max(0,65536-errorSize));if(bytes.length)errors.push(bytes);errorSize+=bytes.length;truncated ||= bytes.length<chunk.length;});
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("close",code=>{clearTimeout(timer);try{const bytes=Buffer.concat(output);resolve({code:code??-1,stdout:raw||truncated?bytes.toString():new TextDecoder("utf-8",{fatal:true}).decode(bytes),bytes,stderr:Buffer.concat(errors).toString(),truncated});}catch{reject(new Error("Git 返回了无法识别的文件名或文本编码"));}});
    child.stdin?.on("error",error=>{child.kill();clearTimeout(timer);reject(error);});child.stdin?.end(input);
  });
}
async function checked(cwd:string,args:string[],input?:string):Promise<string>{const result=await git(cwd,args,input);if(result.code!==0)throw new Error(result.stderr.trim()||result.stdout.trim()||"Git 操作失败");if(result.truncated)throw new Error("Git 输出过大，请缩小操作范围后重试。");return result.stdout;}
function validPath(value:string):void {if(!value||value.includes("\0")||process.platform==="win32"&&value.includes("\\")||value.startsWith("/")||value.split("/").some(part=>["..",".",".git",""].includes(part))||value[1]===":")throw new Error("文件路径必须位于当前 Git 工作目录内");}
export function parseSourceControlStatus(raw:string):Pick<SourceControlRepository,"changes"|"ahead"|"behind"|"detached"|"head"|"branch"|"upstream"> {
  const state:ReturnType<typeof parseSourceControlStatus>={changes:[],ahead:0,behind:0,detached:false},records=raw.split("\0");
  for(let index=0;index<records.length;index++){
    const record=records[index];if(!record)continue;
    if(record.startsWith("# branch.oid ")){const value=record.slice(13);if(value!=="(initial)")state.head=value;continue;}
    if(record.startsWith("# branch.head ")){const value=record.slice(14);if(value==="(detached)")state.detached=true;else state.branch=value;continue;}
    if(record.startsWith("# branch.upstream ")){state.upstream=record.slice(18);continue;}
    if(record.startsWith("# branch.ab ")){const values=record.slice(12).split(" ");state.ahead=Number(values[0].slice(1));state.behind=Number(values[1].slice(1));continue;}
    if(record.startsWith("#"))continue;
    const kind=record[0];let name:string,xy:string,sub="N...",originalPath:string|undefined;
    if(kind==="?"){name=record.slice(2);xy="??";}else if(["1","2","u"].includes(kind)){
      const count=kind==="1"?9:kind==="2"?10:11;let cursor=0;const fields:string[]=[];
      for(let field=0;field<count-1;field++){const next=record.indexOf(" ",cursor);if(next<0)throw new Error("Git 状态记录不完整");fields.push(record.slice(cursor,next));cursor=next+1;}
      name=record.slice(cursor);xy=fields[1];sub=fields[2];if(kind==="2"){originalPath=records[++index];if(!originalPath)throw new Error("Git 重命名记录不完整");validPath(originalPath);}
    }else throw new Error("无法识别的 Git 状态记录");
    const directory=kind==="?"&&name.endsWith("/");if(directory)name=name.slice(0,-1);
    validPath(name);if(xy.length!==2)throw new Error("Git 文件状态无效");state.changes.push({path:name,originalPath,indexStatus:xy[0],worktreeStatus:xy[1],untracked:kind==="?",conflict:kind==="u",submodule:sub.startsWith("S"),directory});
  }return state;
}
async function repositoryRoot(cwd:string):Promise<string|undefined>{const result=await git(cwd,["rev-parse","--show-toplevel"],undefined,16384);return result.code===0?await realpath(result.stdout.trim()):undefined;}
const missing=(error:unknown):boolean=>(error as NodeJS.ErrnoException).code==="ENOENT";
async function fileToken(root:string,name:string):Promise<string>{
  validPath(name);const target=join(root,name);let parent=dirname(target),resolved:string;
  for(;;){try{resolved=await realpath(parent);break;}catch(error){if(!missing(error)||dirname(parent)===parent)throw error;parent=dirname(parent);}}
  const outside=relative(await realpath(root),resolved);if(outside===".."||outside.startsWith("../")||outside.startsWith("..\\")||isAbsolute(outside))throw new Error("文件路径已指向工作目录之外");
  const digest=createHash("sha256");try{const info=await lstat(target);if(info.isSymbolicLink())digest.update("link:"+await readlink(target));else if(info.isFile())for await(const bytes of createReadStream(target))digest.update(bytes);else throw new Error("此项目不是普通文件");}catch(error){if(!missing(error))throw error;digest.update("missing");}return digest.digest("hex");
}

/** A repository gate serializes UI operations while Git retains its native locks. */
export class SourceControl {
  private readonly tails=new Map<string,Promise<unknown>>();
  private async serial<T>(root:string,work:()=>Promise<T>):Promise<T>{const key=process.platform==="win32"?root.toLowerCase():root;const next=(this.tails.get(key)??Promise.resolve()).catch(()=>{}).then(work);this.tails.set(key,next);try{return await next;}finally{if(this.tails.get(key)===next)this.tails.delete(key);}}
  async status(cwd:string):Promise<SourceControlStatus>{const root=await repositoryRoot(cwd);return root?this.serial(root,()=>this.snapshot(cwd,root)):{schemaVersion:1,available:false,workingDirectory:cwd};}
  private async snapshot(cwd:string,root:string):Promise<SourceControlRepository>{
    const raw=await checked(root,["status","--porcelain=v2","-z","--branch","--untracked-files=all"]),parsed=parseSourceControlStatus(raw);
    const comparison=parsed.head??(await checked(root,["hash-object","-t","tree","--stdin"],"")).trim();
    const [statRaw,indexFile,branchRaw,remoteRaw,logRaw,gitDirectory,config,revisions]=await Promise.all([
      parsed.changes.length?checked(root,["diff","--no-ext-diff","--no-textconv","--numstat","-z","-M",comparison,"--"]):Promise.resolve(""),
      checked(root,["rev-parse","--path-format=absolute","--git-path","index"]),
      checked(root,["for-each-ref","--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(worktreepath)%00%(upstream:remotename)%00%(push:remotename)%00%(push:remoteref)%00","refs/heads/"]),
      checked(root,["remote"]),
      parsed.head?checked(root,["log","-20","--format=%H%x00%s%x00%an%x00%cI%x00"]):Promise.resolve(""),
      checked(root,["rev-parse","--absolute-git-dir"]),checked(root,["config","--null","--list"]),
      Promise.all(parsed.changes.map(async file=>{try{const info=await lstat(join(root,file.path),{bigint:true});return[file.path,String(info.size),String(info.mtimeNs),String(info.birthtimeNs)];}catch(error){return[file.path,(error as NodeJS.ErrnoException).code??"unavailable"];}}))
    ]);
    const stats=sourceNumstat(statRaw,validPath);
    for(const file of parsed.changes)Object.assign(file,stats.get(file.path));
    const indexPath=indexFile.trim(),digest=createHash("sha256").update(root).update("\0").update(raw).update(JSON.stringify(revisions));
    try{for await(const chunk of createReadStream(indexPath))digest.update(chunk);}catch(error){if(!missing(error))throw error;}
    const branches=branchRaw.split("\n").filter(Boolean).map(line=>{const[name,current,upstream,worktree,upstreamRemote,pushRemote,pushRef]=line.replace(/\r$/u,"").split("\0");return{name,current:current==="*",upstream:upstream||undefined,worktree:worktree||undefined,upstreamRemote:upstreamRemote||undefined,pushRemote:pushRemote||undefined,pushRef:pushRef||undefined};});
    const remotes=remoteRaw.split(/\r?\n/u).filter(Boolean);
    const recent=logRaw.split(/\r?\n/u).filter(Boolean).map(line=>{const[hash,subject,author,committedAt]=line.split("\0");return{hash,subject,author,committedAt};});
    const gitDir=gitDirectory.trim();let operation:SourceControlRepository["operation"];
    for(const[entry,kind]of [["rebase-merge","rebase"],["rebase-apply","rebase"],["MERGE_HEAD","merge"],["CHERRY_PICK_HEAD","cherry-pick"],["REVERT_HEAD","revert"]] as const)if(existsSync(join(gitDir,entry))){operation=kind;if(entry==="MERGE_HEAD"){let size=0;for await(const bytes of createReadStream(join(gitDir,entry))){size+=bytes.length;if(size>65536)throw new Error("Git 合并状态过大，请在原生终端检查。");digest.update(bytes);}}break;}
    digest.update("\0"+(operation??"")).update(config);const current=branches.find(branch=>branch.current);return{schemaVersion:1,available:true,workingDirectory:cwd,rootPath:root,token:digest.digest("hex"),...parsed,branches,upstreamRemote:current?.upstreamRemote,pushRemote:current?.pushRemote,pushRef:current?.pushRef,remotes,recent,operation};
  }
  async diff(cwd:string,input:{path:string;source:"worktree"|"index"}):Promise<SourceControlDiff>{
    const root=await repositoryRoot(cwd);if(!root)throw new Error("当前目录不是 Git 仓库");return this.serial(root,()=>this.readDiff(root,input));
  }
  async commitDetails(cwd:string,input:{hash:string}){const root=await repositoryRoot(cwd);if(!root)throw new Error("当前目录不是 Git 仓库");return this.serial(root,()=>readSourceCommit(root,input.hash,{git,checked},validPath));}
  async history(cwd:string,input:import("@agenthub/schemas").SourceControlHistoryInput){const root=await repositoryRoot(cwd);if(!root)throw new Error("当前目录不是 Git 仓库");return this.serial(root,()=>readSourceHistory(root,input,{git,checked}));}
  async commitDiff(cwd:string,input:{hash:string;path:string}){const root=await repositoryRoot(cwd);if(!root)throw new Error("当前目录不是 Git 仓库");return this.serial(root,()=>readSourceCommitDiff(root,input,{git,checked},validPath));}
  async file(cwd:string,input:{path:string}){const root=await repositoryRoot(cwd);if(!root)throw new Error("当前目录不是 Git 仓库");return this.serial(root,()=>readSourceFile(root,input.path,{git,checked,validPath}));}
  async save(cwd:string,input:SourceControlSave):Promise<SourceControlSaveResult>{const root=await repositoryRoot(cwd);if(!root)throw new Error("当前目录不是 Git 仓库");return this.serial(root,async()=>{
    const outcome=await writeSourceFile(root,input,{git,checked,validPath}),result:SourceControlSaveResult={saved:true,staged:outcome.staged},errors=outcome.error?[outcome.error]:[];
    try{result.file=await readSourceFile(root,input.path,{git,checked,validPath},true);}catch(error){errors.push('读取保存后的文件状态失败：'+String(error));}
    try{result.status=await this.snapshot(cwd,root);}catch(error){errors.push('刷新 Git 状态失败：'+String(error));}if(errors.length)result.error=errors.join('\n');return result;
  });}
  private async readDiff(root:string,input:{path:string;source:"worktree"|"index"}):Promise<SourceControlDiff>{
      validPath(input.path);const state=parseSourceControlStatus(await checked(root,["status","--porcelain=v2","-z","--untracked-files=all"])),change=state.changes.find(item=>item.path===input.path);if(!change)throw new Error("文件状态已改变，请刷新后重试");
      if(input.source==="index"&&(change.untracked||change.conflict||[".","?"].includes(change.indexStatus)))throw new Error("此文件的暂存状态已改变，请刷新后重试。");
      if(change.directory)return{rootPath:root,path:input.path,source:input.source,patch:"",binary:false,truncated:false,editable:false,hunks:[],partialReason:"directory",previewReason:"directory"};
      const token=input.source==="worktree"&&!change.submodule?await fileToken(root,input.path):undefined;
      const identity=await sourcePreviewIdentity(root,input.path,change,input.source,{git,checked},fileToken);
      if(change.untracked){const result=await git(root,["diff","--no-index","--no-ext-diff","--no-textconv","--no-color","--patch","--","/dev/null",input.path],undefined,LIMIT);if(result.code!==0&&result.code!==1)throw new Error(result.stderr);
        return attachSourceContent(root,change,identity,this.describeDiff(root,change,{path:input.path,source:input.source,binary:result.stdout.split("\n").some(line=>line.startsWith("Binary files ")||line==="GIT binary patch"),truncated:result.truncated,fileToken:token,patch:result.stdout}),{git,checked},fileToken);
      }
      const result=await git(root,["diff",...(input.source==="index"?["--cached"]:[]),"--no-ext-diff","--no-textconv","--no-color","--no-renames","--patch","--",input.path,...(change.originalPath?[change.originalPath]:[])],undefined,LIMIT);if(result.code!==0)throw new Error(result.stderr||"无法读取差异");
      return attachSourceContent(root,change,identity,this.describeDiff(root,change,{path:input.path,source:input.source,patch:result.stdout,binary:result.stdout.split("\n").some(line=>line.startsWith("Binary files ")||line==="GIT binary patch"),truncated:result.truncated,fileToken:token}),{git,checked},fileToken);
  }
  private describeDiff(root:string,change:SourceControlChange,diff:SourceControlDiff):SourceControlDiff{
    if(diff.source==="commit")return diff;
    let reason=diff.binary?"binary":diff.truncated?"truncated":change.conflict?"conflict":change.submodule?"submodule":change.originalPath?"rename":undefined;
    let hunks:SourceControlDiff["hunks"]=[];if(!reason)try{hunks=describeSourcePatch(diff.patch,diff.path,diff.source);}catch{reason="unsupported";}
    return{...diff,rootPath:root,hunks,partialReason:reason,patchToken:reason?undefined:createHash("sha256").update(root+"\0"+sourcePatchToken(diff.path,diff.source,diff.patch,diff.fileToken)).digest("hex")};
  }
  async mutate(cwd:string,input:SourceControlMutation):Promise<{status:SourceControlRepository;output?:string}>{
    if(input.action==="init"){const existing=await repositoryRoot(cwd);if(existing)return{status:await this.serial(existing,()=>this.snapshot(cwd,existing))};return this.serial(await realpath(cwd),async()=>{await checked(cwd,["init"]);const root=await repositoryRoot(cwd);if(!root)throw new Error("无法初始化 Git 仓库");return{status:await this.snapshot(cwd,root)};});}
    const root=await repositoryRoot(cwd);if(!root)throw new Error("当前目录不是 Git 仓库");return this.serial(root,async()=>{
      const state=await this.snapshot(cwd,root);if(input.token!==state.token)throw new Error(input.action==="discard"?"仓库状态或文件内容已改变，请重新查看差异后再试。":"仓库状态已改变，请刷新后重试。");let output="";
      if(input.action==="stage-hunks"||input.action==="unstage-hunks"){
        if(input.paths?.length!==1)throw new Error("请选择一个文件的更改区块。");const path=input.paths[0],source=input.action==="stage-hunks"?"worktree":"index",diff=await this.readDiff(root,{path,source});
        if(!diff.patchToken||input.patchToken!==diff.patchToken)throw new Error("差异内容已改变，请刷新后重新选择。");if((input.hunkIds?.length??0)>10000||(input.lines?.length??0)>100000)throw new Error("选择的更改过多，请按区块操作。");
        const patch=selectSourcePatch(diff.patch,path,source,input.hunkIds,input.lines);await checked(root,["apply","--cached","--check","--whitespace=nowarn","-"],patch);output=await checked(root,["apply","--cached","--whitespace=nowarn","-"],patch);
      }else if(["stage","unstage","discard"].includes(input.action)){
        if(!Array.isArray(input.paths)||!input.paths.length||input.paths.length>10000)throw new Error("请选择需要操作的文件（每次最多 10000 个）");
        const selected=input.paths.map(name=>{validPath(name);const change=state.changes.find(item=>item.path===name);if(!change)throw new Error("文件状态已改变，请刷新后重试");return change;});
        const paths=[...new Set(selected.flatMap(change=>change.originalPath?[change.path,change.originalPath]:[change.path]))];let args:string[];
        if(input.action==="stage")args=["add","-A","--",...paths];else if(input.action==="unstage")args=state.head?["restore","--staged","--",...paths]:["rm","--cached","-f","--ignore-unmatch","--",...paths];
        else{const change=selected[0];if(selected.length!==1||change.untracked||change.conflict||change.submodule)throw new Error("请选择一个非冲突的已跟踪文件放弃未暂存更改。");if(!input.fileToken||input.fileToken!==await fileToken(root,change.path))throw new Error("文件内容已改变，请重新查看差异后再放弃更改。");args=["restore","--worktree","--",change.path];}
        const separator=args.indexOf("--"),filePaths=args.slice(separator+1);args=[...args.slice(0,separator),"--pathspec-from-file=-","--pathspec-file-nul"];output=await checked(root,args,filePaths.join("\0")+"\0");
      }else if(input.action==="commit"){
        if(state.changes.some(change=>change.conflict))throw new Error("请先解决冲突并暂存文件。");if(state.operation!=="merge"&&!state.changes.some(change=>![".","?"].includes(change.indexStatus)))throw new Error("请先暂存需要提交的更改。");if(state.operation&&state.operation!=="merge")throw new Error("请先在原生终端完成当前 Git 操作。");
        if(!input.message?.trim()||Buffer.byteLength(input.message)>65536||input.message.includes("\0"))throw new Error("请输入有效的提交说明。");output=await checked(root,["commit","--file=-"],input.message);
      }else if(input.action==="create-branch"||input.action==="switch-branch"){
        if(!input.branch||input.branch.startsWith("-")||(await git(root,["check-ref-format","--branch",input.branch])).code!==0)throw new Error("分支名称无效。");if(state.operation)throw new Error("请先完成当前 Git 操作。");if(input.action==="switch-branch"&&state.changes.length)throw new Error("请先提交或处理当前更改，再切换分支。");output=await checked(root,input.action==="create-branch"?["switch","-c",input.branch]:["switch","--",input.branch]);
      }else if(["fetch","pull","push"].includes(input.action)){
        const configured=state.branch?(await git(root,["config","--get",`branch.${state.branch}.remote`])).stdout.trim():"",remote=input.remote||(input.action==="push"?state.pushRemote:undefined)||configured||"origin";if(!state.remotes.includes(remote)&&!(remote==="."&&(configured==="."||state.pushRemote===".")))throw new Error("请选择已配置的远程仓库。");
        if(input.action==="fetch")output=await checked(root,["fetch","--prune","--",remote]);else{
          if(!state.branch)throw new Error("请先切换到本地分支。");const configuredMerge=(await git(root,["config","--get",`branch.${state.branch}.merge`])).stdout.trim(),merge=configured===remote?configuredMerge:"";
          if(input.action==="pull"){if(state.changes.length||state.operation)throw new Error("请先提交或处理当前更改，再拉取更新。");if(!merge)throw new Error("当前分支尚未设置上游，请先发布分支。");output=await checked(root,["pull","--ff-only","--no-rebase","--",remote,merge]);}
          else{const target=remote===state.pushRemote&&state.pushRef?state.pushRef:merge||`refs/heads/${state.branch}`;if(!target.startsWith("refs/heads/"))throw new Error("上游分支无效。");output=await checked(root,["push","--porcelain",...(!configured||!configuredMerge?["--set-upstream"]:[]),"--",remote,`HEAD:${target}`]);}
        }
      }else throw new Error("未知源码管理操作");
      return{status:await this.snapshot(cwd,root),output:output.trim()};
    });
  }
}
