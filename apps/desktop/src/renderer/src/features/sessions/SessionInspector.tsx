import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { RefreshCw, X } from "lucide-react";
import type { RuntimeConnection } from "@agenthub/domain";
import { accountQuotaSource, type AccountQuota, type IpcRequestMap } from "@agenthub/schemas";
import { useAccountQuota } from "../../lib/account-quota";
import { useI18n } from "../../lib/i18n";
import { promptCacheRates } from "../../lib/session-usage";
import { useUiReducedMotion } from "../../lib/ui-motion";
import type { TimelineEvent, UiSession } from "../../lib/types";
import { useConnectionsStore } from "../../stores/connections";
import { useAgentsStore } from "../../stores/agents";
import { useProvidersStore } from "../../stores/providers";
import { useTeamsStore } from "../../stores/teams";
import { useUsageStore } from "../../stores/usage";
import { AgentPanel } from "./AgentPanel";
import { useContextUsage } from "./ContextUsageIndicator";
import { InspectorDisclosure } from "./InspectorDisclosure";
import "./session-inspector.css";

const tokenFormat = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function SessionInspector({ session, events, lineageOnly, floating = false, onClose, onOpenSession, compactSlot }: {
  session: UiSession;
  events: TimelineEvent[];
  lineageOnly: boolean;
  floating?: boolean;
  onClose: () => void;
  onOpenSession: (id: string) => void;
  compactSlot: (element: HTMLSpanElement | null) => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const reduced = useUiReducedMotion();
  const cardRef = useRef<HTMLElement>(null);
  const title = lineageOnly ? t("sessions.workspace.agents") : zh ? "会话检查器" : "Conversation inspector";
  const closeLabel = zh ? "收起面板" : "Close panel";

  useEffect(() => {
    if (!floating) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && cardRef.current?.contains(document.activeElement)) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [floating, onClose]);

  if (lineageOnly) {
    return (
      <div className="session-inspector flex h-full min-h-0 w-full flex-col bg-transparent">
        <div className="session-inspector-body">
          <AgentPanel session={session} onOpenSession={onOpenSession} showEmpty />
        </div>
      </div>
    );
  }

  return (
    <motion.aside
      ref={cardRef}
      role="dialog"
      aria-label={title}
      className="session-inspector session-inspector-float"
      initial={reduced ? false : { opacity: 0, y: -8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? undefined : { opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: reduced ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
    >
      <header className="session-inspector-heading">
        <h2>{title}</h2>
        <button type="button" className="workspace-panel-icon" onClick={onClose} title={closeLabel} aria-label={closeLabel}>
          <X size={15} aria-hidden />
        </button>
      </header>
      <div className="session-inspector-body">
        <ContextSection sessionId={session.id} events={events} compactSlot={compactSlot} />
        <AccountsSection session={session} />
        <AgentPanel session={session} onOpenSession={onOpenSession} showEmpty={false} />
      </div>
    </motion.aside>
  );
}

function ContextSection({ sessionId, events, compactSlot }: {
  sessionId: string;
  events: TimelineEvent[];
  compactSlot: (element: HTMLSpanElement | null) => void;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const { used, limit, percentage, cached } = useContextUsage(sessionId);
  const cachedTokens = used !== undefined && cached !== undefined ? Math.min(used, cached) : undefined;
  const uncached = used !== undefined && cachedTokens !== undefined ? used - cachedTokens : undefined;
  const cachedPercent = limit && cachedTokens !== undefined ? Math.min(percentage ?? 0, 100 * cachedTokens / limit) : undefined;
  const summary = useUsageStore(state => state.summaries[sessionId]);
  const instances = useAgentsStore(state => state.instances);
  const cache = useMemo(() => promptCacheRates(summary?.snapshots ?? [],
    new Set(instances.filter(instance => instance.providerId === "antigravity").map(instance => instance.id))), [summary, instances]);
  const { turns, tools } = useMemo(() => {
    let turns = 0;
    let tools = 0;
    for (const { data } of events) {
      if (data.kind === "message" && data.sender === "user") turns++;
      if (data.kind === "tool_activity" || data.kind === "command") tools++;
    }
    return { turns, tools };
  }, [events]);

  const cacheLabel = cache && (zh ? `提示词缓存 ${cache.hit}% · 均值 ${cache.average}%` : `Prompt cache ${cache.hit}% · avg ${cache.average}%`);
  const usageSummary = <span className="session-inspector-section-meta">
    {percentage !== undefined && <strong>{Math.round(percentage)}%</strong>}
    <span>{used === undefined ? "—" : tokenFormat.format(used)} / {limit ? tokenFormat.format(limit) : "—"}</span>
  </span>;
  return <InspectorDisclosure label={zh ? "上下文" : "Context"} summary={usageSummary}>
    {percentage !== undefined && <div className="session-inspector-meter" role="progressbar" aria-label={zh ? "上下文占用" : "Context used"} aria-valuenow={Math.round(percentage)}>
      <span data-tone={cachedPercent === undefined ? "cached" : "uncached"} style={{ transform: `scaleX(${percentage / 100})` }} />
      {cachedPercent !== undefined && <span data-tone="cached" style={{ transform: `scaleX(${cachedPercent / 100})` }} />}
    </div>}
    <dl className="session-inspector-stats">
      {cachedTokens !== undefined && uncached !== undefined && <>
        <div className="session-inspector-breakdown">
          <dt><i data-tone="cached" />{zh ? "已缓存上下文" : "Cached context"}</dt><dd>{tokenFormat.format(cachedTokens)}</dd><dd>{limit ? `${formatPercent(cachedTokens / limit)}%` : "—"}</dd>
        </div>
        <div className="session-inspector-breakdown">
          <dt><i data-tone="uncached" />{zh ? "未缓存上下文" : "Uncached context"}</dt><dd>{tokenFormat.format(uncached)}</dd><dd>{limit ? `${formatPercent(uncached / limit)}%` : "—"}</dd>
        </div>
      </>}
      <div className="session-inspector-breakdown session-inspector-free">
        <dt><i />{zh ? "剩余空间" : "Free space"}</dt>
        <dd>{limit !== undefined && used !== undefined ? tokenFormat.format(Math.max(0, limit - used)) : "—"}</dd>
        <dd>{percentage === undefined ? "—" : `${100 - Math.round(percentage)}%`}</dd>
      </div>
    </dl>
    <footer className="session-inspector-context-footer">
      <span>{zh ? `${turns} 轮 · ${tools} 次工具调用` : `${turns} turns · ${tools} tool calls`}</span>
      {cache && <span className="session-inspector-cache" data-high={cache.hit >= 80} title={cacheLabel}>
        {cache.hit >= 80 ? (zh ? "高命中" : "High hit rate") : (zh ? `缓存 ${cache.hit}%` : `Cache ${cache.hit}%`)}
      </span>}
      <span ref={compactSlot} />
    </footer>
  </InspectorDisclosure>;
}

const formatPercent = (fraction: number): string => new Intl.NumberFormat("en", {
  maximumFractionDigits: fraction < 0.01 ? 1 : 0
}).format(fraction * 100);

function AccountsSection({ session }: { session: UiSession }): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const [dotTarget, setDotTarget] = useState<HTMLSpanElement | null>(null);
  const connections = useConnectionsStore(state => state.connections);
  const current = connections.find(account => account.id === session.connectionId);
  const target = session.target;
  const instanceId = useTeamsStore(state => target.type === "member"
    ? state.teams.find(team => team.id === target.teamId)?.members.find(member => member.id === target.memberId)?.agentInstanceId
    : target.type === "agent" ? target.instanceId : undefined);
  const agents = useAgentsStore(state => state.instances);
  const catalog = useProvidersStore(state => state.catalog);
  const native = agents.find(item => item.id === instanceId);
  const hasNativeQuota = (agent: typeof native): boolean => !!agent?.enabled && !agent.baseUrl?.trim() && !agent.credentialStored
    && catalog.some(provider => provider.providerId === agent.providerId && provider.nativeAccountQuota);
  const other = connections.filter(account => account.enabled
    && account.id !== current?.id && accountQuotaSource(account));
  const revision = session.connectionRevision ?? current?.revision;
  const activeNative = !session.connectionId && native && hasNativeQuota(native) ? native : undefined;
  const nativeKimi = !session.connectionId && !activeNative && native?.providerId === "kimi-code";
  const otherNative = agents.filter(agent => agent.configurationKind === "harness" && agent.id !== activeNative?.id && hasNativeQuota(agent));
  const otherCount = other.length + otherNative.length;
  const currentAvailable = current?.enabled && revision !== undefined && accountQuotaSource(current);
  if (!currentAvailable && !activeNative && !nativeKimi && !otherCount) return <></>;
  return <InspectorDisclosure className="session-inspector-accounts" label={zh ? "账号额度" : "Account limits"}>
    {currentAvailable && current && revision !== undefined &&
      <AccountLimits key={`${current.id}:${revision}`} account={current} lookup={{ connectionId: current.id, revision }} auto />}
    {nativeKimi && <AccountLimits key={session.id} account={{ name: native.displayName, harness: "kimi-code" }} lookup={{ sessionId: session.id }} auto />}
    {activeNative && <AccountLimits key={`${session.id}:${activeNative.updatedAt}`} account={{ name: activeNative.displayName, harness: activeNative.providerId }}
      lookup={{ sessionId: session.id }} auto unpinned />}
    {otherCount > 0 && <InspectorDisclosure className="session-inspector-other-accounts" defaultOpen={false}
      label={zh ? `其他 ${otherCount} 个可用账号` : `${otherCount} other accounts`}
      summary={<span className="session-inspector-account-dots" ref={setDotTarget} />}>
      {other.map(account => <AccountLimits key={`${account.id}:${account.revision}`} account={account} lookup={{ connectionId: account.id, revision: account.revision }} dotTarget={dotTarget} />)}
      {otherNative.map(agent => <AccountLimits key={`${agent.id}:${agent.updatedAt}`} account={{ name: agent.displayName, harness: agent.providerId }}
        lookup={{ agentInstanceId: agent.id }} unpinned dotTarget={dotTarget} />)}
    </InspectorDisclosure>}
  </InspectorDisclosure>;
}


function AccountLimits({ account, lookup, auto = false, unpinned = false, dotTarget }: {
  account: Pick<RuntimeConnection, "name" | "harness">;
  lookup: IpcRequestMap["connection.quota"]["input"];
  auto?: boolean;
  unpinned?: boolean;
  dotTarget?: HTMLSpanElement | null;
}): JSX.Element | null {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const { quota, status, refresh } = useAccountQuota(lookup, true, undefined, unpinned);
  const loading = status === "loading";
  const windows = quota?.windows ?? [];
  const signIn = quota?.unavailableReason === "sign_in";
  const refreshLabel = zh ? "刷新额度" : "Refresh limits";
  const windowPeriod = (window: AccountQuota["windows"][number]): string | undefined =>
    window.windowMinutes === 300 ? (zh ? "5 小时" : "5h")
      : window.windowMinutes === 1440 ? (zh ? "每日" : "Daily")
        : window.windowMinutes === 10080 ? (zh ? "每周" : "Weekly")
          : window.windowMinutes ? (zh ? `${window.windowMinutes} 分钟` : `${window.windowMinutes} min`) : undefined;
  const remainingQuota = (window: AccountQuota["windows"][number]): string | undefined =>
    window.remainingQuota !== undefined && window.totalQuota !== undefined
      ? (zh ? `剩余 ${window.remainingQuota} / ${window.totalQuota}` : `${window.remainingQuota} / ${window.totalQuota} remaining`) : undefined;
  const windowTitle = (window: AccountQuota["windows"][number]): string =>
    [window.label, windowPeriod(window)].filter(Boolean).join(" · ") || (zh ? "订阅额度" : "Subscription");
  const resets = (window: AccountQuota["windows"][number]) => {
    const reset = window.resetsAt ? new Date(window.resetsAt) : undefined;
    const leftMs = reset ? Math.max(0, reset.getTime() - Date.now()) : undefined;
    const marker = window.windowMinutes && leftMs !== undefined ? Math.min(100, leftMs / (window.windowMinutes * 600)) : undefined;
    return { reset, leftMs, marker };
  };
  if (!auto) {
    const minimum = windows.length ? Math.max(0, 100 - Math.max(...windows.map(window => window.usedPercent))) : undefined;
    const tone = minimum === undefined ? undefined : minimum <= 15 ? "danger" : minimum <= 40 ? "warn" : "ok";
    const dotLabel = `${account.name} · ${minimum === undefined ? (zh ? "额度未知" : "Limits unavailable") : `${Math.floor(minimum)}%`}`;
    return <>
    {dotTarget && createPortal(<span className="session-inspector-dot" data-status={tone} title={dotLabel}><span className="sr-only">{dotLabel}</span></span>, dotTarget)}
    {!windows.length && <div className="session-inspector-pool"><span>{account.name}</span><small>{loading ? "…" : "—"}</small></div>}
    {windows.map(window => {
      const title = `${account.name} · ${windowTitle(window)}`;
      const period = windowPeriod(window);
      const name = account.harness === "antigravity" && window.label ? window.label : [account.name, window.label].filter(Boolean).join(" · ");
      const remaining = Math.max(0, 100 - window.usedPercent);
      const { reset, marker } = resets(window);
      return <div className="session-inspector-pool" key={window.id}
        title={[title, remainingQuota(window), reset && `${zh ? "重置" : "Resets"} ${reset.toLocaleString(locale)}`].filter(Boolean).join(" · ")}>
        <span className="session-inspector-pool-label"><span>{name}</span>{period && <span> · {period}</span>}</span>
        <span className="session-inspector-mini-quota" role="progressbar" aria-label={zh ? `${title}剩余` : `${title} remaining`}
          aria-valuenow={Math.floor(remaining)} style={{ backgroundSize: `${remaining}% 100%` }}>
          {marker !== undefined && <i aria-hidden style={{ left: `${marker}%` }} />}
        </span>
        <small>{Math.floor(remaining)}%</small>
      </div>;
    })}</>;
  }
  if (!loading && windows.length === 0 && status !== "failed" && !signIn) return null;
  return <div className="session-inspector-account">
    <div className="session-inspector-account-heading">
      <span className="session-inspector-primary-account" title={account.name}>{account.name}</span>
      <button type="button" className="workspace-panel-icon session-inspector-refresh" data-loading={loading} aria-label={refreshLabel} title={refreshLabel} disabled={loading}
        onClick={refresh}><RefreshCw size={13} aria-hidden /></button>
    </div>
    <div className="session-inspector-quota">
      {loading && windows.length === 0 && <p className="session-inspector-muted" role="status">{zh ? "正在读取额度…" : "Reading limits…"}</p>}
      {signIn && <p className="session-inspector-muted">{zh ? "请先登录当前 CLI，再刷新额度。" : "Sign in to the selected CLI, then refresh."}</p>}
      {status === "failed" && <p className="session-inspector-muted">
        {windows.length ? (zh ? "刷新失败，显示上次额度" : "Refresh failed. Showing the last reading.") : (zh ? "额度读取失败，可点击刷新重试" : "Could not read limits. Refresh to retry.")}
      </p>}
      {windows.map(window => {
        const remaining = Math.max(0, 100 - window.usedPercent);
        const percent = Math.floor(remaining);
        const { reset, leftMs, marker } = resets(window);
        const leftMinutes = leftMs === undefined ? undefined : Math.ceil(leftMs / 60_000);
        const leftHours = leftMinutes === undefined ? 0 : Math.floor(leftMinutes / 60);
        const resetLabel = leftMinutes === undefined ? undefined : leftMinutes === 0
          ? (zh ? "刷新查看新额度" : "Refresh for new limits")
          : leftHours >= 24 ? (zh ? `${Math.floor(leftHours / 24)} 天 ${leftHours % 24} 小时后重置` : `Resets in ${Math.floor(leftHours / 24)}d ${leftHours % 24}h`)
            : leftHours ? (zh ? `${leftHours} 小时 ${leftMinutes % 60} 分钟后重置` : `Resets in ${leftHours}h ${leftMinutes % 60}m`)
              : (zh ? `${leftMinutes} 分钟后重置` : `Resets in ${leftMinutes}m`);
        const title = windowTitle(window);
        return <div key={window.id} className="session-inspector-quota-window">
          <div className="session-inspector-meter-heading">
            <strong title={title}>{title}</strong><span>{percent}%</span>
          </div>
          <div role="progressbar" aria-label={zh ? `${title}剩余` : `${title} remaining`} aria-valuenow={percent} className="session-inspector-quota-steps" data-tone={percent <= 15 ? "danger" : percent <= 40 ? "warn" : "ok"}>
            {Array.from({ length: 20 }, (_, index) => <span key={index} aria-hidden style={{ backgroundSize: `${Math.min(100, Math.max(0, (remaining - index * 5) * 20))}% 100%` }} />)}
          </div>
          {remainingQuota(window) && <div className="session-inspector-muted">{remainingQuota(window)}</div>}
          {reset && <>
            {marker !== undefined && <div className="session-inspector-reset-track" aria-hidden><i style={{ left: `${marker}%` }} /></div>}
            <time dateTime={window.resetsAt} title={reset.toLocaleString(locale)}>{resetLabel}</time>
          </>}
        </div>;
      })}
    </div>
  </div>;
}
