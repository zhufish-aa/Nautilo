import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, Circle, ListChecks, Loader2, X } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import type { TodoGoalItem } from "../../lib/todo-goal";
import { cn } from "../../lib/utils";

/**
 * Floating summary of the agent's todo list, pinned to the top-right of the
 * chat area. Collapsed it shows overall progress plus the current task;
 * expanded it lists every item. Renders nothing when the agent never used a
 * todo tool in this session.
 */
export function TodoGoalCard({ todos, onClose }: { todos: TodoGoalItem[]; onClose(): void }): JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const done = todos.filter((item) => item.status === "done").length;
  const current = todos.find((item) => item.status === "in_progress")
    ?? (done < todos.length ? todos.find((item) => item.status === "pending") : undefined);

  return (
    <section aria-label={t("sessions.workspace.goals")} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    }} className="absolute right-4 top-2 z-10 w-72 max-w-[calc(100%-2rem)] rounded-xl border border-line bg-card shadow-card">
      <div className="flex items-center gap-1 p-1">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-card-hover focus-visible:outline-2 focus-visible:outline-accent">
          <ListChecks className="h-4 w-4 shrink-0 text-ink-2" aria-hidden />
          <span className="shrink-0 text-sm font-medium text-ink">{t("sessions.todo.goal")}</span>
          <span className="shrink-0 px-1.5 text-xs tabular-nums text-ink-3">{done}/{todos.length}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-ink-3">{!expanded && current?.title}</span>
          {expanded
            ? <ChevronUp className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
            : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />}
        </button>
        <button type="button" onClick={onClose} className="workspace-panel-icon" aria-label={t("sessions.workspace.closeGoals")} title={t("sessions.workspace.closeGoals")}>
          <X size={14} aria-hidden />
        </button>
      </div>
      {expanded && (
        <ul className="max-h-60 space-y-1.5 overflow-y-auto border-t border-line px-3 py-2">
          {todos.map((item, index) => (
            <li key={`${index}-${item.title}`} className="flex items-start gap-2 text-sm">
              {item.status === "done"
                ? <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />
                : item.status === "in_progress"
                  ? <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 animate-spin text-ink-2" aria-hidden />
                  : <Circle className="mt-px h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />}
              <span className={cn("min-w-0 leading-relaxed", item.status === "done" ? "text-ink-3 line-through" : "text-ink-2")}>
                {item.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
