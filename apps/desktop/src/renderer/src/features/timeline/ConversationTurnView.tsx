import { Check, ChevronRight, CircleAlert, Square } from "lucide-react";
import type { TimelineTurn } from "@agenthub/schemas";
import type { TimelineEvent } from "../../lib/types";
import { useI18n } from "../../lib/i18n";

export function isTurnTraceStep(event?: TimelineEvent): boolean {
  const data = event?.data;
  return data?.kind === "reasoning" || data?.kind === "command" || data?.kind === "file_change"
    || (data?.kind === "tool_activity" && !data.subagent);
}

export function ConversationTurnView({ turn, expanded, onToggle }: {
  turn: TimelineTurn;
  expanded: boolean;
  onToggle?: () => void;
}): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const status = turn.status === "running" ? (zh ? "执行中" : "In progress")
    : turn.status === "cancelled" ? (zh ? "已停止" : "Stopped")
    : turn.status === "failed" ? (zh ? "未完成" : "Failed")
    : (zh ? "已完成" : "Completed");
  const duration = turn.durationMs === null ? undefined : formatDuration(turn.durationMs, zh);
  const label = duration ? (zh ? status + "，用时 " + duration : status + " in " + duration) : status;
  const tone = turn.status === "cancelled" ? "stopped" : turn.status;
  const content = <>
    {tone === "running" ? <span className="conversation-wait-orbit" aria-hidden />
      : <span className="conversation-step-icon conversation-turn-indicator" aria-hidden>
        {tone === "completed" ? <Check size={12} /> : tone === "stopped" ? <Square size={10} /> : <CircleAlert size={12} />}
      </span>}
    <span>{label}</span>
  </>;
  return <article className="conversation-turn" data-status={tone}>
    <header className="conversation-turn-summary">
      {onToggle ? (
        <button type="button" className="conversation-process-toggle" aria-expanded={expanded}
          title={expanded ? (zh ? "收起过程" : "Collapse activity") : (zh ? "展开过程" : "Show activity")}
          onClick={onToggle}>
          {content}<ChevronRight size={12} className="conversation-turn-chevron" aria-hidden />
        </button>
      ) : <span className="conversation-process-label">{content}</span>}
    </header>
  </article>;
}

function formatDuration(durationMs: number, zh: boolean): string | undefined {
  if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 1) return zh ? "不到1秒" : "less than 1s";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = seconds % 60;
  return [hours && `${hours}${zh ? "小时" : "h"}`, minutes && `${minutes}${zh ? "分" : "m"}`, rest && `${rest}${zh ? "秒" : "s"}`].filter(Boolean).join(zh ? "" : " ");
}
