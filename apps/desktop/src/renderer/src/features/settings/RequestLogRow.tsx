import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, Check, ChevronDown, Wrench } from "lucide-react";
import { Link } from "react-router-dom";
import type { RequestLog } from "@agenthub/schemas";
import { UI_EASE_OUT, useUiReducedMotion } from "../../lib/ui-motion";
import { useSessionsStore } from "../../stores/sessions";
import { useConnectionsStore } from "../../stores/connections";
import { sessionErrorPresentation } from "../../lib/session-error-presentation";
import { ms, stages, statusLabel } from "./request-log-display";

export function RequestLogRow({
  row,
  zh,
}: {
  row: RequestLog;
  zh: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false),
    reduced = useUiReducedMotion();
  const title = useSessionsStore(
    (s) => s.sessions.find((v) => v.id === row.sessionId)?.title,
  );
  const connection = useConnectionsStore(state => state.connections.find(item => item.id === row.connectionId));
  const failure = row.failure && sessionErrorPresentation(row.failure.code ?? "", row.failure.message, zh, connection);
  const opening = row.runtime?.startupTimings?.openDetails;
  return (
    <article className="request-log-row" data-state={row.status}>
      <button
        className="request-log-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="request-log-identity">
          <strong>{row.model || row.providerId}</strong>
          <span>
            {row.providerId} ·{" "}
            {new Date(row.createdAt).toLocaleString(zh ? "zh-CN" : "en-US", {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        </span>
        <span>{ms(row.milestones.firstText)}</span>
        <span>{ms(row.milestones.ended)}</span>
        <span className="request-log-state">
          <i />
          {statusLabel[row.status]?.[zh ? 0 : 1] ?? row.status}
          <ChevronDown
            size={14}
            style={{ transform: open ? "rotate(180deg)" : undefined }}
          />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="details"
            className="request-log-details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.24, ease: UI_EASE_OUT }}
          >
            <div className="request-log-detail-body">
              <div className="request-log-meta">
                <Link to={`/sessions/${row.sessionId}`}>
                  {title || row.sessionId}
                  <ArrowUpRight size={14} />
                </Link>
                <span title={row.id}>ID {row.id}</span>
                {row.runtime && (
                  <span>
                    {row.runtime.reused === true
                      ? zh
                        ? "复用原生进程"
                        : "Native process reused"
                      : row.runtime.reused === false
                        ? zh
                          ? "新建原生进程"
                          : "New native process"
                        : ""}
                    {row.runtime.attachMs !== undefined &&
                      ` · ${ms(row.runtime.attachMs)}`}
                  </span>
                )}
              </div>
              {row.runtime?.startupTimings && <div className="request-log-meta">
                <span>{zh ? "运行配置准备" : "Runtime preparation"} · {ms(row.runtime.startupTimings.prepareMs)}</span>
                <span>{zh ? "加载原生运行环境" : "Native runtime loading"} · {ms(row.runtime.startupTimings.bootstrapMs)}</span>
                <span>{zh ? "打开原生会话" : "Native session opening"} · {ms(row.runtime.startupTimings.sessionOpenMs)}</span>
              </div>}
              {opening && <div className="request-log-meta">
                {opening.loaderWaitMs !== undefined && <span title={opening.pendingPlugins?.join("\n")}>
                  {zh ? "等待原生插件就绪" : "Waiting for native plugins"} · {ms(opening.loaderWaitMs)}
                </span>}
                {opening.providerUpdateMs !== undefined && <span>
                  {zh ? "绑定连接" : "Connection binding"} · {ms(opening.providerUpdateMs)}
                </span>}
                <span>{zh ? "创建会话" : "Session creation"} · {ms(opening.sessionCreateMs)}</span>
                <span>{zh ? "恢复 Agent" : "Agent attachment"} · {ms(opening.agentResolveMs)}</span>
                <span>{zh ? "应用会话选项" : "Session options"} · {ms(opening.preferencesMs)}</span>
              </div>}
              <ol className="request-stage-list">
                {stages.map(([key, cn, en]) => (
                  <li
                    key={key}
                    data-observed={row.milestones[key] !== undefined}
                  >
                    <span className="request-stage-dot">
                      {row.milestones[key] !== undefined && <Check size={10} />}
                    </span>
                    <span>{zh ? cn : en}</span>
                    <strong>{ms(row.milestones[key])}</strong>
                  </li>
                ))}
              </ol>
              {row.failure && (
                <div className="request-log-failure">
                  <strong>
                    {failure?.loginRequired ? failure.title : row.failure.stage}
                    {!failure?.loginRequired && row.failure.code && ` · ${row.failure.code}`}
                  </strong>
                  <span>{failure?.loginRequired ? failure.description : row.failure.message}</span>
                  {failure?.loginRequired && <Link to={`/settings?section=accounts${row.connectionId ? `&connection=${encodeURIComponent(row.connectionId)}` : ""}`}>
                    {zh ? "重新登录" : "Sign in again"} <ArrowUpRight size={14}/>
                  </Link>}
                </div>
              )}
              <details className="request-log-tools">
                <summary>
                  <Wrench size={14} />
                  {zh ? "工具与连接" : "Tools and connection"}
                </summary>
                <dl>
                  <dt>{zh ? "连接版本" : "Connection revision"}</dt>
                  <dd>
                    {row.connectionId
                      ? `${row.connectionId} / ${row.connectionRevision ?? "—"}`
                      : zh
                        ? "原生配置"
                        : "Native configuration"}
                  </dd>
                  <dt>{zh ? "实际调用" : "Observed calls"}</dt>
                  <dd>{row.observedTools.join(" · ") || "—"}</dd>
                  <dt>{zh ? "原生报告" : "Native reported"}</dt>
                  <dd>{row.nativeTools?.join(" · ") ?? "—"}</dd>
                  <dt>{zh ? "Nautilo 传入" : "Nautilo supplied"}</dt>
                  <dd>{row.suppliedTools.join(" · ") || "—"}</dd>
                </dl>
              </details>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}
