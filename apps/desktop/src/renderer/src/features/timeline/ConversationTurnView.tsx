import { useId, useState, type ComponentProps } from "react";
import { Check, ChevronRight, CircleAlert, Square } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import type { ConversationTurn } from "../../lib/conversation-timeline";
import { TimelineEventView } from "./Timeline";
import { workflowTool } from "./WorkflowToolActivity";

/** Important interactions and the answer keep their slot when process rows fold. */
export function turnEventAlwaysVisible(turn: ConversationTurn, event: ConversationTurn["events"][number]): boolean {
  const data = event.data;
  return event === turn.result || data.kind === "error" || data.kind === "approval" || data.kind === "workflow_plan" ||
    data.kind === "task_update" || data.kind === "tool_activity" && !!data.subagent ||
    data.kind === "activity" && data.phase === "stopped";
}

export function isTurnTraceStep(event?: ConversationTurn["events"][number]): boolean {
  const data = event?.data;
  return data?.kind === "reasoning" || data?.kind === "command" || data?.kind === "file_change"
    || (data?.kind === "tool_activity" && !data.subagent && (data.toolName === "run_code" || !!data.codeExecution || !!workflowTool(data.toolName)));
}

export function ConversationTurnView({ turn, summaryOnly = false, expanded: controlledExpanded, onToggle, ...actions }: {
  turn: ConversationTurn; summaryOnly?: boolean; expanded?: boolean; onToggle?: () => void;
} & Omit<ComponentProps<typeof TimelineEventView>, "event">): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const regionId = useId();
  const [expansion, setExpansion] = useState({ completed: turn.completed, open: !turn.completed });
  const expanded = controlledExpanded ?? (expansion.completed === turn.completed ? expansion.open : !turn.completed);
  const stopped = turn.events.some(event => event.data.kind === "activity" && event.data.phase === "stopped");
  const failed = turn.events.some(event => !event.background && event.data.kind === "error");
  const process = turn.events.filter((event) => !turnEventAlwaysVisible(turn, event));
  const author = turn.events.find((event) => event.data.kind === "message" && event.data.sender === "agent");
  const name = author?.data.kind === "message" ? author.data.authorName ?? "Nautilo" : "Nautilo";
  const duration = turn.durationMs === undefined ? undefined : formatDuration(turn.durationMs, zh);
  const status = turn.completed
    ? stopped ? (zh ? "已停止" : "Stopped") : failed ? (zh ? "未完成" : "Failed") : (zh ? "已完成" : "Completed")
    : zh ? "执行中" : "In progress";
  const label = `${status}${turn.completed && duration ? (zh ? `，用时 ${duration}` : ` in ${duration}`) : ""}`;
  const tone = !turn.completed ? "running" : stopped ? "stopped" : failed ? "failed" : "completed";
  const summary = <>
    {tone === "running" ? <span className="conversation-wait-orbit" aria-hidden /> :
      <span className="conversation-step-icon conversation-turn-indicator" aria-hidden>
        {tone === "completed" ? <Check size={12} strokeWidth={2.2} /> : tone === "stopped" ? <Square size={10} /> : <CircleAlert size={12} />}
      </span>}
    {tone === "running" ? <span className="conversation-wait-label">
      {label}<span className="conversation-wait-sheen" data-label={label} aria-hidden />
    </span> : <span>{label}</span>}
    {process.length > 0 && <ChevronRight size={12} className="conversation-turn-chevron" aria-hidden />}
  </>;

  return <article className="conversation-turn" aria-label={name} data-status={tone}>
    <header className="conversation-turn-summary">
      {process.length > 0 ?
      <button type="button" className="conversation-process-toggle" aria-expanded={expanded} aria-controls={summaryOnly ? undefined : regionId}
        title={expanded ? (zh ? "收起过程" : "Collapse activity") : (zh ? "展开过程" : "Show activity")}
        onClick={onToggle ?? (() => setExpansion({ completed: turn.completed, open: !expanded }))}>
        {summary}
      </button> : <div className="conversation-process-label">{summary}</div>}
    </header>
    {!summaryOnly && <div id={regionId} className="conversation-turn-body conversation-process">
      {turn.events.map((event, index) => {
        // Collapse process rows in place. Delegations, notices and the reply
        // keep their chronological slot and React identity across updates.
        const visible = expanded || turnEventAlwaysVisible(turn, event);
        const trace = expanded && isTurnTraceStep(event);
        return <div key={event.id} hidden={!visible} data-event-kind={event.data.kind}
          className={event === turn.result ? "conversation-result" : trace ? "conversation-process-row" : undefined}
          data-trace-step={trace || undefined}
          data-trace-prev={trace && isTurnTraceStep(turn.events[index - 1]) || undefined}
          data-trace-next={trace && isTurnTraceStep(turn.events[index + 1]) || undefined}>
          {visible && <TimelineEventView event={event} {...actions} showAuthor={false} />}
        </div>;
      })}
    </div>}
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
