import { useState } from "react";
import { KeyRound, Pencil, Plus, Search, Server, UserRound } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { providerMeta } from "../../lib/provider-catalog";
import type { AgentInstanceConfig } from "../../lib/types";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Input } from "../../components/ui/Input";
import { Switch } from "../../components/ui/Switch";
import { useAgentsStore } from "../../stores/agents";
import { toast } from "../../stores/toast";
import { AgentEditorDialog } from "./AgentEditorDialog";
import { AccountLoginPanel } from "./AccountLoginPanel";

function protocolName(instance: AgentInstanceConfig): string {
  if (instance.loginProfileDirectory) return instance.loginProfileLabel || providerMeta(instance.providerId).name;
  const value = instance.apiType || (instance.providerId === "codex" ? instance.wireApi || "responses" : "");
  const names: Record<string, string> = { responses: "OpenAI Responses", chat: "OpenAI Chat Completions", anthropic: "Anthropic Messages", "openai-responses": "OpenAI Responses", "openai-completions": "OpenAI Chat Completions", "anthropic-messages": "Anthropic Messages", "google-generative-ai": "Google Generative AI" };
  return names[value] || value || providerMeta(instance.providerId).name;
}

export function InstancesPanel(): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const instances = useAgentsStore((state) => state.instances);
  const setInstanceEnabled = useAgentsStore((state) => state.setInstanceEnabled);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AgentInstanceConfig>();
  const [selectedId, setSelectedId] = useState<string>();
  const [source, setSource] = useState<"api" | "account">("api");
  const [tab, setTab] = useState<"connection" | "models">("connection");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const visible = instances.filter((instance) => Boolean(instance.loginProfileDirectory) === (source === "account") && `${instance.displayName} ${instance.baseUrl ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const selected = visible.find((instance) => instance.id === selectedId) ?? visible[0];
  const openCreate = (): void => { setEditing(undefined); setEditorOpen(true); };
  const openEdit = (): void => { if (selected) { setEditing(selected); setEditorOpen(true); } };
  const toggle = async (enabled: boolean): Promise<void> => {
    if (busy || !selected) return;
    setBusy(true);
    try { await setInstanceEnabled(selected.id, enabled); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div className="instances-panel">
    <div className="instance-type-tabs flex gap-6 border-b border-line" role="tablist" aria-label={zh ? "连接类型" : "Connection type"}>
      {([{ id: "api", name: zh ? "API 连接" : "API connections" }, { id: "account", name: zh ? "登录账号" : "Login accounts" }] as const).map((item) => <button type="button" key={item.id} role="tab" aria-selected={source === item.id} onClick={() => { setSource(item.id); setQuery(""); }} className={`border-b-2 px-1 pb-3 text-sm ${source === item.id ? "border-ink font-medium text-ink" : "border-transparent text-ink-3"}`}>{item.name}</button>)}
    </div>
    <div className="instance-layout">
      <aside className="instance-navigation">
        <div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-ink-3" aria-hidden /><Input className="pl-9" aria-label={zh ? "搜索连接" : "Search connections"} placeholder={zh ? "搜索连接" : "Search connections"} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <Button variant="outline" className="w-full" onClick={openCreate}><Plus className="h-4 w-4" aria-hidden />{zh ? "添加连接" : "Add connection"}</Button>
        <div className="instance-list space-y-1">{visible.map((instance) => <button key={instance.id} type="button" onClick={() => setSelectedId(instance.id)} aria-pressed={selected?.id === instance.id} className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-hover ${selected?.id === instance.id ? "bg-hover" : ""}`}>
          {source === "account" ? <UserRound className="h-5 w-5 shrink-0 text-ink-2" /> : <Server className="h-5 w-5 shrink-0 text-ink-2" />}
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{instance.displayName}</span><span className="mt-1 block truncate text-xs text-ink-3">{protocolName(instance)}</span></span>
          {!instance.enabled && <span className="h-1.5 w-1.5 rounded-full bg-ink-3/40" aria-label={zh ? "已停用" : "Disabled"} />}
        </button>)}</div>
        {visible.length === 0 && <p className="px-2 py-3 text-xs text-ink-3">{query ? (zh ? "没有匹配的连接" : "No matching connections") : (zh ? "尚无连接" : "No connections yet")}</p>}
      </aside>
      {selected ? <section className="instance-detail min-w-0 space-y-5">
        <header className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold text-ink">{selected.displayName}</h2><p className="mt-1 text-sm text-ink-3">{protocolName(selected)}</p></div><Button variant="outline" size="sm" onClick={openEdit}><Pencil className="h-3.5 w-3.5" />{zh ? "编辑连接" : "Edit connection"}</Button></header>
        <div className="flex gap-6 border-b border-line">{([{ id: "connection", name: zh ? "连接设置" : "Connection" }, { id: "models", name: zh ? "模型配置" : "Models" }] as const).map((item) => <button type="button" key={item.id} aria-pressed={tab === item.id} onClick={() => setTab(item.id)} className={`border-b-2 px-1 pb-3 text-sm ${tab === item.id ? "border-ink font-medium text-ink" : "border-transparent text-ink-3"}`}>{item.name}</button>)}</div>
        {tab === "connection" ? <div className="space-y-5">
          <div className="flex items-center justify-between border-b border-line pb-5"><span className="text-sm text-ink-2">{zh ? "启用连接" : "Enable connection"}</span><Switch checked={selected.enabled} disabled={busy} onCheckedChange={(enabled) => void toggle(enabled)} aria-label={zh ? "启用连接" : "Enable connection"} /></div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-5 text-sm">
            <dt className="text-ink-3">{zh ? "协议" : "Protocol"}</dt><dd className="text-ink-2">{protocolName(selected)}</dd>
            {selected.loginProfileDirectory ? <><dt className="text-ink-3">{zh ? "登录目录" : "Login directory"}</dt><dd className="break-all font-mono text-xs text-ink-2">{selected.loginProfileDirectory}</dd></> : <><dt className="text-ink-3">Base URL</dt><dd className="break-all text-ink-2">{selected.baseUrl || (zh ? "默认端点" : "Default endpoint")}</dd><dt className="text-ink-3">API Key</dt><dd className="flex items-center gap-2 text-ink-2"><KeyRound className="h-3.5 w-3.5" />{selected.credentialStored ? (zh ? "已配置" : "Configured") : (zh ? "未配置 · 使用本机认证或无需认证" : "Not set · local authentication or unauthenticated")}</dd></>}
          </dl>
          {selected.loginProfileDirectory && <AccountLoginPanel key={selected.id} instance={selected} />}
          <details className="border-t border-line pt-4"><summary className="cursor-pointer text-sm text-ink-3">{zh ? "高级连接信息" : "Advanced connection details"}</summary><dl className="mt-4 space-y-2 text-xs text-ink-3"><dt>{providerMeta(selected.providerId).name}</dt><dd className="break-all font-mono">{selected.executable}</dd>{selected.baseArgs.length > 0 && <dd className="break-all font-mono">{selected.baseArgs.join(" ")}</dd>}</dl></details>
        </div> : <div className="space-y-4"><div className="flex items-center justify-between"><h3 className="text-sm font-medium">{zh ? "可用模型" : "Configured models"} <span className="ml-2 text-xs font-normal text-ink-3">{selected.models?.length ?? 0}</span></h3><Button variant="outline" size="sm" onClick={openEdit}>{zh ? "管理模型" : "Manage models"}</Button></div>
          {(selected.models?.length ?? 0) > 0 ? <ul className="divide-y divide-line rounded-lg border border-line">{selected.models!.map((model) => <li key={model.id} className="flex items-center justify-between gap-4 px-4 py-3"><div className="min-w-0"><p className="truncate text-sm text-ink">{model.displayName || model.id}</p><p className="mt-1 truncate font-mono text-xs text-ink-3">{model.id}</p></div><div className="text-right text-xs text-ink-3"><p>{model.enabled === false ? (zh ? "已停用" : "Disabled") : model.defaultReasoningEffort || model.reasoningEfforts[0] || (zh ? "服务商默认" : "Provider default")}</p><p className="mt-1">{model.pricing && Object.values(model.pricing).some((value) => value !== undefined) ? (zh ? "价格已设置" : "Pricing set") : (zh ? "价格未设置" : "Pricing not set")}</p></div></li>)}</ul> : <p className="py-6 text-sm text-ink-3">{zh ? "未配置固定模型列表，使用服务商发现的模型。" : "No curated model list. Models are discovered from the provider."}</p>}
        </div>}
      </section> : <EmptyState icon={Server} title={zh ? "添加你的第一个连接" : "Add your first connection"} description={zh ? "配置端点、认证和模型，供会话使用。" : "Configure endpoints, authentication and models for your conversations."} action={<Button variant="outline" onClick={openCreate}>{zh ? "添加连接" : "Add connection"}</Button>} />}
    </div>
    <AgentEditorDialog open={editorOpen} onOpenChange={setEditorOpen} instance={editing} initialConnectionMode={source} />
  </div>;
}
