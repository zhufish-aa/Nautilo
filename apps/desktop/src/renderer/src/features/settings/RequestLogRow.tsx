import { Snowflake, Zap } from "lucide-react";
import { memo } from "react";
import type { RequestLog } from "@agenthub/schemas";
import { duration, liveRequest, ms, statusLabel, ttftTone } from "./request-log-display";
import { harnessName } from "./UsageCharts";

export const RequestLogRow = memo(function RequestLogRow({ row, title, selected, maximum, zh, onSelect }: {
  row: RequestLog;
  title: string;
  selected: boolean;
  maximum?: number;
  zh: boolean;
  onSelect: (id: string) => void;
}) {
  const first = row.milestones.firstText;
  const reused = row.runtime?.reused;
  const status = statusLabel[row.status]?.[zh ? 0 : 1] ?? row.status;
  const time = new Date(row.createdAt).toLocaleString(zh ? "zh-CN" : "en-GB", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  return <button type="button" className="request-log-row" data-request-id={row.id} data-state={row.status}
    data-live={liveRequest(row)} aria-pressed={selected} tabIndex={selected ? 0 : -1} onClick={() => onSelect(row.id)}>
    <span className="request-log-row-top">
      <i className="request-status-dot" role="img" aria-label={status} title={status} />
      <strong title={title}>{title}</strong>
      <span className="request-log-total" title={ms(row.milestones.ended)}>{duration(row.milestones.ended)}</span>
    </span>
    <span className="request-log-row-context">
      <span title={[row.providerId, row.model].filter(Boolean).join(" · ")}>
        {[harnessName(row.providerId), row.model].filter(Boolean).join(" · ")}
      </span>
      {typeof reused === "boolean" && <span className="request-badge" data-tone={reused ? "good" : "slow"}>
        {reused ? <Zap size={10} /> : <Snowflake size={10} />}{reused ? (zh ? "复用" : "Reused") : (zh ? "冷启动" : "Cold start")}
      </span>}
    </span>
    <span className="request-log-row-metrics">
      <span className="request-ttft" data-tone={ttftTone(first)}>
        {zh ? "首字" : "TTFT"} <b>{ms(first)}</b>
        {typeof first === "number" && <span className="request-mini-track" title={zh ? "相对于筛选结果中的最长首字延迟" : "Relative to the slowest matching first text"} aria-hidden>
          <i style={{ transform: `scaleX(${maximum ? first / maximum : 0})` }} />
        </span>}
      </span>
      <time dateTime={row.createdAt} title={new Date(row.createdAt).toLocaleString()}>{time}</time>
    </span>
  </button>;
});
