import { AccountConnectDialog } from "./AccountConnectDialog";
import { accountHarnessName } from "./account-connect";
import { AccountRoutingControl } from "./AccountRoutingControl";
import { NativeConnectionImportDialog } from "./NativeConnectionImportDialog";
import { useEffect, useId, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useSearchParams } from "react-router-dom";
import { Eye, EyeOff, FolderInput, LoaderCircle, Plus, RefreshCw, Search, Server, Trash2, Info } from "lucide-react";
import type { RuntimeConnection } from "@agenthub/domain";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";
import { IdentityAvatar, ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { useI18n } from "../../lib/i18n";
import { newId } from "../../lib/utils";
import { useConnectionsStore, type ConnectionDraft } from "../../stores/connections";
import { useAgentsStore } from "../../stores/agents";
import { toast } from "../../stores/toast";
import { AccountLoginPanel } from "../agents/AccountLoginPanel";
import { ModelConfigurationEditor } from "../agents/ModelConfigurationEditor";
import { modelRow, serializeModels, type ModelRow } from "../agents/model-editor";
import { DiagnosticStatus, ServiceDiagnosticPanel } from "./ServiceDiagnosticPanel";
import { useUiReducedMotion, useSurfaceEntrance } from "../../lib/ui-motion";

const protocols = [{ value: "responses", label: "OpenAI Responses" }, { value: "chat", label: "OpenAI Chat Completions" }, { value: "anthropic", label: "Anthropic Messages" }];
function label(connection: RuntimeConnection): string { return connection.kind === "login" ? accountHarnessName(connection.harness ?? "codex") : protocols.find((item) => item.value === connection.protocol)?.label ?? connection.protocol ?? "API"; }
function fresh(kind: "api" | "login"): ConnectionDraft { return { id: newId("connection"), name: "", kind, enabled: true, ...(kind === "api" ? { protocol: "responses" as const, baseUrl: "" } : { harness: "codex", loginProfileDirectory: "" }), models: [] }; }

function ConnectionMark({ connection, size = "sm" }: { connection: Pick<ConnectionDraft, "id" | "name" | "kind" | "harness">; size?: "sm" | "md" }): JSX.Element {
  return connection.kind === "login" ? <ProviderAvatar providerId={connection.harness ?? "codex"} size={size} /> : <IdentityAvatar label={connection.name || "API"} seed={connection.id} size={size} />;
}

/** Independent versioned connections; agent executables are not part of API providers. */
export function ConnectionsPanel(): JSX.Element {
  const [searchParams] = useSearchParams();
  const requestedConnectionId = searchParams.get("connection");
  const focusedConnection = useRef<string>();
  const { locale } = useI18n(); const zh = locale === "zh-CN";
  const motionId = useId(); const reducedMotion = useUiReducedMotion();
  const { connections, loading, error: loadError, hydrate, save, remove, models: discover } = useConnectionsStore();
  const installations = useAgentsStore((state) => state.installations);
  const instances = useAgentsStore((state) => state.instances);
  const loadConnectionModels = useConnectionsStore((state) => state.loadModels);
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
  const [importOpen, setImportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false); const [discardTarget, setDiscardTarget] = useState<RuntimeConnection | "api" | "login" | "new">();
  const [dirty, setDirty] = useState(false); const generation = useRef(0);
  const selected = connections.find((item) => item.id === selectedId);
  const detailRef = useSurfaceEntrance<HTMLElement>(selectedId);
  const visible = connections.filter((item) => item.kind === kind && `${item.name} ${item.baseUrl ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { void hydrate(); }, [hydrate]);
  const edit = (connection: RuntimeConnection): void => {
    setKind(connection.kind);
    generation.current++; setFetching(false); setSelectedId(connection.id); setRevision(connection.revision);
    const { revision: _revision, createdAt: _created, updatedAt: _updated, hasCredential: _credential, accountGateway: _gateway, ...values } = connection;
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
  useEffect(() => {
    if (requestedConnectionId && focusedConnection.current !== requestedConnectionId) {
      const connection = connections.find(item => item.id === requestedConnectionId);
      if (!connection) return;
      focusedConnection.current = requestedConnectionId;
      if (dirty) setDiscardTarget(connection);
      else { setQuery(""); setTab("connection"); edit(connection); }
      return;
    }
    if (!draft && visible[0]) edit(visible[0]);
  }, [connections, kind, requestedConnectionId]);
  useEffect(() => {
    if (!selected || selected.kind !== "login" || !selected.enabled || dirty) return;
    let current = true;
    const request = generation.current;
    setFetching(true);
    void loadConnectionModels(selected.id, selected.revision).then((catalog) => {
      if (!current || request !== generation.current) return;
      if (catalog.models.length) setRows(catalog.models.map((model) => modelRow(model, newId("model"))));
      if (catalog.warning) setError(catalog.warning);
    }).finally(() => { if (current && request === generation.current) setFetching(false); });
    return () => { current = false; };
  }, [selected?.id, selected?.revision, dirty, loadConnectionModels]);
  const patch = (changes: Partial<ConnectionDraft>): void => { setDraft((current) => current ? { ...current, ...changes } : current); setDirty(true); generation.current++; setFetching(false); };
  const submit = async (): Promise<void> => {
    if (!draft || busy) return;
    setError("");
    if (!draft.name.trim()) { setError(zh ? "请填写连接名称" : "Enter a connection name"); return; }
    if (draft.kind === "api" && !draft.baseUrl?.trim()) { setError(zh ? "请填写服务商 API Base URL" : "Enter the provider API base URL"); return; }
    if (draft.kind === "login" && !draft.loginProfileDirectory?.trim()) { setError(zh ? "请填写独立登录目录的绝对路径" : "Enter an absolute isolated login directory"); return; }
    let configuredModels; try { configuredModels = serializeModels(rows); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    const connection: ConnectionDraft = { id: draft.id, name: draft.name.trim(), kind: draft.kind, enabled: draft.enabled, models: configuredModels,
      ...(draft.kind === "api" ? { protocol: draft.protocol, baseUrl: draft.baseUrl?.trim() } : { harness: draft.harness, loginProfileDirectory: draft.loginProfileDirectory?.trim(), ...(draft.harness === "antigravity" ? { nativeLogin: true } : {}) }) };
    setBusy(true);
    try { const saved = await save(connection, revision, draft.kind === "api" ? apiKey : undefined, draft.kind === "api" && clearApiKey); edit(saved); toast.success(zh ? "连接已保存" : "Connection saved"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const fetchModels = async (): Promise<void> => {
    if (!selected || fetching || dirty || busy) return;
    const request = ++generation.current; setFetching(true); setError("");
    try { const catalog = await discover(selected.id, selected.revision, undefined); if (request !== generation.current) return;
      if (!catalog.models.length) { setError(catalog.warning || (zh ? "服务商未返回模型" : "The provider returned no models")); return; }
      setRows((current) => { const ids = new Set(current.map((row) => row.id)); return [...current, ...catalog.models.filter((model) => !ids.has(model.id)).map((model) => modelRow(model, newId("model")))]; }); setDirty(true);
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
  const refreshAfterLogin = async (): Promise<void> => {
    if (!selected || dirty) return;
    const request = ++generation.current;
    setFetching(true);
    try {
      const catalog = await loadConnectionModels(selected.id, selected.revision, true);
      if (request !== generation.current) return;
      if (catalog.models.length) setRows(catalog.models.map((model) => modelRow(model, newId("model"))));
      setError(catalog.warning ?? "");
    } finally {
      if (request === generation.current) setFetching(false);
    }
  };
  const deleteConnection = async (): Promise<void> => {
    if (!selected || busy) return; setBusy(true);
    try { await remove(selected.id); setDeleteOpen(false); setSelectedId(undefined); setDraft(undefined); setDirty(false); setApiKey(""); }
    catch (cause) { setDeleteOpen(false); setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const installed = installations.find((item) => item.providerId === draft?.harness);
  return <div className="connections-panel space-y-6" data-tab={tab}>
    <div className="connection-kind-tabs">{([{ id: "api", name: zh ? "API 连接" : "API connections" }, { id: "login", name: zh ? "登录账号" : "Login accounts" }] as const).map((item) => <button type="button" key={item.id} disabled={busy} aria-pressed={kind === item.id} onClick={() => navigate(item.id)}>{kind === item.id && <motion.span className="management-selection" layoutId={`${motionId}-kind`} transition={{type:"spring",duration:reducedMotion ? 0 : 0.5,bounce:0.2}} aria-hidden/>}<span>{item.name}</span><span className="connection-kind-count">{connections.filter(connection=>connection.kind===item.id).length}</span></button>)}</div>
    {loadError && <div role="alert" className="flex items-center justify-between gap-3 text-sm text-danger"><span>{loadError}</span><Button variant="outline" size="sm" onClick={() => void hydrate()}>{zh ? "重试" : "Retry"}</Button></div>}
    <div className="connection-layout grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="space-y-3 lg:border-r lg:border-line lg:pr-5">
        <div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-ink-3" /><Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={zh ? "搜索连接" : "Search connections"} placeholder={zh ? "搜索连接" : "Search connections"} /></div>
        <Button variant="outline" className="w-full" disabled={busy} onClick={() => navigate("new")}><Plus className="h-4 w-4" />{kind === "login" ? (zh ? "添加账号" : "Add account") : (zh ? "添加连接" : "Add connection")}</Button>
        {kind === "api" && <Button variant="outline" className="w-full" disabled={busy} onClick={() => setImportOpen(true)}><FolderInput className="h-4 w-4"/>{zh ? "从 Harness 导入" : "Import from a harness"}</Button>}
        <div className="connection-list">{visible.map((item) => <button type="button" key={item.id} disabled={busy} aria-pressed={selectedId === item.id} onClick={() => navigate(item)}>
          {selectedId === item.id && <motion.span className="connection-selection" layoutId={`${motionId}-connection`} transition={{type:"spring",duration:reducedMotion ? 0 : 0.5,bounce:0.2}} aria-hidden/>}
          <ConnectionMark connection={item}/><span className="connection-item-copy"><span className="connection-item-name">{item.name}</span><span className="connection-item-protocol">{label(item)}{!item.enabled ? zh ? " · 已停用" : " · Disabled" : ""}</span><DiagnosticStatus target={{kind:"connection",id:item.id,version:String(item.revision)}}/></span>
        </button>)}</div>
        {loading && <p className="text-xs text-ink-3">{zh ? "读取连接…" : "Loading connections…"}</p>}
        {!loading && !visible.length && <p className="px-2 py-4 text-xs text-ink-3">{zh ? "暂无匹配的连接" : "No matching connections"}</p>}
      </aside>
      {draft ? <section ref={detailRef} className="connection-detail min-w-0 space-y-5">
        <header className="connection-heading"><ConnectionMark connection={draft} size="md" /><div className="connection-heading-copy"><h2>{draft.name || (zh ? "新连接" : "New connection")}</h2><Tooltip content={zh ? "保存会创建新版本。旧会话继续使用原版本及原密钥，修改或清空这里的密钥不会撤销旧版本。停用连接可阻止所有版本运行；撤销密钥请前往服务商。不会自动切换其他账号或端点。" : "Saving creates a revision. Existing conversations retain their original revision and key; changing or clearing this key does not revoke older revisions. Disabling blocks all revisions. Revoke keys with the provider. No account or endpoint is substituted."}><button type="button" className="connection-revision-pill">{revision ? `${zh ? "版本" : "Revision"} ${revision}` : zh ? "尚未保存" : "Not saved"}<Info size={12} aria-hidden /></button></Tooltip></div>{selected && <Button variant="ghost" size="sm" className="connection-delete" disabled={busy} onClick={() => setDeleteOpen(true)} aria-label={zh ? "删除连接" : "Delete connection"}><Trash2 size={14} />{zh ? "删除" : "Delete"}</Button>}</header>
        <div className="connection-editor-tabs" role="tablist" aria-label={zh ? "连接配置" : "Connection configuration"} onKeyDown={(event) => {
          if (busy || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "connection" : event.key === "End" ? "models" : tab === "connection" ? "models" : "connection";
          setTab(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-connection-tab="${next}"]`)?.focus();
        }}>{([{ id: "connection", name: zh ? "连接设置" : "Connection" }, { id: "models", name: zh ? "模型配置" : "Models" }] as const).map((item) => <button type="button" role="tab" key={item.id} id={`connection-${item.id}-tab`} data-connection-tab={item.id} aria-controls={`connection-${item.id}-panel`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} disabled={busy} onClick={() => setTab(item.id)}>{tab === item.id && <motion.span className="management-selection" layoutId={`${motionId}-tab`} transition={{type:"spring",duration:reducedMotion ? 0 : 0.5,bounce:0.2}} aria-hidden/>}<span>{item.name}</span>{item.id === "models" && <span className="connection-kind-count">{rows.filter(row=>row.enabled !== false).length}</span>}</button>)}</div>
        {selected && <ServiceDiagnosticPanel target={{kind:"connection",id:selected.id,version:String(selected.revision)}} disabled={busy || dirty}/>}
        <fieldset disabled={busy} className="connection-editor-panels min-w-0">
        <div className="connection-tab-panel" role="tabpanel" id="connection-connection-panel" aria-labelledby="connection-connection-tab" hidden={tab !== "connection"}><div className="connection-form-fields">
          <Field label={zh ? "连接名称" : "Connection name"}><Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} aria-label={zh ? "连接名称" : "Connection name"} placeholder={zh ? "例如：工作 API" : "e.g. Work API"} /></Field>
          {draft.kind === "api" ? <>
            <Field label={zh ? "协议" : "Protocol"} hint={zh ? "API 连接可供各个 Harness 使用，由对应插件应用端点、密钥和模型配置。模型列表只显示这里已启用的模型。运行使用所选连接，不会借用其他账号或密钥。" : "API connections are available to each harness. Its plugin applies the endpoint, key and model configuration. Only models enabled here appear in the picker. Runs use the selected connection without borrowing another account or key."}><SelectField value={draft.protocol} options={protocols} onValueChange={(protocol) => patch({ protocol: protocol as RuntimeConnection["protocol"] })} aria-label={zh ? "协议" : "Protocol"} /></Field>
            <Field label="Base URL" className="connection-full-field" hint={zh ? "填入服务商的 API 基础地址。HTTPS 必需，127.0.0.1 或 [::1] 本机地址可用 HTTP。" : "Use your provider's API base URL. HTTPS is required; HTTP is allowed for 127.0.0.1 or [::1]."}><Input value={draft.baseUrl ?? ""} onChange={(event) => patch({ baseUrl: event.target.value })} aria-label="Base URL" placeholder="https://api.example.com/v1" spellCheck={false} className="font-mono text-sm" /></Field>
            <Field label="API Key" className="connection-full-field"><div className="relative"><Input type={showKey ? "text" : "password"} value={apiKey} autoComplete="off" spellCheck={false} aria-label="API Key" placeholder={selected?.hasCredential && !clearApiKey ? (zh ? "已保存 · 留空保留" : "Saved · leave blank to keep") : (zh ? "运行前需配置 API Key" : "API key required before running")} onChange={(event) => { setApiKey(event.target.value); setClearApiKey(false); setDirty(true); }} className="pr-11 font-mono text-sm" /><button type="button" onClick={() => setShowKey(!showKey)} aria-label={showKey ? zh ? "隐藏密钥" : "Hide key" : zh ? "显示密钥" : "Show key"} className="connection-key-visibility">{showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>{selected?.hasCredential && <button type="button" className="mt-2 text-xs text-ink-3 underline" onClick={() => { setApiKey(""); setClearApiKey(!clearApiKey); setDirty(true); }}>{clearApiKey ? (zh ? "保存时移除密钥 · 撤销" : "Key will be removed on save · undo") : (zh ? "移除已保存的密钥" : "Remove saved key")}</button>}</Field>
          </> : <>
            <Field label={zh ? "账号类型" : "Account type"} hint={draft.harness === "antigravity" ? (zh ? "与官方 agy 共用系统凭据库中的 Google 登录。" : "Google sign-in is shared with official agy through the OS keyring.") : (zh ? "一个目录对应一个账号。已用于会话的目录不要重新登录其他账号。" : "Use one directory per account. Keep the identity of existing conversations.")}><p className="text-sm text-ink-2">{accountHarnessName(draft.harness ?? "codex")}</p></Field>
            {draft.harness !== "antigravity" && <details className="connection-storage connection-full-field"><summary className="cursor-pointer text-xs text-ink-3">{zh ? "账号存储信息（应用管理）" : "Account storage (managed by the app)"}</summary><p className="mt-2 break-all font-mono text-xs text-ink-3">{draft.loginProfileDirectory}</p></details>}
            {selected && selected.harness !== "antigravity" && <AccountRoutingControl key={selected.id} connection={selected} disabled={busy || dirty} />}
            {selected && !dirty && installed?.executable ? <AccountLoginPanel onLoginSuccess={() => void refreshAfterLogin()} key={`${selected.id}:${selected.revision}`} instance={{ id: selected.id, displayName: selected.name, providerId: selected.harness!, executable: installed.executable, baseArgs: [], envPolicyId: "env-standard", enabled: selected.enabled, status: "available", loginProfileDirectory: selected.loginProfileDirectory, createdAt: selected.createdAt, updatedAt: selected.updatedAt }} /> : <p className="text-xs text-ink-3">{zh ? "安装对应官方 CLI 后可重新登录此账号。" : "Install the matching official CLI to sign in to this account again."}</p>}
          </>}
          <div className="connection-enabled-control connection-full-field"><span className="text-sm">{zh ? "启用连接" : "Enable connection"}</span><Switch checked={draft.enabled} onCheckedChange={(enabled) => patch({ enabled })} aria-label={zh ? "启用连接" : "Enable connection"} /></div>
        </div></div><div className="connection-tab-panel connection-models space-y-4" role="tabpanel" id="connection-models-panel" aria-labelledby="connection-models-tab" hidden={tab !== "models"}>{draft.kind === "login" && <p className="text-sm text-ink-3">{fetching ? (zh ? "正在自动获取账号模型…" : "Discovering account models…") : (zh ? "模型由登录账号自动获取。可刷新列表，或按需调整显示名称和价格。" : "Models are discovered from this account. Refresh or customize labels and pricing as needed.")}</p>}{draft.kind === "api" && (!selected || dirty) && <p className="text-xs text-ink-3">{zh ? "先保存连接，再获取模型；手动编辑随连接一起保存。" : "Save the connection before fetching models. Manual edits are saved with it."}</p>}<ModelConfigurationEditor key={draft.id} fetchAction={<Button variant="outline" size="sm" disabled={!selected || dirty || fetching} onClick={() => void fetchModels()}>{fetching ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{zh ? "获取模型" : "Fetch models"}</Button>} models={rows} onChange={(models) => { setRows(models); setDirty(true); generation.current++; setFetching(false); }} /></div>
        </fieldset>
        {error && <div className="space-y-2"><p role="alert" className="break-words text-sm text-danger">{error}</p>{selected && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reloadCurrent()}>{zh ? "放弃修改并重载已保存版本" : "Discard edits and reload saved version"}</Button>}</div>}

        <div className="connection-save-bar flex justify-end gap-3"><Button variant="outline" disabled={busy} onClick={() => { if (selected) edit(selected); else { setDraft(undefined); setDirty(false); setApiKey(""); } }}>{zh ? "取消" : "Cancel"}</Button><Button variant="primary" disabled={busy || (!!selected && !dirty)} onClick={() => void submit()}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" />}{tab === "models" ? (zh ? "保存模型" : "Save models") : (zh ? "保存连接" : "Save connection")}</Button></div>
      </section> : <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-center"><Server className="h-7 w-7 text-ink-3" /><p className="text-sm text-ink-3">{zh ? "添加独立供应商连接，再在新会话中选择。" : "Add an independent provider connection, then select it in a new conversation."}</p><Button variant="outline" onClick={() => navigate("new")}>{kind === "login" ? (zh ? "添加账号" : "Add account") : (zh ? "添加连接" : "Add connection")}</Button></div>}
    </div>
    <AccountConnectDialog open={accountOpen} onOpenChange={setAccountOpen} onConnected={(connection) => { setKind("login"); setQuery(""); edit(connection); toast.success(zh ? "账号已添加" : "Account added"); }} />
    <NativeConnectionImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={async imported => { await hydrate(); if (!dirty && imported[0]) { setQuery(""); edit(imported[0]); } toast.success(zh ? `已导入 ${imported.length} 个连接` : `${imported.length} connections imported`); }}/>
    <Dialog open={deleteOpen} onOpenChange={(open) => { if (!busy) setDeleteOpen(open); }} title={zh ? "删除连接？" : "Delete connection?"} footer={<><Button variant="outline" disabled={busy} onClick={() => setDeleteOpen(false)}>{zh ? "取消" : "Cancel"}</Button><Button variant="primary" disabled={busy} onClick={() => void deleteConnection()}>{zh ? "删除" : "Delete"}</Button></>}><p className="text-sm text-ink-2">{zh ? "服务端会检查已有会话引用；使用中的连接可能无法删除。" : "The server checks existing conversation references; connections in use may not be removable."}</p></Dialog>
    <Dialog open={discardTarget !== undefined} onOpenChange={(open) => { if (!open) setDiscardTarget(undefined); }} title={zh ? "放弃未保存的修改？" : "Discard unsaved changes?"} footer={<><Button variant="outline" onClick={() => setDiscardTarget(undefined)}>{zh ? "继续编辑" : "Keep editing"}</Button><Button variant="primary" onClick={() => { const target = discardTarget; setDiscardTarget(undefined); if (target === "new") create(); else if (typeof target === "string") changeKind(target); else if (target) edit(target); }}>{zh ? "放弃修改" : "Discard"}</Button></>}><p className="text-sm text-ink-2">{zh ? "当前连接和模型的修改尚未保存。" : "Connection and model changes have not been saved."}</p></Dialog>
  </div>;
}
