import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Activity, ArrowUpRight, Coins, Database, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { getBridge } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { estimateSnapshot, snapshotTotal, type UsageTotals } from "../../lib/session-usage";
import { useAgentsStore } from "../../stores/agents";
import { useSessionsStore } from "../../stores/sessions";
import { useUsageStore } from "../../stores/usage";

const number = (value: number | undefined) => value === undefined ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: value >= 100_000 ? "compact" : "standard" }).format(value);
const money = (value: number | undefined) => value === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
const sum = (values: Array<number | undefined>) => { const known = values.filter((v): v is number => v !== undefined); return known.length ? known.reduce((a, b) => a + b, 0) : undefined; };

export function UsagePanel(): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedSession = searchParams.get("session");
  const sessions = useSessionsStore(state => state.sessions);
  const instances = useAgentsStore(state => state.instances);
  const { summaries, loading, errors, refreshedAt, refresh } = useUsageStore();
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(50);
  const canRead = !!getBridge();
  const [provider, setProvider] = useState("");
  const [includeChildren, setIncludeChildren] = useState(true);
  const [expanded, setExpanded] = useState<string>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  // Usage history is loaded only on this page, with bounded concurrency and no startup cost.
  const sessionIds = sessions.map(session => session.id).sort().join("\n");
  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    const queue = sessionIds.split("\n").filter(Boolean);
    const worker = async () => { while (!cancelled && queue.length) { const id = queue.shift(); if (id) await refresh(id); } };
    void Promise.all([worker(), worker(), worker()]);
    return () => { cancelled = true; };
  }, [sessionIds, refreshVersion, refresh, canRead]);
  const rows = useMemo(() => sessions.map(session => {
    const target = session.target;
    const instance = target.type === "agent" ? instances.find(item => item.id === target.instanceId) : undefined;
    const summary = summaries[session.id];
    const estimates = summary?.snapshots.map(snapshot => {
      // Only the price captured for that run can price its historical usage.
      return estimateSnapshot(snapshot, snapshot.pricingSnapshot);
    }) ?? [];
    const fullyEstimated = estimates.length > 0 && estimates.every(value => value !== undefined);
    return { session, instance, summary, estimate: fullyEstimated ? sum(estimates) : undefined };
  }).filter(row => (!selectedSession || row.session.id === selectedSession) && (includeChildren || !row.session.parentSessionId) && (!provider || row.instance?.providerId === provider) && `${row.session.title} ${row.session.model ?? ""} ${row.instance?.displayName ?? ""}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt)), [sessions, instances, summaries, query, provider, includeChildren, selectedSession]);
  const known = rows.filter(row => row.summary?.totalTokens !== undefined);
  const priced = rows.filter(row => row.estimate !== undefined);
  const busy = sessions.some(session => loading[session.id]);
  const failures = rows.filter(row => errors[row.session.id]);
  const providerIds = [...new Set(instances.map(instance => instance.providerId))];
  const cards = [
    { icon: Database, title: zh ? "已记录 Token" : "Recorded tokens", value: number(sum(rows.map(row => row.summary?.totalTokens))), note: zh ? `${known.length} / ${rows.length} 个会话有用量数据` : `${known.length} / ${rows.length} sessions with usage` },
    { icon: Coins, title: zh ? "等价 API 估算" : "Equivalent API estimate", value: money(sum(rows.map(row => row.estimate))), note: zh ? "按每轮记录价格 · 不是账单" : "Recorded run rates · not an invoice" },
    { icon: ShieldCheck, title: zh ? "估算覆盖" : "Estimate coverage", value: `${priced.length} / ${rows.length}`, note: zh ? "未定价或缺失用量不按零费用计算" : "Unknown usage or rates never count as free" }
  ];
  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-sm text-muted">{zh ? "查看各会话的累计用量、缓存与费用。" : "Review session totals, cache usage and costs."}</p><p className="mt-1 text-xs text-muted">{zh ? "全部时间 · Nautilo 已保存的会话 · 不读取其他 CLI 历史目录" : "All time · sessions saved in Nautilo · no external CLI history scanning"}</p></div>
      <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setRefreshVersion(value => value + 1)} disabled={busy || !canRead}><RefreshCw size={14} className={busy ? "animate-spin" : ""} />{zh ? "刷新" : "Refresh"}</Button><Link to="/settings?section=accounts" className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-2 text-xs text-ink hover:bg-surface">{zh ? "价格设置" : "Set prices"}<ArrowUpRight size={14} /></Link></div>
    </div>
    {selectedSession && <button className="text-left text-xs text-accent hover:underline" onClick={() => { const next = new URLSearchParams(searchParams); next.delete("session"); setSearchParams(next, { replace: true }); }}>{zh ? "← 查看全部会话" : "← View all sessions"}</button>}
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-line px-3 py-2"><Search size={15} className="text-muted" /><input aria-label={zh ? "搜索会话或模型" : "Search sessions or models"} placeholder={zh ? "搜索会话、模型、实例…" : "Search sessions, models, instances…"} value={query} onChange={event => setQuery(event.target.value)} className="w-full bg-transparent text-sm text-ink outline-none" /></label>
      <select aria-label={zh ? "Agent 类型筛选" : "Agent harness filter"} className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink" value={provider} onChange={event => setProvider(event.target.value)}><option value="">{zh ? "全部 Agent 类型" : "All agent harnesses"}</option>{providerIds.map(id => <option key={id} value={id}>{id}</option>)}</select>
      <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={includeChildren} onChange={event => setIncludeChildren(event.target.checked)} />{zh ? "含子 Agent 会话" : "Include child sessions"}</label>
    </div>
    <div className="grid gap-3 min-[700px]:grid-cols-3">{cards.map(card => <div key={card.title} className="rounded-xl border border-line bg-surface/30 p-5"><div className="flex items-center gap-2 text-sm text-muted"><card.icon size={17} />{card.title}</div><div className="mt-3 text-3xl font-semibold tracking-tight text-ink tabular-nums">{card.value}</div><p className="mt-2 text-xs leading-5 text-muted">{card.note}</p></div>)}</div>
    <div className="rounded-xl border border-line bg-surface/30 px-4 py-3 text-xs leading-6 text-muted">{zh ? "费用口径：CLI 返回费用仅为供应商报告值，可能是标价折算；订阅实付金额不可得。等价 API 估算只对每轮已记录的完整价格生效，不代表账单。旧事件没有累计范围时保留为未知，避免把上下文快照重复相加。" : "Cost semantics: CLI costs are provider-reported values and may be list-price equivalents. Subscription charges are unavailable. API estimates require complete rates captured for each run; they are not invoices. Legacy events without an accounting scope remain unknown to prevent counting context snapshots twice."}</div>
    {!canRead && <p role="status" className="text-xs text-muted">{zh ? "请在桌面应用中读取已保存的用量。" : "Open the desktop app to read persisted usage."}</p>}
    {failures.length > 0 && <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600">{zh ? `${failures.length} 个会话读取失败；已读取数据仍可查看，请刷新重试。` : `${failures.length} sessions could not be read. Available data is retained; refresh to retry.`}</div>}
    <section className="overflow-hidden rounded-xl border border-line">
      <div className="flex items-center justify-between border-b border-line p-4"><h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><Activity size={17} />{zh ? "会话明细" : "Session details"}</h2><span aria-live="polite" className="text-xs text-muted">{busy ? (zh ? "正在读取用量…" : "Loading usage…") : `${rows.length} ${zh ? "个会话" : "sessions"}`}</span></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-xs"><thead className="bg-surface/50 text-muted"><tr>{[zh ? "会话 / 当前模型" : "Session / current model", "Token", zh ? "CLI 报告 (USD)" : "CLI reported (USD)", zh ? "等价估算 (USD)" : "Equivalent estimate (USD)", zh ? "状态" : "Status"].map(label => <th key={label} className="px-4 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{rows.slice(0, visibleCount).map(row => <UsageRow key={row.session.id} row={row} zh={zh} error={errors[row.session.id]} loading={loading[row.session.id]} loaded={!!refreshedAt[row.session.id]} expanded={expanded === row.session.id} onToggle={() => setExpanded(expanded === row.session.id ? undefined : row.session.id)} />)}</tbody></table></div>
      {rows.length > visibleCount && <button type="button" onClick={() => setVisibleCount(count => count + 50)} className="w-full border-t border-line py-3 text-xs text-accent">{zh ? "加载更多会话" : "Show more sessions"}</button>}
      {!rows.length && <div className="py-14 text-center text-sm text-muted">{sessions.length ? (zh ? "没有匹配的会话" : "No matching sessions") : (zh ? "还没有会话。开始对话后，用量会显示在这里。" : "No sessions yet. Usage appears here after a conversation.")}</div>}
    </section>
  </div>;
}

function UsageRow({ row, zh, error, loading, loaded, expanded, onToggle }: { row: { session: { id: string; title: string; model?: string }; instance?: { displayName: string }; summary?: UsageTotals; estimate?: number }; zh: boolean; error?: string; loading?: boolean; loaded: boolean; expanded: boolean; onToggle: () => void }): JSX.Element {
  const s = row.summary;
  const partial = !!s && s.snapshots.some(snapshot => snapshotTotal(snapshot) === undefined);
  return <><tr className="border-t border-line hover:bg-surface/40"><td className="max-w-[280px] px-4 py-3"><button onClick={onToggle} aria-expanded={expanded} className="block max-w-full truncate text-left font-medium text-ink hover:text-accent">{row.session.title || (zh ? "未命名会话" : "Untitled session")}</button><div className="mt-1 truncate text-[11px] text-muted">{row.instance?.displayName ?? "—"} · {row.session.model ?? (zh ? "默认模型" : "Default model")}</div></td><td className="px-4 py-3 tabular-nums text-ink">{number(s?.totalTokens)}{partial && <span className="ml-1 text-muted">*</span>}</td><td className="px-4 py-3 tabular-nums text-muted">{money(s?.reportedCost)}</td><td className="px-4 py-3 tabular-nums text-ink">{money(row.estimate)}</td><td className="px-4 py-3 text-muted">{error ? (zh ? "读取失败" : "Read failed") : loading ? (zh ? "读取中" : "Loading") : !loaded ? (zh ? "待读取" : "Pending") : s?.totalTokens !== undefined ? (zh ? "已记录" : "Recorded") : (zh ? "不可得" : "Unavailable")}</td></tr>{expanded && <tr className="border-t border-line bg-surface/30"><td colSpan={5} className="px-4 py-4"><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[[zh ? "输入 (CLI 原值)" : "Input (CLI value)", s?.inputTokens], [zh ? "输出" : "Output", s?.outputTokens], [zh ? "缓存读取" : "Cache read", s?.cachedInputTokens], [zh ? "缓存写入" : "Cache write", s?.cacheCreationInputTokens]].map(([label, value]) => <div key={label as string}><div className="text-muted">{label}</div><div className="mt-1 font-medium tabular-nums text-ink">{number(value as number | undefined)}</div></div>)}</div><p className="mt-3 text-[11px] text-muted">{zh ? "— 表示未提供，不是零。输入是否包含缓存由 CLI 标记，Token 总量自动去重；思考 Token 已包含在输出中。* 表示仅汇总可得部分。" : "— means unavailable, not zero. Totals respect CLI cache semantics; reasoning is already included in output. * indicates a partial known total."}</p>{error && <p className="mt-2 text-amber-600">{error}</p>}</td></tr>}</>;
}
