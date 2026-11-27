import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  Layers,
  LoaderCircle,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  Terminal,
  Users,
  X,
} from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Input";
import { SelectField } from "../../components/ui/Select";
import { SlidingTabs } from "../../components/ui/SlidingTabs";
import { Switch } from "../../components/ui/Switch";
import { isElectron } from "../../lib/bridge";
import { capabilityEnabledFor } from "../../lib/capability-enablement";
import { toDaemonProviderId } from "../../lib/core-mappers";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { ENV_POLICIES, permissionModesFor, useProviderMetas } from "../../lib/provider-catalog";
import { useUiReducedMotion } from "../../lib/ui-motion";
import { useAgentsStore } from "../../stores/agents";
import { useConnectionsStore } from "../../stores/connections";
import { useProviderToolsStore } from "../../stores/provider-tools";
import { useProvidersStore } from "../../stores/providers";
import { toast } from "../../stores/toast";
import { ProviderCard } from "./ProvidersPanel";
import { HarnessPluginsPanel } from "./HarnessPluginsPanel";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import "./harness-panel.css";

const compactVersion = (version?: string): string | undefined => {
  const value = version?.match(/\bv?(\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)*)/i)?.[1];
  return value ? `v${value}` : undefined;
};

const compactExecutable = (executable?: string): string | undefined => {
  const value = executable?.trim();
  if (!value) return undefined;
  const parts = value.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || value;
};

export function HarnessPage(): JSX.Element {
  return <section className="harness-page flex h-full min-h-0 flex-col" data-tour="agents-page">
    <HarnessPanel embedded />
  </section>;
}

