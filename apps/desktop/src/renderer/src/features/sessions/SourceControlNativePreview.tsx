import {useEffect,useLayoutEffect,useMemo,useRef,useState,type ClipboardEvent,type CSSProperties,type MutableRefObject} from "react";
import {ChevronDown,ChevronsUpDown,Loader2,X} from "lucide-react";
import type {DiffReviewNavigation,DiffReviewPosition} from "../../components/ui/DiffCodeEditor";
import type {NativeDiffData} from "./source-control-native-data";

export default function SourceControlNativePreview({before,value,filePath,sideBySide,hideUnchanged,zh,navigationRef,onReviewPosition,onFallback}:{
  before:string;value:string;filePath:string;sideBySide:boolean;hideUnchanged:boolean;zh:boolean;
  navigationRef:MutableRefObject<DiffReviewNavigation|null>;
  onReviewPosition:(position:DiffReviewPosition)=>void;
  onFallback:()=>void;
}):JSX.Element{
  const [data,setData]=useState<NativeDiffData>();
  const surface=useRef<HTMLDivElement>(null);
  const index=useRef(0);
  const anchored=useRef(false);
  const [searching,setSearching]=useState(false);
  const found=useRef<HTMLElement>();

  useEffect(()=>{
    // Millions of empty lines can fit the text limit. Keep large files in the virtualized editor.
    if((before.match(/\r\n|\r|\n/g)?.length??0)+(value.match(/\r\n|\r|\n/g)?.length??0)>16_000){onFallback();return;}
    const worker=new Worker(new URL("./source-control-native.worker.ts",import.meta.url),{type:"module"});
    worker.onmessage=(event:MessageEvent<NativeDiffData>)=>{setData(event.data);worker.terminate();};
    worker.onerror=event=>{event.preventDefault();onFallback();};
    worker.postMessage({before,after:value,path:filePath});
    return()=>{worker.onmessage=null;worker.onerror=null;worker.terminate();};
  },[before,value,filePath,onFallback]);

  useLayoutEffect(()=>{
    const scroller=surface.current;
    if(!scroller)return;
    const targets=Array.from(scroller.querySelectorAll<HTMLElement>("[data-scm-change]"));
    const count=targets.length;
    index.current=Math.min(index.current,Math.max(0,count-1));
    const show=(target:HTMLElement):void=>{
      scroller.scrollTop=Math.max(0,target.offsetTop-Math.floor(scroller.clientHeight/2)+10);
    };
    if(!anchored.current&&count){show(targets[0]);anchored.current=true;}
    onReviewPosition({count,index:count?index.current+1:0});
    navigationRef.current={move(direction){
      if(!count)return;
      index.current=(index.current+direction+count)%count;
      show(targets[index.current]);
      onReviewPosition({count,index:index.current+1});
    }};
    return()=>{navigationRef.current=null;};
  },[data,sideBySide,hideUnchanged,navigationRef,onReviewPosition]);

  const content=useMemo(()=>data?.blocks.map((block,blockIndex)=>{
    const rows=(sideBySide?block.split:block.unified).map((chunk,chunkIndex)=><div key={chunkIndex} className="scm-native-chunk"
      style={{height:chunk.length*19}} dangerouslySetInnerHTML={{__html:chunk.html}}/>);
    if(block.kind==="fold"&&hideUnchanged)return <details key={blockIndex} className="scm-native-fold">
      <summary><span><ChevronsUpDown size={12} aria-hidden/>{zh?`展开 ${block.length} 行`:`Expand ${block.length} lines`}</span></summary>{rows}
    </details>;
    return <div key={blockIndex} data-scm-change={block.kind==="change"?"":undefined}>{rows}</div>;
  }),[data,sideBySide,hideUnchanged,zh]);

  const findNext=(query:string):void=>{
    const scroller=surface.current;
    if(!scroller||!query)return;
    const needle=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"iu");
    const rows=Array.from(scroller.querySelectorAll<HTMLElement>("code"));
    // Search runs only on demand. Scrolling itself has no JavaScript listener.
    const start=found.current?rows.indexOf(found.current)+1:0;
    for(let step=0;step<rows.length;step++){
      const code=rows[(start+step)%rows.length];
      const match=needle.exec(code.textContent??"");
      if(!match)continue;
      found.current=code;
      const fold=code.closest("details");
      if(fold)fold.open=true;
      code.scrollIntoView({block:"center",inline:"nearest"});
      const range=document.createRange();
      const text=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);
      let offset=0;
      for(let node=text.nextNode();node;node=text.nextNode()){
        const end=offset+(node.nodeValue?.length??0);
        if(offset<=match.index&&match.index<end)range.setStart(node,match.index-offset);
        if(match.index+match[0].length<=end){range.setEnd(node,match.index+match[0].length-offset);break;}
        offset=end;
      }
      const selection=window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      break;
    }
  };

  const copyColumn=(event:ClipboardEvent<HTMLDivElement>):void=>{
    if(!sideBySide)return;
    const selection=window.getSelection();
    const anchor=selection?.anchorNode;
    const cell=(anchor instanceof Element?anchor:anchor?.parentElement)?.closest<HTMLElement>("[data-side]");
    const side=cell?.dataset.side;
    if(!side||!selection?.rangeCount||selection.isCollapsed)return;

    // Split rows alternate in the DOM. Copy the selected pane's source, without the opposite pane or gutter.
    const selected=selection.getRangeAt(0),line=document.createRange(),lines:string[]=[];
    for(const code of event.currentTarget.querySelectorAll(`[data-side="${side}"] code`)){
      if(!selected.intersectsNode(code))continue;
      line.selectNodeContents(code);
      if(selected.compareBoundaryPoints(Range.START_TO_START,line)>0)line.setStart(selected.startContainer,selected.startOffset);
      if(selected.compareBoundaryPoints(Range.END_TO_END,line)<0)line.setEnd(selected.endContainer,selected.endOffset);
      lines.push(line.toString());
    }
    if(lines.length){event.clipboardData.setData("text/plain",lines.join("\n"));event.preventDefault();}
  };

  if(!data)return <div className="scm-empty" role="status"><Loader2 size={18} className="animate-spin"/>{zh?"正在加载代码视图":"Loading code view"}</div>;

  const findLabel=zh?"查找代码":"Find in diff";
  return <div className="scm-native-preview" data-split={sideBySide||undefined} style={{"--scm-native-columns":data.columns} as CSSProperties} onKeyDown={event=>{
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="f"){event.preventDefault();setSearching(true);}
    if(searching&&event.key==="Escape"){event.stopPropagation();setSearching(false);surface.current?.focus();}
  }}>
    {searching&&<form className="scm-native-search" role="search" onSubmit={event=>{event.preventDefault();findNext(String(new FormData(event.currentTarget).get("query")??""));}}>
      <input type="search" autoFocus name="query" aria-label={findLabel} placeholder={findLabel} onChange={()=>{found.current=undefined;}}/>
      <button type="submit" aria-label={zh?"下一个匹配":"Next match"}><ChevronDown size={14}/></button>
      <button type="button" aria-label={zh?"关闭查找":"Close find"} onClick={()=>{setSearching(false);surface.current?.focus();}}><X size={14}/></button>
    </form>}
    <div ref={surface} className="scm-native-scroll" role="region" tabIndex={0} aria-label={zh?"代码差异内容":"Code diff content"} onCopy={copyColumn}>{content}</div>
    <div className="scm-native-horizontal" onScroll={event=>surface.current?.style.setProperty("--scm-native-pan",`${event.currentTarget.scrollLeft}px`)}>
      <div aria-hidden/>
    </div>
  </div>;
}
