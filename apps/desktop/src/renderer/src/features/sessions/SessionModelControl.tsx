import { useEffect, useRef, useState } from "react";
import type { RuntimeConnection } from "@agenthub/domain";
import { Dialog } from "../../components/ui/Dialog";
import { SelectField } from "../../components/ui/Select";
import { Button } from "../../components/ui/Button";
import { useTeamsStore } from "../../stores/teams";
import { connectionModelKey, useConnectionsStore } from "../../stores/connections";
import { connectionSupportsAgent } from "../../lib/session-connections";
import { connectionModelCatalog, type ConnectionModelSelection } from "../../lib/connection-models";
import { Box, Check, ChevronDown, Search } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { configureWorkbenchSession } from "../../lib/orchestration-runtime";
import { useAgentsStore } from "../../stores/agents";
import { useSessionsStore } from "../../stores/sessions";
import { toast } from "../../stores/toast";

export type ComposerConfiguration = ConnectionModelSelection;
type Draft = { instanceId: string; configuration: ComposerConfiguration; onChange: (patch: ComposerConfiguration) => void; onInstanceChange?: (id: string) => void };
const effortLabel = (value: string) => ({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" }[value] ?? value);

/** Conversation identity is fixed. Only supported model/effort choices belong here. */
export function SessionModelControl({ sessionId, disabled, draft }: { sessionId?: string; disabled?: boolean; draft?: Draft }): JSX.Element | null {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [boundConnection, setBoundConnection] = useState<RuntimeConnection>();
  const [connectionError, setConnectionError] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<{ id?: string; revision?: number; name: string; destination?: string; sourceSessionId: string; sourceConnectionId?: string; sourceRevision?: number }>();
  const connectionCatalogs = useConnectionsStore((state) => state.modelCatalogs);
  const connectionModelsLoading = useConnectionsStore((state) => state.loadingModels);
  const loadConnectionModels = useConnectionsStore((state) => state.loadModels);
  const connections = useConnectionsStore(state => state.connections);
  const hydrateConnections = useConnectionsStore(state => state.hydrate);
  const getConnection = useConnectionsStore(state => state.get);
  const teams = useTeamsStore(state => state.teams);
  const root = useRef<HTMLDivElement>(null);
  const session = useSessionsStore(state => state.sessions.find(item => item.id === sessionId));
  const instances = useAgentsStore(state => state.instances);
  const catalogs = useAgentsStore(state => state.modelCatalogs);
  const loading = useAgentsStore(state => state.loadingModels);
  const loadModels = useAgentsStore(state => state.loadModels);
  const target = session?.target;
  const member = target?.type === "member" ? teams.find(team => team.id === target.teamId)?.members.find(member => member.id === target.memberId) : undefined;
  const instanceId = target?.type === "agent" ? target.instanceId : member?.agentInstanceId ?? draft?.instanceId;
  const instance = instances.find(item => item.id === instanceId);
  const catalog = instance ? catalogs[instance.id] : undefined;
  const configuration = session ?? draft?.configuration;
  const connectionId = configuration?.connectionId;
  const currentHead = connections.find(item => item.id === connectionId);
  const connectionRevision = sessionId ? configuration?.connectionRevision : currentHead?.revision ?? configuration?.connectionRevision;
  const activeApprovalContext = useRef({ sessionId, instanceId, connectionId, connectionRevision });
  activeApprovalContext.current = { sessionId, instanceId, connectionId, connectionRevision };
  const selectedConnection = sessionId ? (boundConnection && boundConnection.id === connectionId && (connectionRevision === undefined || boundConnection.revision === connectionRevision) ? boundConnection : undefined) : connections.find(item => item.id === connectionId);
  const connectionKey = connectionId && (connectionRevision ?? selectedConnection?.revision) ? connectionModelKey(connectionId, (connectionRevision ?? selectedConnection?.revision)!) : undefined;
  const connectionCatalog = selectedConnection ? connectionModelCatalog(selectedConnection, connectionKey ? connectionCatalogs[connectionKey] : undefined) : undefined;
  const compatible = !!selectedConnection && !!instance && connectionSupportsAgent(selectedConnection, instance);
  const models = connectionId ? compatible ? connectionCatalog?.models ?? [] : [] : instance?.configurationKind === "harness" ? [] : catalog?.models ?? [];
  const modelId = configuration?.model || (!connectionId ? member?.model : undefined) || (connectionId ? connectionCatalog?.defaultModel ?? models[0]?.id : catalog?.defaultModel);
  const model = models.find(item => item.id === modelId);
  const effort = configuration?.reasoningEffort || (!connectionId ? member?.reasoningEffort : undefined) || model?.defaultReasoningEffort || model?.reasoningEfforts[0];
  const locked = disabled || saving;
  useEffect(() => { void hydrateConnections(); }, [hydrateConnections]);
  useEffect(() => {
    let current = true;
    setBoundConnection(undefined); setConnectionError(false);
    if (sessionId && connectionId) void getConnection(connectionId, connectionRevision).then(value => { if (current) setBoundConnection(value); }).catch(() => { if (current) setConnectionError(true); });
    return () => { current = false; };
  }, [sessionId, connectionId, connectionRevision, getConnection]);
  useEffect(() => {
    let current = true;
    setLoadError(false);
    if (instanceId && !connectionId && instance?.configurationKind !== "harness") void loadModels(instanceId).catch(() => { if (current) setLoadError(true); });
    return () => { current = false; };
  }, [instanceId, connectionId, instance?.configurationKind, loadModels]);
  useEffect(() => {
    let current = true;
    if (connectionId && compatible && selectedConnection) void loadConnectionModels(connectionId, connectionRevision ?? selectedConnection.revision)
      .catch(() => { if (current) setLoadError(true); });
    return () => { current = false; };
  }, [connectionId, connectionRevision, selectedConnection?.revision, compatible, loadConnectionModels]);
  useEffect(() => { setMenu(false); }, [sessionId, instanceId, disabled]);
  useEffect(() => { setPendingConnection(undefined); }, [sessionId, instanceId, connectionId, connectionRevision]);
  useEffect(() => {
    if (!menu) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node) && !(event.target as Element).closest?.("[data-radix-popper-content-wrapper]")) setMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { setMenu(false); triggerRef.current?.focus(); } };
    document.addEventListener("mousedown", outside); document.addEventListener("keydown", escape);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [menu]);
  if (!configuration || !instance) return null;
  const configure = async (patch: Omit<ComposerConfiguration, "connectionId"> & { connectionId?: string | null; confirmConnectionChange?: boolean }) => {
    if (locked) return false;
    setSaving(true);
    try {
      if (sessionId) await configureWorkbenchSession(sessionId, patch);
      else {
        const { confirmConnectionChange: _confirmed, connectionId: nextConnectionId, ...next } = patch;
        // Model/effort edits are partial updates. An omitted connection ID
        // preserves the binding; only an explicit null clears it.
        draft?.onChange({
          ...next,
          ...("connectionId" in patch ? { connectionId: nextConnectionId ?? undefined } : {}),
        });
      }
      setMenu(false);
      return true;
    }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); return false; }
    finally { setSaving(false); }
  };
  const unavailable = !connectionId && instance.configurationKind === "harness"
    ? (zh ? "请先选择供应商或账号" : "Choose a provider or account first")
    : selectedConnection && !compatible
      ? (zh ? "当前连接与 Harness 不兼容" : "This connection is incompatible with the harness")
      : (zh ? "请在供应商设置中启用模型" : "Enable a model in provider settings");
  const efforts = model?.reasoningEfforts ?? [];
  const label = model?.displayName || modelId || (loading[instance.id] ? (zh ? "读取模型…" : "Loading models…") : unavailable);
  const modelDescription = effort ? label + " · " + effortLabel(effort) : label;
  const hint = disabled ? (zh ? "运行中不可更改" : "Cannot change during a run") : (zh ? "下一次发送时生效" : "Applies to the next message");
  const changeConnection = (candidate: { id?: string; revision?: number; name: string; destination?: string }) => {
    if (locked || (candidate.id === connectionId && candidate.revision === connectionRevision)) return;
    if (sessionId) { setMenu(false); setPendingConnection({ ...candidate, sourceSessionId: sessionId, sourceConnectionId: connectionId, sourceRevision: connectionRevision }); }
    else void configure({ connectionId: candidate.id ?? null, connectionRevision: candidate.revision, model: "", reasoningEffort: "", serviceTier: "" });
  };
  const confirmConnection = () => {
    const approved = pendingConnection;
    const current = useSessionsStore.getState().sessions.find(item => item.id === approved?.sourceSessionId);
    if (!approved || approved.sourceSessionId !== activeApprovalContext.current.sessionId || instanceId !== activeApprovalContext.current.instanceId || !current || current.connectionId !== approved.sourceConnectionId || current.connectionRevision !== approved.sourceRevision) {
      setPendingConnection(undefined);
      return;
    }
    void configure({ connectionId: approved.id ?? null, connectionRevision: approved.revision, confirmConnectionChange: true, model: "", reasoningEffort: "", serviceTier: "" }).then(success => { if (success) setPendingConnection(undefined); });
  };
  const visibleModels = models.filter((item) => `${item.displayName} ${item.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const connectionOptions = [
    ...(instance.configurationKind === "harness" ? [] : [{ value: "__instance", label: zh ? "旧会话原有连接" : "Legacy connection" }]),
    ...connections.filter((item) => connectionSupportsAgent(item, instance)).map((item) => ({ value: item.id, label: item.name }))
  ];
  if (connectionId && !connectionOptions.some((item) => item.value === connectionId)) {
    connectionOptions.push({ value: connectionId, label: selectedConnection?.name ?? connectionId });
  }
  const chooseConnection = (id: string): void => {
    const item = connections.find((connection) => connection.id === id);
    changeConnection(item ? {
      id: item.id, revision: item.revision, name: item.name,
      destination: item.kind === "api" ? item.baseUrl : `${item.harness} · ${zh ? "所选登录账号" : "Selected login account"}`
    } : {
      name: zh ? "Agent 原有配置" : "Existing agent configuration",
      destination: instance.baseUrl || `${instance.providerId} · ${zh ? "接收地址由本机 CLI 配置决定，Nautilo 未验证" : "Destination comes from local CLI configuration and is not verified by Nautilo"}`
    });
  };
  return <div ref={root} className="composer-model-control">
    <Dialog open={!!pendingConnection && pendingConnection.sourceSessionId === sessionId} onOpenChange={open => { if (!open && !saving) setPendingConnection(undefined); }} title={zh ? "切换下一轮的账号 / 供应商？" : "Switch account / provider for the next message?"} description={zh ? "下一条消息会向下方账号/端点发送本会话已保存的聊天文本和最近 8 个产物的名称/路径，其中可能包含此前发给其他供应商的信息。原生推理、缓存、工具事件与旧图片不迁移，图片请重新附加。聊天记录保留，但不是无损上下文迁移；文本超限时会拒绝发送，不会静默截断。" : "The next message will share saved conversation text and names/paths of the latest 8 artifacts with the account/endpoint below. This may include information previously sent to other providers. Native reasoning, cache, tool events and previous images do not transfer; reattach images. History is retained, but this is not lossless context transfer. Oversized text is rejected rather than silently truncated."} footer={<><Button variant="ghost" disabled={saving} onClick={() => setPendingConnection(undefined)}>{zh ? "取消" : "Cancel"}</Button><Button disabled={locked} onClick={confirmConnection}>{zh ? "切换下一轮" : "Switch next message"}</Button></>}><p className="text-sm font-medium text-ink">{pendingConnection?.name}</p><p className="mt-1 break-all text-xs text-muted">{pendingConnection?.destination}</p></Dialog>
    {menu && <div role="dialog" aria-label={zh ? "模型设置" : "Model settings"} className="composer-model-menu">
      <div className="model-menu-heading"><span>{zh ? "选择模型" : "Choose model"}</span><span>{hint}</span></div>
      {draft?.onInstanceChange && <div className="model-menu-agent">
        <span>Agent</span>
        <SelectField value={instance.id} disabled={locked} onValueChange={(id) => { setQuery(""); draft.onInstanceChange?.(id); }} options={instances.filter((item) => item.enabled && item.configurationKind === "harness").map((item) => ({ value: item.id, label: item.displayName }))} aria-label={zh ? "选择 Agent" : "Choose an agent"} />
      </div>}
      <div className="model-menu-search"><Search size={15} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? "搜索模型" : "Search models"} aria-label={zh ? "搜索模型" : "Search models"} /></div>
      <div className="model-menu-list">
        {visibleModels.map((item) => <button type="button" key={item.id} title={item.id} disabled={locked} className="model-menu-option" aria-pressed={item.id === modelId} onClick={() => void configure({ model: item.id, reasoningEffort: item.defaultReasoningEffort ?? item.reasoningEfforts[0] ?? "", serviceTier: item.defaultServiceTier ?? "" }).then((saved) => { if (saved) triggerRef.current?.focus(); })}>
          <Box size={16} aria-hidden /><span><strong>{item.displayName}</strong></span>{item.id === modelId && <Check size={15} />}
        </button>)}
        {!visibleModels.length && <p className="model-menu-empty">{connectionKey && connectionModelsLoading[connectionKey] ? (zh ? "正在获取账号模型…" : "Discovering models…") : loadError ? (zh ? "模型读取失败，请在供应商设置中刷新。" : "Models could not be loaded. Refresh in provider settings.") : query ? (zh ? "没有匹配的模型" : "No matching models") : unavailable}</p>}
      </div>
      {efforts.length > 0 && <div className="model-menu-efforts"><span>{zh ? "推理强度" : "Reasoning effort"}</span><div>{efforts.map((item) => <button type="button" key={item} disabled={locked} aria-pressed={item === effort} onClick={() => void configure({ reasoningEffort: item })}>{effortLabel(item)}</button>)}</div></div>}
      <section className="model-menu-connections" aria-label={zh ? "账号与供应商" : "Account & provider"}>
        <div className="model-connections-heading"><span>{zh ? "账号与供应商" : "Account & provider"}</span><span>{zh ? "点击下方切换" : "Select below to switch"}</span></div>
        <SelectField value={connectionId ?? (instance.configurationKind === "harness" ? undefined : "__instance")} placeholder={zh ? "选择供应商或账号" : "Choose a provider or account"} disabled={locked} onValueChange={chooseConnection} options={connectionOptions} aria-label={zh ? "选择账号或供应商" : "Choose account or provider"} />
        {connectionId && <p className="model-connection-caption">{selectedConnection?.kind === "login" ? (zh ? "登录账号" : "Signed-in account") : (zh ? "API 供应商" : "API provider")}{selectedConnection?.kind === "api" && selectedConnection.protocol ? ` · ${selectedConnection.protocol === "responses" ? "Responses" : selectedConnection.protocol === "chat" ? "Chat Completions" : "Anthropic"}` : ""}</p>}
        {sessionId && currentHead && currentHead.revision !== connectionRevision && connectionSupportsAgent(currentHead, instance) && <button type="button" disabled={locked} onClick={() => chooseConnection(currentHead.id)}>{zh ? `更新到 v${currentHead.revision}` : `Update to v${currentHead.revision}`}</button>}
      </section>
      {connectionCatalog?.warning && <p className="model-menu-empty">{connectionCatalog.warning}</p>}
      {connectionError && <p role="alert" className="model-menu-empty text-danger">{zh ? "绑定连接读取失败，请重试。" : "Unable to load the bound connection. Please retry."}</p>}
    </div>}
    <button ref={triggerRef} type="button" disabled={locked} className="composer-model-trigger" aria-label={zh ? "选择模型" : "Choose model"} aria-expanded={menu} aria-description={modelDescription} title={modelDescription} onClick={() => { setMenu(!menu); setQuery(""); }}>
      <Box size={16} aria-hidden /><span>{modelId === "default" ? `${instance.displayName} / ${zh ? "默认" : "Default"}` : label}</span>{effort && <span className="composer-effort-label" aria-label={`${zh ? "推理强度" : "Reasoning effort"} ${effortLabel(effort)}`}>· {effortLabel(effort)}</span>}<ChevronDown size={12} aria-hidden />
    </button>
  </div>;
}
