import {DefaultLinesDiffComputer} from "monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js";
import {escapeHtml,highlightCodeLines} from "../../lib/highlight";

type LineRange={startLineNumber:number;endLineNumberExclusive:number};
type TextRange={startLineNumber:number;startColumn:number;endLineNumber:number;endColumn:number};
type Change={original:LineRange;modified:LineRange;innerChanges?:{originalRange:TextRange;modifiedRange:TextRange}[]};
type Row={oldLine?:number;newLine?:number;kind?:"remove"|"add";oldHtml?:string;newHtml?:string};
type Chunk={length:number;html:string};
export type PreviewBlock={kind:"context"|"fold"|"change";split:Chunk[];unified:Chunk[];length:number};
export type NativeDiffData={blocks:PreviewBlock[];columns:number};

function markedLines(lines:string[],changes:Change[],side:"originalRange"|"modifiedRange",html:string[]):void{
  const marks=new Map<number,[number,number][]>();
  for(const change of changes){
    for(const inner of change.innerChanges??[]){
      const range=inner[side];
      for(let line=range.startLineNumber;line<=range.endLineNumber;line++){
        const start=line===range.startLineNumber?range.startColumn-1:0;
        const end=line===range.endLineNumber?range.endColumn-1:lines[line-1].length;
        if(end<=start)continue;
        const spans=marks.get(line)??[];
        spans.push([start,end]);
        marks.set(line,spans);
      }
    }
  }
  for(const [line,spans] of marks){
    let column=0;
    html[line-1]=html[line-1].replace(/<[^>]+>|[^<]+/g,part=>{
      if(part.startsWith("<"))return part;
      const plain=part.replace(/&(?:amp|lt|gt|quot|#x27);/g,entity=>({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":"\"","&#x27;":"'"})[entity]!);
      const start=column;
      column+=plain.length;
      let next=0,result="";
      for(const [from,to] of spans){
        const left=Math.max(next,from-start),right=Math.min(plain.length,to-start);
        if(right<=left)continue;
        result+=escapeHtml(plain.slice(next,left))+`<mark>${escapeHtml(plain.slice(left,right))}</mark>`;
        next=right;
      }
      return next?result+escapeHtml(plain.slice(next)):part;
    });
  }
}

function cell(html:string|undefined,oldLine?:number,newLine?:number,kind?:Row["kind"],unified=false):string{
  const oldNumber=unified||oldLine!==undefined?`<span class="scm-native-number">${oldLine??""}</span>`:"";
  const newNumber=unified||oldLine===undefined?`<span class="scm-native-number">${newLine??""}</span>`:"";
  const side=unified?"":oldLine!==undefined?' data-side="old"':newLine!==undefined?' data-side="new"':"";
  return `<div class="scm-native-cell${kind?` is-${kind}`:""}"${side}>${oldNumber}${newNumber}<span class="scm-native-marker">${kind==="add"?"+":kind==="remove"?"−":""}</span><code>${html??""}</code></div>`;
}

function chunks(rows:Row[],split:boolean,changed=false):Chunk[]{
  const result:Chunk[]=[];
  for(let start=0;start<rows.length;start+=96){
    const visible=rows.slice(start,start+96);
    result.push({length:visible.length,html:visible.map(row=>{
      if(!split)return cell(row.newHtml??row.oldHtml,row.oldLine,row.newLine,row.kind,true);
      const old=cell(row.oldHtml,row.oldLine,undefined,changed&&row.oldLine!==undefined?"remove":undefined);
      const next=cell(row.newHtml,undefined,row.newLine,changed&&row.newLine!==undefined?"add":undefined);
      return old+next;
    }).join("")});
  }
  return result;
}

export function prepareNativeDiff(before:string,after:string,path:string):NativeDiffData{
  const left=before.split(/\r\n|\r|\n/),right=after.split(/\r\n|\r|\n/);
  const diff=new DefaultLinesDiffComputer().computeDiff(left,right,{ignoreTrimWhitespace:false,computeMoves:false,maxComputationTimeMs:1000});
  if(diff.hitTimeout)throw new Error("Code diff needs the virtualized editor");
  const changes=diff.changes as Change[];
  const oldHtml=highlightCodeLines(left.join("\n"),path),newHtml=highlightCodeLines(right.join("\n"),path);
  markedLines(left,changes,"originalRange",oldHtml);
  markedLines(right,changes,"modifiedRange",newHtml);
  const blocks:PreviewBlock[]=[];
  const add=(kind:PreviewBlock["kind"],rows:Row[]):void=>{
    if(rows.length)blocks.push({kind,split:chunks(rows,true),unified:chunks(rows,false),length:rows.length});
  };
  let old=1,next=1;
  const context=(end:number,first:boolean,last:boolean):void=>{
    const rows:Row[]=[];
    while(old<end&&next<=right.length){
      rows.push({oldLine:old,newLine:next,oldHtml:oldHtml[old++-1],newHtml:newHtml[next++-1]});
    }
    const beforeFold=first?0:3,afterFold=last?0:3;
    if(!changes.length||rows.length<beforeFold+afterFold+4){add("context",rows);return;}
    add("context",rows.slice(0,beforeFold));
    add("fold",rows.slice(beforeFold,rows.length-afterFold));
    add("context",rows.slice(rows.length-afterFold));
  };
  for(const [index,change] of changes.entries()){
    context(change.original.startLineNumber,index===0,false);
    const removed:Row[]=[],added:Row[]=[];
    while(old<change.original.endLineNumberExclusive){removed.push({oldLine:old,oldHtml:oldHtml[old++-1],kind:"remove"});}
    while(next<change.modified.endLineNumberExclusive){added.push({newLine:next,newHtml:newHtml[next++-1],kind:"add"});}
    const paired=Array.from({length:Math.max(removed.length,added.length)},(_,row)=>({
      oldLine:removed[row]?.oldLine,oldHtml:removed[row]?.oldHtml,
      newLine:added[row]?.newLine,newHtml:added[row]?.newHtml
    }));
    if(paired.length)blocks.push({kind:"change",split:chunks(paired,true,true),unified:chunks([...removed,...added],false),length:paired.length});
  }
  context(left.length+1,changes.length===0,true);
  let columns=1;
  for(const lines of [left,right])for(const line of lines){
    columns=Math.max(columns,line.replace(/\t/g,"    ").replace(/[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7ff\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]/g,"xx").length);
  }
  return {blocks,columns};
}
