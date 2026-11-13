import { useCallback, useEffect, useRef, useState } from "react";
import { Clock3, RefreshCw, Search } from "lucide-react";
import type { RequestLogPage } from "@agenthub/schemas";
import { requestCore } from "../../lib/bridge";
import { useI18n } from "../../lib/i18n";
import { useSurfaceEntrance } from "../../lib/ui-motion";
import { RequestLogRow } from "./RequestLogRow";
import { requestLogErrorMessage, statusLabel } from "./request-log-display";
import "./request-logs.css";

export function RequestLogsPanel({
  sessionId,
}: {
  sessionId?: string;
}): JSX.Element {
  const zh = useI18n().locale === "zh-CN",
    ref = useSurfaceEntrance<HTMLDivElement>(sessionId);
  const [page, setPage] = useState<RequestLogPage>({ items: [] }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [query, setQuery] = useState("");
  const generation = useRef(0);
  const load = useCallback(
    async (before?: string) => {
      const version = ++generation.current;
      setBusy(true);
      setError("");
      try {
        const result = await requestCore<RequestLogPage>("requestLog.list", {
          sessionId,
          status: status || undefined,
          before,
          limit: 40,
        });
        if (version === generation.current)
          setPage((previous) =>
            before
              ? { ...result, items: [...previous.items, ...result.items] }
              : result,
          );
      } catch (e) {
        if (version === generation.current) setError(requestLogErrorMessage(e, zh));
      } finally {
        if (version === generation.current) setBusy(false);
      }
    },
    [sessionId, status, zh],
  );
  useEffect(() => {
    setPage({ items: [] });
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const rows = page.items.filter((row) =>
    `${row.providerId} ${row.model ?? ""} ${row.id} ${row.failure?.code ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="request-logs" ref={ref}>
      <div className="request-log-toolbar">
        <label>
          <Search size={15} />
          <input
            aria-label={zh ? "筛选请求" : "Filter requests"}
            placeholder={
              zh ? "模型、Harness 或请求 ID" : "Model, harness or request ID"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label={zh ? "请求状态" : "Request status"}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">{zh ? "全部状态" : "All statuses"}</option>
          {Object.entries(statusLabel).map(([key, label]) => (
            <option key={key} value={key}>
              {label[zh ? 0 : 1]}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
          {zh ? "刷新" : "Refresh"}
        </button>
      </div>
      {error && (
        <div className="request-log-notice" role="alert">
          {error}
        </div>
      )}
      <div className="request-log-table">
        <div className="request-log-columns">
          <span>{zh ? "请求" : "Request"}</span>
          <span>{zh ? "首段正文" : "First text"}</span>
          <span>{zh ? "总耗时" : "Total"}</span>
          <span>{zh ? "状态" : "Status"}</span>
        </div>
        {rows.map((row) => (
          <RequestLogRow key={row.id} row={row} zh={zh} />
        ))}
        {!rows.length && !busy && !error && (
          <div className="request-log-empty">
            <Clock3 size={22} />
            <span>{zh ? "暂无匹配的请求记录" : "No matching requests"}</span>
          </div>
        )}
        {error && !page.items.length && <div className="request-log-empty" role="status">
          {zh ? "请求日志未能加载" : "Request logs could not be loaded"}
        </div>}
        {busy && !page.items.length && (
          <div className="request-log-empty" role="status">
            {zh ? "正在读取请求日志" : "Loading request logs"}
          </div>
        )}
      </div>
      {page.nextCursor && (
        <button
          className="request-log-more"
          disabled={busy}
          onClick={() => void load(page.nextCursor)}
        >
          {zh ? "加载更多" : "Load more"}
        </button>
      )}
    </div>
  );
}
