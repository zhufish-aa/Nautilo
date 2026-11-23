import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowDown, Clock3, Download, RefreshCw, Search, X } from "lucide-react";
import type { RequestLog, RequestLogPage } from "@agenthub/schemas";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { useSessionsStore } from "../../stores/sessions";
import { useConnectionsStore } from "../../stores/connections";
import { RequestLogRow } from "./RequestLogRow";
import { RequestTrace } from "./RequestTrace";
import { abnormalRequest, duration, ms, requestLogErrorMessage, requestTelemetry, statusLabel, ttftTone } from "./request-log-display";
import { harnessName, percent } from "./UsageCharts";
import "./request-logs.css";

const filters = ["all", "slow", "cold", "abnormal"] as const;
type Filter = typeof filters[number];
type Sort = "latest" | "firstText" | "ended";
const matchesQuickFilter = (row: RequestLog, filter: Filter) => {
  switch (filter) {
    case "slow": return (row.milestones.firstText ?? 0) > 8000;
    case "cold": return row.runtime?.reused === false;
    case "abnormal": return abnormalRequest(row);
    default: return true;
  }
};

export function RequestLogsPanel({ sessionId, actionsHost }: { sessionId?: string; actionsHost: HTMLElement | null }) {
  const zh = useI18n().locale === "zh-CN";
  const t = (cn: string, en: string) => zh ? cn : en;
  const sessions = useSessionsStore(s => s.sessions);
  const connections = useConnectionsStore(s => s.connections);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [live, setLive] = useState(false);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [status, setStatus] = useState("");
  const [quick, setQuick] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("latest");
  const [selectedId, setSelectedId] = useState<string>();
  const [narrow, setNarrow] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const generation = useRef(0);
  const loading = useRef(false);
  const load = useCallback(async (silent = false) => {
    if (loading.current) {
      if (!silent) setBusy(true);
      return;
    }
    const version = ++generation.current;
    loading.current = true;
    if (!silent) setBusy(true);
    try {
      const items: RequestLog[] = [];
      let cursor: string | undefined;
      do {
        const page: RequestLogPage = await requestCore<RequestLogPage>("requestLog.list", { sessionId, before: cursor, limit: 200 });
        if (version !== generation.current) return;
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      setLogs(items);
      setError("");
    } catch (error) {
      if (version === generation.current) setError(requestLogErrorMessage(error, zh));
    } finally {
      if (version === generation.current) {
        loading.current = false;
        setBusy(false);
      }
    }
  }, [sessionId, zh]);

  useEffect(() => {
    setLogs([]);
    setSelectedId(undefined);
    setDrawer(false);
    setError("");
    void load();
    return () => { generation.current++; loading.current = false; };
  }, [load]);
  useEffect(() => {
    if (!live) return;
    void load(true);
    const timer = window.setInterval(() => { if (!document.hidden) void load(true); }, 4000);
    return () => window.clearInterval(timer);
  }, [live, load]);
  useEffect(() => {
    if (!panel.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const compact = entry.contentRect.width < 960;
      setNarrow(compact);
      if (!compact) setDrawer(false);
    });
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, []);

  const titles = useMemo(() => new Map(sessions.map(session => [session.id, session.title])), [sessions]);
  const titleOf = (row: RequestLog) => titles.get(row.sessionId)?.trim() || row.id.slice(0, 12);
  const choices = (field: "providerId" | "model") => [...new Set(logs.flatMap(row => row[field] ? [row[field]] : []))].sort();
  const providers = useMemo(() => choices("providerId"), [logs]);
  const models = useMemo(() => choices("model"), [logs]);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const base = logs.filter(row => {
    if (provider && row.providerId !== provider || model && row.model !== model || status && row.status !== status) return false;
    const searchable = [titles.get(row.sessionId), harnessName(row.providerId), row.providerId, row.model, row.runtime?.pid,
      row.id, row.sessionId, row.runId, row.failure?.code].join(" ").toLowerCase();
    return terms.every(term => searchable.includes(term));
  });
  const rows = base.filter(row => matchesQuickFilter(row, quick));
  if (sort !== "latest") rows.sort((a, b) => (b.milestones[sort] ?? -1) - (a.milestones[sort] ?? -1));
  const selected = rows.find(row => row.id === selectedId) ?? rows[0];
  const connection = selected?.connectionId ? connections.find(item => item.id === selected.connectionId) : undefined;
  const telemetry = requestTelemetry(rows);
  const finished = telemetry.completed + telemetry.abnormal;
  const knownRuntime = telemetry.reused + telemetry.fresh;
  const rate = knownRuntime ? telemetry.reused / knownRuntime * 100 : undefined;
  const label = {
    all: t("全部", "All"), slow: t("慢首字", "Slow TTFT"), cold: t("冷启动", "Cold start"), abnormal: t("失败 / 中断", "Failed / stopped"),
  };
  const sortNames: Record<Sort, string> = {
    latest: t("最新时间", "Newest first"), firstText: t("首字最慢", "Slowest TTFT"), ended: t("总耗时最长", "Longest total"),
  };
  const focusRow = (id: string) => list.current?.querySelector<HTMLButtonElement>(`[data-request-id="${CSS.escape(id)}"]`)?.focus();
  const move = (event: KeyboardEvent) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" || !selected) return;
    event.preventDefault();
    const index = rows.indexOf(selected);
    const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    setSelectedId(next.id);
    focusRow(next.id);
  };
  const open = useCallback((id: string) => {
    setSelectedId(id);
    if (narrow) setDrawer(true);
  }, [narrow]);
  const exportLogs = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `nautilo-request-logs-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const trace = selected && <RequestTrace row={selected} title={titleOf(selected)} connection={connection} zh={zh} />;
  const empty = busy ? t("正在读取请求日志", "Loading request logs") : t("暂无匹配的请求记录", "No matching requests");
  return <div className="request-logs" ref={panel}>
    {actionsHost && createPortal(<div className="request-actions">
        <button type="button" aria-pressed={live} className="request-live" onClick={() => setLive(!live)}>
          <i className="request-status-dot" />{t("实时追踪", "Live")}
        </button>
        <button type="button" onClick={exportLogs} disabled={!rows.length}><Download size={14} />{t("导出 JSON", "Export JSON")}</button>
        <button type="button" onClick={() => void load()} disabled={busy} aria-busy={busy}><RefreshCw size={14} data-spinning={busy} />{t("刷新", "Refresh")}</button>
    </div>, actionsHost)}
    <dl className="request-telemetry" aria-label={t("请求统计", "Request telemetry")}>
      <div><dt>{t("请求数", "Requests")}</dt><dd>{rows.length}
        <small data-tone={telemetry.abnormal ? "bad" : "good"} title={t("成功率基于已结束的请求", "Success rate among finished requests")}>
          {finished ? `${percent(telemetry.completed / finished * 100)} ${t("成功", "success")}` : "—"}
        </small>
      </dd><span>{t("失败 / 中断", "Failed / stopped")} {telemetry.abnormal}</span></div>
      <div><dt>{t("首字延迟", "Time to first text")} <span>P50</span></dt>
        <dd data-tone={ttftTone(telemetry.p50)}>{ms(telemetry.p50)}</dd>
        <span title={t(`已记录首段正文的请求 ${telemetry.firstCount} 条`, `${telemetry.firstCount} requests with first text recorded`)}>P95 <b>{ms(telemetry.p95)}</b></span>
      </div>
      <div><dt>{t("原生进程复用率", "Native process reuse")}</dt>
        <dd>{percent(rate)}{rate !== undefined && <span className="request-mini-track request-reuse-track" aria-hidden><i style={{ transform: `scaleX(${rate / 100})` }} /></span>}</dd>
        <span>{t("复用", "Reused")} {telemetry.reused} · {t("冷启动", "Cold")} {telemetry.fresh}</span>
      </div>
      <div><dt>{t("平均总耗时", "Mean total")}</dt><dd>{duration(telemetry.mean)}</dd>
        <span title={ms(telemetry.longest)}>{t("最长", "Longest")} <b>{duration(telemetry.longest)}</b></span></div>
    </dl>
    <div className="request-filters">
      <div className="request-search"><Search size={15} /><input aria-label={t("搜索请求", "Search requests")} value={query} onChange={e => setQuery(e.target.value)}
        placeholder={t("搜索会话、模型、Harness、PID 或 ID", "Search title, model, Harness, PID or ID")} />
        {query && <button type="button" aria-label={t("清除搜索", "Clear search")} onClick={() => setQuery("")}><X size={14} /></button>}
      </div>
      <div className="request-quick" role="group" aria-label={t("快速筛选", "Quick filters")}>
        {filters.map(key => {
          const count = base.filter(row => matchesQuickFilter(row, key)).length;
          return <button type="button" key={key} aria-pressed={quick === key} onClick={() => setQuick(key)}
            title={key === "slow" ? t("首段正文耗时超过 8 秒", "First text above 8 seconds") : undefined}>{label[key]} <small>{count}</small></button>;
        })}
      </div>
      <div className="request-selects">
        <select aria-label="Harness" value={provider} onChange={e => setProvider(e.target.value)}>
          <option value="">{t("全部 Harness", "All Harnesses")}</option>{providers.map(id => <option value={id} key={id}>{harnessName(id)}</option>)}
        </select>
        <select aria-label={t("模型", "Model")} value={model} onChange={e => setModel(e.target.value)}>
          <option value="">{t("全部模型", "All models")}</option>{models.map(id => <option key={id}>{id}</option>)}
        </select>
        <select aria-label={t("请求状态", "Request status")} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">{t("全部状态", "All statuses")}</option>{Object.entries(statusLabel).map(([id, name]) => <option value={id} key={id}>{name[zh ? 0 : 1]}</option>)}
        </select>
        <select aria-label={t("排序", "Sort")} value={sort} onChange={e => setSort(e.target.value as Sort)}>
          {Object.entries(sortNames).map(([id, name]) => <option value={id} key={id}>{name}</option>)}
        </select>
      </div>
    </div>
    {error && <p className="request-log-notice" role="alert">{error}</p>}
    <div className="request-workbench" data-narrow={narrow}>
      <section className="request-list" aria-label={t("请求流", "Requests")}>
        <div className="request-list-header">
          <h2>{t("请求流", "Requests")}</h2>
          <div className="request-list-sort" role="group" aria-label={t("按列排序", "Column sorting")}>
            {(["latest", "firstText", "ended"] as const).map((key, index) => <button type="button" key={key} aria-pressed={sort === key}
              title={sortNames[key]} onClick={() => setSort(key)}>{(zh ? ["时间", "首字", "总耗时"] : ["Time", "TTFT", "Total"])[index]}{sort === key && <ArrowDown size={11} />}</button>)}
          </div>
        </div>
        <div className="request-list-body" ref={list} onKeyDown={move}>
          {rows.map(row => <RequestLogRow key={row.id} row={row} title={titleOf(row)} selected={row.id === selected?.id}
            maximum={telemetry.maxFirst} zh={zh} onSelect={open} />)}
          {!rows.length && <div className="request-log-empty" role="status"><Clock3 size={21} />{empty}</div>}
        </div>
      </section>
      {!narrow && <div className="request-trace-pane">{trace ?? <div className="request-log-empty">{empty}</div>}</div>}
    </div>
    {narrow && <Dialog.Root open={drawer && !!selected} onOpenChange={setDrawer}>
      <Dialog.Portal>
        <Dialog.Overlay className="request-drawer-overlay" />
        <Dialog.Content className="request-log-drawer" aria-describedby={undefined} onCloseAutoFocus={event => {
          event.preventDefault();
          if (selected) focusRow(selected.id);
        }}>
          <div className="request-drawer-header">
            <Dialog.Title>{t("请求诊断", "Request trace")}</Dialog.Title>
            <Dialog.Close aria-label={t("关闭", "Close")}><X size={17} /></Dialog.Close>
          </div>
          <div className="request-trace-pane">{trace}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>}
  </div>;
}
