import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronRight, Info, RefreshCw, Search, X } from "lucide-react";
import type { UsageOverviewPayload, UsageOverviewQuery, UsageSessionRow, UsageSourceRow } from "@agenthub/schemas";
import { Tooltip } from "../../components/ui/Tooltip";
import { SlidingTabs } from "../../components/ui/SlidingTabs";
import { requestCore, getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { buildUsageOverview } from "../../../../shared/usage-overview";
import { harnessName, money, percent, splitLabel, TokenMix, tokens, UsageRanking, UsageTrend, type RankDimension } from "./UsageCharts";
import { RequestLogsPanel } from "./RequestLogsPanel";
import "./usage-overview.css";

const priceSettings = "/settings?section=accounts";
const periods = ["24h", "7d", "30d", "all"] as const;
const empty = buildUsageOverview([], { view: "usage" });
type SortColumn = "totalTokens" | "costUsd" | "updatedAt";

export function UsagePanel(): JSX.Element {
  const zh = useI18n().locale === "zh-CN";
  const [params, setParams] = useSearchParams();
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null);
  const logs = params.get("tab") === "requests";
  const sessionId = params.get("session") ?? undefined;
  return <div className="usage-overview">
    <div className="usage-toolbar" data-requests={logs}>
      <SlidingTabs tablist className="usage-view-tabs" label={zh ? "用量与费用" : "Usage and costs"}
        value={logs ? "requests" : "usage"} items={[{ id: "usage", label: zh ? "会话汇总" : "Session usage" },
          { id: "requests", label: zh ? "请求日志" : "Request logs" }]}
        onChange={id => setParams(previous => { const next = new URLSearchParams(previous); next.set("tab", id); return next; }, { replace: true })} />
      <div ref={setActionsHost} className="usage-toolbar-slot" />
    </div>
    {logs ? <RequestLogsPanel sessionId={sessionId} actionsHost={actionsHost} />
      : <UsageSummary actionsHost={actionsHost} sessionId={sessionId} clearSession={() => setParams(previous => {
        const next = new URLSearchParams(previous); next.delete("session"); return next;
      }, { replace: true })} zh={zh} />}
  </div>;
}

