import { useState } from "react";
import { ArrowRight, Globe, RotateCw } from "lucide-react";
import { NautiloMark } from "../../components/ui/IdentityAvatar";
import type { BrowserOmniboxData } from "../../../../shared/browser-shell";

export function BrowserStart({data,zh,onOpen,onProbe}:{data:BrowserOmniboxData;zh:boolean;onOpen:(value:string)=>void;onProbe:()=>Promise<void>}) {
  const [text,setText] = useState("");
  const [probing,setProbing] = useState(false);
  return <div className="br-start">
    <div className="br-start-inner">
      <div className="br-start-mark"><NautiloMark/></div>
      <h2>{zh ? "新标签页" : "New tab"}</h2>
      <p>{zh ? "打开网址，或直接输入本机端口。" : "Enter a URL or a local development port."}</p>
      <form className="br-start-address" onSubmit={event => {event.preventDefault();if (text.trim()) onOpen(text);}}>
        <input autoComplete="off" spellCheck={false} aria-label={zh ? "起始页网址" : "Start page address"} placeholder={zh ? "例如 localhost:5173" : "e.g. localhost:5173"} value={text} onChange={event => setText(event.target.value)}/>
        <button className="br-icon" aria-label={zh ? "打开网址" : "Open address"} title={zh ? "打开网址" : "Open address"}><ArrowRight/></button>
      </form>
      <section className="br-start-group">
        <header><h3>{zh ? "本机开发服务" : "Local development"}</h3>
          <button className="br-icon" title={zh ? "重新探测端口" : "Rescan local ports"} aria-label={zh ? "重新探测端口" : "Rescan local ports"} disabled={probing}
            onClick={() => {setProbing(true);void onProbe().finally(() => setProbing(false));}}><RotateCw className={probing ? "browser-tab-loading" : undefined}/></button>
        </header>
        <div>{(data.ports.length ? data.ports : [3000,5173,8080]).map(port => <button key={port} onClick={() => onOpen(String(port))}>
          {data.ports.length ? <span className="br-dot" data-tone="green" data-pulse/> : <Globe/>}
          localhost:{port}
        </button>)}</div>
      </section>
      {data.history.length > 0 && <section className="br-start-group">
        <header><h3>{zh ? "最近访问" : "Recently visited"}</h3></header>
        <div>{data.history.slice(0,6).map(({url,title},index) => <button key={url} className="br-start-recent" style={{animationDelay:`${index*30}ms`}} title={url} onClick={() => onOpen(url)}><Globe/>{title}</button>)}</div>
      </section>}
    </div>
  </div>;
}