export function HarnessPanel({ embedded = true }: { embedded?: boolean }): JSX.Element {
  const { locale, t } = useI18n();
  const zh = locale === "zh-CN";
  const reduced = useUiReducedMotion();
  const navigate = useNavigate();
  const location = useLocation();
  const providers = useProviderMetas();
  const catalog = useProvidersStore(state => state.catalog);
  const { instances, installations, detecting, ensureHarness, updateInstance, setInstanceEnabled, redetect } = useAgentsStore();
  const { connections, hydrate: hydrateConnections } = useConnectionsStore();
  const tools = useProviderToolsStore(state => state.tools);
  const toolsLoaded = useProviderToolsStore(state => state.loaded);
  const loadTools = useProviderToolsStore(state => state.load);

  useEffect(() => { void hydrateConnections(); }, [hydrateConnections]);
  useEffect(() => { if (isElectron && !toolsLoaded) void loadTools(); }, [loadTools, toolsLoaded]);

  const imageAccounts = connections.filter(connection => connection.enabled && connection.kind === "login" && connection.harness === "codex");
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "ready" | "disabled" | "missing">("all");
  const [togglingId, setTogglingId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [copiedExec, setCopiedExec] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = providers.find((item) => item.id === selectedId);
  const profile = instances.find((item) => item.configurationKind === "harness" && item.providerId === selected?.id);
  const installation = installations.find((item) => item.providerId === selected?.id);
  const managesPlugins = catalog.some(item => item.providerId === selected?.id && item.harnessPlugins);
  const [form, setForm] = useState({ executable: "", permissionMode: "", envPolicyId: "env-standard", poolSize: "", imageAccount: "", enabled: true });

  useEffect(() => {
    function focusSearch(event: KeyboardEvent): void {
      if (event.key !== "/" || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey
        || event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]")
        || document.querySelector('[role="dialog"][data-state="open"]') || !searchRef.current?.getClientRects().length) return;
      event.preventDefault();
      searchRef.current.focus();
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    if (!copiedExec) return;
    const timer = window.setTimeout(() => setCopiedExec(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedExec]);

  useEffect(() => {
    if (!selected || profile || installation?.status !== "ready") return;
    void ensureHarness(selected.id).catch((cause) => setError(String(cause)));
  }, [selected?.id, profile?.id, installation?.status, ensureHarness]);

  useEffect(() => {
    setForm({
      executable: profile?.executable ?? installation?.executable ?? "",
      permissionMode: profile?.permissionMode ?? permissionModesFor(selected?.id ?? "")[0]?.value ?? "",
      envPolicyId: profile?.envPolicyId ?? "env-standard",
      poolSize: profile?.appServerPoolSize?.toString() ?? "",
      imageAccount: profile?.imageGenerationConnectionId ?? "",
      enabled: profile?.enabled ?? true,
    });
    setDirty(false);
    setError("");
  }, [selected?.id, profile?.updatedAt, installation?.executable]);

  const patch = (value: Partial<typeof form>): void => {
    setForm((current) => ({ ...current, ...value }));
    setDirty(true);
  };

  const save = async (): Promise<void> => {
    if (!selected || busy) return;
    if (!form.executable.trim()) { setError(zh ? "请填写可执行文件" : "Enter an executable"); return; }
    const poolSize = form.poolSize.trim() ? Number(form.poolSize) : undefined;
    if (poolSize !== undefined && (!Number.isSafeInteger(poolSize) || poolSize < 1)) {
      setError(zh ? "并发上限需要正整数" : "Use a positive integer for concurrency");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const current = profile ?? await ensureHarness(selected.id, form.executable.trim());
      const { id, status: _status, createdAt: _created, updatedAt: _updated, ...draft } = current;
      await updateInstance(id, {
        ...draft,
        executable: form.executable.trim(),
        permissionMode: form.permissionMode || undefined,
        envPolicyId: form.envPolicyId,
        appServerPoolSize: selected.id === "codex" ? poolSize : undefined,
        imageGenerationConnectionId: selected.id === "codex" ? form.imageAccount || undefined : undefined,
        enabled: form.enabled,
      });
      await redetect(selected.id);
      setDirty(false);
      toast.success(zh ? "Harness 已保存" : "Harness saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggleCardEnabled = async (providerId: string, nextEnabled: boolean): Promise<void> => {
    if (togglingId) return;
    setTogglingId(providerId);
    try {
      const existing = instances.find(candidate => candidate.configurationKind === "harness" && candidate.providerId === providerId);
      const target = existing ?? await ensureHarness(providerId);
      await setInstanceEnabled(target.id, nextEnabled);
      toast.success(nextEnabled
        ? (zh ? "已启用 Harness" : "Harness enabled")
        : (zh ? "已停用 Harness" : "Harness disabled"));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTogglingId("");
    }
  };

  const skillsList = useMemo(() => tools.filter(item => item.kind === "skill"), [tools]);
  const mcpsList = useMemo(() => tools.filter(item => item.kind === "mcp"), [tools]);

  const cards = useMemo(() => {
    const built = providers.map(item => {
      const installed = installations.find(candidate => candidate.providerId === item.id);
      const configured = instances.find(candidate => candidate.configurationKind === "harness" && candidate.providerId === item.id);
      const daemonId = toDaemonProviderId(item.id);
      const detected = installed?.status === "ready";
      const enabled = configured?.enabled !== false;
      const ready = detected && enabled;
      const harnessConnections = connections.filter(connection => connection.enabled && connection.harness === item.id);
      const profileDirectory = configured?.loginProfileDirectory?.trim();
      const matchingProfileAccounts = profileDirectory ? connections.filter(connection =>
        connection.kind === "login" && connection.harness === item.id && connection.loginProfileDirectory?.trim() === profileDirectory,
      ) : [];
      const accountLabel = harnessConnections.length === 1
        ? harnessConnections[0]!.name
        : harnessConnections.length > 1
          ? (zh ? `${harnessConnections.length} 个账号` : `${harnessConnections.length} accounts`)
          : profileDirectory
            ? (matchingProfileAccounts.length === 1 ? matchingProfileAccounts[0]?.name : undefined) || configured?.loginProfileLabel || (zh ? "独立登录" : "Isolated login")
            : configured?.baseUrl || configured?.credentialStored ? (zh ? "本地 API" : "Local API") : undefined;
      const defaultModel = configured?.models?.find(model => model.enabled !== false);
      const modelName = defaultModel?.displayName?.trim() || defaultModel?.id;
      const skillCount = skillsList.filter(tool => capabilityEnabledFor(tool, daemonId)).length;
      const mcpCount = mcpsList.filter(tool => capabilityEnabledFor(tool, daemonId)).length;
      const permModes = permissionModesFor(item.id);
      const activePermValue = configured?.permissionMode ?? permModes[0]?.value;
      const permLabel = permModes.find(mode => mode.value === activePermValue)?.name[locale];
      const hasPlugins = catalog.some(entry => entry.providerId === item.id && entry.harnessPlugins);
      const rank = ready ? 0 : (detected && !enabled) ? 1 : 2;
      return {
        item, installed, configured, daemonId, detected, enabled, ready,
        harnessConnections, accountLabel, modelName, skillCount, mcpCount,
        permLabel, hasPlugins, rank,
      };
    });
    return built.sort((a, b) => a.rank - b.rank);
  }, [providers, installations, instances, connections, skillsList, mcpsList, catalog, locale, zh]);

  const readyCount = cards.filter(card => card.ready).length;
  const disabledCount = cards.filter(card => card.detected && !card.enabled).length;
  const missingCount = cards.filter(card => !card.detected).length;
  const totalCount = cards.length;
  const readyPct = totalCount ? (readyCount / totalCount) * 100 : 0;
  const disabledPct = totalCount ? (disabledCount / totalCount) * 100 : 0;
  const missingPct = totalCount ? (missingCount / totalCount) * 100 : 0;

  const activeConnections = useMemo(() => connections.filter(connection => connection.enabled), [connections]);
  const loginAccountsCount = activeConnections.filter(connection => connection.kind === "login").length;
  const apiAccountsCount = activeConnections.length - loginAccountsCount;
  const readyDaemonIds = useMemo(() => new Set(cards.filter(card => card.ready).map(card => card.daemonId)), [cards]);
  const activeSkillsCount = useMemo(() => skillsList.filter(tool => [...readyDaemonIds].some(id => capabilityEnabledFor(tool, id))).length, [skillsList, readyDaemonIds]);
  const activeMcpsCount = useMemo(() => mcpsList.filter(tool => [...readyDaemonIds].some(id => capabilityEnabledFor(tool, id))).length, [mcpsList, readyDaemonIds]);

  const filterView = filter === "disabled" && disabledCount === 0 ? "all" : filter;
  const filters: Array<{ id: string; label: string; count: number; warning?: boolean }> = [
    { id: "all", label: zh ? "全部工具" : "All tools", count: totalCount },
    { id: "ready", label: zh ? "已就绪" : "Ready", count: readyCount },
  ];
  if (disabledCount > 0) filters.push({ id: "disabled", label: zh ? "已停用" : "Disabled", count: disabledCount });
  filters.push({ id: "missing", label: zh ? "待检测" : "Not detected", count: missingCount, warning: missingCount > 0 });

  const search = query.trim().toLocaleLowerCase();
  const visible = cards.filter(({ item, detected, enabled, ready, accountLabel, permLabel }) => {
    if (filterView === "ready" && !ready) return false;
    if (filterView === "disabled" && !(detected && !enabled)) return false;
    if (filterView === "missing" && detected) return false;
    if (!search) return true;
    return [item.name, item.id, item.vendor, accountLabel, permLabel].filter(Boolean).join(" ").toLocaleLowerCase().includes(search);
  });

  const detectingCount = providers.filter(item => detecting[item.id]).length;
  const checking = detectingCount > 0;
  const detectLabel = checking
    ? (zh ? `检测中 (${detectingCount})` : `Detecting (${detectingCount})`)
    : (zh ? "重新检测全部" : "Detect all");

  const closeEditor = (): void => {
    if (busy) return;
    setSelectedId("");
    setDirty(false);
    setError("");
  };

  const navigateSettings = (section: string, harnessId?: string): void => {
    if (dirty) {
      setError(zh ? "更改尚未保存，请先保存或点击“取消”。" : "Save your changes or cancel before leaving.");
      return;
    }
    setSelectedId("");
    const params = new URLSearchParams({ section });
    if (harnessId) params.set("harness", harnessId);
    navigate(`/settings?${params.toString()}`, { state: location.state });
  };

  const onSpotlightMove = (event: ReactPointerEvent<HTMLElement>): void => {
    if (reduced) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
  };

  const copyExecutable = async (value: string): Promise<void> => {
    if (!value.trim()) return;
    try {
      await navigator.clipboard.writeText(value.trim());
      setCopiedExec(true);
    } catch (cause) {
      toast.error(String(cause));
    }
  };

  const selectedCard = selected ? cards.find(card => card.item.id === selected.id) : undefined;
  const selectedPermModes = selected ? permissionModesFor(selected.id) : [];
  const activePermOption = selectedPermModes.find(mode => mode.value === form.permissionMode);
  const activeEnvPolicy = ENV_POLICIES.find(policy => policy.id === form.envPolicyId);

  return <div className="harness-panel harness-overview" data-reduced-motion={reduced}>
    {embedded && <header className="harness-stage-header">
      <div className="harness-stage-title">
        <h1>{zh ? "Harness 管理" : "Harnesses"}</h1>
        <span className="harness-stage-pill" data-ready={readyCount > 0}>
          <i aria-hidden />
          {zh ? `${readyCount} / ${totalCount} 已就绪` : `${readyCount} / ${totalCount} ready`}
        </span>
      </div>
      <div className="harness-stage-actions">
        <Button
          variant="outline"
          size="sm"
          className="harness-detect-all"
          disabled={checking || providers.length === 0}
          onClick={() => void Promise.all(providers.map(item => redetect(item.id)))}
        >
          <RefreshCw size={13} className={checking ? "animate-spin" : undefined} aria-hidden />
          {detectLabel}
        </Button>
      </div>
    </header>}

    <section className="harness-kpi-deck" onPointerMove={onSpotlightMove} aria-label={zh ? "Harness 环境概览" : "Harness environment overview"}>
      <div className="harness-kpi-deck-inner">
        <div className="harness-kpi-cell">
          <span className="harness-kpi-label">
            <i className="harness-metric-dot" data-active={readyCount > 0} aria-hidden />
            {zh ? "本地 CLI 就绪度" : "Local CLI readiness"}
          </span>
          <strong className="harness-kpi-value" data-accent={readyCount > 0}>
            {readyCount}<em> / {totalCount}</em>
          </strong>
          <div className="harness-kpi-bar" aria-hidden>
            <span className="harness-kpi-bar-ready" style={{ width: `${readyPct}%` }} />
            <span className="harness-kpi-bar-disabled" style={{ width: `${disabledPct}%` }} />
            <span className="harness-kpi-bar-missing" style={{ width: `${missingPct}%` }} />
          </div>
          <small className="harness-kpi-sub">
            {[
              zh ? `${readyCount} 已就绪` : `${readyCount} ready`,
              disabledCount > 0 ? (zh ? `${disabledCount} 已停用` : `${disabledCount} disabled`) : null,
              missingCount > 0 ? (zh ? `${missingCount} 待检测` : `${missingCount} not detected`) : null,
            ].filter(Boolean).join(" · ")}
          </small>
        </div>

        <div className="harness-kpi-cell">
          <div className="harness-kpi-row">
            <span className="harness-kpi-label">
              <Users size={12} aria-hidden />
              {zh ? "账号与连接" : "Accounts & connections"}
            </span>
            <button type="button" className="harness-kpi-link" onClick={() => navigateSettings("accounts")}>
              {zh ? "管理" : "Manage"}<ArrowUpRight size={11} aria-hidden />
            </button>
          </div>
          <strong className="harness-kpi-value">
            {activeConnections.length}<em> {zh ? "个已启用" : "active"}</em>
          </strong>
          <small className="harness-kpi-sub">
            {activeConnections.length > 0
              ? (zh ? `原生登录 ${loginAccountsCount} · API 供应商 ${apiAccountsCount}` : `${loginAccountsCount} native logins · ${apiAccountsCount} API providers`)
              : (zh ? "可在“供应商与账号”中绑定官方账号或 API" : "Connect native accounts or API keys in Providers")}
          </small>
        </div>

        <div className="harness-kpi-cell">
          <div className="harness-kpi-row">
            <span className="harness-kpi-label">
              <Layers size={12} aria-hidden />
              {zh ? "已装配能力" : "Active capabilities"}
            </span>
            <div className="harness-kpi-links">
              <button type="button" className="harness-kpi-link" onClick={() => navigateSettings("skills")}>
                Skills<ArrowUpRight size={11} aria-hidden />
              </button>
              <button type="button" className="harness-kpi-link" onClick={() => navigateSettings("mcp")}>
                MCP<ArrowUpRight size={11} aria-hidden />
              </button>
            </div>
          </div>
          <strong className="harness-kpi-value">
            {activeSkillsCount}<em> Skill</em>
            <span className="harness-kpi-sep" aria-hidden>·</span>
            {activeMcpsCount}<em> MCP</em>
          </strong>
          <small className="harness-kpi-sub">
            {zh ? `共 ${skillsList.length} 项技能 · ${mcpsList.length} 个 MCP 服务可供分配` : `${skillsList.length} skills · ${mcpsList.length} MCP servers in library`}
          </small>
        </div>
      </div>
    </section>

    <div className="harness-overview-toolbar">
      <SlidingTabs
        value={filterView}
        onChange={value => setFilter(value as typeof filter)}
        items={filters}
        className="capability-underline-tabs"
        label={zh ? "筛选 Harness" : "Filter harnesses"}
      />
      <div className="harness-overview-tools">
        <div className="harness-overview-search">
          <Search size={14} aria-hidden />
          <input
            ref={searchRef}
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={zh ? "搜索名称、厂商或权限..." : "Search name, vendor or mode..."}
            aria-label={zh ? "搜索 Harness" : "Search harnesses"}
            aria-keyshortcuts="/"
          />
          {query ? (
            <button type="button" aria-label={zh ? "清除搜索" : "Clear search"} onClick={() => { setQuery(""); searchRef.current?.focus(); }}>
              <X size={13} aria-hidden />
            </button>
          ) : (
            <kbd className="harness-search-kbd" aria-hidden>/</kbd>
          )}
        </div>
        {!embedded && <button type="button" className="harness-overview-detect" title={detectLabel} aria-label={detectLabel} aria-busy={checking}
          disabled={checking || providers.length === 0} onClick={() => void Promise.all(providers.map(item => redetect(item.id)))}>
          <RefreshCw size={15} className={checking ? "animate-spin" : undefined} aria-hidden />
        </button>}
      </div>
    </div>

    <div className="harness-overview-body">
      <div className="harness-card-grid">
        {visible.map(({ item, installed, configured, detected, enabled, ready, accountLabel, modelName, skillCount, mcpCount, permLabel, hasPlugins }, index) => {
          const version = compactVersion(installed?.version);
          const execPath = configured?.executable || installed?.executable;
          const execShort = compactExecutable(execPath);
          const isDetecting = !!detecting[item.id];
          const isToggling = togglingId === item.id;
          const statusKey = !detected ? (installed?.status === "outdated" ? "outdated" : "missing") : !enabled ? "disabled" : "ready";
          const statusText = statusKey === "ready" ? (zh ? "就绪" : "Ready")
            : statusKey === "disabled" ? (zh ? "已停用" : "Disabled")
            : statusKey === "outdated" ? (zh ? "需更新" : "Outdated")
            : (zh ? "待检测" : "Not detected");
          const setupHint = item.id === "custom-cli" && !configured?.executable
            ? (zh ? "需先配置本地 CLI 映射" : "Set up the local CLI mapping")
            : installed?.status === "outdated" ? (zh ? "本地 CLI 版本过低，请更新" : "Update the local CLI version")
              : (zh ? "未检测到本地命令，点击配置路径或重新检测" : "CLI not detected — configure path or detect again");

          const openCard = (): void => {
            setError("");
            setSelectedId(item.id);
          };
          const handleCardClick = (event: MouseEvent<HTMLElement>): void => {
            if ((event.target as HTMLElement).closest("button, [role='switch']")) return;
            openCard();
          };

          return <motion.article
            key={item.id}
            layout={reduced ? false : "position"}
            initial={reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduced ? 0 : 0.2, delay: reduced ? 0 : Math.min(index, 9) * 0.025, ease: [0.22, 1, 0.36, 1] }}
            className="harness-tool-card"
            data-state={statusKey}
            onPointerMove={onSpotlightMove}
            onClick={handleCardClick}
          >
            <div className="harness-tool-header">
              <ProviderAvatar providerId={item.id} />
              <div className="harness-tool-identity">
                <div className="harness-tool-name-row">
                  <button type="button" className="harness-card-title-btn" aria-haspopup="dialog" onClick={openCard} title={item.name}>
                    {item.name}
                  </button>
                  <span className="harness-tool-status" data-state={statusKey}>{statusText}</span>
                </div>
                <span className="harness-version-meta">
                  <span>{item.vendor}</span>
                  {version && <><span aria-hidden>·</span><span className="harness-tool-version" title={installed?.version}>{version}</span></>}
                </span>
              </div>
              {detected && (
                <div className="harness-card-switch" onClick={event => event.stopPropagation()}>
                  <Switch
                    checked={enabled}
                    disabled={isToggling}
                    onCheckedChange={checked => void toggleCardEnabled(item.id, checked)}
                    aria-label={`${zh ? "启用" : "Enable"} ${item.name}`}
                  />
                </div>
              )}
            </div>

            <div className="harness-tool-telemetry">
              {detected ? <>
                <span className="harness-meta-chip" data-active={!!accountLabel} title={accountLabel || (zh ? "使用 CLI 原生默认登录" : "Using CLI default login")}>
                  <Users size={11} aria-hidden />
                  <span>{accountLabel || (zh ? "原生默认登录" : "CLI default")}</span>
                </span>
                {permLabel && <span className="harness-meta-chip" title={zh ? `默认权限：${permLabel}` : `Default permissions: ${permLabel}`}>
                  <ShieldCheck size={11} aria-hidden />
                  <span>{permLabel}</span>
                </span>}
                {modelName && <span className="harness-meta-chip" data-active="true" title={modelName}>
                  <span>{modelName}</span>
                </span>}
                <span className="harness-meta-chip harness-meta-count" data-active={skillCount > 0} title={zh ? `已启用 ${skillCount} 项 Skill` : `${skillCount} skills enabled`}>
                  <Layers size={11} aria-hidden />
                  <span>{skillCount} Skill</span>
                </span>
                <span className="harness-meta-chip harness-meta-count" data-active={mcpCount > 0} title={zh ? `已启用 ${mcpCount} 个 MCP 服务` : `${mcpCount} MCP servers enabled`}>
                  <Server size={11} aria-hidden />
                  <span>{mcpCount} MCP</span>
                </span>
                {hasPlugins && <span className="harness-meta-chip" title={zh ? "支持原生插件管理" : "Supports native plugins"}>
                  <Puzzle size={11} aria-hidden />
                  <span>{zh ? "插件" : "Plugins"}</span>
                </span>}
              </> : (
                <p className="harness-setup-hint" title={setupHint}>{setupHint}</p>
              )}
            </div>

            <div className="harness-tool-footer">
              <span className="harness-exec-chip" title={execPath || undefined}>
                <Terminal size={11} aria-hidden />
                <code>{execShort || (zh ? "未配置命令" : "No executable")}</code>
              </span>
              <div className="harness-footer-actions">
                <button
                  type="button"
                  className="harness-card-icon-btn"
                  disabled={isDetecting}
                  title={zh ? `重新检测 ${item.name}` : `Detect ${item.name}`}
                  aria-label={zh ? `重新检测 ${item.name}` : `Detect ${item.name}`}
                  onClick={event => { event.stopPropagation(); void redetect(item.id); }}
                >
                  <RefreshCw size={12} className={isDetecting ? "animate-spin" : undefined} aria-hidden />
                </button>
                <button type="button" className="harness-tool-action" aria-haspopup="dialog" onClick={openCard}>
                  {detected ? (zh ? "配置" : "Configure") : (zh ? "去配置" : "Set up")}
                  <ChevronRight size={13} aria-hidden />
                </button>
              </div>
            </div>
          </motion.article>;
        })}
      </div>

      {!visible.length && <EmptyState
        icon={Search}
        title={zh ? "没有找到匹配的 Harness" : "No matching harnesses"}
        description={zh ? "试试其他关键词，或切换上方的状态筛选。" : "Try another keyword or switch the status filter above."}
      />}
    </div>

    <Dialog
      open={!!selected}
      onOpenChange={(open) => {
        if (open || busy) return;
        if (dirty) {
          setError(zh ? "更改尚未保存，请保存或点击“取消”放弃。" : "Save your changes or choose Cancel to discard them.");
          return;
        }
        closeEditor();
      }}
      title={zh ? "Harness 运行配置" : "Harness runtime settings"}
      widthClass="max-w-[720px]"
      footer={<>
        <Button className="harness-config-done" variant="ghost" size="sm" disabled={busy} onClick={closeEditor}>
          {dirty ? t("common.cancel") : (zh ? "完成" : "Done")}
        </Button>
        <Button className="harness-config-save" variant="primary" size="sm" disabled={busy || !dirty} onClick={() => void save()}>
          {busy && <LoaderCircle size={14} className="animate-spin" />}
          {zh ? "保存配置" : "Save changes"}
        </Button>
      </>}
    >
      {selected && <div className="harness-detail harness-config-editor">
        <header className="harness-profile-header">
          <ProviderAvatar providerId={selected.id} size="lg" />
          <div className="harness-profile-copy">
            <div className="harness-profile-title">
              <h3>{selected.name}</h3>
              <span className="harness-tool-status" data-state={installation?.status === "ready" ? "ready" : "missing"}>
                {installation?.status === "ready" ? (zh ? "已安装" : "Installed") : (zh ? "待检测" : "Not detected")}
              </span>
            </div>
            <p className="harness-version-meta">
              <span>{selected.vendor}</span>
              <span aria-hidden>·</span>
              <span className="harness-tool-version" title={installation?.version}>
                {compactVersion(installation?.version) || installation?.version || (zh ? "版本未知" : "Version unknown")}
              </span>
            </p>
            {(selected.capabilities.length > 0 || managesPlugins) && (
              <div className="harness-capability-pills">
                {selected.capabilities.map(capability => (
                  <span key={capability} className="harness-cap-pill">
                    {t(`capabilities.${capability}` as MessageKey)}
                  </span>
                ))}
                {managesPlugins && <span className="harness-cap-pill harness-cap-pill-accent">{zh ? "原生插件" : "Native plugins"}</span>}
              </div>
            )}
          </div>
          <div className="harness-profile-maintenance">
            {installation ? <ProviderCard key={installation.providerId} installation={installation} actionsOnly /> :
              <Button variant="ghost" size="icon" aria-label={zh ? "检测 CLI" : "Detect CLI"} title={zh ? "检测 CLI" : "Detect CLI"} disabled={busy || detecting[selected.id]} onClick={() => void redetect(selected.id)}>
                <RefreshCw size={14} aria-hidden className={detecting[selected.id] ? "animate-spin" : ""} />
              </Button>}
          </div>
        </header>

        {selectedCard && (
          <div className="harness-ecosystem-links" aria-label={zh ? "关联能力快捷入口" : "Connected capabilities"}>
            <button type="button" className="harness-eco-tile" onClick={() => navigateSettings("accounts")}>
              <span className="harness-eco-label"><Users size={12} aria-hidden />{zh ? "账号连接" : "Accounts"}</span>
              <strong>{selectedCard.harnessConnections.length} <small>{zh ? "个已启用" : "active"}</small></strong>
              <ArrowUpRight size={13} className="harness-eco-arrow" aria-hidden />
            </button>
            <button type="button" className="harness-eco-tile" onClick={() => navigateSettings("skills", selected.id)}>
              <span className="harness-eco-label"><Layers size={12} aria-hidden />{zh ? "Skills 技能" : "Skills"}</span>
              <strong>{selectedCard.skillCount} <small>{zh ? "项已启用" : "enabled"}</small></strong>
              <ArrowUpRight size={13} className="harness-eco-arrow" aria-hidden />
            </button>
            <button type="button" className="harness-eco-tile" onClick={() => navigateSettings("mcp", selected.id)}>
              <span className="harness-eco-label"><Server size={12} aria-hidden />{zh ? "MCP 服务" : "MCP servers"}</span>
              <strong>{selectedCard.mcpCount} <small>{zh ? "个已启用" : "enabled"}</small></strong>
              <ArrowUpRight size={13} className="harness-eco-arrow" aria-hidden />
            </button>
          </div>
        )}

        <div className="harness-enabled-row">
          <div className="harness-enabled-copy">
            <strong>{zh ? "启用此 Harness" : "Enable this harness"}</strong>
            <small>{zh ? "停用后将不再出现在新建会话与工作流执行器列表中。" : "Disabled harnesses stay hidden from new sessions and workflow runners."}</small>
          </div>
          <Switch checked={form.enabled} onCheckedChange={(enabled) => patch({ enabled })} aria-label={zh ? "启用 Harness" : "Enable harness"} />
        </div>

        <section className="harness-config-section">
          <div className="harness-section-heading">
            <h4>{zh ? "运行配置" : "Runtime settings"}</h4>
            {dirty && <span className="harness-dialog-save-state">{zh ? "有未保存的更改" : "Unsaved changes"}</span>}
          </div>
          <Field label={zh ? "可执行文件" : "Executable"}>
            <div className="harness-exec-field">
              <Input
                className="harness-executable"
                value={form.executable}
                onChange={(event) => patch({ executable: event.target.value })}
                aria-label={zh ? "可执行文件" : "Executable"}
                spellCheck={false}
              />
              {form.executable.trim() && (
                <button
                  type="button"
                  className="harness-exec-action"
                  title={copiedExec ? (zh ? "已复制" : "Copied") : (zh ? "复制路径" : "Copy path")}
                  aria-label={copiedExec ? (zh ? "已复制" : "Copied") : (zh ? "复制路径" : "Copy path")}
                  onClick={() => void copyExecutable(form.executable)}
                >
                  {copiedExec ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                </button>
              )}
              {installation?.executable && form.executable.trim() !== installation.executable.trim() && (
                <button
                  type="button"
                  className="harness-exec-action"
                  title={zh ? "恢复检测路径" : "Reset to detected path"}
                  aria-label={zh ? "恢复检测路径" : "Reset to detected path"}
                  onClick={() => patch({ executable: installation.executable ?? "" })}
                >
                  <RotateCcw size={13} aria-hidden />
                </button>
              )}
            </div>
          </Field>
          <div className="harness-form-grid">
            <Field label={zh ? "默认权限" : "Default permissions"}>
              <SelectField
                aria-label={zh ? "默认权限" : "Default permissions"}
                value={form.permissionMode || undefined}
                disabled={!selectedPermModes.length}
                onValueChange={(permissionMode) => patch({ permissionMode })}
                options={selectedPermModes.map((mode) => ({ value: mode.value, label: mode.name[locale], hint: mode.description[locale] }))}
              />
              {activePermOption?.description[locale] && <p className="harness-field-hint">{activePermOption.description[locale]}</p>}
            </Field>
            <Field label={zh ? "环境变量策略" : "Environment policy"}>
              <SelectField
                aria-label={zh ? "环境变量策略" : "Environment policy"}
                value={form.envPolicyId}
                onValueChange={(envPolicyId) => patch({ envPolicyId })}
                options={ENV_POLICIES.map((policy) => ({ value: policy.id, label: t(policy.nameKey as MessageKey) }))}
              />
              {activeEnvPolicy && <p className="harness-field-hint">{t(activeEnvPolicy.descriptionKey as MessageKey)}</p>}
            </Field>
          </div>
        </section>

        {selected.id === "codex" && <section className="harness-config-section">
          <div className="harness-section-heading"><h4>{zh ? "并发与图片生成" : "Concurrency & images"}</h4></div>
          <div className="harness-form-grid">
            <Field label={zh ? "并发进程上限" : "Concurrent process limit"}>
              <Input type="number" min={1} value={form.poolSize} onChange={(event) => patch({ poolSize: event.target.value })} placeholder={zh ? "自动" : "Automatic"} />
            </Field>
            <Field label={zh ? "图片生成账号" : "Image generation account"}>
              <SelectField
                value={form.imageAccount || "__auto"}
                onValueChange={(value) => patch({ imageAccount: value === "__auto" ? "" : value })}
                options={[
                  { value: "__auto", label: zh ? "自动选择 Codex 登录账号" : "Automatically choose a Codex account" },
                  ...imageAccounts.map(account => ({ value: account.id, label: account.name })),
                  { value: "off", label: zh ? "不启用图片生成" : "Disable image generation" },
                ]}
              />
              <p className="harness-field-hint">{zh ? "图片使用此官方账号，聊天使用会话模型。" : "Images use this account; chat uses the session model."}</p>
            </Field>
          </div>
        </section>}

        {managesPlugins && (profile ? <HarnessPluginsPanel key={profile.id + ":" + profile.updatedAt} instanceId={profile.id}
          accounts={connections.filter(item => item.enabled && item.kind === "login" && item.harness === selected.id)} />
          : <p className="harness-notice-muted">{zh ? "保存可执行文件后即可管理原生插件。" : "Save the executable to manage native plugins."}</p>)}

        {installation?.status !== "ready" && (
          <div className="harness-install-alert">
            <Terminal size={14} aria-hidden />
            <span>{installation?.message || (zh ? "安装对应 CLI 后点击右上角重新检测。" : "Install the CLI, then click detect above.")}</span>
          </div>
        )}
        {error && <p role="alert" className="harness-error-alert">{error}</p>}
      </div>}
    </Dialog>
  </div>;
}