function UsageSummary({ actionsHost, sessionId, clearSession, zh }: { actionsHost: HTMLElement | null; sessionId?: string; clearSession: () => void; zh: boolean }): JSX.Element {
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState<typeof periods[number]>("all");
  const [harness, setHarness] = useState("");
  const [includeChildren, setIncludeChildren] = useState(true);
  const [sort, setSort] = useState<{ key: SortColumn; asc: boolean }>({ key: "updatedAt", asc: false });
  const [drill, setDrill] = useState<{ dimension: RankDimension; id: string; label: string }>();
  const [expanded, setExpanded] = useState<string>();
  const [limit, setLimit] = useState(50);
  const [revision, setRevision] = useState(0);
  const [overview, setOverview] = useState<UsageOverviewPayload>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const canRead = !!getBridge();
  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    setBusy(true);
    setError(undefined);
    const timer = window.setTimeout(() => {
      const filters: UsageOverviewQuery = { view: "usage", sessionId, period, query, harness, includeChildren };
      void requestCore<UsageOverviewPayload | { rows: UsageSourceRow[] }>("metrics.get", filters)
        .then(result => {
          if (cancelled) return;
          // Electron aggregates before returning through its bridge. The other
          // shell reaches the same daemon and uses the shared calculator.
          const data = "summary" in result ? result : Array.isArray(result.rows) ? buildUsageOverview(result.rows, filters) : undefined;
          if (!data) throw new Error("Usage overview requires the updated backend");
          setOverview(data);
        })
        .catch(reason => { if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason)); })
        .finally(() => { if (!cancelled) setBusy(false); });
    }, query ? 160 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [canRead, harness, includeChildren, period, query, revision, sessionId]);

  const data = overview ?? empty;
  const visible = useMemo(() => data.rows.filter(row => !drill || (
    drill.dimension === "byProject" ? row.projectId === drill.id
      : drill.dimension === "byHarness" ? row.harnesses.includes(drill.id) || (!drill.id && !row.harness)
        : row.models.includes(drill.id) || (!drill.id && !row.models.length)
  )).sort((a, b) => {
    const left = a[sort.key], right = b[sort.key];
    if (left === undefined || right === undefined) return left === right ? 0 : left === undefined ? 1 : -1;
    const order = typeof left === "string" ? left.localeCompare(String(right)) : left - Number(right);
    return order * (sort.asc ? 1 : -1);
  }), [data.rows, drill, sort]);
  const { summary } = data;
  const costs = zh
    ? "用量按实际运行时间统计。缓存写入归入未缓存输入。只有完整拆分的记录才进入彩色分段，灰段表示有总量但缺少拆分。累计快照的历史基线只进全部时间的总量，不分配到某天。自定义单价优先，参考价按标准文本 API，费用不代表订阅或实际账单。"
    : "Usage is timed by real runs. Uncached input includes cache writes. Colors use complete splits; gray marks measured totals without a split. Undated cumulative baselines count only in all-time totals. Custom rates take priority. Estimates use standard text API rates and do not represent bills.";

  return <>
    {actionsHost && createPortal(<div className="usage-actions">
        <div className="usage-segments" aria-label={zh ? "时间范围" : "Date range"}>
          {periods.map((key, i) => <button type="button" key={key} aria-pressed={period === key}
            onClick={() => { setPeriod(key); setLimit(50); }}>{["24h", zh ? "7天" : "7 days", zh ? "30天" : "30 days", zh ? "全部" : "All"][i]}</button>)}
        </div>
        <Tooltip content={costs}><button type="button" aria-label={zh ? "统计口径" : "Accounting"}><Info size={14} /><span>{zh ? "统计口径" : "Accounting"}</span></button></Tooltip>
        <button type="button" disabled={busy || !canRead} onClick={() => setRevision(r => r + 1)} aria-label={zh ? "刷新" : "Refresh"}>
          <RefreshCw size={14} className={busy ? "motion-safe:animate-spin" : undefined} /><span>{zh ? "刷新" : "Refresh"}</span>
        </button>
        <Link to={priceSettings}>{zh ? "价格设置" : "Set prices"}<ArrowUpRight size={13} /></Link>
    </div>, actionsHost)}
    {(sessionId || data.unpricedModels > 0 || error || !canRead) && <div className="usage-notes">
      {sessionId && <button type="button" onClick={clearSession}>{zh ? "← 查看全部会话" : "← View all sessions"}</button>}
      {data.unpricedModels > 0 && <Link to={priceSettings}>{zh ? `${data.unpricedModels} 个模型的用量未匹配单价` : `${data.unpricedModels} models have usage without matching prices`} <ArrowUpRight size={12} /></Link>}
      {error && <span role="status" title={error}>{zh ? "用量读取失败，请刷新或检查后端版本" : "Could not read usage. Refresh or check the backend version."}</span>}
      {!canRead && <span role="status">{zh ? "请在桌面应用中读取用量" : "Open the desktop app to read usage"}</span>}
    </div>}

    <section className="usage-panel usage-kpis" aria-label={zh ? "核心指标" : "Usage summary"}>
      <div><h2>{zh ? "已记录 Token" : "Recorded tokens"}</h2><strong>{tokens(overview ? summary.totalTokens ?? 0 : undefined)}</strong>
        <TokenMix value={summary} zh={zh} />
        <small title={splitLabel(summary, zh, true)}>{summary.hasBreakdown ? splitLabel(summary, zh) : `${summary.recordedSessions} / ${summary.totalSessions} ${zh ? "会话" : "sessions"}`}</small></div>
      <div><h2>{zh ? "缓存效率" : "Cache efficiency"}</h2><strong className="usage-rate">{percent(summary.cacheHitRate)}</strong>
        <small>{summary.cacheHitRate === undefined ? (zh ? "当前数据无缓存明细" : "No cache breakdown") : (zh ? `缓存命中 ${tokens(summary.cachedTokens)} Token` : `${tokens(summary.cachedTokens)} cached tokens`)}</small></div>
      <div><h2>{zh ? "参考费用估算" : "Reference cost estimate"}</h2><strong>{money(overview ? summary.estimatedCostUsd ?? 0 : undefined)}</strong>
        <small>{summary.pricedSessions > 0 ? (zh ? `已覆盖 ${summary.pricedSessions} / ${summary.recordedSessions} 已记录会话` : `${summary.pricedSessions} / ${summary.recordedSessions} recorded sessions priced`)
          : <Link to={priceSettings}>{zh ? "配置单价" : "Configure rates"} <ArrowUpRight size={12} /></Link>}</small></div>
      <div><h2>{zh ? "会话活跃度" : "Session activity"}</h2><strong>{summary.recordedSessions} <em>/ {summary.totalSessions} {zh ? "会话" : "sessions"}</em></strong>
        <small>{zh ? `${summary.totalRequests} 轮运行` : `${summary.totalRequests} runs`}</small></div>
    </section>

    <div className="usage-charts">
      <UsageTrend points={data.trendSeries} zh={zh} hourly={period === "24h"} />
      <UsageRanking breakdowns={data.breakdowns} zh={zh} onSelect={(dimension, rank) => {
        setDrill({ dimension, id: rank.id, label: (dimension === "byHarness" ? harnessName(rank.name) : rank.name) ?? (zh ? "未记录" : "Unknown") });
        setLimit(50);
      }} />
    </div>

    <section className="usage-panel usage-details">
      <div className="usage-details-heading">
        <h2>{zh ? "会话明细" : "Session details"} <small aria-live="polite">{visible.length}</small></h2>
        <div className="usage-filters">
          <label className="usage-search"><Search size={15} aria-hidden /><input aria-label={zh ? "搜索会话或模型" : "Search sessions or models"}
            placeholder={zh ? "搜索会话、模型、项目…" : "Search sessions, models, projects…"} value={query}
            onChange={event => { setQuery(event.target.value); setDrill(undefined); setLimit(50); }} /></label>
          <select aria-label={zh ? "Agent 类型筛选" : "Agent harness filter"} value={harness}
            onChange={event => { setHarness(event.target.value); setDrill(undefined); setLimit(50); }}>
            <option value="">{zh ? "全部 Agent 类型" : "All agent harnesses"}</option>
            {data.harnesses.map(id => <option key={id} value={id}>{harnessName(id)}</option>)}
          </select>
          <label className="usage-children-control"><input type="checkbox" checked={includeChildren} onChange={event => {
            setIncludeChildren(event.target.checked); setLimit(50);
          }} />{zh ? "含子 Agent 会话" : "Include child sessions"}</label>
        </div>
      </div>
      {drill && <div className="usage-drill"><button type="button" onClick={() => setDrill(undefined)} title={zh ? "清除排行筛选" : "Clear breakdown filter"}>
        {drill.label}<X size={12} /></button></div>}
      <table className="usage-table">
        <thead><tr>{([
          [zh ? "会话 / 模型" : "Session / model"], [zh ? "Token 用量" : "Tokens", "totalTokens"], [zh ? "缓存率" : "Cache hit"],
          [zh ? "费用 (USD)" : "Cost (USD)", "costUsd"], [zh ? "最近活跃" : "Last active", "updatedAt"], [zh ? "状态" : "Status"],
        ] as [string, SortColumn?][]).map(([label, key]) =>
          <th scope="col" key={label} aria-sort={key === sort.key ? sort.asc ? "ascending" : "descending" : undefined}
            data-column={key ?? (label === (zh ? "缓存率" : "Cache hit") ? "cache" : undefined)}>
            {key ? <button type="button" onClick={() => { setSort(current => ({ key, asc: key === current.key && !current.asc })); setLimit(50); }}>
              {label}{key === sort.key && (sort.asc ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
            </button> : label}</th>)}</tr></thead>
        <tbody>{visible.slice(0, limit).map(row => <SessionRow key={row.sessionId} row={row} zh={zh} expanded={expanded === row.sessionId}
          onToggle={() => setExpanded(expanded === row.sessionId ? undefined : row.sessionId)} />)}</tbody>
      </table>
      {!visible.length && <div className="usage-table-empty" role="status">{busy ? (zh ? "正在读取用量…" : "Loading usage…")
        : (zh ? "没有匹配的会话" : "No matching sessions")}</div>}
      {visible.length > limit && <button type="button" className="usage-more" onClick={() => setLimit(n => n + 50)}>{zh ? "加载更多会话" : "Show more sessions"}</button>}
    </section>
  </>;
}

function SessionRow({ row, zh, expanded, onToggle }: { row: UsageSessionRow; zh: boolean; expanded: boolean; onToggle: () => void }): JSX.Element {
  const date = new Date(row.updatedAt);
  const formatted = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(zh ? "zh-TW" : "en-US", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date) : "—";
  const recorded = row.totalTokens !== undefined;
  const model = row.currentModel ?? row.models.at(-1);
  const context = [row.projectName, harnessName(row.harness), model].filter(Boolean).join(" · ");
  const labels = zh ? { reported: "CLI 报告的已知费用", configured: "按自定义单价估算", reference: "按公开 API 参考价估算",
    estimated: "运行记录中的估算费用", mixed: "合计已知的配置与参考估算" }
    : { reported: "Known CLI-reported cost", configured: "Estimated from configured rates", reference: "Estimated from public API rates",
      estimated: "Estimate recorded by runtime", mixed: "Known configured and reference estimates" };
  return <><tr>
    <td><button type="button" className="usage-session-title" onClick={onToggle} aria-expanded={expanded} title={row.title ?? undefined}>
      <ChevronRight size={13} /><span>{row.title || (zh ? "未命名会话" : "Untitled session")}</span>
    </button><div className="usage-session-meta" title={context}>{context}</div></td>
    <td data-column="totalTokens"><span className="usage-token-number">{tokens(row.totalTokens)}</span><TokenMix value={row} zh={zh} /></td>
    <td data-column="cache" data-hit={row.cacheHitRate !== undefined && row.cacheHitRate >= 70}>{percent(row.cacheHitRate)}</td>
    <td data-column="costUsd" title={row.costSource ? labels[row.costSource] : undefined}>{money(row.costUsd)}</td>
    <td data-column="updatedAt" title={row.updatedAt}>{formatted}</td>
    <td><span className="usage-row-status" data-recorded={recorded}>{recorded ? (zh ? "已记录" : "Recorded") : (zh ? "未记录" : "Unrecorded")}</span></td>
  </tr>{expanded && <tr className="usage-expanded"><td colSpan={6}>
    <div><span>{zh ? "用量构成" : "Token breakdown"}</span><strong>{splitLabel(row, zh, true)}</strong></div>
    {row.cacheHitRate !== undefined && <div><span>{zh ? "缓存率" : "Cache hit"}</span><strong>{percent(row.cacheHitRate)}</strong></div>}
    {row.cacheWriteTokens !== undefined && <div><span>{zh ? "其中缓存写入" : "Cache writes within input"}</span><strong>{row.cacheWriteTokens.toLocaleString("en-US")}</strong></div>}
    {row.costSource && <div><span>{zh ? "费用来源" : "Cost source"}</span><strong>{labels[row.costSource]}</strong></div>}
  </td></tr>}</>;
}
