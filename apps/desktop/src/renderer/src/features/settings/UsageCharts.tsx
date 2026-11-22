import { useEffect, useMemo, useRef, useState } from "react";
import type { UsageComponents, UsageRank, UsageTrendBucket } from "@agenthub/schemas";

const integer = new Intl.NumberFormat("en-US");
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const smallUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });
export const tokens = (n: number | undefined): string => n === undefined ? "—" : n >= 999_950 ? (n / 1e6).toFixed(2) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "K" : integer.format(n);
export const money = (n: number | undefined): string => n === undefined ? "—"
  : n > 0 && n < .0001 ? "<$0.0001" : n > 0 && n < .01 ? smallUsd.format(n) : usd.format(n);
export const percent = (n: number | undefined): string => n === undefined ? "—" : n.toFixed(1).replace(/\.0$/, "") + "%";
export const harnessName = (name: string | null | undefined) => ({
  "claude-code": "Claude Code", "kimi-code": "Kimi Code", codex: "Codex", opencode: "OpenCode", omp: "Oh My Pi", antigravity: "Antigravity", trae: "Trae", pi: "Pi", deepseek: "DeepSeek",
}[name ?? ""] ?? name);

function series(value: UsageComponents) {
  return [
    ["cached", value.cachedTokens ?? 0],
    ["input", value.inputTokens ?? 0],
    ["output", value.outputTokens ?? 0],
    ["unknown", Math.max(0, (value.totalTokens ?? 0) - value.breakdownTokens)],
  ] as const;
}

export function splitLabel(value: UsageComponents, zh: boolean, exact = false): string {
  const format = exact ? (n: number | undefined) => n === undefined ? "—" : integer.format(n) : tokens;
  const label = zh ? ["缓存", "未缓存输入", "输出"] : ["Cached", "Uncached input", "Output"];
  return value.breakdownTokens > 0 || value.inputTokens !== undefined
    ? [value.cachedTokens, value.inputTokens, value.outputTokens].map((n, i) => label[i] + " " + format(n)).join(" · ")
      + (value.breakdownTokens < (value.totalTokens ?? 0) && exact ? (zh ? " · 仅统计有拆分记录的部分" : " · Breakdown covers measured records only") : "")
    : zh ? "这部分用量没有拆分明细" : "Token breakdown unavailable";
}

export function TokenMix({ value, zh }: { value: UsageComponents; zh: boolean }): JSX.Element | null {
  const total = value.totalTokens;
  if (!total) return null;
  return <div className="usage-mix" title={splitLabel(value, zh, true)} role="img" aria-label={splitLabel(value, zh, true)}>
    {series(value).filter(([, n]) => n > 0).map(([key, n]) =>
      <span key={key} data-series={key} style={{ flexGrow: n }} />)}
  </div>;
}

