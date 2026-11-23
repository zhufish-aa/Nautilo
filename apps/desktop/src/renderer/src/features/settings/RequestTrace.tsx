import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronRight, Clipboard, Code2, Copy } from "lucide-react";
import { Link } from "react-router-dom";
import type { RequestLog } from "@agenthub/schemas";
import type { RuntimeConnection } from "@agenthub/domain";
import { sessionErrorPresentation } from "../../lib/session-error-presentation";
import { harnessName, percent } from "./UsageCharts";
import { RequestRuntimeDetails, RequestRuntimeLine } from "./RequestRuntimeDetails";
import { liveRequest, ms, phaseLabels, requestTrace, statusLabel, tracePosition, traceReport } from "./request-log-display";

export function RequestTrace({ row, title, connection, zh }: {
  row: RequestLog;
  title: string;
  connection?: RuntimeConnection;
  zh: boolean;
}) {
  const [raw, setRaw] = useState(false);
  const [logarithmic, setLogarithmic] = useState(false);
  const [copied, setCopied] = useState<{ id: string; key: string }>();
  const [copyError, setCopyError] = useState(false);
  const copyTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  const t = (cn: string, en: string) => zh ? cn : en;
  const trace = requestTrace(row);
  const status = statusLabel[row.status]?.[zh ? 0 : 1] ?? row.status;
  const failure = row.failure && sessionErrorPresentation(row.failure.code ?? "", row.failure.message, zh, connection);
  const json = raw ? JSON.stringify(row, null, 2) : "";
  const wasCopied = (key: string) => copied?.id === row.id && copied.key === key;
  const copy = async (key: string, value: string) => {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(value);
      setCopied({ id: row.id, key });
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(undefined), 1600);
    } catch {
      setCopyError(true);
    }
  };
  const phaseShare = (value?: number) => trace.partitioned && trace.total && value !== undefined ? value / trace.total * 100 : undefined;
  const phasePercent = (value?: number) => {
    const share = phaseShare(value);
    return share !== undefined && share > 0 && share < .1 ? "<0.1%" : percent(share);
  };
  const bottleneck = trace.bottleneck;
  const sessionUrl = `/sessions?session=${encodeURIComponent(row.sessionId)}`;
  return <div className="request-trace">
    <section className="request-trace-head request-trace-arrival" key={row.id + ":head"}>
      <div className="request-trace-title-row">
        <div>
          <h2>{title}</h2>
          <Link className="request-trace-session-link" to={sessionUrl}>{t("打开会话", "Open conversation")}<ArrowUpRight size={13} /></Link>
        </div>
        <div className="request-actions">
          <button type="button" className="request-copy-report" data-copied={wasCopied("report")} onClick={() => void copy("report", traceReport(row, title, zh))}>
            {wasCopied("report") ? <Check size={15} /> : <Clipboard size={15} />}
            {wasCopied("report") ? t("已复制", "Copied") : t("复制诊断报告", "Copy report")}
          </button>
          <button type="button" aria-pressed={raw} onClick={() => setRaw(!raw)}><Code2 size={15} />{t("原始 JSON", "Raw JSON")}</button>
        </div>
      </div>
      <div className="request-trace-meta">
        <span className="request-badge request-trace-status" data-state={row.status} data-live={liveRequest(row)}><i className="request-status-dot" />{status}</span>
        <span>{harnessName(row.providerId)}</span>
        {row.model && <code>{row.model}</code>}
        <button type="button" className="request-copy-id" title={row.id}
          aria-label={wasCopied("id") ? t("已复制请求 ID", "Request ID copied") : t("复制请求 ID", "Copy request ID")}
          data-copied={wasCopied("id")} onClick={() => void copy("id", row.id)}>
          <code>ID {row.id.slice(0, 8)}{row.id.length > 8 && "…"}</code>{wasCopied("id") ? <Check size={12} /> : <Copy size={12} />}
        </button>
        <time dateTime={row.createdAt} title={row.createdAt}>{new Date(row.createdAt).toLocaleString(zh ? "zh-CN" : "en-GB", { hour12: false })}</time>
        {connection?.name && <Link to={`/settings?section=accounts&connection=${encodeURIComponent(connection.id)}`} title={t("当前连接名称", "Current connection name")}>{connection.name}</Link>}
      </div>
      <RequestRuntimeLine row={row} zh={zh} raw={raw} />
      {row.failure && <div className="request-trace-error" role="note">
        <strong>{[failure?.loginRequired ? failure.title : row.failure.stage, row.failure.code].filter(Boolean).join(" · ")}</strong>
        <p>{failure?.loginRequired ? failure.description : row.failure.message.split(/\r?\n/, 1)[0]}</p>
        {failure?.loginRequired && <Link to={`/settings?section=accounts${row.connectionId ? `&connection=${encodeURIComponent(row.connectionId)}` : ""}`}>
          {t("重新登录", "Sign in again")} <ArrowUpRight size={13} />
        </Link>}
        {(failure?.loginRequired || /[\r\n]/.test(row.failure.message)) && <details>
          <summary><ChevronRight size={13} />{t("完整错误", "Full error")}</summary>
          <pre>{row.failure.message}</pre>
        </details>}
      </div>}
      {copyError && <p className="request-log-notice" role="alert">{t("剪贴板写入失败，请重试。", "Could not write to the clipboard. Try again.")}</p>}
    </section>
    {raw ? <section className="request-trace-raw request-trace-arrival" key={row.id + ":json"}>
      <div className="request-section-heading"><h3>{t("原始日志", "Raw log")}</h3>
        <div className="request-actions"><button type="button" data-copied={wasCopied("json")} onClick={() => void copy("json", json)}>
          {wasCopied("json") ? <Check size={14} /> : <Copy size={14} />}{wasCopied("json") ? t("已复制", "Copied") : t("复制 JSON", "Copy JSON")}
        </button></div>
      </div>
      <pre tabIndex={0}>{json}</pre>
    </section> : <>
      <section className="request-waterfall request-trace-arrival" key={row.id + ":trace"} aria-label={t("执行链路瀑布流", "Request waterfall")}>
        <div className="request-section-heading">
          <h3>{t("执行链路瀑布流", "Request waterfall")}</h3>
          {bottleneck && <span className="request-badge request-bottleneck" data-tone="slow">
            {t("主要耗时", "Bottleneck")} · {phaseLabels[bottleneck.key][zh ? 0 : 1]} · {ms(bottleneck.value)} · {phasePercent(bottleneck.value)}
          </span>}
        </div>
        {trace.partitioned && trace.total! > 0 && <div className="request-phase-bar" aria-label={t("各阶段耗时占比", "Phase duration shares")}>
          {trace.phases.filter(phase => phase.value).map(phase => <span key={phase.key} data-phase={phase.key}
            data-slow={phase.key === "waiting" && phase.value! > 10_000}
            style={{ width: `${phaseShare(phase.value)}%` }}
            title={`${phaseLabels[phase.key][zh ? 0 : 1]} · ${ms(phase.value)} · ${phasePercent(phase.value)}`} />)}
        </div>}
        <dl className="request-phase-legend">
          {trace.phases.map(phase => <div key={phase.key} data-phase={phase.key} data-slow={phase.key === "waiting" && (phase.value ?? 0) > 10_000}>
            <dt><i />{phaseLabels[phase.key][zh ? 0 : 1]}</dt>
            <dd>{ms(phase.value)}{phaseShare(phase.value) !== undefined && <span> · {phasePercent(phase.value)}</span>}</dd>
          </div>)}
        </dl>
        <div className="request-waterfall-controls">
          <span>{t("累计时间", "Elapsed time")} · {ms(trace.horizon)}</span>
          <div role="group" aria-label={t("时间刻度", "Time scale")} className="request-scale">
            <button type="button" aria-pressed={!logarithmic} onClick={() => setLogarithmic(false)}>{t("线性", "Linear")}</button>
            <button type="button" aria-pressed={logarithmic} onClick={() => setLogarithmic(true)}>{t("对数", "Log")}</button>
          </div>
        </div>
        <table className="request-waterfall-table">
          <colgroup><col className="request-node-col" /><col className="request-time-col" /><col className="request-time-col" /><col /></colgroup>
          <thead><tr><th scope="col">{t("节点", "Milestone")}</th><th scope="col" title={t("与上一已记录节点的间隔", "Interval from previous recorded milestone")}>+Δ</th><th scope="col" title={t("从排队开始的累计耗时", "Elapsed from admission")}>@t</th><th scope="col">{t("时间分布", "Timeline")}</th></tr></thead>
          <tbody>{trace.nodes.map(node => {
            const start = tracePosition(node.start, trace.horizon, logarithmic);
            const end = node.at === undefined ? start : tracePosition(node.at, trace.horizon, logarithmic);
            return <tr key={node.key} data-observed={node.at !== undefined} data-longest={node === trace.longestNode} data-phase={node.phase}>
              <th scope="row">{zh ? node.cn : node.en}</th>
              <td>{node.delta ? "+" : ""}{ms(node.delta)}</td>
              <td>{node.at !== undefined && "@"}{ms(node.at)}</td>
              <td><div className="request-waterfall-track">
                {node.at !== undefined && <span data-point={start === end} title={`${ms(node.start)} → ${ms(node.at)}`} style={{ left: `${start}%`, width: `${end - start}%` }} />}
              </div></td>
            </tr>;
          })}</tbody>
        </table>
      </section>
      <RequestRuntimeDetails row={row} zh={zh} />
    </>}
  </div>;
}
