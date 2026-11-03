import { AccountConnectDialog } from "./AccountConnectDialog";
import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, LoaderCircle, Plus, RefreshCw, Search, Server, Trash2, UserRound } from "lucide-react";
import type { RuntimeConnection } from "@agenthub/domain";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { useI18n } from "../../lib/i18n";
import { newId } from "../../lib/utils";
import { useConnectionsStore, type ConnectionDraft } from "../../stores/connections";
import { useAgentsStore } from "../../stores/agents";
import { toast } from "../../stores/toast";
import { AccountLoginPanel } from "../agents/AccountLoginPanel";
import { ModelConfigurationEditor } from "../agents/ModelConfigurationEditor";
import { modelRow, serializeModels, type ModelRow } from "../agents/model-editor";

const protocols = [{ value: "responses", label: "OpenAI Responses" }, { value: "chat", label: "OpenAI Chat Completions" }, { value: "anthropic", label: "Anthropic Messages" }];
function label(connection: RuntimeConnection): string { return connection.kind === "login" ? connection.harness === "claude-code" ? "Claude Code" : "Codex" : protocols.find((item) => item.value === connection.protocol)?.label ?? connection.protocol ?? "API"; }
function fresh(kind: "api" | "login"): ConnectionDraft { return { id: newId("connection"), name: "", kind, enabled: true, ...(kind === "api" ? { protocol: "responses" as const, baseUrl: "" } : { harness: "codex", loginProfileDirectory: "" }), models: [] }; }