export function UsageTrend({ points, zh, hourly }: { points: UsageTrendBucket[]; zh: boolean; hourly: boolean }): JSX.Element {
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [active, setActive] = useState<number>();
  const element = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(580);
  useEffect(() => {
    const chart = element.current;
    if (!chart) return;
    const resize = new ResizeObserver(([entry]) => setWidth(Math.max(180, Math.floor(entry.contentRect.width))));
    resize.observe(chart);
    return () => resize.disconnect();
  }, []);
  useEffect(() => setActive(undefined), [points, metric]);
  const values = points.map(point => metric === "tokens" ? point.totalTokens : point.estimatedCostUsd);
  const maximum = Math.max(1e-9, ...values.map(value => value ?? 0));
  const exponent = 10 ** Math.floor(Math.log10(maximum / 4));
  const step = ([1, 2, 2.5, 5, 10].find(value => value * exponent >= maximum / 4) ?? 10) * exponent;
  const scale = Math.max(metric === "tokens" ? 1 : .01, step * 4);
  const fullDate = new Intl.DateTimeFormat(zh ? "zh-TW" : "en-US", { dateStyle: "medium", ...(hourly ? { timeStyle: "short" } : {}) });
  const left = 48, right = 10, top = 12, bottom = 183;
  const band = (width - left - right) / Math.max(1, points.length);
  const bar = Math.max(0.6, Math.min(40, band * .68));
  const height = (n: number) => n / scale * (bottom - top);
  const labelStep = Math.max(1, Math.ceil(points.length / Math.floor((width - left) / 50)));
  const current = active === undefined ? undefined : points[active];
  const marks = useMemo(() => points.map((point, index) => {
    const x = left + band * (index + .5);
    const chunks = (metric === "tokens" ? series(point) : [["cached", point.estimatedCostUsd ?? 0] as const]).filter(([, n]) => n > 0);
    let y = bottom;
    return <g key={point.bucketKey}>
      {chunks.map(([key, n], part) => {
        const h = n / scale * (bottom - top);
        y -= h;
        const r = part === chunks.length - 1 ? Math.min(3, h / 2, bar / 2) : 0;
        const x1 = x - bar / 2, x2 = x + bar / 2;
        return r > 0 ? <path key={key} data-series={key} d={`M${x1} ${y + h}V${y + r}Q${x1} ${y} ${x1 + r} ${y}H${x2 - r}Q${x2} ${y} ${x2} ${y + r}V${y + h}Z`} />
          : <rect key={key} x={x1} y={y} width={bar} height={h} data-series={key} />;
      })}
      {index % labelStep === 0 && <text x={x} y={202} textAnchor="middle">{point.label}</text>}
    </g>;
  }), [points, metric, band, bar, scale, labelStep]);
  return <section className="usage-panel" aria-label={zh ? "消耗趋势" : "Usage trend"}>
    <div className="usage-chart-heading">
      <div><h2>{zh ? "消耗趋势" : "Usage trend"}</h2>
      {metric === "tokens" && <div className="usage-legend">
        {([["cached", zh ? "缓存" : "Cached"], ["input", zh ? "输入" : "Input"], ["output", zh ? "输出" : "Output"],
          ...(points.some(p => (p.totalTokens ?? 0) > p.breakdownTokens) ? [["unknown", zh ? "未拆分" : "Unsplit"]] : [])]).map(([key, label]) =>
          <span key={key}><i data-series={key} />{label}</span>)}
      </div>}</div>
      <div className="usage-segments">
        <button type="button" aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>Token</button>
        <button type="button" aria-pressed={metric === "cost"} onClick={() => setMetric("cost")}>{zh ? "费用" : "Cost"}</button>
      </div>
    </div>
    <div className="usage-trend" ref={element}>
      {!values.some(value => value !== undefined) ? <div className="usage-chart-empty">{metric === "cost"
        ? (zh ? "此时间范围没有可归属日期的费用估算" : "No dated cost estimates in this range")
        : (zh ? "此时间范围没有可归属日期的 Token 记录" : "No dated token records in this range")}</div>
        : <svg width="100%" height="210" role="img" tabIndex={0} aria-label={zh ? "消耗趋势，左右方向键查看时间桶" : "Usage trend. Use arrow keys to inspect a bucket."}
          onPointerMove={event => {
            const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
            setActive(x < left || x >= width - right ? undefined : Math.min(points.length - 1, Math.floor((x - left) / band)));
          }}
          onPointerLeave={() => setActive(undefined)} onBlur={() => setActive(undefined)}
          onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Escape") return;
            event.preventDefault();
            setActive(event.key === "Escape" ? undefined : Math.min(points.length - 1, Math.max(0, (active ?? 0) + (event.key === "ArrowLeft" ? -1 : 1))));
          }}>
          {[0, 1, 2, 3, 4].map(i => {
            const n = scale * i / 4;
            const y = bottom - height(n);
            return <g key={i}><line x1={left} x2={width - right} y1={y} y2={y} className="usage-grid-line" />
              <text x={left - 7} y={y + 3} textAnchor="end">{metric === "tokens" ? tokens(n) : "$" + Number(n.toPrecision(3))}</text></g>;
          })}
          {marks}
          {active !== undefined && <line className="usage-trend-cursor" x1={left + band * (active + .5)} x2={left + band * (active + .5)} y1={top} y2={bottom} />}
        </svg>}
      {current && active !== undefined && <div className="usage-chart-tooltip" role="status" style={{ left: Math.max(0, Math.min(width - 206, left + band * (active + .5) - 95)) }}>
        <b>{fullDate.format(new Date(current.bucketKey))}</b>
        <dl>
          {([[zh ? "总 Token" : "Total tokens", current.totalTokens === undefined ? "—" : integer.format(current.totalTokens)],
            ...(current.inputTokens === undefined ? [] : [
              [zh ? "缓存读取" : "Cached", integer.format(current.cachedTokens ?? 0)],
              [zh ? "未缓存输入" : "Uncached input", integer.format(current.inputTokens)],
              [zh ? "输出" : "Output", integer.format(current.outputTokens ?? 0)],
            ]),
            [zh ? "缓存命中率" : "Cache hit rate", percent(current.cacheHitRate)],
            [zh ? "会话" : "Sessions", integer.format(current.sessionsCount)],
            [zh ? "参考费用估算" : "Cost estimate", money(current.estimatedCostUsd)]]).map(([label, value]) =>
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        {(current.totalTokens ?? 0) > current.breakdownTokens && <small>{zh ? "拆分只覆盖有明细的记录" : "Breakdown covers measured records only"}</small>}
      </div>}
    </div>
  </section>;
}

export type RankDimension = "byModel" | "byHarness" | "byProject";
export function UsageRanking({ breakdowns, zh, onSelect }: {
  breakdowns: Record<RankDimension, UsageRank[]>; zh: boolean; onSelect: (dimension: RankDimension, rank: UsageRank) => void;
}): JSX.Element {
  const [dimension, setDimension] = useState<RankDimension>("byModel");
  const ranked = breakdowns[dimension].slice(0, 6);
  return <section className="usage-panel" aria-label={zh ? "消耗分布" : "Usage breakdown"}>
    <div className="usage-chart-heading"><h2>{zh ? "消耗分布" : "Usage breakdown"}</h2>
      <div className="usage-segments">{(["byModel", "byHarness", "byProject"] as const).map((key, index) =>
        <button type="button" key={key} aria-pressed={dimension === key} onClick={() => setDimension(key)}>{[zh ? "模型" : "Model", "Harness", zh ? "项目" : "Project"][index]}</button>)}</div>
    </div>
    {ranked.length ? <ol className="usage-ranking">{ranked.map((row, index) => {
      const name = (dimension === "byHarness" ? harnessName(row.name) : row.name) ?? (zh ? "未记录" : "Unknown");
      return <li key={row.id}><button type="button" title={name} onClick={() => onSelect(dimension, row)}>
        <span className="usage-rank-line"><b>{name}</b><span>{tokens(row.totalTokens)}</span><small>{percent(row.sharePercent)}</small></span>
        <span className="usage-rank-bar"><i style={{ width: row.sharePercent + "%", opacity: 1 - index * .085 }} /></span>
      </button></li>;
    })}</ol> : <div className="usage-chart-empty">{zh ? "暂无用量可分组" : "No usage to break down"}</div>}
  </section>;
}
