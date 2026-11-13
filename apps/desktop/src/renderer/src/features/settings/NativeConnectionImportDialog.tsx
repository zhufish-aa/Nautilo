import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, FolderInput, KeyRound, LoaderCircle, RefreshCw, Search, AlertCircle } from "lucide-react";
import type { RuntimeConnection } from "@agenthub/domain";
import type { NativeConnectionCandidate, NativeConnectionImportResult, NativeConnectionScan } from "@agenthub/schemas";
import { Dialog } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import "./native-connection-import.css";

const harnessNames: Record<string, string> = { codex: "Codex", "claude-code": "Claude Code", "kimi-code": "Kimi Code", pi: "Pi", omp: "Oh My Pi", "command-code": "Command Code", command: "Command Code", opencode: "OpenCode", trae: "Trae", deepseek: "DeepSeek Harness" };
const protocolNames = { responses: "Responses", chat: "Chat Completions", anthropic: "Anthropic Messages" };
const avatar = (id: string): string => ["command", "command-code"].includes(id) ? "commandcode" : id;

export function NativeConnectionImportDialog({ open, onOpenChange, onImported }: {
  open: boolean; onOpenChange: (value: boolean) => void; onImported: (connections: RuntimeConnection[]) => Promise<void>;
}): JSX.Element {
  const { locale } = useI18n(); const zh = locale === "zh-CN";
  const [scan, setScan] = useState<NativeConnectionScan>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false), [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const message = (cause: unknown): string => {
    const raw = cause instanceof Error ? cause.message : String(cause);
    if (raw.includes("SCAN_EXPIRED")) return zh ? "预览已过期，请重新扫描。" : "Preview expired. Scan again.";
    return zh ? "操作未完成，请重试。" : "The operation failed. Please retry.";
  };
  const refresh = async (): Promise<void> => {
    const request = ++sequence.current; setLoading(true); setError("");
    try {
      const result = await requestCore<NativeConnectionScan>("connection.scanNative", {});
      if (sequence.current !== request) return;
      setScan(result); setSelected(new Set(result.candidates.filter(c => c.hasCredential && !c.existingConnectionId).map(c => c.id)));
    } catch (cause) { if (sequence.current === request) setError(message(cause)); }
    finally { if (sequence.current === request) setLoading(false); }
  };
  useEffect(() => {
    if (open) { setQuery(""); setScan(undefined); setSelected(new Set()); void refresh(); }
    return () => { sequence.current++; };
  }, [open]);
  const toggle = (id: string): void => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const candidates = scan?.candidates ?? [];
  const visible = candidates.filter(c => `${c.name} ${c.baseUrl} ${c.sources.map(s => harnessNames[s.harness] ?? s.harness).join(" ")} ${c.models.map(m => m.id).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const selectable = visible.filter(c => !c.existingConnectionId);
  const allSelected = selectable.length > 0 && selectable.every(c => selected.has(c.id));
  const unreadable = scan?.sources.filter(s => s.status === "error") ?? [];
  const submit = async (): Promise<void> => {
    if (!scan || !selected.size || importing || loading) return;
    setImporting(true); setError("");
    try {
      const result = await requestCore<NativeConnectionImportResult>("connection.importNative", { scanId: scan.scanId, candidateIds: [...selected] });
      const saved = result.items.flatMap(item => item.connection ? [item.connection] : []);
      if (saved.length) await onImported(saved);
      const failed = result.items.filter(item => item.status === "failed");
      if (!failed.length) onOpenChange(false);
      else {
        setError(zh ? `${failed.length} 个连接导入失败，可重试。` : `${failed.length} imports failed. You can retry.`);
        setSelected(new Set(failed.map(item => item.candidateId)));
        const completed = new Map(result.items.filter(i => i.connection).map(i => [i.candidateId, i.connection!.id]));
        setScan(current => current ? { ...current, candidates: current.candidates.map(c => completed.has(c.id) ? { ...c, existingConnectionId: completed.get(c.id) } : c) } : current);
      }
    } catch (cause) { setError(message(cause)); }
    finally { setImporting(false); }
  };
  return <Dialog open={open} onOpenChange={value => { if (!importing) onOpenChange(value); }} title={zh ? "从 Harness 导入" : "Import from a harness"} widthClass="max-w-3xl" footer={<>
    <span className="native-import-footer-count">{zh ? `已选择 ${selected.size} 个连接` : `${selected.size} selected`}</span>
    <Button variant="outline" disabled={importing} onClick={() => onOpenChange(false)}>{zh ? "取消" : "Cancel"}</Button>
    <Button variant="primary" disabled={!selected.size || importing || loading} onClick={() => void submit()}>{importing ? <LoaderCircle size={15} className="animate-spin" /> : <FolderInput size={15} />}{zh ? `导入${selected.size ? ` ${selected.size} 个连接` : ""}` : `Import${selected.size ? ` ${selected.size}` : ""}`}</Button>
  </>}>
    <div className="native-import">
      <div className="native-import-toolbar"><div className="native-import-search"><Search size={15}/><Input value={query} onChange={e => setQuery(e.target.value)} aria-label={zh ? "搜索导入连接" : "Search connections to import"} placeholder={zh ? "搜索名称、Harness 或模型" : "Search name, harness or model"}/></div><Button variant="outline" size="sm" disabled={loading || importing} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? "animate-spin" : ""}/>{zh ? "重新扫描" : "Scan again"}</Button></div>
      {error && <div className="native-import-error" role="alert"><AlertCircle size={16}/>{error}</div>}
      {loading ? <div className="native-import-empty" role="status"><LoaderCircle size={24} className="animate-spin"/><span>{zh ? "正在读取本机配置…" : "Reading native configurations…"}</span></div> : scan && <>
        <div className="native-import-list-heading"><label><input type="checkbox" checked={allSelected} disabled={!selectable.length || importing} onChange={() => setSelected(previous => { const next = new Set(previous); for (const c of selectable) { if (allSelected) next.delete(c.id); else next.add(c.id); } return next; })}/>{zh ? "选择全部" : "Select all"}</label><span>{zh ? `${candidates.length} 个连接` : `${candidates.length} connections`}</span></div>
        <div className="native-import-list">{visible.map(candidate => <CandidateRow key={candidate.id} candidate={candidate} zh={zh} checked={selected.has(candidate.id)} disabled={importing} onToggle={() => toggle(candidate.id)}/>)}
          {!visible.length && <div className="native-import-empty"><FolderInput size={25}/><strong>{query ? (zh ? "没有匹配的连接" : "No matching connections") : (zh ? "未找到可导入的 API 配置" : "No native API configurations found")}</strong>{!query && <span>{zh ? "OAuth 账号请在「登录账号」中添加。" : "Add OAuth accounts in Login accounts."}</span>}</div>}
        </div>
        {!!unreadable.length && <details className="native-import-read-errors"><summary><AlertCircle size={14}/>{zh ? `${unreadable.length} 个配置未能读取` : `${unreadable.length} unreadable configurations`}<ChevronDown size={14}/></summary>{unreadable.map(s => <div key={`${s.harness}:${s.path}`}><strong>{harnessNames[s.harness] ?? s.harness}</strong><span>{s.path}</span></div>)}</details>}
      </>}
    </div>
  </Dialog>;
}

function CandidateRow({ candidate: c, zh, checked, disabled, onToggle }: { candidate: NativeConnectionCandidate; zh: boolean; checked: boolean; disabled: boolean; onToggle: () => void }): JSX.Element {
  const source = c.sources[0], name = harnessNames[source?.harness] ?? source?.harness;
  return <article className="native-import-row" data-selected={checked} data-existing={!!c.existingConnectionId}>
    <label className="native-import-choice"><input type="checkbox" checked={checked} disabled={disabled || !!c.existingConnectionId} onChange={onToggle}/><ProviderAvatar providerId={avatar(source?.harness ?? "")} size="sm"/>
      <span className="native-import-identity"><strong>{c.name}</strong><span>{name}{c.sources.length > 1 ? ` +${c.sources.length - 1}` : ""} · {protocolNames[c.protocol]}</span></span>
      {c.existingConnectionId ? <span className="native-import-existing"><Check size={13}/>{zh ? "已存在" : "Already added"}</span> : <span className="native-import-key" data-ready={c.hasCredential}><KeyRound size={13}/>{c.hasCredential ? (zh ? "密钥就绪" : "Key found") : (zh ? "缺少密钥" : "Key missing")}</span>}
    </label>
    <div className="native-import-row-body"><div className="native-import-endpoint" title={c.baseUrl}>{c.baseUrl}</div><div className="native-import-models" title={c.models.map(m => m.id).join(", ")}>{c.models.length ? <>{c.models.slice(0, 3).map(m => <span key={m.id}>{m.displayName || m.id}</span>)}{c.models.length > 3 && <span>+{c.models.length - 3}</span>}</> : <span>{zh ? "导入后添加模型" : "Add models after import"}</span>}</div>
      <details className="native-import-sources"><summary>{zh ? "配置来源" : "Configuration source"}<ChevronDown size={12}/></summary>{c.sources.map(s => <span key={`${s.harness}:${s.path}`} title={s.path}>{harnessNames[s.harness] ?? s.harness} · {s.path}</span>)}</details>
    </div>
  </article>;
}
