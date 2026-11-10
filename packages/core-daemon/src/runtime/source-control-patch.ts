import {createHash} from "node:crypto";
import type {SourceControlHunk} from "@agenthub/schemas";
interface Row {sign:string;text:string;noNewline:boolean;line:number}
interface Hunk {id:string;header:string;startLine:number;endLine:number;oldStart:number;newStart:number;rows:Row[]}
interface Parsed {hunks:Hunk[];kind:"new"|"deleted"|"modified";mode:string}
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
export function sourcePatchToken(path:string,source:string,patch:string,fileToken=""):string{return digest([path,source,patch,fileToken].join("\0"));}
function parse(patch:string,path:string,source:string):Parsed {
  const lines=patch.match(/[^\n]*\n|[^\n]+$/gu)??[];
  if(lines.filter(line=>line.startsWith("diff --git ")).length!==1||lines.some(line=>/^(?:old mode|new mode|rename |copy |GIT binary patch|Binary files)/u.test(line)))throw new Error("此差异不支持逐块操作，请使用整文件操作。");
  const creation=lines.find(line=>line.startsWith("new file mode ")),deletion=lines.find(line=>line.startsWith("deleted file mode "));
  const mode=(creation??deletion??lines.find(line=>line.startsWith("index "))??"").trim().split(" ").at(-1)??"100644";
  if(mode==="120000"||mode==="160000")throw new Error("此文件类型不支持逐块操作。");
  const hunks:Hunk[]=[];
  for(let cursor=0;cursor<lines.length;cursor++){
    if(!lines[cursor].startsWith("@@ "))continue;
    const start=cursor,match=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(lines[cursor]);if(!match)throw new Error("差异区块格式无效。");
    const rows:Row[]=[];let oldCount=0,newCount=0;
    while(cursor+1<lines.length&&!lines[cursor+1].startsWith("@@ ")){
      const line=lines[++cursor];if(line.startsWith("\\ ")){if(!rows.length)throw new Error("差异换行标记无效。");rows.at(-1)!.noNewline=true;continue;}
      const sign=line[0];if(![" ","+","-"].includes(sign))throw new Error("差异正文格式无效。");
      if(sign!=="+")oldCount++;if(sign!=="-")newCount++;rows.push({sign,text:line.slice(1),noNewline:false,line:cursor+1});
    }
    if(oldCount!==Number(match[2]??1)||newCount!==Number(match[4]??1))throw new Error("差异区块不完整，请刷新后重试。");
    hunks.push({id:digest([path,source,lines.slice(start,cursor+1).join("")].join("\0")),header:lines[start].trimEnd(),startLine:start+1,endLine:cursor+1,oldStart:Number(match[1]),newStart:Number(match[3]),rows});
  }
  if(!hunks.length)throw new Error("没有可操作的文本区块。");return{hunks,kind:creation?"new":deletion?"deleted":"modified",mode};
}
export function describeSourcePatch(patch:string,path:string,source:string):SourceControlHunk[]{return parse(patch,path,source).hunks.map(({id,header,startLine,endLine})=>({id,header,startLine,endLine}));}
/** Quote filenames using Git's C quoting, including control bytes. */
function quote(value:string):string{return '"'+[...value].map(char=>char==='"'?'\\"':char==='\\'?'\\\\':char.charCodeAt(0)<32||char.charCodeAt(0)===127?'\\'+char.charCodeAt(0).toString(8).padStart(3,'0'):char).join('')+'"';}
export function selectSourcePatch(patch:string,path:string,source:"worktree"|"index",hunkIds:string[]=[],selectedLines:number[]=[]):string {
  const parsed=parse(patch,path,source),ids=new Set(hunkIds),selected=new Set(selectedLines),valid=new Set(parsed.hunks.flatMap(hunk=>hunk.rows.filter(row=>row.sign!==" ").map(row=>row.line)));
  if(hunkIds.some(id=>!parsed.hunks.some(hunk=>hunk.id===id))||selectedLines.some(line=>!Number.isSafeInteger(line)||!valid.has(line)))throw new Error("选择的差异已失效，请刷新后重试。");
  for(const hunk of parsed.hunks)if(ids.has(hunk.id))for(const row of hunk.rows)if(row.sign!==" ")selected.add(row.line);
  if(!selected.size)throw new Error("请选择需要操作的区块或更改行。");
  const reverse=source==="index",kind=reverse?(parsed.kind==="new"?"deleted":parsed.kind==="deleted"?"new":"modified"):parsed.kind;
  let delta=0,completeDeletion=kind==="deleted",body="";
  for(const hunk of parsed.hunks){
    const raw=hunk.rows.map(row=>({...row,sign:reverse?(row.sign==="+"?"-":row.sign==="-"?"+":" "):row.sign}));
    const oriented:Row[]=[];
    for(let index=0;index<raw.length;){if(raw[index].sign===" "){oriented.push(raw[index++]);continue;}const block:Row[]=[];while(index<raw.length&&raw[index].sign!==" ")block.push(raw[index++]);const removed=block.filter(row=>row.sign==="-"),added=block.filter(row=>row.sign==="+");for(let row=0;row<Math.max(removed.length,added.length);row++){if(removed[row])oriented.push(removed[row]);if(added[row])oriented.push(added[row]);}}
    if(oriented.some(row=>row.sign==="-"&&!selected.has(row.line)))completeDeletion=false;
    if(!oriented.some(row=>row.sign!==" "&&selected.has(row.line)))continue;
    const transformed=oriented.flatMap(row=>row.sign==="+"&&!selected.has(row.line)?[]:[row.sign==="-"&&!selected.has(row.line)?{...row,sign:" "}:row]);
    const oldCount=transformed.filter(row=>row.sign!=="+").length,newCount=transformed.filter(row=>row.sign!=="-").length;
    const oldStart=reverse?hunk.newStart:hunk.oldStart,anchor=oldStart-(oldCount?1:0)+delta,newStart=anchor+(newCount?1:0);
    if(anchor<0)throw new Error("差异区块位置无效。");body+=`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`;
    let lastNew=-1;transformed.forEach((row,index)=>{if(row.sign!=="-")lastNew=index;});
    for(let index=0;index<transformed.length;index++){
      const row=transformed[index],text=row.text.endsWith("\n")?row.text:row.text+"\n",newNoNewline=row.noNewline&&index===lastNew;
      if(row.sign===" "&&row.noNewline&&!newNoNewline)body+='-'+text+'\\ No newline at end of file\n'+'+'+text;
      else{body+=row.sign+text;if(row.noNewline&&(row.sign==="-"||newNoNewline))body+='\\ No newline at end of file\n';}
    }
    delta+=newCount-oldCount;
  }
  return`diff --git ${quote("a/"+path)} ${quote("b/"+path)}\n`+(kind==="new"?`new file mode ${parsed.mode}\n`:completeDeletion?`deleted file mode ${parsed.mode}\n`:"")+`--- ${kind==="new"?"/dev/null":quote("a/"+path)}\n+++ ${completeDeletion?"/dev/null":quote("b/"+path)}\n`+body;
}
