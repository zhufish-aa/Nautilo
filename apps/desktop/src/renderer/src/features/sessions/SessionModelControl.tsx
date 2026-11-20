import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RuntimeConnection } from "@agenthub/domain";
import { SelectField } from "../../components/ui/Select";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { useTeamsStore } from "../../stores/teams";
import { connectionModelKey, useConnectionsStore } from "../../stores/connections";
import { connectionCanBeSelected, connectionSupportsAgent } from "../../lib/session-connections";
import { connectionModelCatalog, type ConnectionModelSelection } from "../../lib/connection-models";
import { ArrowUpRight, Box, Check, ChevronDown, Search, Server, SlidersHorizontal } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { configureWorkbenchSession } from "../../lib/orchestration-runtime";
import { useAgentsStore } from "../../stores/agents";
import { useSessionsStore } from "../../stores/sessions";
import { toast } from "../../stores/toast";
import "./model-picker.css";
import { ConnectionPicker } from "./ConnectionPicker";

export type ComposerConfiguration = ConnectionModelSelection;
type Draft = { instanceId: string; configuration: ComposerConfiguration; onChange: (patch: ComposerConfiguration) => void; onInstanceChange?: (id: string) => void };
const effortLabel = (value: string) => ({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" }[value] ?? value);
function ModelMark({ name }: { name: string }): JSX.Element {
  const provider = /deepseek/i.test(name) ? "deepseek" : /claude/i.test(name) ? "claude-code" : /(?:^|[/\s-])(?:gpt|o[134])(?:[/\s.-]|$)/i.test(name) ? "codex" : /kimi|moonshot/i.test(name) ? "kimi-code" : undefined;
  return provider ? <ProviderAvatar providerId={provider} size="sm"/> : <Box size={17} aria-hidden/>;
}

/** Conversation identity is fixed. Only supported model/effort choices belong here. */
export function SessionModelControl({ sessionId, disabled, running, draft, inline }: { sessionId?: string; disabled?: boolean; running?: boolean; draft?: Draft; inline?: boolean }): JSX.Element | null {
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
  const connectionCatalogs = useConnectionsStore((state) => state.modelCatalogs);
  const connectionModelsLoading = useConnectionsStore((state) => state.loadingModels);
  const loadConnectionModels = useConnectionsStore((state) => state.loadModels);
  const connections = useConnectionsStore(state => state.connections);
  const hydrateConnections = useConnectionsStore(state => state.hydrate);
  const getConnection = useConnectionsStore(state => state.get);
  const teams = useTeamsStore(state => state.teams);
  const root = useRef<HTMLDivElement>(null);
  const session = useSessionsStore(state => state.sessions.find(item => item.id === sessionId));
  const nextTurnModel = useSessionsStore(state => sessionId ? state.nextTurnModels[sessionId] : undefined);
  const setNextTurnModel = useSessionsStore(state => state.setNextTurnModel);
  const instances = useAgentsStore(state => state.instances);
  const catalogs = useAgentsStore(state => state.modelCatalogs);
  const loading = useAgentsStore(state => state.loadingModels);
  const loadModels = useAgentsStore(state => state.loadModels);
  const target = session?.target;
  const member = target?.type === "member" ? teams.find(team => team.id === target.teamId)?.members.find(member => member.id === target.memberId) : undefined;
  const instanceId = target?.type === "agent" ? target.instanceId : member?.agentInstanceId ?? draft?.instanceId;
  const instance = instances.find(item => item.id === instanceId);
  const catalog = instance ? catalogs[instance.id] : undefined;
  const configuration = session ? nextTurnModel ?? session : draft?.configuration;
  const connectionId = configuration?.connectionId;
  const currentHead = connections.find(item => item.id === connectionId);
  const connectionRevision = sessionId ? configuration?.connectionRevision : currentHead?.revision ?? configuration?.connectionRevision;
  const selectedConnection = [currentHead, boundConnection].find(item => item && item.id === connectionId && (connectionRevision === undefined || item.revision === connectionRevision));
  const connectionKey = connectionId && (connectionRevision ?? selectedConnection?.revision) ? connectionModelKey(connectionId, (connectionRevision ?? selectedConnection?.revision)!) : undefined;
  const connectionCatalog = selectedConnection ? connectionModelCatalog(selectedConnection, connectionKey ? connectionCatalogs[connectionKey] : undefined) : undefined;
  const compatible = !!selectedConnection && !!instance && (nextTurnModel
    ? connectionCanBeSelected(selectedConnection, instance)
    : connectionSupportsAgent(selectedConnection, instance));
  const models = connectionId ? compatible ? connectionCatalog?.models ?? [] : [] : catalog?.models ?? [];
  const modelId = configuration?.model || (!connectionId && !nextTurnModel ? member?.model : undefined)
    || (connectionId ? connectionCatalog?.defaultModel ?? models.find(item => item.isDefault)?.id ?? models[0]?.id : catalog?.defaultModel);
  const model = models.find(item => item.id === modelId);
  const effort = configuration?.reasoningEffort || (!connectionId && !nextTurnModel ? member?.reasoningEffort : undefined) || model?.defaultReasoningEffort || model?.reasoningEfforts[0];
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
    if (instanceId && !connectionId) void loadModels(instanceId).catch(() => { if (current) setLoadError(true); });
    return () => { current = false; };
  }, [instanceId, connectionId, loadModels]);
  useEffect(() => {
    let current = true;
    if (connectionId && compatible && selectedConnection) void loadConnectionModels(connectionId, connectionRevision ?? selectedConnection.revision)
      .catch(() => { if (current) setLoadError(true); });
    return () => { current = false; };
  }, [connectionId, connectionRevision, selectedConnection?.revision, compatible, loadConnectionModels]);
  useEffect(() => { setMenu(false); }, [sessionId, instanceId, disabled]);
  useEffect(() => {
    if (!menu) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node) && !(event.target as Element).closest?.("[data-radix-popper-content-wrapper]")) setMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { setMenu(false); triggerRef.current?.focus(); } };
    document.addEventListener("mousedown", outside); document.addEventListener("keydown", escape);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [menu]);
  if (!configuration || !instance) return null;
  const configureModel = async (patch: Pick<ComposerConfiguration, "model" | "reasoningEffort" | "serviceTier">) => {
    if (locked) return false;
    if (session && (running || nextTurnModel)) {
      setNextTurnModel(session.id, {
        sourceConnectionId: session.connectionId,
        sourceConnectionRevision: session.connectionRevision,
        connectionId,
        connectionRevision,
        model: configuration.model,
        reasoningEffort: configuration.reasoningEffort,
        serviceTier: configuration.serviceTier,
        ...nextTurnModel,
        ...patch,
      });
      setMenu(false);
      return true;
    }
    setSaving(true);
    try {
      if (sessionId) await configureWorkbenchSession(sessionId, patch);
      else draft?.onChange(patch);
      setMenu(false);
      return true;
    }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); return false; }
    finally { setSaving(false); }
  };
  const unavailable = !connectionId && instance.configurationKind === "harness"
    ? (zh ? "使用 Harness 原生默认模型" : "Use harness native default model")
    : selectedConnection && !compatible
      ? (zh ? "当前连接与 Harness 不兼容" : "This connection is incompatible with the harness")
      : (zh ? "请在供应商设置中启用模型" : "Enable a model in provider settings");
  const efforts = model?.reasoningEfforts ?? [];
  const label = model?.displayName || modelId || (loading[instance.id] ? (zh ? "读取模型…" : "Loading models…") : unavailable);
  const modelDescription = effort ? label + " · " + effortLabel(effort) : label;
  const hint = zh ? "下一次发送时生效" : "Applies to the next message";
  const nextMessageDescription = nextTurnModel
    ? `${zh ? "下一条" : "Next message"}: ${selectedConnection?.name ?? instance.displayName} · ${modelDescription}`
    : modelDescription;
  const triggerLabel = modelId === "default" ? `${instance.displayName} / ${zh ? "默认" : "Default"}` : label;
  const nextAccount = nextTurnModel && nextTurnModel.connectionId !== session?.connectionId ? selectedConnection?.name : undefined;
  const chooseConnection = (selected?: RuntimeConnection) => {
    if (locked || (selected?.id === connectionId && selected?.revision === connectionRevision)) return;
    const selection = {
      connectionId: selected?.id,
      connectionRevision: selected?.revision,
      model: selected?.models?.find(item => item.enabled !== false)?.id ?? "",
      reasoningEffort: "",
      serviceTier: "",
    };
    if (session) {
      const usesCurrent = selected?.id === session.connectionId && selected?.revision === session.connectionRevision;
      setNextTurnModel(session.id, usesCurrent ? undefined : {
        ...selection,
        sourceConnectionId: session.connectionId,
        sourceConnectionRevision: session.connectionRevision,
        enableAccountRoute: !!selected && !connectionSupportsAgent(selected, instance),
      });
    } else {
      draft?.onChange(selection);
    }
    setMenu(false);
  };
  const visibleModels = models.filter((item) => `${item.displayName} ${item.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const panel = menu && <div role="dialog" aria-label={zh ? "模型设置" : "Model settings"} className="composer-model-menu model-picker-surface" data-design-frame="o7KjQn-82u">
      <div className="model-menu-heading" title={hint}><span>{zh ? "选择模型" : "Choose model"}</span><Link to="/settings?section=accounts" aria-label={zh ? "管理模型" : "Manage models"} onClick={() => setMenu(false)}><SlidersHorizontal size={16}/></Link></div>
      {draft?.onInstanceChange && <div className="model-menu-agent">
        <span>Agent</span>
        <SelectField value={instance.id} disabled={locked} onValueChange={(id) => { setQuery(""); draft.onInstanceChange?.(id); }} options={instances.filter((item) => item.enabled && item.configurationKind === "harness").map((item) => ({ value: item.id, label: item.displayName }))} aria-label={zh ? "选择 Agent" : "Choose an agent"} />
      </div>}
      <div className="model-menu-search"><Search size={15} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? "搜索模型" : "Search models"} aria-label={zh ? "搜索模型" : "Search models"} /></div>
      <section className="model-picker-connection" aria-label={zh ? "账号与供应商" : "Account & provider"}>
        <Server size={16} aria-hidden/>
        <ConnectionPicker instance={instance} value={connectionId} disabled={locked} nextMessage={!!session} fallback={instance.configurationKind === "harness" ? undefined : { value: "__instance", label: zh ? "旧会话原有连接" : "Legacy connection" }} onChange={chooseConnection}/>
        {selectedConnection && <span className="model-picker-protocol">{selectedConnection.kind === "login" ? (zh ? "账号" : "Account") : selectedConnection.protocol === "responses" ? "Responses" : selectedConnection.protocol === "chat" ? "Chat" : "Anthropic"}</span>}
      </section>
      <div className="model-menu-list">
        {visibleModels.map((item) => <button type="button" key={item.id} title={item.id} disabled={locked} className="model-menu-option" aria-pressed={item.id === modelId} onClick={() => void configureModel({ model: item.id, reasoningEffort: item.defaultReasoningEffort ?? item.reasoningEfforts[0] ?? "", serviceTier: item.defaultServiceTier ?? "" }).then((saved) => { if (saved) triggerRef.current?.focus(); })}>
          <ModelMark name={`${item.id} ${item.displayName}`}/><span><strong>{item.displayName}</strong></span>{item.id === modelId && <Check size={15} />}
        </button>)}
        {!visibleModels.length && <p className="model-menu-empty">{connectionKey && connectionModelsLoading[connectionKey] ? (zh ? "正在获取账号模型…" : "Discovering models…") : loadError ? (zh ? "模型读取失败，请在供应商设置中刷新。" : "Models could not be loaded. Refresh in provider settings.") : query ? (zh ? "没有匹配的模型" : "No matching models") : unavailable}</p>}
      </div>
      {efforts.length > 0 && <div className="model-menu-efforts"><span>{zh ? "推理强度" : "Reasoning effort"}</span><div>{efforts.map((item) => <button type="button" key={item} disabled={locked} aria-pressed={item === effort} onClick={() => void configureModel({ reasoningEffort: item })}>{effortLabel(item)}</button>)}</div></div>}
      {sessionId && currentHead && currentHead.revision !== connectionRevision && connectionCanBeSelected(currentHead, instance) && <button type="button" className="model-picker-revision" disabled={locked} onClick={() => chooseConnection(currentHead)}>{zh ? `更新到 v${currentHead.revision}` : `Update to v${currentHead.revision}`}</button>}
      {connectionCatalog?.warning && <p className="model-menu-empty">{connectionCatalog.warning}</p>}
      {connectionError && <p role="alert" className="model-menu-empty text-danger">{zh ? "绑定连接读取失败，请重试。" : "Unable to load the bound connection. Please retry."}</p>}
      <footer className="model-picker-footer">
        {session && nextTurnModel
          ? <button type="button" className="hover:text-ink" disabled={locked} onClick={() => { setNextTurnModel(session.id, undefined); setMenu(false); triggerRef.current?.focus(); }}>
              {zh ? "恢复当前设置" : "Keep current settings"}
            </button>
          : <span>{models.length} {zh ? "个可用模型" : "available models"}</span>}
        <Link to="/settings?section=accounts" onClick={() => setMenu(false)}><SlidersHorizontal size={13}/>{zh ? "管理模型" : "Manage models"}<ArrowUpRight size={12}/></Link>
      </footer>
    </div>;
  return <div ref={root} className="composer-model-control" data-inline={inline || undefined}>
    {!inline && panel}
    <button ref={triggerRef} type="button" disabled={locked} className="composer-model-trigger" aria-label={zh ? "选择模型" : "Choose model"} aria-expanded={menu} aria-description={nextMessageDescription} title={nextMessageDescription} onClick={() => { setMenu(!menu); setQuery(""); }}>
      <Box size={16} aria-hidden /><span>{nextAccount ? `${nextAccount} · ${triggerLabel}` : triggerLabel}</span>{effort && <span className="composer-effort-label" aria-label={`${zh ? "推理强度" : "Reasoning effort"} ${effortLabel(effort)}`}>· {effortLabel(effort)}</span>}<ChevronDown size={12} aria-hidden />
    </button>
    {inline && panel}
  </div>;
}
