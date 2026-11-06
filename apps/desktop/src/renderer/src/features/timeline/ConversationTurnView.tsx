import { useId, useState, type ComponentProps } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import type { ConversationTurn } from "../../lib/conversation-timeline";
import { TimelineEventView } from "./Timeline";

export function ConversationTurnView({ turn, ...actions }: { turn: ConversationTurn } & Omit<ComponentProps<typeof TimelineEventView>, "event">): JSX.Element {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const regionId = useId();
  const [expansion, setExpansion] = useState({ completed: turn.completed, open: !turn.completed });
  const expanded = expansion.completed === turn.completed ? expansion.open : !turn.completed;
  const stopped = turn.events.some(event => event.data.kind === "activity" && event.data.phase === "stopped");
  const failed = turn.events.some(event => !event.background && event.data.kind === "error");
  const notices = turn.events.filter((event) => event.data.kind === "error" || event.data.kind === "approval" || event.data.kind === "activity" && event.data.phase === "stopped");
  const dispatches = turn.events.filter((event) => event.data.kind === "task_update" || event.data.kind === "tool_activity" && event.data.subagent);
  const process = turn.events.filter((event) => event !== turn.result && !notices.includes(event) && !dispatches.includes(event));
  const author = turn.events.find((event) => event.data.kind === "message" && event.data.sender === "agent");
  const name = author?.data.kind === "message" ? author.data.authorName ?? "Nautilo" : "Nautilo";
  const duration = turn.durationMs === undefined ? undefined : formatDuration(turn.durationMs, zh);
  const status = turn.completed
    ? stopped ? (zh ? "已停止" : "Stopped") : failed ? (zh ? "未完成" : "Failed") : (zh ? "已完成" : "Completed")
    : zh ? "执行中" : "In progress";
  const label = `${status}${turn.completed && duration ? (zh ? `，用时 ${duration}` : ` in ${duration}`) : ""}`;
  const summary = <>
    {!turn.completed && <Loader2 size={13} className="animate-spin" aria-hidden />}
    <span>{label}</span>
    {process.length > 0 && <ChevronDown size={12} className={expanded ? "rotate-180" : undefined} aria-hidden />}
  </>;

  return <article className="conversation-turn" aria-label={name}>
    <header className="conversation-turn-summary">
      {process.length > 0 ?
      <button type="button" className="conversation-process-toggle" aria-expanded={expanded} aria-controls={regionId}
        title={expanded ? (zh ? "收起过程" : "Collapse activity") : (zh ? "展开过程" : "Show activity")}
        onClick={() => setExpansion({ completed: turn.completed, open: !expanded })}>
        {summary}
      </button> : <div className="conversation-process-label">{summary}</div>}
    </header>
    <div id={regionId} className="conversation-turn-body conversation-process">
      {turn.events.map((event) => {
        // Collapse process rows in place. Delegations, notices and the reply
        // keep their chronological slot and React identity across updates.
        const visible = expanded || event === turn.result || notices.includes(event) || dispatches.includes(event);
        return <div key={event.id} hidden={!visible} data-event-kind={event.data.kind} className={event === turn.result ? "conversation-result" : undefined}>
          {visible && <TimelineEventView event={event} {...actions} showAuthor={false} />}
        </div>;
      })}
    </div>
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
