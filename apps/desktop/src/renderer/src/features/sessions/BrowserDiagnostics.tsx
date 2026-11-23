import { useRef, useState } from "react";
import { Check, Sparkles, Trash2, X } from "lucide-react";
import type { BrowserIssue } from "../../../../shared/browser-shell";

export function BrowserDiagnostics({issues,zh,onClose,onClear,onSend}:{
  issues:BrowserIssue[]; zh:boolean; onClose:()=>void; onClear:()=>void; onSend:(ids:string[])=>Promise<boolean>;
}) {
  const [kind,setKind] = useState<BrowserIssue["kind"]>("console");
  const [excluded,setExcluded] = useState<Set<string>>(() => new Set());
  const [height,setHeight] = useState(200);
  const [sent,setSent] = useState(false);
  const [sending,setSending] = useState(false);
  const drag = useRef<{y:number;height:number}>();
  const shown = issues.filter(issue => issue.kind === kind);
  const selected = issues.filter(issue => !excluded.has(issue.id)).map(issue => issue.id);
  const allShown = shown.length > 0 && shown.every(issue => !excluded.has(issue.id));
  const toggle = (checked:boolean, ids:string[]) => setExcluded(current => {
    const next = new Set(current);
    for (const id of ids) checked ? next.delete(id) : next.add(id);
    return next;
  });
  const label = zh ? "一键发给 AI 修复" : "Send to AI";
  const resize = (value:number) => setHeight(Math.max(136,Math.min(value,540)));
  return <section className="br-diagnostics" style={{height}} aria-label={zh ? "浏览器诊断" : "Browser diagnostics"}>
    <div role="separator" aria-label={zh ? "调整诊断抽屉高度" : "Resize diagnostics"} aria-orientation="horizontal" aria-valuenow={height} tabIndex={0}
      className="br-diagnostics-resizer" onPointerDown={event => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {y:event.clientY,height};
      }} onPointerMove={event => {if (drag.current) resize(drag.current.height+drag.current.y-event.clientY);}} onLostPointerCapture={() => {drag.current=undefined;}}
      onKeyDown={event => {if (event.key === "ArrowUp" || event.key === "ArrowDown") {event.preventDefault();resize(height+(event.key === "ArrowUp" ? 24 : -24));}}}/>
    <header>
      <div role="tablist" className="br-diagnostics-tabs" data-network={kind==="network"}>
        {(["console","network"] as const).map(type => <button type="button" key={type} role="tab" aria-selected={kind===type} onClick={() => setKind(type)}>
          {type === "console" ? (zh ? "Console 报错" : "Console") : (zh ? "失败请求" : "Failed requests")} <span>{issues.filter(issue => issue.kind===type).length}</span>
        </button>)}
      </div>
      <button className="br-icon" title={zh ? "清空诊断" : "Clear diagnostics"} aria-label={zh ? "清空诊断" : "Clear diagnostics"} onClick={onClear}><Trash2/></button>
      <button className="br-send" data-sent={sent} aria-label={label} title={label} disabled={!selected.length || sending} onClick={() => {
        setSending(true);
        void onSend(selected).then(ok => {
          if (ok) {setSent(true);setTimeout(() => setSent(false),900);}
        }).finally(() => setSending(false));
      }}>{sent ? <Check/> : <Sparkles/>}<span>{label}</span></button>
      <button className="br-icon" title={zh ? "关闭诊断" : "Close diagnostics"} aria-label={zh ? "关闭诊断" : "Close diagnostics"} onClick={onClose}><X/></button>
    </header>
    <div className="br-diagnostics-scroll">
      {shown.length ? <label className="br-diagnostics-select"><input type="checkbox" checked={allShown} onChange={event => toggle(event.target.checked,shown.map(issue=>issue.id))}/>{zh ? "全选此类" : "Select all in this tab"}</label> : <p className="br-diagnostics-empty">{zh ? "暂无这类记录" : "Nothing recorded"}</p>}
      {shown.map(issue => <article key={issue.id} className="br-issue">
        <input type="checkbox" aria-label={issue.message} checked={!excluded.has(issue.id)} onChange={event => toggle(event.target.checked,[issue.id])}/>
        <time>{new Date(issue.time).toLocaleTimeString(zh ? "zh-CN" : "en-GB",{hour12:false})}</time>
        {issue.kind === "network" ? <>
          <span className="br-http" data-warning={!!issue.status&&issue.status<500}>{issue.status ?? "ERR"}</span>
          <details><summary>{issue.method} · {issue.source}</summary>{issue.message !== issue.source && <p>{issue.message}</p>}</details>
          <small>{issue.duration === undefined ? "—" : Math.round(issue.duration) + " ms"}</small>
        </> : <>
          <span className="br-http" data-warning={issue.warning}>{issue.warning ? "WARN" : "ERR"}</span>
          <details><summary>{issue.message.split("\n")[0]}</summary><pre>{[issue.message,issue.source,issue.stack].filter(Boolean).join("\n")}</pre></details>
        </>}
      </article>)}
    </div>
  </section>;
}
