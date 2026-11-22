import { AccountConnectDialog } from "./AccountConnectDialog";
import { accountHarnessName } from "./account-connect";
import { AccountRoutingControl } from "./AccountRoutingControl";
import { NativeConnectionImportDialog } from "./NativeConnectionImportDialog";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowRight, Eye, EyeOff, FolderInput, LoaderCircle, LogIn, Plus, RefreshCw, Search, Server, ShieldCheck, Trash2 } from "lucide-react";
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
import { requestCore } from "../../lib/bridge";
import { connectionModelKey, useConnectionsStore, type ConnectionDraft } from "../../stores/connections";
import { useAgentsStore } from "../../stores/agents";
import { toast } from "../../stores/toast";
import { AccountLoginPanel } from "../agents/AccountLoginPanel";
import { ModelConfigurationEditor } from "../agents/ModelConfigurationEditor";
import { modelRow, serializeModels, type ModelRow } from "../agents/model-editor";
import { ServiceDiagnosticPanel } from "./ServiceDiagnosticPanel";
import { AccountStorage, AccountSummary } from "./AccountConnectionDetails";
import { useSurfaceEntrance } from "../../lib/ui-motion";
import "./connections.css";

const protocols = [{ value: "responses", label: "OpenAI Responses" }, { value: "chat", label: "OpenAI Chat Completions" }, { value: "anthropic", label: "Anthropic Messages" }];
function label(connection: RuntimeConnection): string { return connection.kind === "login" ? accountHarnessName(connection.harness ?? "codex") : protocols.find((item) => item.value === connection.protocol)?.label ?? connection.protocol ?? "API"; }
function fresh(kind: "api" | "login"): ConnectionDraft { return { id: newId("connection"), name: "", kind, enabled: true, ...(kind === "api" ? { protocol: "responses" as const, baseUrl: "" } : { harness: "codex", loginProfileDirectory: "" }), models: [] }; }

function endpointHost(url?: string): string | undefined {
  if (!url) return;
  try { return new URL(url).host; } catch { return; }
}

function ConnectionMark({ connection, size = "sm" }: { connection: Pick<ConnectionDraft, "id" | "name" | "kind" | "harness">; size?: "sm" | "md" }): JSX.Element {
  return connection.kind === "login" ? <ProviderAvatar providerId={connection.harness ?? "codex"} size={size} /> : <IdentityAvatar label={connection.name || "API"} seed={connection.id} size={size} />;
}

