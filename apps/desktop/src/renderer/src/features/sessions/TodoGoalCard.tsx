import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, Circle, ListChecks, Loader2 } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import type { TodoGoalItem } from "../../lib/todo-goal";
import { cn } from "../../lib/utils";

/**
 * Floating summary of the agent's todo list, pinned to the top-right of the
 * chat area. Collapsed it shows overall progress plus the current task;
 * expanded it lists every item. Renders nothing when the agent never used a
 * todo tool in this session.
 */
export function TodoGoalCard({ todos }: { todos: TodoGoalItem[] }): JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const done = todos.filter((item) => item.status === "done").length;
  const current = todos.find((item) => item.status === "in_progress")
    ?? (done < todos.length ? todos.find((item) => item.status === "pending") : undefined);

  return (
    <div className="absolute top-3 right-4 z-10 w-72 max-w-[calc(100%-2rem)] rounded-xl border border-line bg-panel/95 shadow-lg backdrop-blur">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        <ListChecks className="h-4 w-4 shrink-0 text-accent" aria-hidden />
        <span className="shrink-0 text-xs font-semibold text-ink">{t("sessions.todo.goal")}</span>
        <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-semibold text-accent">
          {done}/{todos.length}
        </span>
        {current && <span className="min-w-0 flex-1 truncate text-xs text-ink-3">{current.title}</span>}
        {expanded
          ? <ChevronUp className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
          : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />}
      </button>
      {expanded && (
        <ul className="max-h-60 space-y-1.5 overflow-y-auto border-t border-line px-3 py-2">
          {todos.map((item, index) => (
            <li key={`${index}-${item.title}`} className="flex items-start gap-2 text-xs">
              {item.status === "done"
                ? <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />
                : item.status === "in_progress"
                  ? <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 animate-spin text-accent" aria-hidden />
                  : <Circle className="mt-px h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />}
              <span className={cn("min-w-0 leading-relaxed", item.status === "done" ? "text-ink-3 line-through" : "text-ink-2")}>
                {item.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
