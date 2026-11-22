import { useMemo, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { RuntimeConnection } from "@agenthub/domain";
import { accountQuotaSource, type AccountQuota, type IpcRequestMap } from "@agenthub/schemas";
import { useAccountQuota } from "../../lib/account-quota";
import { useI18n } from "../../lib/i18n";
import { promptCacheRates } from "../../lib/session-usage";
import type { TimelineEvent, UiSession } from "../../lib/types";
import { useConnectionsStore } from "../../stores/connections";
import { useAgentsStore } from "../../stores/agents";
import { useProvidersStore } from "../../stores/providers";
import { useTeamsStore } from "../../stores/teams";
import { useUsageStore } from "../../stores/usage";
import { AgentPanel } from "./AgentPanel";
import { useContextUsage } from "./ContextUsageIndicator";
import "./session-inspector.css";

const tokenFormat = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function SessionInspector({ session, events, menu, onOpenSession, compactSlot }: {
  session: UiSession;
  events: TimelineEvent[];
  menu: ReactNode;
  onOpenSession: (id: string) => void;
  compactSlot: (element: HTMLSpanElement | null) => void;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  return <aside className="session-inspector" aria-label={zh ? "会话信息" : "Conversation details"}>
    <header className="session-inspector-heading"><h2>{zh ? "会话关系" : "Lineage"}</h2>{menu}</header>
    <div className="session-inspector-body">
      <AgentPanel session={session} onOpenSession={onOpenSession} />
      <ContextSection sessionId={session.id} events={events} compactSlot={compactSlot} />
      <AccountsSection session={session} />
    </div>
  </aside>;
}

function ContextSection({ sessionId, events, compactSlot }: {
  sessionId: string;
  events: TimelineEvent[];
  compactSlot: (element: HTMLSpanElement | null) => void;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const { used, limit, percentage, cached } = useContextUsage(sessionId);
  const uncached = used !== undefined && cached !== undefined ? used - cached : undefined;
  const cachedPercent = limit && cached !== undefined ? Math.min(percentage ?? 0, 100 * cached / limit) : undefined;
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
      if (data.kind === "tool_group") tools += data.callCount;
    }
    return { turns, tools };
  }, [events]);

  return <section className="session-inspector-section">
    <header className="session-inspector-section-heading"><h3>{zh ? "上下文" : "Context"}</h3></header>
    <div className="session-inspector-meter-heading">
      <strong>{percentage === undefined ? (zh ? "占用比例未知" : "Usage percentage unavailable") : `${Math.round(percentage)}%${zh ? " 已用" : " used"}`}</strong>
      <span>{used === undefined ? "—" : tokenFormat.format(used)} / {limit ? tokenFormat.format(limit) : "—"}</span>
    </div>
    {percentage !== undefined && <div className="session-inspector-meter" role="progressbar" aria-label={zh ? "上下文占用" : "Context used"} aria-valuenow={Math.round(percentage)}>
      <span style={{ width: `${percentage}%` }}>{cachedPercent !== undefined && percentage > 0 && <i style={{ width: `${100 * cachedPercent / percentage}%` }} />}</span>
    </div>}
    <dl className="session-inspector-stats">
      {cached !== undefined && uncached !== undefined && <>
        <div className="session-inspector-breakdown">
          <dt><i data-tone="cached" />{zh ? "已缓存上下文" : "Cached context"}</dt><dd>{tokenFormat.format(cached)}</dd><dd>{limit ? `${formatPercent(cached / limit)}%` : "—"}</dd>
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
      {cache && <div className="session-inspector-cache">
        <dt>{zh ? "提示词缓存" : "Prompt cache"}</dt><dd>{cache.hit}% <small>· {zh ? "均值" : "avg"} {cache.average}%</small></dd>
      </div>}
    </dl>
    <footer className="session-inspector-context-footer">
      <span>{zh ? `${turns} 轮 · ${tools} 次工具调用` : `${turns} turns · ${tools} tool calls`}</span>
      <span ref={compactSlot} />
    </footer>
  </section>;
}

const formatPercent = (fraction: number): string => new Intl.NumberFormat("en", {
  maximumFractionDigits: fraction < 0.01 ? 1 : 0
}).format(fraction * 100);

function AccountsSection({ session }: { session: UiSession }): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
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
  const nativeKimi = !session.connectionId && native?.providerId === "kimi-code";
  const activeNative = !session.connectionId && native && hasNativeQuota(native) ? native : undefined;
  const otherNative = agents.filter(agent => agent.configurationKind === "harness" && agent.id !== activeNative?.id && hasNativeQuota(agent));
  return <section className="session-inspector-section session-inspector-accounts">
    <h3 className="sr-only">{zh ? "账号额度" : "Account limits"}</h3>
    {current?.enabled && revision !== undefined && accountQuotaSource(current) &&
      <AccountLimits key={`${current.id}:${revision}`} account={current} lookup={{ connectionId: current.id, revision }} auto />}
    {nativeKimi && <AccountLimits key={session.id} account={{ name: native.displayName, harness: "kimi-code" }} lookup={{ sessionId: session.id }} auto />}
    {activeNative && <AccountLimits key={`${session.id}:${activeNative.updatedAt}`} account={{ name: activeNative.displayName, harness: activeNative.providerId }}
      lookup={{ sessionId: session.id }} auto unpinned />}
    {(other.length > 0 || otherNative.length > 0) && <>
      <h4 className="session-inspector-subheading">{zh ? "其他登录账号" : "Other signed-in accounts"}</h4>
      {other.map(account => <AccountLimits key={`${account.id}:${account.revision}`} account={account} lookup={{ connectionId: account.id, revision: account.revision }} />)}
      {otherNative.map(agent => <AccountLimits key={`${agent.id}:${agent.updatedAt}`} account={{ name: agent.displayName, harness: agent.providerId }}
        lookup={{ agentInstanceId: agent.id }} unpinned />)}
    </>}
  </section>;
}


function AccountLimits({ account, lookup, auto = false, unpinned = false }: {
  account: Pick<RuntimeConnection, "name" | "harness">;
  lookup: IpcRequestMap["connection.quota"]["input"];
  auto?: boolean;
  unpinned?: boolean;
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
    if (windows.length === 0) return null;
    return <>{windows.map(window => {
      const title = `${account.name} · ${windowTitle(window)}`;
      const period = windowPeriod(window);
      const name = account.harness === "antigravity" && window.label ? window.label : [account.name, window.label].filter(Boolean).join(" · ");
      const remaining = 100 - window.usedPercent;
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
      <button type="button" className="session-inspector-toggle" aria-label={refreshLabel} title={refreshLabel} disabled={loading}
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
            <i className="session-inspector-quota-ring" aria-hidden style={{ background: `conic-gradient(var(--session-inspector-amber) ${remaining}%, var(--line-strong) 0)` }} />
            <strong title={title}>{title}</strong><span>{percent}%</span>
          </div>
          <div role="progressbar" aria-label={zh ? `${title}剩余` : `${title} remaining`} aria-valuenow={percent} className="session-inspector-quota-steps">
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