/** Independent versioned connections; agent executables are not part of API providers. */
export function ConnectionsPanel(): JSX.Element {
  const [searchParams] = useSearchParams();
  const requestedConnectionId = searchParams.get("connection");
  const focusedConnection = useRef<string>();
  const { locale } = useI18n(); const zh = locale === "zh-CN";
  const { connections, loading, error: loadError, hydrate, save, remove, models: discover, modelCatalogs, get: getConnection } = useConnectionsStore();
  const installations = useAgentsStore((state) => state.installations);
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
  const [accountDetail, setAccountDetail] = useState<RuntimeConnection>();
  const [now, setNow] = useState(Date.now);
  const detailMeta = accountDetail?.id === selected?.id && accountDetail?.revision === selected?.revision ? accountDetail?.accountMeta : undefined;
  const selectedAccount = selected && { ...selected, accountMeta: { ...selected.accountMeta, localUsage: detailMeta?.localUsage, referencedByHarnesses: detailMeta?.referencedByHarnesses } };
  const detailRef = useSurfaceEntrance<HTMLElement>(selectedId);
  const visible = connections.filter(item => item.kind === kind && [item.name, item.baseUrl, label(item), item.accountMeta?.accountEmail, item.accountMeta?.accountLabel, item.accountMeta?.subscriptionPlan].filter(Boolean).join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  const searchLabel = kind === "login" ? (zh ? "搜索账号" : "Search accounts") : (zh ? "搜索连接" : "Search connections");
  useEffect(() => { void hydrate(); }, [hydrate]);
  useEffect(() => {
    if (!selected || selected.kind !== "login") return;
    let active = true;
    void requestCore<RuntimeConnection>("connection.get", { connectionId: selected.id, revision: selected.revision, includeUsage: true }).then(value => {
      if (active) setAccountDetail(value);
    }, () => undefined);
    return () => { active = false; };
  }, [selected?.id, selected?.revision]);
  useEffect(() => {
    const delays = connections.map(item => Date.parse(item.accountMeta?.rateLimitedUntil ?? "") - now).filter(delay => delay > 0);
    if (!delays.length) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(60_000, ...delays) + 20);
    return () => window.clearTimeout(timer);
  }, [connections, now]);
  const edit = (connection: RuntimeConnection): void => {
    setKind(connection.kind);
    generation.current++; setFetching(false); setSelectedId(connection.id); setRevision(connection.revision);
    const { revision: _revision, createdAt: _created, updatedAt: _updated, hasCredential: _credential, accountGateway: _gateway, accountMeta: _meta, ...values } = connection;
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
    if (draft.kind === "login" && !draft.nativeLogin && !draft.loginProfileDirectory?.trim()) { setError(zh ? "请填写独立登录目录的绝对路径" : "Enter an absolute isolated login directory"); return; }
    let configuredModels; try { configuredModels = serializeModels(rows); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    const connection: ConnectionDraft = { id: draft.id, name: draft.name.trim(), kind: draft.kind, enabled: draft.enabled, models: configuredModels,
      ...(draft.kind === "api" ? { protocol: draft.protocol, baseUrl: draft.baseUrl?.trim() } : { harness: draft.harness, loginProfileDirectory: draft.loginProfileDirectory?.trim(), ...(["antigravity", "opencode"].includes(draft.harness ?? "") ? { nativeLogin: true } : {}) }) };
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
      await getConnection(selected.id);
      const catalog = await loadConnectionModels(selected.id, selected.revision, true);
      if (request !== generation.current) return;
      if (catalog.models.length) setRows(catalog.models.map((model) => modelRow(model, newId("model"))));
      setError(catalog.warning ?? "");
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
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
  const modelCount = rows.filter(row => row.enabled).length;
  const previewModels = [...new Set((draft?.models ?? []).filter(model => model.enabled !== false).map(model => model.displayName?.trim() || model.id))];
  const catalog = selected && modelCatalogs[connectionModelKey(selected.id, selected.revision)];
  const defaultModel = previewModels[0] ?? catalog?.models.find(model => model.id === catalog.defaultModel)?.displayName ?? catalog?.defaultModel;
  const meta = selected?.accountMeta;
  const storedDirectory = draft?.harness === "antigravity" ? undefined : draft?.loginProfileDirectory || undefined;
  const storage = meta?.storageMeta ?? (storedDirectory ? { configDir: storedDirectory } : undefined);
  const headingStatus = Date.parse(meta?.rateLimitedUntil ?? "") > now ? { tone: "danger", text: zh ? "限流冷却中" : "Rate limited" }
    : draft?.enabled ? { tone: "ok", text: zh ? "已启用" : "Enabled" } : { tone: "muted", text: zh ? "已停用" : "Disabled" };
  const headingSubtitle = draft?.kind === "login" && selected ? [label(selected), meta?.accountEmail || meta?.accountLabel, meta?.workspaceName].filter(Boolean).join(" · ")
    : draft?.kind === "api" ? [protocols.find(item => item.value === draft.protocol)?.label, endpointHost(draft.baseUrl)].filter(Boolean).join(" · ") : undefined;
  return <div className="connections-panel" data-tab={tab}>
    <div className="connection-kind-tabs" role="group" aria-label={zh ? "连接类型" : "Connection type"}>
      {([{ id: "api", name: zh ? "API 连接" : "API connections" }, { id: "login", name: zh ? "登录账号" : "Login accounts" }] as const).map(item => (
        <button type="button" key={item.id} disabled={busy} aria-pressed={kind === item.id} onClick={() => navigate(item.id)}>
          <span>{item.name}</span><span className="connection-kind-count">{connections.filter(connection => connection.kind === item.id).length}</span>
        </button>
      ))}
    </div>
    {loadError && <div role="alert" className="flex items-center justify-between gap-3 text-sm text-danger"><span>{loadError}</span><Button variant="outline" size="sm" onClick={() => void hydrate()}>{zh ? "重试" : "Retry"}</Button></div>}
    <div className="connection-layout">
      <aside>
        <div className="connection-list-toolbar" data-kind={kind}>
          <div className="connection-search relative"><Search className="absolute left-3 h-4 w-4 text-ink-3" /><Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={searchLabel} placeholder={searchLabel} /></div>
          <div className="connection-list-actions">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => navigate("new")}><Plus size={15}/>{kind === "login" ? (zh ? "添加账号" : "Add account") : (zh ? "添加连接" : "Add connection")}</Button>
            {kind === "api" && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setImportOpen(true)}><FolderInput size={14}/>{zh ? "从 Harness 导入" : "Import from harness"}</Button>}
          </div>
        </div>
        <div className="connection-list">{visible.map(item => {
          const meta = item.accountMeta;
          const cooling = Date.parse(meta?.rateLimitedUntil ?? "") > now;
          const tone = !item.enabled ? "muted" : cooling || meta?.authStatus === "expired" || meta?.authStatus === "error" ? "danger" : meta?.authStatus === "valid" ? "ok" : "warn";
          const identity = meta?.accountEmail || meta?.accountLabel || label(item);
          const savedModels = item.models?.filter(model => model.enabled !== false).length ?? 0;
          const count = item.models?.length ? savedModels : modelCatalogs[connectionModelKey(item.id, item.revision)]?.models.length ?? 0;
          const badge = cooling ? (zh ? "限流中" : "Limited") : !item.enabled ? (zh ? "停用" : "Disabled") : meta?.subscriptionPlan;
          return <button type="button" key={item.id} disabled={busy} aria-pressed={selectedId === item.id} onClick={() => navigate(item)}>
            <span className="connection-list-mark"><ConnectionMark connection={item}/><i className="connection-status-dot" data-tone={tone}/></span>
            <span className="connection-item-copy">
              <span className="connection-item-line"><span className="connection-item-name" title={item.name}>{item.name}</span><span className="connection-item-model-count">{count}{zh ? " 模型" : " models"}</span></span>
              <span className="connection-item-line"><span className="connection-item-protocol" title={identity}>{identity}</span>{badge && <span className="connection-tag" data-tone={cooling ? "danger" : !item.enabled ? "muted" : "plan"}>{badge}</span>}</span>
            </span>
          </button>;
        })}</div>
        {loading && <p className="text-xs text-ink-3">{zh ? "读取连接…" : "Loading connections…"}</p>}
        {!loading && !visible.length && <p className="px-2 py-4 text-xs text-ink-3">{zh ? "暂无匹配的连接" : "No matching connections"}</p>}
      </aside>
      {draft ? <section ref={detailRef} className="connection-detail min-w-0">
        <header className="connection-heading">
          <ConnectionMark connection={draft} size="md" />
          <div className="connection-heading-copy">
            <div className="connection-heading-line">
              <h2>{draft.name || (zh ? "新连接" : "New connection")}</h2>
              <span className="connection-tag" data-tone={headingStatus.tone}>{headingStatus.text}</span>
              {meta?.subscriptionPlan && <span className="connection-tag" data-tone="plan">{meta.subscriptionPlan}</span>}
              {revision && <Tooltip content={zh ? "保存会创建新版本。已有会话继续用原版本和原密钥。停用连接会阻止所有版本运行；如需撤销密钥，请前往服务商。" : "Saving creates a revision. Existing sessions keep their revision and key. Disabling blocks all revisions. Revoke keys with the provider."}><button type="button" className="connection-revision-pill" aria-label={zh ? `版本 ${revision}` : `Revision ${revision}`}>v{revision}</button></Tooltip>}
            </div>
            {headingSubtitle && <p title={headingSubtitle}>{headingSubtitle}</p>}
          </div>
          {selected && <Button variant="ghost" size="sm" className="connection-delete" disabled={busy} onClick={() => setDeleteOpen(true)} aria-label={zh ? "删除连接" : "Delete connection"}><Trash2 size={14} />{zh ? "删除" : "Delete"}</Button>}
        </header>
        <div className="connection-editor-tabs" role="tablist" aria-label={zh ? "连接配置" : "Connection configuration"} onKeyDown={(event) => {
          if (busy || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "connection" : event.key === "End" ? "models" : tab === "connection" ? "models" : "connection";
          setTab(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-connection-tab="${next}"]`)?.focus();
        }}>{([{ id: "connection", name: zh ? "连接设置" : "Connection" }, { id: "models", name: zh ? "模型配置" : "Models" }] as const).map((item) => <button type="button" role="tab" key={item.id} id={`connection-${item.id}-tab`} data-connection-tab={item.id} aria-controls={`connection-${item.id}-panel`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} disabled={busy} onClick={() => setTab(item.id)}><span>{item.name}</span>{item.id === "models" && <span className="connection-kind-count">{modelCount}</span>}</button>)}</div>
        <div className="connection-detail-scroll">
        <fieldset disabled={busy} className="connection-editor-panels min-w-0">
        <div className="connection-tab-panel" role="tabpanel" id="connection-connection-panel" aria-labelledby="connection-connection-tab" hidden={tab !== "connection"}>
          {draft.kind === "login" && selectedAccount && <>
            <AccountSummary key={`${selectedAccount.id}:${selectedAccount.revision}`} connection={selectedAccount} modelCount={modelCount} defaultModel={defaultModel} onModels={() => setTab("models")} now={now} />
            <div className="connection-verification">
              {draft.loginProfileDirectory ? <AccountLoginPanel disabled={dirty} onLoginSuccess={() => void refreshAfterLogin()} key={`${selectedAccount.id}:${selectedAccount.revision}`} instance={{ id: selectedAccount.id, displayName: selectedAccount.name, providerId: selectedAccount.harness!, executable: installed?.executable ?? "", baseArgs: [], envPolicyId: "env-standard", enabled: selectedAccount.enabled, status: "available", loginProfileDirectory: selectedAccount.loginProfileDirectory, createdAt: selectedAccount.createdAt, updatedAt: selectedAccount.updatedAt }} />
                : <div className="connection-auth-shared"><LogIn size={17}/><p>{zh ? "此账号共享本机的官方登录。可在官方 CLI 管理，或用「添加账号」建立独立连接。" : "This account shares the device's official login. Manage it in the official CLI or add an isolated account."}</p></div>}
              <ServiceDiagnosticPanel key={selectedAccount.id} target={{kind:"connection",id:selectedAccount.id,version:String(selectedAccount.revision)}} disabled={busy || dirty}/>
            </div>
          </>}
          {draft.kind === "api" && selected && <div className="connection-verification"><ServiceDiagnosticPanel key={selected.id} target={{kind:"connection",id:selected.id,version:String(selected.revision)}} disabled={busy || dirty}/></div>}
          <div className="connection-form-fields">
          <Field label={zh ? "连接名称" : "Connection name"} className={draft.kind === "login" && !previewModels.length ? "connection-full-field" : undefined}><Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} aria-label={zh ? "连接名称" : "Connection name"} placeholder={zh ? "例如：工作连接" : "e.g. Work connection"} /></Field>
          {draft.kind === "api" ? <>
            <Field label={zh ? "协议" : "Protocol"} hint={zh ? "API 连接可供各个 Harness 使用，由对应插件应用端点、密钥和模型配置。模型列表只显示这里已启用的模型。运行使用所选连接，不会借用其他账号或密钥。" : "API connections are available to each harness. Its plugin applies the endpoint, key and model configuration. Only models enabled here appear in the picker. Runs use the selected connection without borrowing another account or key."}><SelectField value={draft.protocol} options={protocols} onValueChange={(protocol) => patch({ protocol: protocol as RuntimeConnection["protocol"] })} aria-label={zh ? "协议" : "Protocol"} /></Field>
            <Field label="Base URL" className="connection-full-field" hint={zh ? "填入服务商的 API 基础地址。HTTPS 必需，127.0.0.1 或 [::1] 本机地址可用 HTTP。" : "Use your provider's API base URL. HTTPS is required; HTTP is allowed for 127.0.0.1 or [::1]."}><Input value={draft.baseUrl ?? ""} onChange={(event) => patch({ baseUrl: event.target.value })} aria-label="Base URL" placeholder="https://api.example.com/v1" spellCheck={false} className="connection-mono" /></Field>
            <Field label="API Key" className="connection-full-field"><div className="relative"><Input type={showKey ? "text" : "password"} value={apiKey} autoComplete="off" spellCheck={false} aria-label="API Key" placeholder={selected?.hasCredential && !clearApiKey ? (zh ? "已保存 · 留空保留" : "Saved · leave blank to keep") : (zh ? "运行前需配置 API Key" : "API key required before running")} onChange={(event) => { setApiKey(event.target.value); setClearApiKey(false); setDirty(true); }} className="pr-11 connection-mono" /><button type="button" onClick={() => setShowKey(!showKey)} aria-label={showKey ? zh ? "隐藏密钥" : "Hide key" : zh ? "显示密钥" : "Show key"} className="connection-key-visibility">{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
              {selected?.hasCredential && <div className="connection-key-actions">{!clearApiKey && <span><ShieldCheck size={14}/>{zh ? "当前已保存凭据" : "Credential saved"}</span>}<button type="button" onClick={() => { setApiKey(""); setClearApiKey(!clearApiKey); setDirty(true); }}>{clearApiKey ? (zh ? "保存时移除密钥 · 撤销" : "Key will be removed on save · undo") : (zh ? "移除密钥" : "Remove key")}</button></div>}
            </Field>
          </> : previewModels.length > 0 && <div className="connection-model-preview">
            <span>{zh ? "已配置模型" : "Configured models"}</span>
            <div><div>{previewModels.slice(0, 4).map(model => <code key={model} title={model}>{model}</code>)}</div>
              {previewModels.length > 4 && <button type="button" onClick={() => setTab("models")}>+{previewModels.length - 4} {zh ? "更多" : "more"}<ArrowRight size={12}/></button>}
            </div>
          </div>}
          </div>
          <div className="connection-switches">
            {selectedAccount?.kind === "login" && <AccountRoutingControl key={selectedAccount.id} connection={selectedAccount} disabled={busy || dirty} />}
            <div className="connection-enabled-control"><div><strong>{zh ? "启用连接" : "Enable connection"}</strong><p>{zh ? "关闭后在新建任务和模型选择器中隐藏" : "Hide in new tasks and model pickers when disabled"}</p></div><Switch checked={draft.enabled} onCheckedChange={(enabled) => patch({ enabled })} aria-label={zh ? "启用连接" : "Enable connection"} /></div>
          </div>
          {draft.kind === "login" && storage && <AccountStorage key={draft.id} storage={storage}/>}
        </div><div className="connection-tab-panel connection-models space-y-4" role="tabpanel" id="connection-models-panel" aria-labelledby="connection-models-tab" hidden={tab !== "models"}>{draft.kind === "login" && <p className="text-sm text-ink-3">{fetching ? (zh ? "正在自动获取账号模型…" : "Discovering account models…") : (zh ? "模型由登录账号自动获取。可刷新列表，或按需调整显示名称和价格。" : "Models are discovered from this account. Refresh or customize labels and pricing as needed.")}</p>}{draft.kind === "api" && (!selected || dirty) && <p className="text-xs text-ink-3">{zh ? "先保存连接，再获取模型；手动编辑随连接一起保存。" : "Save the connection before fetching models. Manual edits are saved with it."}</p>}<ModelConfigurationEditor key={draft.id} fetchAction={<Button variant="outline" size="sm" disabled={!selected || dirty || fetching} onClick={() => void fetchModels()}>{fetching ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{zh ? "获取模型" : "Fetch models"}</Button>} models={rows} onChange={(models) => { setRows(models); setDirty(true); generation.current++; setFetching(false); }} /></div>
        </fieldset>
        {error && <div className="space-y-2"><p role="alert" className="break-words text-sm text-danger">{error}</p>{selected && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reloadCurrent()}>{zh ? "放弃修改并重载已保存版本" : "Discard edits and reload saved version"}</Button>}</div>}
        </div>

        <div className="connection-save-bar flex justify-end gap-3"><Button variant="ghost" disabled={busy} onClick={() => { if (selected) edit(selected); else { setDraft(undefined); setDirty(false); setApiKey(""); } }}>{zh ? "取消" : "Cancel"}</Button><Button variant="primary" className="connection-save" disabled={busy || (!!selected && !dirty)} onClick={() => void submit()}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" />}{tab === "models" ? (zh ? "保存模型" : "Save models") : (zh ? "保存连接" : "Save connection")}</Button></div>
      </section> : <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-center"><Server className="h-7 w-7 text-ink-3" /><p className="text-sm text-ink-3">{zh ? "添加独立供应商连接，再在新会话中选择。" : "Add an independent provider connection, then select it in a new conversation."}</p><Button variant="outline" onClick={() => navigate("new")}>{kind === "login" ? (zh ? "添加账号" : "Add account") : (zh ? "添加连接" : "Add connection")}</Button></div>}
    </div>
    <AccountConnectDialog open={accountOpen} onOpenChange={setAccountOpen} onConnected={(connection) => { setKind("login"); setQuery(""); edit(connection); toast.success(zh ? "账号已添加" : "Account added"); }} onSelectExisting={(connection) => { setKind("login"); setQuery(""); edit(connection); }} />
    <NativeConnectionImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={async imported => { await hydrate(); if (!dirty && imported[0]) { setQuery(""); edit(imported[0]); } toast.success(zh ? `已导入 ${imported.length} 个连接` : `${imported.length} connections imported`); }}/>
    <Dialog open={deleteOpen} onOpenChange={(open) => { if (!busy) setDeleteOpen(open); }} title={zh ? "删除连接？" : "Delete connection?"} footer={<><Button variant="outline" disabled={busy} onClick={() => setDeleteOpen(false)}>{zh ? "取消" : "Cancel"}</Button><Button variant="primary" disabled={busy} onClick={() => void deleteConnection()}>{zh ? "删除" : "Delete"}</Button></>}><p className="text-sm text-ink-2">{zh ? "服务端会检查已有会话引用；使用中的连接可能无法删除。" : "The server checks existing conversation references; connections in use may not be removable."}</p></Dialog>
    <Dialog open={discardTarget !== undefined} onOpenChange={(open) => { if (!open) setDiscardTarget(undefined); }} title={zh ? "放弃未保存的修改？" : "Discard unsaved changes?"} footer={<><Button variant="outline" onClick={() => setDiscardTarget(undefined)}>{zh ? "继续编辑" : "Keep editing"}</Button><Button variant="primary" onClick={() => { const target = discardTarget; setDiscardTarget(undefined); if (target === "new") create(); else if (typeof target === "string") changeKind(target); else if (target) edit(target); }}>{zh ? "放弃修改" : "Discard"}</Button></>}><p className="text-sm text-ink-2">{zh ? "当前连接和模型的修改尚未保存。" : "Connection and model changes have not been saved."}</p></Dialog>
  </div>;
}
