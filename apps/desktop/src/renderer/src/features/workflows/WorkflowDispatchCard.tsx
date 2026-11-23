import { useMemo } from "react";
import { Copy } from "lucide-react";
import { toast } from "../../stores/toast";
import { workflowRecord, workflowTargetName, type WorkflowDispatch } from "./workflow-dispatch";
import "./workflow-dispatch-card.css";

function entryLabel(key: string, zh: boolean): string {
  if (!zh) return key;
  if (key === "summary") return "摘要";
  if (key === "evidence") return "证据";
  if (key === "previous") return "上一轮传入";
  return key;
}

function jsonEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quoted && character === "\\") { index++; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === "{" || character === "[") depth++;
    if ((character === "}" || character === "]") && --depth === 0) return index + 1;
  }
  return text.length;
}

function splitDispatchText(text: string): { text: string; json: boolean }[] {
  const parts: { text: string; json: boolean }[] = [];
  const opening = /```json[ \t]*\r?\n|\{(?=\s*(?:["}]|[\p{L}_$][\p{L}\p{N}_$-]*\s*:))|\[(?=\s*(?:[\[{"\]]|-?\d|true\b|false\b|null\b))/giu;
  let cursor = 0;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    const fenced = match[0].startsWith("```");
    const start = fenced ? opening.lastIndex : match.index;
    const closingFence = fenced ? text.indexOf("```", start) : -1;
    const end = fenced ? (closingFence < 0 ? text.length : closingFence) : jsonEnd(text, start);
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index), json: false });
    parts.push({ text: text.slice(start, end), json: true });
    cursor = opening.lastIndex = closingFence < 0 ? end : end + 3;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), json: false });
  return parts;
}

function DispatchJson({ value, zh }: { value: string; zh: boolean }): JSX.Element {
  const formatted = useMemo(() => {
    try { return JSON.stringify(JSON.parse(value), null, 2); }
    catch { return value; }
  }, [value]);
  const label = zh ? "复制 JSON" : "Copy JSON";
  return <div className="workflow-dispatch-json">
    <pre><code>{formatted}</code></pre>
    <button type="button" className="workflow-dispatch-icon-button workflow-dispatch-copy" title={label} aria-label={label}
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); toast.success(zh ? "已复制 JSON" : "JSON copied"); }
        catch { toast.error(zh ? "复制失败" : "Could not copy JSON"); }
      }}><Copy size={13} aria-hidden /></button>
  </div>;
}

function DispatchText({ value, zh }: { value: string; zh: boolean }): JSX.Element {
  const parts = useMemo(() => splitDispatchText(value), [value]);
  return <>{parts.map((part, index) => part.json
    ? <DispatchJson key={index} value={part.text} zh={zh} />
    : part.text.trim() && <p key={index} className="workflow-dispatch-value">{part.text.trim()}</p>)}</>;
}

function PayloadValue({ value, zh, fields = true }: { value: unknown; zh: boolean; fields?: boolean }): JSX.Element {
  if (typeof value === "string" && value.trim()) return <DispatchText value={value} zh={zh} />;
  const record = workflowRecord(value);
  if (fields && record && Object.keys(record).length) return <dl>{Object.entries(record).map(([key, item]) =>
    <div key={key}><dt>{entryLabel(key, zh)}</dt><dd><PayloadValue value={item} zh={zh} fields={false}/></dd></div>)}</dl>;
  if (Array.isArray(value) && value.length && value.every(item => typeof item === "string")) return <ul>{value.map((item, index) =>
    <li key={index}><DispatchText value={item} zh={zh}/></li>)}</ul>;
  if (record || Array.isArray(value)) return <DispatchJson value={JSON.stringify(value, null, 2)} zh={zh} />;
  return <p className="workflow-dispatch-value">{String(value ?? "").trim() || (zh ? "空" : "Empty")}</p>;
}

export function WorkflowIncoming({ dispatch, zh }: { dispatch: WorkflowDispatch; zh: boolean }): JSX.Element | null {
  const { run, instance } = dispatch;
  if (instance.incoming == null && instance.item == null) return null;
  const envelope = workflowRecord(instance.incoming);
  const source = run.definition.nodes.find(node => node.id === envelope?.from);
  const outlet = source?.exits.find(exit => exit.id === envelope?.branch)?.name;
  return <section className="workflow-dispatch-incoming" aria-label={zh ? "传入数据" : "Incoming data"}>
    <h4>{zh ? "传入数据" : "Incoming data"}</h4>
    <div className="workflow-dispatch-inset">
      {source && <p className="workflow-dispatch-origin">{zh ? "来自" : "From"} {workflowTargetName(run, source.id, zh)}{outlet && ` · ${outlet}`}</p>}
      {instance.incoming != null && <PayloadValue value={envelope && Object.hasOwn(envelope, "result") ? envelope.result : instance.incoming} zh={zh}/>}
      {instance.item != null && <div className="workflow-dispatch-item"><strong>{zh ? "当前处理项" : "Current item"}</strong><PayloadValue value={instance.item} zh={zh}/></div>}
      {envelope?.previous != null && <details className="workflow-dispatch-history"><summary>{zh ? "查看上游历史" : "Previous inputs"}</summary><PayloadValue value={envelope.previous} zh={zh}/></details>}
    </div>
  </section>;
}
