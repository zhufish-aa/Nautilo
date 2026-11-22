import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Link } from "react-router-dom";
import type { RuntimeConnection } from "@agenthub/domain";
import { SelectField } from "../../components/ui/Select";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { useTeamsStore } from "../../stores/teams";
import { connectionModelKey, useConnectionsStore } from "../../stores/connections";
import { connectionCanBeSelected, connectionSupportsAgent } from "../../lib/session-connections";
import { connectionModelCatalog, type ConnectionModelSelection } from "../../lib/connection-models";
import { ArrowUpRight, Box, Check, ChevronDown, Search, Server, X } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { configureWorkbenchSession } from "../../lib/orchestration-runtime";
import { useAgentsStore } from "../../stores/agents";
import { useSessionsStore } from "../../stores/sessions";
import { toast } from "../../stores/toast";
import "./model-picker.css";
import { ConnectionPicker } from "./ConnectionPicker";

export type ComposerConfiguration = ConnectionModelSelection;
type Draft = { instanceId: string; configuration: ComposerConfiguration; onChange: (patch: ComposerConfiguration) => void; onInstanceChange?: (id: string) => void };
const effortLabel = (value: string) => ({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" }[value] ?? value);
const pickerEase = [.22, 1, .36, 1] as const;
const reasoningTag = /\b(thinking|reasoning)\b/i;
function ModelMark({ name }: { name: string }): JSX.Element {
  const provider = /deepseek/i.test(name) ? "deepseek" : /claude/i.test(name) ? "claude-code" : /(?:^|[/\s-])(?:gpt|o[134])(?:[/\s.-]|$)/i.test(name) ? "codex" : /kimi|moonshot/i.test(name) ? "kimi-code" : undefined;
  return <span className="model-option-mark" aria-hidden>{provider ? <ProviderAvatar providerId={provider} size="sm" /> : <Box size={14} />}</span>;
}

/** Conversation identity is fixed. Only supported model/effort choices belong here. */
export function SessionModelControl({ sessionId, disabled, running, draft, inline }: { sessionId?: string; disabled?: boolean; running?: boolean; draft?: Draft; inline?: boolean }): JSX.Element | null {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState("");
  const reduced = useUiReducedMotion();
  const panelId = useId();
  const listId = `${panelId}-models`;
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLSpanElement>(null);
  const pickedModel = useRef<string>();
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
  useEffect(() => { setMenu(false); }, [sessionId, disabled]);
  function highlightModel(row?: HTMLButtonElement): void {
    const highlight = highlightRef.current;
    if (!highlight) return;
    listRef.current?.querySelector("[data-highlighted]")?.removeAttribute("data-highlighted");
    if (row) {
      highlight.style.transform = `translateY(${row.offsetTop}px)`;
      highlight.style.height = `${row.offsetHeight || 38}px`;
      highlight.dataset.visible = "";
      row.dataset.highlighted = "";
      searchRef.current?.setAttribute("aria-activedescendant", row.id);
    } else {
      highlight.removeAttribute("data-visible");
      searchRef.current?.removeAttribute("aria-activedescendant");
    }
  }

  function handleSearchKeys(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(".model-menu-option:not(:disabled)") ?? []);
    if (!rows.length) return;
    const current = rows.findIndex(row => row.hasAttribute("data-highlighted"));
    event.preventDefault();
    if (event.key === "Enter") {
      rows[Math.max(current, 0)].click();
      return;
    }
    const index = event.key === "ArrowDown" ? (current + 1) % rows.length : current <= 0 ? rows.length - 1 : current - 1;
    const row = rows[index];
    highlightModel(row);
    row.scrollIntoView?.({ block: "nearest" });
  }

  function drawCheck(icon: SVGSVGElement | null): void {
    if (!icon || !pickedModel.current) return;
    pickedModel.current = undefined;
    if (!reduced) icon.querySelector("path")?.animate?.([{ strokeDashoffset: 22 }, { strokeDashoffset: 0 }], { duration: 180, easing: "ease-out" });
  }

  useLayoutEffect(() => {
    highlightModel();
  }, [menu, query, instanceId, connectionId, connectionRevision]);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const surface = panelRef.current;
    if (!menu || !trigger || !surface) return;
    surface.inert = false;
    const gap = inline ? 8 : 12;
    const place = () => {
      const anchor = trigger.getBoundingClientRect();
      const above = anchor.top - 2 * gap;
      const below = window.innerHeight - anchor.bottom - 2 * gap;
      const openAbove = above >= Math.min(180, surface.scrollHeight) || above >= below;
      const left = inline ? anchor.left : anchor.right - surface.offsetWidth;
      surface.style.left = `${Math.max(gap, Math.min(left, window.innerWidth - surface.offsetWidth - gap))}px`;
      surface.style.top = openAbove ? "auto" : `${anchor.bottom + gap}px`;
      surface.style.bottom = openAbove ? `${window.innerHeight - anchor.top + gap}px` : "auto";
      surface.style.maxHeight = `min(520px, ${openAbove ? above : below}px)`;
      surface.style.transformOrigin = `${openAbove ? "bottom" : "top"} ${inline ? "left" : "right"}`;
    };
    place();
    const visibility = inline ? new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) setMenu(false); }) : undefined;
    visibility?.observe(trigger);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      visibility?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [menu, inline]);
  useLayoutEffect(() => {
    if (!menu || reduced) return;
    const rows = Array.from(listRef.current?.querySelectorAll(".model-menu-option") ?? []).slice(0, 6);
    const animations = rows.map((row, index) => row.animate?.([
      { opacity: 0, transform: "translateY(4px)" },
      { opacity: 1, transform: "translateY(0)" }
    ], { duration: 180, delay: index * 16, easing: "ease-out", fill: "backwards" }));
    return () => animations.forEach(animation => animation?.cancel());
  }, [menu, reduced]);
  useEffect(() => {
    if (!menu) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !panelRef.current?.contains(target) && !(target as Element).closest?.("[data-radix-popper-content-wrapper]")) setMenu(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { setMenu(false); triggerRef.current?.focus({ preventScroll: true }); } };
    document.addEventListener("mousedown", outside); document.addEventListener("keydown", escape);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [menu]);
  if (!configuration || !instance) return null;
  const configureModel = async (patch: Pick<ComposerConfiguration, "model" | "reasoningEffort" | "serviceTier">): Promise<void> => {
    if (locked) return;
    if (!session) {
      draft?.onChange(patch);
      return;
    }
    if (running || nextTurnModel) {
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
      return;
    }
    setSaving(true);
    try {
      await configureWorkbenchSession(session.id, patch);
    }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  const nativeDefault = !connectionId && instance.configurationKind === "harness";
  const unavailable = nativeDefault
    ? (zh ? "使用 Harness 原生默认模型" : "Use harness native default model")
    : selectedConnection && !compatible
      ? (zh ? "当前连接与 Harness 不兼容" : "This connection is incompatible with the harness")
      : (zh ? "请在供应商设置中启用模型" : "Enable a model in provider settings");
  const efforts = model?.reasoningEfforts ?? [];
  const effortIndex = efforts.indexOf(effort ?? "");
  const label = model?.displayName || modelId || (loading[instance.id] ? (zh ? "读取模型…" : "Loading models…") : unavailable);
  const modelDescription = effort ? label + " · " + effortLabel(effort) : label;
  const hint = zh ? "下一次发送时生效" : "Applies to the next message";
  const nextMessageDescription = nextTurnModel
    ? `${zh ? "下一条" : "Next message"}: ${selectedConnection?.name ?? instance.displayName} · ${modelDescription}`
    : modelDescription;
  const triggerLabel = draft && nativeDefault && (modelId === "default" || label === unavailable)
    ? (zh ? "原生默认模型" : "Native default model")
    : modelId === "default" ? `${instance.displayName} / ${zh ? "默认" : "Default"}` : label;
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
    setQuery("");
  };
  const visibleModels = models.filter((item) => `${item.displayName} ${item.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const panel = menu && <motion.div key={panelId} ref={panelRef} id={panelId} role="dialog" aria-label={zh ? "模型设置" : "Model settings"} aria-busy={saving || undefined}
    className={`composer-model-menu model-picker-surface${inline ? " plan-model-popover" : ""}`} data-design-frame="o7KjQn-82u"
    initial={reduced ? false : "opening"}
    animate="open"
    exit="closing"
    variants={{
      opening: { opacity: 0, transform: "translateY(8px) scale(.955)" },
      open: { opacity: 1, transform: "translateY(0) scale(1)", transition: { duration: reduced ? 0 : .22, ease: pickerEase } },
      closing: { opacity: 0, transform: "translateY(5px) scale(.97)", transition: { duration: reduced ? 0 : .13, ease: "easeIn" } },
    }}
    onAnimationStart={variant => {
      if (panelRef.current) panelRef.current.inert = variant === "closing";
    }}>
      <div className="model-menu-search">
        <Search size={14} aria-hidden />
        <input ref={searchRef} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
          value={query} onChange={event => setQuery(event.target.value)} onKeyDown={handleSearchKeys}
          placeholder={zh ? "搜索模型" : "Search models"} aria-label={zh ? "搜索模型" : "Search models"} />
        {query ? <button type="button" className="model-search-clear" aria-label={zh ? "清除搜索" : "Clear search"} onClick={() => { setQuery(""); searchRef.current?.focus({ preventScroll: true }); }}><X size={13} aria-hidden /></button>
          : <kbd aria-hidden="true">Esc</kbd>}
      </div>
      <div className="model-picker-body">
        {draft?.onInstanceChange && <div className="model-menu-agent">
          <span>Agent</span>
          <SelectField value={instance.id} disabled={locked} onValueChange={(id) => { setQuery(""); draft.onInstanceChange?.(id); }} options={instances.filter((item) => item.enabled && item.configurationKind === "harness").map((item) => ({ value: item.id, label: item.displayName }))} aria-label={zh ? "选择 Agent" : "Choose an agent"} />
        </div>}
        <section className="model-picker-connection" aria-label={zh ? "账号与供应商" : "Account & provider"}>
          <div className="model-picker-connection-row">
            <Server size={14} aria-hidden />
            <ConnectionPicker instance={instance} value={connectionId} disabled={locked} nextMessage={!!session} fallback={instance.configurationKind === "harness" ? undefined : { value: "__instance", label: zh ? "旧会话原有连接" : "Legacy connection" }} onChange={chooseConnection}/>
            {selectedConnection && <span className="model-picker-protocol">{selectedConnection.kind === "login" ? (zh ? "账号" : "Account") : selectedConnection.protocol === "responses" ? "Responses" : selectedConnection.protocol === "chat" ? "Chat" : "Anthropic"}</span>}
          </div>
        </section>
        <div className="model-menu-list" id={listId} role="listbox" aria-label={zh ? "可用模型" : "Available models"} ref={listRef} key={connectionKey ?? instance.id}
          onPointerLeave={event => { if (event.pointerType === "mouse") highlightModel(); }}>
          <span className="model-list-highlight" ref={highlightRef} aria-hidden="true" />
          {visibleModels.map((item, index) => {
            const [, name, capability] = item.displayName.match(/^(.+?)\s*\(([^()]+)\)$/) ?? [];
            const badge = capability ?? (item.capabilities.some(value => reasoningTag.test(value)) ? "Thinking" : undefined);
            return <button type="button" key={item.id} id={`${listId}-${index}`} title={item.id} aria-label={item.displayName} disabled={disabled} aria-disabled={saving || undefined}
              className="model-menu-option" role="option" aria-selected={item.id === modelId} tabIndex={-1}
              onPointerEnter={event => { if (event.pointerType === "mouse" && !locked) highlightModel(event.currentTarget); }}
              onClick={event => {
                if (locked) return;
                pickedModel.current = item.id;
                if (!reduced) event.currentTarget.animate?.([{ transform: "scale(.985)" }, { transform: "scale(1)" }], { duration: 150, easing: "ease-out" });
                void configureModel({ model: item.id, reasoningEffort: item.defaultReasoningEffort ?? item.reasoningEfforts[0] ?? "", serviceTier: item.defaultServiceTier ?? "" });
                searchRef.current?.focus({ preventScroll: true });
              }}>
              <ModelMark name={`${item.id} ${item.displayName}`} />
              <span className="model-option-name">{name ?? item.displayName}</span>
              {badge && <small className="model-option-tag" data-reasoning={reasoningTag.test(badge) || undefined}>{badge}</small>}
              <span className="model-option-indicator" aria-hidden="true">
                {item.id === modelId && <Check className="model-option-check" size={14} ref={pickedModel.current === item.id ? drawCheck : undefined} />}
              </span>
            </button>;
          })}
        </div>
        {!visibleModels.length && <p className="model-menu-empty" role="status">{connectionKey && connectionModelsLoading[connectionKey] ? (zh ? "正在获取账号模型…" : "Discovering models…") : loadError ? (zh ? "模型读取失败，请在供应商设置中刷新。" : "Models could not be loaded. Refresh in provider settings.") : query ? (zh ? "没有匹配的模型" : "No matching models") : unavailable}</p>}
        {efforts.length > 0 && <div className="model-menu-efforts" role="group" aria-label={zh ? "推理强度" : "Reasoning effort"}>
          <span>{zh ? "推理强度" : "Reasoning effort"}</span>
          <div className="model-effort-scroll">
            <div className="model-effort-track" style={{ "--effort-count": efforts.length, "--effort-index": effortIndex } as CSSProperties}>
              {efforts.map(item => <button type="button" key={item} title={effortLabel(item)} disabled={disabled} aria-disabled={saving || undefined} aria-pressed={item === effort}
                onClick={() => { if (item !== effort) void configureModel({ reasoningEffort: item }); }}>{effortLabel(item)}</button>)}
            </div>
          </div>
        </div>}
        {sessionId && currentHead && currentHead.revision !== connectionRevision && connectionCanBeSelected(currentHead, instance) && <button type="button" className="model-picker-revision" disabled={locked} onClick={() => chooseConnection(currentHead)}>{zh ? `更新到 v${currentHead.revision}` : `Update to v${currentHead.revision}`}</button>}
        {connectionCatalog?.warning && <p className="model-menu-empty">{connectionCatalog.warning}</p>}
        {connectionError && <p role="alert" className="model-menu-empty text-danger">{zh ? "绑定连接读取失败，请重试。" : "Unable to load the bound connection. Please retry."}</p>}
      </div>
      <footer className="model-picker-footer" title={hint}>
        <span>{models.length} {zh ? "个可用模型" : "available models"}</span>
        <div className="model-picker-footer-actions">
          {session && nextTurnModel && <button type="button" disabled={disabled} title={zh ? "恢复当前设置" : "Keep current settings"}
            aria-label={zh ? "恢复当前设置" : "Keep current settings"}
            onClick={() => { setNextTurnModel(session.id, undefined); setQuery(""); searchRef.current?.focus({ preventScroll: true }); }}>
            {zh ? "恢复" : "Reset"}
          </button>}
          <Link to="/settings?section=accounts" onClick={() => setMenu(false)}>{zh ? "管理模型" : "Manage models"}<ArrowUpRight size={12} aria-hidden /></Link>
        </div>
      </footer>
    </motion.div>;
  return <div ref={root} className="composer-model-control">
    <button ref={triggerRef} type="button" disabled={disabled} className="composer-model-trigger" aria-label={zh ? "选择模型" : "Choose model"} aria-haspopup="dialog" aria-expanded={menu} aria-controls={menu ? panelId : undefined} aria-description={nextMessageDescription} title={nextMessageDescription} onClick={() => { if (!menu) pickedModel.current = undefined; setMenu(!menu); setQuery(""); }}>
      <Box size={15} aria-hidden />
      <span className="model-trigger-label">{triggerLabel}</span>
      {effort && <span className="composer-effort-label" aria-label={`${zh ? "推理强度" : "Reasoning effort"} ${effortLabel(effort)}`}>
        <span className="model-trigger-effort-value">
          {efforts.map(item => <span key={item} aria-hidden="true">{effortLabel(item)}</span>)}
          <span>{effortLabel(effort)}</span>
        </span>
      </span>}
      <ChevronDown className="model-trigger-chevron" size={12} aria-hidden />
    </button>
    {createPortal(<AnimatePresence>{panel}</AnimatePresence>, document.body)}
  </div>;
}