/** Independent versioned connections; agent executables are not part of API providers. */
export function ConnectionsPanel(): JSX.Element {
  const { locale } = useI18n(); const zh = locale === "zh-CN";
  const { connections, loading, error: loadError, hydrate, save, remove, models: discover } = useConnectionsStore();
  const installations = useAgentsStore((state) => state.installations);
  const instances = useAgentsStore((state) => state.instances);
  const [discoveryInstanceId, setDiscoveryInstanceId] = useState("");
  const [kind, setKind] = useState<"api" | "login">("api");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<ConnectionDraft>();
  const [revision, setRevision] = useState<number>();
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [tab, setTab] = useState<"connection" | "models">("connection");
  const [apiKey, setApiKey] = useState(""); const [clearApiKey, setClearApiKey] = useState(false); const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false); const [fetching, setFetching] = useState(false); const [error, setError] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false); const [discardTarget, setDiscardTarget] = useState<RuntimeConnection | "api" | "login" | "new">();
  const [dirty, setDirty] = useState(false); const generation = useRef(0);
  const selected = connections.find((item) => item.id === selectedId);
  const visible = connections.filter((item) => item.kind === kind && `${item.name} ${item.baseUrl ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { void hydrate(); }, [hydrate]);
  const edit = (connection: RuntimeConnection): void => {
    generation.current++; setFetching(false); setSelectedId(connection.id); setDiscoveryInstanceId(""); setRevision(connection.revision);
    const { revision: _revision, createdAt: _created, updatedAt: _updated, hasCredential: _credential, ...values } = connection;
    setDraft(values); setRows((connection.models ?? []).map((model) => modelRow(model, newId("model"))));
    setApiKey(""); setClearApiKey(false); setShowKey(false); setError(""); setDirty(false);
  };
  const create = (): void => { if (kind === "login") { if (selected) edit(selected); else { setDraft(undefined); setDirty(false); } setAccountOpen(true); return; } generation.current++; setFetching(false); setSelectedId(undefined); setRevision(undefined); setDraft(fresh(kind)); setRows([]); setApiKey(""); setClearApiKey(false); setError(""); setShowKey(false); setDirty(false); setTab("connection"); };
  const changeKind = (value: "api" | "login"): void => { generation.current++; setFetching(false); setKind(value); setQuery(""); setDraft(undefined); setSelectedId(undefined); setRows([]); setError(""); setApiKey(""); setClearApiKey(false); setDirty(false); };
  const navigate = (target: RuntimeConnection | "api" | "login" | "new"): void => {
    if (busy || target === kind || (typeof target !== "string" && target.id === selectedId)) return;
    if (dirty) { setDiscardTarget(target); return; }
    if (target === "new") create(); else if (typeof target === "string") changeKind(target); else edit(target);
  };
  useEffect(() => { if (!draft && visible[0]) edit(visible[0]); }, [connections, kind]);
  const patch = (changes: Partial<ConnectionDraft>): void => { setDraft((current) => current ? { ...current, ...changes } : current); setDirty(true); generation.current++; setFetching(false); };
  const submit = async (): Promise<void> => {
    if (!draft || busy) return;
    setError("");
    if (!draft.name.trim()) { setError(zh ? "请填写连接名称" : "Enter a connection name"); return; }
    if (draft.kind === "api" && !draft.baseUrl?.trim()) { setError(zh ? "请填写服务商 API Base URL" : "Enter the provider API base URL"); return; }
    if (draft.kind === "login" && !draft.loginProfileDirectory?.trim()) { setError(zh ? "请填写独立登录目录的绝对路径" : "Enter an absolute isolated login directory"); return; }
    let configuredModels; try { configuredModels = serializeModels(rows); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    const connection: ConnectionDraft = { id: draft.id, name: draft.name.trim(), kind: draft.kind, enabled: draft.enabled, models: configuredModels,
      ...(draft.kind === "api" ? { protocol: draft.protocol, baseUrl: draft.baseUrl?.trim() } : { harness: draft.harness, loginProfileDirectory: draft.loginProfileDirectory?.trim() }) };
    setBusy(true);
    try { const saved = await save(connection, revision, draft.kind === "api" ? apiKey : undefined, draft.kind === "api" && clearApiKey); edit(saved); toast.success(zh ? "连接已保存" : "Connection saved"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const fetchModels = async (): Promise<void> => {
    if (!selected || fetching || dirty || busy) return;
    const request = ++generation.current; setFetching(true); setError("");
    try { const catalog = await discover(selected.id, selected.revision, selected.kind === "login" ? discoveryInstanceId || undefined : undefined); if (request !== generation.current) return;
      if (!catalog.models.length) { setError(catalog.warning || (zh ? "服务商未返回模型" : "The provider returned no models")); return; }
      setRows((current) => { const ids = new Set(current.map((row) => row.id)); return [...current, ...catalog.models.filter((model) => !ids.has(model.id)).map((model) => modelRow(selected.kind === "api" && selected.protocol === "anthropic" ? { ...model, reasoningEfforts: [], defaultReasoningEffort: undefined } : model, newId("model")))]; }); setDirty(true);
      if (catalog.warning) setError(catalog.warning);
    } catch (cause) { if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (request === generation.current) setFetching(false); }
  };
  const reloadCurrent = async (): Promise<void> => {
    if (!selected || busy) return;
    setBusy(true);
    try { edit(await useConnectionsStore.getState().get(selected.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const deleteConnection = async (): Promise<void> => {
    if (!selected || busy) return; setBusy(true);
    try { await remove(selected.id); setDeleteOpen(false); setSelectedId(undefined); setDraft(undefined); setDirty(false); setApiKey(""); }
    catch (cause) { setDeleteOpen(false); setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const installed = installations.find((item) => item.providerId === draft?.harness);
  return <div className="space-y-6">
    <div className="flex gap-6 border-b border-line">{([{ id: "api", name: zh ? "API 连接" : "API connections" }, { id: "login", name: zh ? "登录账号" : "Login accounts" }] as const).map((item) => <button type="button" key={item.id} disabled={busy} aria-pressed={kind === item.id} onClick={() => navigate(item.id)} className={`border-b-2 px-1 pb-3 text-sm ${kind === item.id ? "border-ink font-medium" : "border-transparent text-ink-3"}`}>{item.name}</button>)}</div>
    {loadError && <div role="alert" className="flex items-center justify-between gap-3 text-sm text-danger"><span>{loadError}</span><Button variant="outline" size="sm" onClick={() => void hydrate()}>{zh ? "重试" : "Retry"}</Button></div>}
    <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="space-y-3 lg:border-r lg:border-line lg:pr-5">
        <div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-ink-3" /><Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={zh ? "搜索连接" : "Search connections"} placeholder={zh ? "搜索连接" : "Search connections"} /></div>
        <Button variant="outline" className="w-full" disabled={busy} onClick={() => navigate("new")}><Plus className="h-4 w-4" />{kind === "login" ? (zh ? "添加账号" : "Add account") : (zh ? "添加连接" : "Add connection")}</Button>
        <div className="space-y-1 pt-2">{visible.map((item) => <button type="button" key={item.id} disabled={busy} aria-pressed={selectedId === item.id} onClick={() => navigate(item)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-hover ${selectedId === item.id ? "bg-hover" : ""}`}>{item.kind === "login" ? <UserRound className="h-5 w-5 shrink-0 text-ink-2" /> : <Server className="h-5 w-5 shrink-0 text-ink-2" />}<span className="min-w-0"><span className="block truncate text-sm font-medium">{item.name}</span><span className="mt-1 block truncate text-xs text-ink-3">{label(item)}{!item.enabled ? zh ? " · 已停用" : " · Disabled" : ""}</span></span></button>)}</div>
        {loading && <p className="text-xs text-ink-3">{zh ? "读取连接…" : "Loading connections…"}</p>}
        {!loading && !visible.length && <p className="px-2 py-4 text-xs text-ink-3">{zh ? "暂无匹配的连接" : "No matching connections"}</p>}
      </aside>
      {draft ? <section className="min-w-0 space-y-5">
        <header className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">{draft.name || (zh ? "新连接" : "New connection")}</h2><p className="mt-1 text-xs text-ink-3">{revision ? `${zh ? "版本" : "Revision"} ${revision}` : zh ? "尚未保存" : "Not saved"}</p></div>{selected && <Button variant="ghost" size="icon" disabled={busy} onClick={() => setDeleteOpen(true)} aria-label={zh ? "删除连接" : "Delete connection"}><Trash2 className="h-4 w-4" /></Button>}</header>
        <div className="flex gap-6 border-b border-line">{([{ id: "connection", name: zh ? "连接设置" : "Connection" }, { id: "models", name: zh ? "模型配置" : "Models" }] as const).map((item) => <button type="button" key={item.id} aria-pressed={tab === item.id} onClick={() => setTab(item.id)} className={`border-b-2 px-1 pb-3 text-sm ${tab === item.id ? "border-ink font-medium" : "border-transparent text-ink-3"}`}>{item.name}</button>)}</div>
        <fieldset disabled={busy} className="min-w-0 space-y-5">
        {tab === "connection" ? <div className="space-y-5">
          <Field label={zh ? "连接名称" : "Connection name"}><Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} aria-label={zh ? "连接名称" : "Connection name"} placeholder={zh ? "例如：工作 API" : "e.g. Work API"} /></Field>
          {draft.kind === "api" ? <>
            <Field label={zh ? "协议" : "Protocol"}><SelectField value={draft.protocol} options={protocols} onValueChange={(protocol) => patch({ protocol: protocol as RuntimeConnection["protocol"] })} aria-label={zh ? "协议" : "Protocol"} /></Field>
            <Field label="Base URL"><Input value={draft.baseUrl ?? ""} onChange={(event) => patch({ baseUrl: event.target.value })} aria-label="Base URL" placeholder="https://api.example.com/v1" spellCheck={false} className="font-mono text-sm" /><p className="mt-2 text-xs text-ink-3">{zh ? "填入服务商的 API 基础地址。HTTPS 必需，127.0.0.1 或 [::1] 本机地址可用 HTTP。" : "Use your provider's API base URL. HTTPS is required; HTTP is allowed for 127.0.0.1 or [::1]."}</p></Field>
            <Field label="API Key"><div className="relative"><Input type={showKey ? "text" : "password"} value={apiKey} autoComplete="off" spellCheck={false} aria-label="API Key" placeholder={selected?.hasCredential && !clearApiKey ? (zh ? "已保存 · 留空保留" : "Saved · leave blank to keep") : (zh ? "运行前需配置 API Key" : "API key required before running")} onChange={(event) => { setApiKey(event.target.value); setClearApiKey(false); setDirty(true); }} className="pr-11 font-mono text-sm" /><button type="button" onClick={() => setShowKey(!showKey)} aria-label={showKey ? zh ? "隐藏密钥" : "Hide key" : zh ? "显示密钥" : "Show key"} className="absolute right-3 top-3 text-ink-3">{showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>{selected?.hasCredential && <button type="button" className="mt-2 text-xs text-ink-3 underline" onClick={() => { setApiKey(""); setClearApiKey(!clearApiKey); setDirty(true); }}>{clearApiKey ? (zh ? "保存时移除密钥 · 撤销" : "Key will be removed on save · undo") : (zh ? "移除已保存的密钥" : "Remove saved key")}</button>}</Field>
            <p className="text-xs leading-relaxed text-ink-3">{zh ? "API 连接独立于 Agent，运行前必须配置密钥，不会借用本机登录。会话会检查兼容性：Codex 支持所列协议；Claude Code 仅支持 Anthropic；其余适配器暂不支持。Anthropic 转换不支持图片、原生联网、thinking 或结构化输出。" : "API connections are independent of agents and require a key before running; local login is never used as a fallback. Sessions validate compatibility: Codex supports these protocols; Claude Code supports Anthropic only; other adapters are unsupported. The Anthropic bridge excludes images, hosted search, thinking and structured output."}</p>
          </> : <>
            <Field label={zh ? "账号类型" : "Account type"}><p className="text-sm text-ink-2">{draft.harness === "claude-code" ? "Claude Code" : "Codex"}</p></Field>
            <details className="rounded-lg border border-line p-3"><summary className="cursor-pointer text-xs text-ink-3">{zh ? "账号存储信息（应用管理）" : "Account storage (managed by the app)"}</summary><p className="mt-2 break-all font-mono text-xs text-ink-3">{draft.loginProfileDirectory}</p></details>
            <p className="text-xs leading-relaxed text-ink-3">{zh ? "一个目录对应一个账号。已用于会话的目录不要重新登录其他账号。账号连接不使用 API Key 或自定义端点。" : "Use one directory per account. Never sign another account into a directory already used by a conversation. Account connections do not use API keys or custom endpoints."}</p>
            {selected && !dirty && installed?.executable ? <AccountLoginPanel key={`${selected.id}:${selected.revision}`} instance={{ id: selected.id, displayName: selected.name, providerId: selected.harness!, executable: installed.executable, baseArgs: [], envPolicyId: "env-standard", enabled: selected.enabled, status: "available", loginProfileDirectory: selected.loginProfileDirectory, createdAt: selected.createdAt, updatedAt: selected.updatedAt }} /> : <p className="text-xs text-ink-3">{zh ? "安装对应官方 CLI 后可重新登录此账号。" : "Install the matching official CLI to sign in to this account again."}</p>}
          </>}
          <div className="flex items-center justify-between border-t border-line pt-4"><span className="text-sm">{zh ? "启用连接" : "Enable connection"}</span><Switch checked={draft.enabled} onCheckedChange={(enabled) => patch({ enabled })} aria-label={zh ? "启用连接" : "Enable connection"} /></div>
        </div> : <div className="space-y-4"><div className="flex items-center justify-between"><span className="text-sm font-medium">{zh ? "模型配置" : "Models"}</span><Button variant="outline" size="sm" disabled={!selected || dirty || fetching || (draft.kind === "login" && !discoveryInstanceId)} onClick={() => void fetchModels()}>{fetching ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{zh ? "获取模型" : "Fetch models"}</Button></div>{(!selected || dirty) && <p className="text-xs text-ink-3">{zh ? "先保存连接，再获取模型；手动编辑随连接一起保存。" : "Save the connection before fetching models. Manual edits are saved with it."}</p>}{draft.kind === "login" && <Field label={zh ? "用于获取模型的本机 Agent" : "Local agent for model discovery"}><SelectField value={discoveryInstanceId || undefined} placeholder={zh ? "选择同类已配置 Agent" : "Choose a matching configured agent"} options={instances.filter((item) => item.providerId === draft.harness && item.enabled).map((item) => ({ value: item.id, label: item.displayName }))} onValueChange={setDiscoveryInstanceId} aria-label={zh ? "用于获取模型的本机 Agent" : "Local agent for model discovery"} /><p className="mt-2 text-xs text-ink-3">{zh ? "仅使用所选 Agent 的可执行文件，登录和模型仍来自当前独立账号。" : "Only the selected agent's executable is used; authentication and models belong to this independent account."}</p></Field>}<ModelConfigurationEditor key={draft.id} models={rows} onChange={(models) => { setRows(models); setDirty(true); }} /></div>}
        </fieldset>
        {error && <div className="space-y-2"><p role="alert" className="break-words text-sm text-danger">{error}</p>{selected && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reloadCurrent()}>{zh ? "放弃修改并重载已保存版本" : "Discard edits and reload saved version"}</Button>}</div>}
        <p className="border-t border-line pt-4 text-xs leading-relaxed text-ink-3">{zh ? "保存会创建新版本。旧会话继续使用原版本及原密钥，修改或清空这里的密钥不会撤销旧版本。停用连接可阻止所有版本运行；撤销密钥请前往服务商。不会自动切换其他账号或端点。" : "Saving creates a revision. Existing conversations retain their original revision and key; changing or clearing this key does not revoke older revisions. Disabling blocks all revisions. Revoke keys with the provider. No account or endpoint is substituted."}</p>
        <div className="flex justify-end gap-3"><Button variant="outline" disabled={busy} onClick={() => { if (selected) edit(selected); else { setDraft(undefined); setDirty(false); setApiKey(""); } }}>{zh ? "取消" : "Cancel"}</Button><Button variant="primary" disabled={busy || (!!selected && !dirty)} onClick={() => void submit()}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" />}{zh ? "保存连接" : "Save connection"}</Button></div>
      </section> : <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-center"><Server className="h-7 w-7 text-ink-3" /><p className="text-sm text-ink-3">{zh ? "添加独立供应商连接，再在新会话中选择。" : "Add an independent provider connection, then select it in a new conversation."}</p><Button variant="outline" onClick={() => navigate("new")}>{kind === "login" ? (zh ? "添加账号" : "Add account") : (zh ? "添加连接" : "Add connection")}</Button></div>}
    </div>
    <AccountConnectDialog open={accountOpen} onOpenChange={setAccountOpen} onConnected={(connection) => { setKind("login"); setQuery(""); edit(connection); toast.success(zh ? "账号已添加" : "Account added"); }} />
    <Dialog open={deleteOpen} onOpenChange={(open) => { if (!busy) setDeleteOpen(open); }} title={zh ? "删除连接？" : "Delete connection?"} footer={<><Button variant="outline" disabled={busy} onClick={() => setDeleteOpen(false)}>{zh ? "取消" : "Cancel"}</Button><Button variant="primary" disabled={busy} onClick={() => void deleteConnection()}>{zh ? "删除" : "Delete"}</Button></>}><p className="text-sm text-ink-2">{zh ? "服务端会检查已有会话引用；使用中的连接可能无法删除。" : "The server checks existing conversation references; connections in use may not be removable."}</p></Dialog>
    <Dialog open={discardTarget !== undefined} onOpenChange={(open) => { if (!open) setDiscardTarget(undefined); }} title={zh ? "放弃未保存的修改？" : "Discard unsaved changes?"} footer={<><Button variant="outline" onClick={() => setDiscardTarget(undefined)}>{zh ? "继续编辑" : "Keep editing"}</Button><Button variant="primary" onClick={() => { const target = discardTarget; setDiscardTarget(undefined); if (target === "new") create(); else if (typeof target === "string") changeKind(target); else if (target) edit(target); }}>{zh ? "放弃修改" : "Discard"}</Button></>}><p className="text-sm text-ink-2">{zh ? "当前连接和模型的修改尚未保存。" : "Connection and model changes have not been saved."}</p></Dialog>
  </div>;
}
