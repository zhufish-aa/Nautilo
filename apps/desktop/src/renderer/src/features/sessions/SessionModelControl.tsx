import { useEffect, useRef, useState } from "react";
import type { ProviderModel, RuntimeConnection } from "@agenthub/domain";
import { Dialog } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { useTeamsStore } from "../../stores/teams";
import { useConnectionsStore } from "../../stores/connections";
import { connectionSupportsAgent } from "../../lib/session-connections";
import { Check, ChevronDown } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { configureWorkbenchSession } from "../../lib/orchestration-runtime";
import { useAgentsStore } from "../../stores/agents";
import { useSessionsStore } from "../../stores/sessions";
import { toast } from "../../stores/toast";

export type ComposerConfiguration = { model?: string; reasoningEffort?: string; serviceTier?: string; permissionMode?: string; connectionId?: string; connectionRevision?: number };
type Draft = { instanceId: string; configuration: ComposerConfiguration; onChange: (patch: ComposerConfiguration) => void; onInstanceChange?: (id: string) => void };
const effortLabel = (value: string) => ({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" }[value] ?? value);

/** Conversation identity is fixed. Only supported model/effort choices belong here. */
export function SessionModelControl({ sessionId, disabled, draft }: { sessionId?: string; disabled?: boolean; draft?: Draft }): JSX.Element | null {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [menu, setMenu] = useState<"models" | "efforts">();
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [boundConnection, setBoundConnection] = useState<RuntimeConnection>();
  const [connectionError, setConnectionError] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<{ id?: string; revision?: number; name: string; destination?: string; sourceSessionId: string; sourceConnectionId?: string; sourceRevision?: number }>();
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
  const connectionRevision = configuration?.connectionRevision;
  const activeApprovalContext = useRef({ sessionId, instanceId, connectionId, connectionRevision });
  activeApprovalContext.current = { sessionId, instanceId, connectionId, connectionRevision };
  const selectedConnection = sessionId ? (boundConnection && boundConnection.id === connectionId && (connectionRevision === undefined || boundConnection.revision === connectionRevision) ? boundConnection : undefined) : connections.find(item => item.id === connectionId);
  const currentHead = connections.find(item => item.id === connectionId);
  const connectionModels: ProviderModel[] = (selectedConnection?.models ?? []).filter(item => item.enabled !== false).map((item, index) => ({ ...item, displayName: item.displayName || item.id, capabilities: [], serviceTiers: [], isDefault: index === 0 }));
  const models = connectionId ? connectionModels : catalog?.models ?? [];
  const modelId = configuration?.model || (!connectionId ? member?.model : undefined) || (connectionId ? models[0]?.id : catalog?.defaultModel);
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
    if (instanceId && !connectionId) void loadModels(instanceId).catch(() => { if (current) setLoadError(true); });
    return () => { current = false; };
  }, [instanceId, connectionId, loadModels]);
  useEffect(() => { setMenu(undefined); }, [sessionId, instanceId, disabled]);
  useEffect(() => { setPendingConnection(undefined); }, [sessionId, instanceId, connectionId, connectionRevision]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setMenu(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(undefined); };
    document.addEventListener("mousedown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [menu]);
  if (!configuration || !instance) return null;
  const configure = async (patch: Omit<ComposerConfiguration, "connectionId"> & { connectionId?: string | null; confirmConnectionChange?: boolean }) => {
    if (locked) return false;
    setSaving(true);
    try { if (sessionId) await configureWorkbenchSession(sessionId, patch); else { const { confirmConnectionChange: _confirmed, ...next } = patch; draft?.onChange({ ...next, connectionId: next.connectionId ?? undefined }); } setMenu(undefined); return true; }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); return false; }
    finally { setSaving(false); }
  };
  const unavailable = zh ? "未提供可选模型" : "No models available";
  const efforts = model?.reasoningEfforts ?? [];
  const label = model?.displayName || modelId || (loading[instance.id] ? (zh ? "读取模型…" : "Loading models…") : unavailable);
  const hint = disabled ? (zh ? "运行中不可更改" : "Cannot change during a run") : (zh ? "下一次发送时生效" : "Applies to the next message");
  const changeConnection = (candidate: { id?: string; revision?: number; name: string; destination?: string }) => {
    if (locked || (candidate.id === connectionId && candidate.revision === connectionRevision)) return;
    if (sessionId) { setMenu(undefined); setPendingConnection({ ...candidate, sourceSessionId: sessionId, sourceConnectionId: connectionId, sourceRevision: connectionRevision }); }
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
  return <div ref={root} className="relative min-w-0">
    <Dialog open={!!pendingConnection && pendingConnection.sourceSessionId === sessionId} onOpenChange={open => { if (!open && !saving) setPendingConnection(undefined); }} title={zh ? "切换下一轮的账号 / 供应商？" : "Switch account / provider for the next message?"} description={zh ? "下一条消息会向下方账号/端点发送本会话已保存的聊天文本和最近 8 个产物的名称/路径，其中可能包含此前发给其他供应商的信息。原生推理、缓存、工具事件与旧图片不迁移，图片请重新附加。聊天记录保留，但不是无损上下文迁移；文本超限时会拒绝发送，不会静默截断。" : "The next message will share saved conversation text and names/paths of the latest 8 artifacts with the account/endpoint below. This may include information previously sent to other providers. Native reasoning, cache, tool events and previous images do not transfer; reattach images. History is retained, but this is not lossless context transfer. Oversized text is rejected rather than silently truncated."} footer={<><Button variant="ghost" disabled={saving} onClick={() => setPendingConnection(undefined)}>{zh ? "取消" : "Cancel"}</Button><Button disabled={locked} onClick={confirmConnection}>{zh ? "切换下一轮" : "Switch next message"}</Button></>}><p className="text-sm font-medium text-ink">{pendingConnection?.name}</p><p className="mt-1 break-all text-xs text-muted">{pendingConnection?.destination}</p></Dialog>
    {menu && <div role="dialog" aria-label={menu === "models" ? (zh ? "模型" : "Model") : (zh ? "推理强度" : "Reasoning effort")} className="absolute bottom-full right-0 z-40 mb-2 w-72 max-w-[calc(100vw-3rem)] overflow-hidden rounded-xl border border-line bg-card p-1.5 shadow-pop">
      <div className="border-b border-line px-3 py-2"><p className="text-xs font-medium text-ink">{menu === "models" ? (zh ? "模型" : "Model") : (zh ? "推理强度" : "Reasoning effort")}</p><p className="mt-1 text-[11px] text-muted">{hint}</p></div>
      <div className="max-h-64 overflow-y-auto py-1">
        {menu === "models" && <div className="mb-1 border-b border-line px-2 pb-2">
          <label className="block text-[11px] text-muted">{zh ? "账号 / 供应商" : "Account / provider"}</label>
          <select aria-label={zh ? "选择账号或供应商" : "Choose account or provider"} disabled={locked} value={connectionId ?? ""} onChange={event => { const item = connections.find(item => item.id === event.target.value); changeConnection(item ? { id: item.id, revision: item.revision, name: item.name, destination: item.kind === "api" ? item.baseUrl : `${item.harness} · ${zh ? "所选官方登录账号" : "selected official login account"}` } : { name: zh ? "Agent 原有配置" : "Existing agent configuration", destination: instance.baseUrl || `${instance.providerId} · ${zh ? "接收地址由本机 CLI 配置决定，Nautilo 未验证" : "destination comes from local CLI configuration and is not verified by Nautilo"}` }); }} className="mt-1 w-full rounded-md border border-line bg-card px-2 py-2 text-xs text-ink">
            <option value="">{zh ? "Agent 原有配置" : "Existing agent configuration"}</option>
            {connectionId && !connections.some(item => item.id === connectionId && connectionSupportsAgent(item, instance)) && <option value={connectionId}>{selectedConnection?.name ?? connectionId} · {zh ? "已绑定版本" : "Bound revision"}</option>}
            {connections.filter(item => connectionSupportsAgent(item, instance)).map(item => <option key={item.id} value={item.id}>{item.name} · {item.kind === "login" ? (zh ? "账号" : "Account") : item.protocol}</option>)}
          </select>
          <p className="mt-1 text-[10px] text-muted">{connectionId ? `${selectedConnection?.name ?? connectionId} · v${connectionRevision ?? selectedConnection?.revision ?? "—"}` : (zh ? "兼容旧会话的实例配置" : "Legacy instance configuration")}</p>
          {sessionId && currentHead && currentHead.revision !== connectionRevision && connectionSupportsAgent(currentHead, instance) && <button type="button" disabled={locked} onClick={() => changeConnection({ id: currentHead.id, revision: currentHead.revision, name: currentHead.name, destination: currentHead.kind === "api" ? currentHead.baseUrl : `${currentHead.harness} · ${zh ? "所选官方登录账号" : "selected official login account"}` })} className="mt-1 text-[11px] text-accent hover:underline disabled:opacity-40">{zh ? `更新到连接 v${currentHead.revision}（下次发送）` : `Update to connection v${currentHead.revision} (next message)`}</button>}
          {connectionError && <p role="alert" className="mt-1 text-[11px] text-amber-600">{zh ? "绑定连接读取失败，未使用其他连接替代。" : "Bound connection could not be loaded; no fallback was substituted."}</p>}
        </div>}
        {menu === "models" ? models.map(item => <button key={item.id} type="button" disabled={locked} onClick={() => void configure({ model: item.id, reasoningEffort: item.defaultReasoningEffort ?? item.reasoningEfforts[0] ?? "", serviceTier: item.defaultServiceTier ?? "" })} className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left hover:bg-card-hover disabled:opacity-40"><span className="min-w-0"><span className="block truncate text-sm text-ink">{item.displayName}</span><span className="block truncate text-[11px] text-muted">{item.id}</span></span>{item.id === modelId && <Check size={14} className="shrink-0 text-accent" />}</button>) : efforts.map(item => <button key={item} type="button" disabled={locked} onClick={() => void configure({ reasoningEffort: item })} className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-card-hover disabled:opacity-40">{effortLabel(item)}{item === effort && <Check size={14} className="text-accent" />}</button>)}
        {menu === "models" && !models.length && <p className="px-3 py-3 text-xs text-muted">{loadError ? (zh ? "模型列表读取失败，请在供应商设置中刷新。" : "Could not load models. Refresh in provider settings.") : unavailable}</p>}
      </div>
    </div>}
    <div className="flex min-w-0 items-center gap-1">
      <button type="button" disabled={locked} onClick={() => setMenu(menu === "models" ? undefined : "models")} title={hint} aria-label={zh ? "选择模型" : "Choose model"} aria-expanded={menu === "models"} className="flex h-8 max-w-52 items-center gap-1 rounded-lg px-2 text-sm text-ink-2 hover:bg-card-hover disabled:opacity-40"><span className="truncate">{label}</span><ChevronDown size={14} className="shrink-0" /></button>
      <button type="button" disabled={locked || !efforts.length} onClick={() => setMenu(menu === "efforts" ? undefined : "efforts")} title={efforts.length ? hint : (zh ? "当前模型未提供可选推理强度" : "This model has no supported reasoning choices")} aria-label={zh ? "选择推理强度" : "Choose reasoning effort"} aria-expanded={menu === "efforts"} className="flex h-8 items-center gap-1 rounded-lg px-2 text-sm text-ink-2 hover:bg-card-hover disabled:opacity-40">{effort ? effortLabel(effort) : (zh ? "默认" : "Default")}<ChevronDown size={14} /></button>
    </div>
  </div>;
}
