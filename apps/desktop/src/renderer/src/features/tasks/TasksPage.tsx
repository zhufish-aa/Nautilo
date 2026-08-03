import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Workflow } from "lucide-react";
import type { TaskStatus } from "@agenthub/domain";
import { PageHeader } from "../../components/layout/AppShell";
import { EmptyState } from "../../components/ui/EmptyState";
import { StatusChip, type ChipTone } from "../../components/ui/Badge";
import { useI18n } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import type { SessionTask, UiSession } from "../../lib/types";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";

/* ---------------------------------------------------------------------------
 * /tasks — orchestration board. Every orchestration run (a main session that
 * planned tasks) gets a live DAG: spring-in nodes, drawn-in dependency edges,
 * flowing dashes on edges feeding an active task and a breathing glow on the
 * running node. Clicking a node opens the delegated sub-session.
 * ------------------------------------------------------------------------ */

const NODE_W = 210;
const NODE_H = 76;
const GAP_X = 96;
const GAP_Y = 36;

const STATUS_META: Record<TaskStatus, { tone: ChipTone; color: string; active: boolean }> = {
  draft: { tone: "muted", color: "var(--ink-3)", active: false },
  ready: { tone: "muted", color: "var(--ink-3)", active: false },
  queued: { tone: "muted", color: "var(--ink-3)", active: false },
  blocked_dependency: { tone: "warn", color: "var(--warn)", active: false },
  waiting_user: { tone: "warn", color: "var(--warn)", active: false },
  waiting_approval: { tone: "warn", color: "var(--warn)", active: false },
  running: { tone: "accent", color: "var(--accent)", active: true },
  verifying: { tone: "info", color: "var(--info)", active: true },
  review_required: { tone: "info", color: "var(--info)", active: false },
  merge_ready: { tone: "info", color: "var(--info)", active: false },
  completed: { tone: "ok", color: "var(--ok)", active: false },
  failed: { tone: "danger", color: "var(--danger)", active: false },
  cancelled: { tone: "danger", color: "var(--danger)", active: false }
};

/** One orchestration run: the planning (main) session plus its tasks. */
interface RunGroup {
  session: UiSession;
  tasks: SessionTask[];
}

function layoutDag(tasks: SessionTask[]): { x: number; y: number; level: number }[] {
  const levels: number[] = tasks.map(() => 0);
  const indexOf = new Map(tasks.map((task, index) => [task.id, index]));
  let changed = true;
  let guard = 0;
  while (changed && guard < 16) {
    changed = false;
    guard += 1;
    tasks.forEach((task, index) => {
      const level = task.dependencies.length
        ? Math.max(...task.dependencies.map((dep) => (levels[indexOf.get(dep) ?? -1] ?? -1) + 1))
        : 0;
      if (level !== levels[index]) {
        levels[index] = level;
        changed = true;
      }
    });
  }
  const perLevel = new Map<number, number>();
  return tasks.map((_, index) => {
    const level = levels[index]!;
    const row = perLevel.get(level) ?? 0;
    perLevel.set(level, row + 1);
    return { x: 48 + level * (NODE_W + GAP_X), y: 48 + row * (NODE_H + GAP_Y), level };
  });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function DagCanvas({
  group,
  onOpenTask
}: {
  group: RunGroup;
  onOpenTask: (group: RunGroup, task: SessionTask) => void;
}): JSX.Element {
  const { t } = useI18n();
  const { tasks } = group;
  const positions = useMemo(() => layoutDag(tasks), [tasks]);
  const indexOf = useMemo(() => new Map(tasks.map((task, index) => [task.id, index])), [tasks]);
  const maxX = Math.max(0, ...positions.map((pos) => pos.x)) + NODE_W + 48;
  const maxY = Math.max(0, ...positions.map((pos) => pos.y)) + NODE_H + 48;

  return (
    <div className="max-h-[54vh] overflow-auto">
      <svg width={maxX} height={maxY} role="img" aria-label={t("tasksPage.title")} className="mx-auto block">
        <defs>
          <marker id="tasks-dag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink-3)" />
          </marker>
          <marker id="tasks-dag-arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
          </marker>
        </defs>
        {tasks.flatMap((task, index) =>
          task.dependencies.map((dep) => {
            const depIndex = indexOf.get(dep) ?? -1;
            const from = positions[depIndex];
            const to = positions[index];
            if (!from || !to) return null;
            const active = STATUS_META[task.status]?.active ?? false;
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            const midX = (x1 + x2) / 2;
            return (
              <motion.path
                key={`${dep}-${task.id}`}
                d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={active ? "var(--accent)" : "var(--line-strong)"}
                strokeWidth={active ? 2 : 1.5}
                strokeOpacity={active ? 0.9 : 0.8}
                markerEnd={active ? "url(#tasks-dag-arrow-active)" : "url(#tasks-dag-arrow)"}
                className={active ? "dag-edge-flow" : undefined}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 0.55, delay: 0.2 + from.level * 0.12, ease: "easeInOut" }}
              />
            );
          })
        )}
        {tasks.map((task, index) => {
          const pos = positions[index]!;
          const meta = STATUS_META[task.status] ?? STATUS_META.queued;
          const statusText = t(`sessions.taskStatus.${task.status}` as Parameters<typeof t>[0]);
          const subtitle = truncate(`${task.memberName ?? "—"} · ${statusText}`, 24);
          return (
            <motion.g
              key={task.id}
              className="dag-node"
              style={{ cursor: "pointer" }}
              role="button"
              tabIndex={0}
              aria-label={`${task.title} · ${statusText}`}
              onClick={() => onOpenTask(group, task)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenTask(group, task);
                }
              }}
              initial={{ opacity: 0, scale: 0.85, x: pos.x, y: pos.y + 16 }}
              animate={{ opacity: 1, scale: 1, x: pos.x, y: pos.y }}
              transition={{ type: "spring", stiffness: 260, damping: 26, delay: 0.3 + pos.level * 0.12 + index * 0.04 }}
            >
              {meta.active && (
                <motion.rect
                  x={-6}
                  y={-6}
                  width={NODE_W + 12}
                  height={NODE_H + 12}
                  rx={20}
                  fill={meta.color}
                  animate={{ opacity: [0.1, 0.26, 0.1] }}
                  transition={{ duration: 2.4, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}
                />
              )}
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={16}
                fill="var(--card)"
                stroke={meta.color}
                strokeOpacity={meta.active ? 0.85 : 0.35}
                strokeWidth={meta.active ? 1.6 : 1}
              />
              <rect width={4} height={NODE_H} rx={2} fill={meta.color} />
              {meta.active && (
                <motion.circle
                  cx={NODE_W - 18}
                  cy={18}
                  fill={meta.color}
                  animate={{ r: [3.5, 6, 3.5], opacity: [0.9, 0.3, 0.9] }}
                  transition={{ duration: 1.6, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}
                />
              )}
              {!meta.active && <circle cx={NODE_W - 18} cy={18} r={3.5} fill={meta.color} />}
              <text x={18} y={32} fill="var(--ink)" fontSize={13} fontWeight={600}>
                {truncate(task.title, 14)}
              </text>
              <text x={18} y={56} fill="var(--ink-3)" fontSize={11}>
                {subtitle}
              </text>
            </motion.g>
          );
        })}
      </svg>
    </div>
  );
}

export function TasksPage(): JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const sessions = useSessionsStore((state) => state.sessions);
  const tasksBySession = useSessionsStore((state) => state.tasks);
  const projects = useProjectsStore((state) => state.projects);
  const setActiveSession = useSessionsStore((state) => state.setActiveSession);
  const [selectedId, setSelectedId] = useState<string | undefined>();

  const groups = useMemo<RunGroup[]>(
    () =>
      sessions
        .filter((session) => (tasksBySession[session.id]?.length ?? 0) > 0)
        .map((session) => ({ session, tasks: tasksBySession[session.id]! }))
        .sort((a, b) => (b.session.lastMessageAt ?? b.session.updatedAt).localeCompare(a.session.lastMessageAt ?? a.session.updatedAt)),
    [sessions, tasksBySession]
  );
  const group = groups.find((item) => item.session.id === selectedId) ?? groups[0];

  const projectName = (session: UiSession): string =>
    projects.find((item) => item.id === session.projectId)?.name ?? "";

  const openTask = (owner: RunGroup, task: SessionTask): void => {
    const child = sessions.find((item) => item.parentSessionId === owner.session.id && item.taskId === task.id);
    setActiveSession((child ?? owner.session).id);
    navigate("/sessions");
  };

  if (!group) {
    return (
      <>
        <PageHeader title={t("tasksPage.title")} subtitle={t("tasksPage.subtitle")} />
        <EmptyState icon={Workflow} title={t("tasksPage.empty")} description={t("tasksPage.emptyHint")} />
      </>
    );
  }

  const total = group.tasks.length;
  const done = group.tasks.filter((task) => task.status === "completed").length;
  const active = group.tasks.filter((task) => STATUS_META[task.status]?.active).length;
  const failed = group.tasks.filter((task) => task.status === "failed" || task.status === "cancelled").length;

  return (
    <>
      <PageHeader
        title={t("tasksPage.title")}
        subtitle={t("tasksPage.subtitle")}
        actions={
          groups.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2">
              {groups.map((item) => (
                <button
                  key={item.session.id}
                  type="button"
                  onClick={() => setSelectedId(item.session.id)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition-all",
                    item.session.id === group.session.id
                      ? "border-accent/50 bg-accent-soft text-accent shadow-pop"
                      : "border-line bg-card text-ink-3 hover:border-accent/30 hover:text-ink"
                  )}
                >
                  {item.session.title || t("tasksPage.untitled")}
                </button>
              ))}
            </div>
          ) : undefined
        }
      />
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 220, damping: 24 }}
        className="mb-4 flex flex-wrap items-center gap-2.5"
      >
        <StatusChip tone="muted" label={t("tasksPage.statsTotal", { count: total })} />
        <StatusChip tone="accent" pulse={active > 0} label={t("tasksPage.statsActive", { count: active })} />
        <StatusChip tone="ok" label={t("tasksPage.statsDone", { count: done })} />
        {failed > 0 && <StatusChip tone="danger" label={t("tasksPage.statsFailed", { count: failed })} />}
        <div className="flex min-w-40 flex-1 items-center gap-2.5">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line/60">
            <motion.div
              className="h-full rounded-full bg-accent"
              initial={{ width: 0 }}
              animate={{ width: `${total ? (done / total) * 100 : 0}%` }}
              transition={{ type: "spring", stiffness: 120, damping: 22 }}
            />
          </div>
          <span className="shrink-0 text-[11px] font-medium text-ink-3">{t("tasksPage.progress", { done, total })}</span>
        </div>
      </motion.div>

      <motion.section
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 200, damping: 24, delay: 0.08 }}
        className="mb-4 overflow-hidden rounded-2xl border border-line bg-card/60 shadow-card"
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <span className="min-w-0 truncate text-[13px] font-medium text-ink-2">
            {group.session.title || t("tasksPage.untitled")}
            <span className="text-ink-3">{projectName(group.session) ? ` · ${projectName(group.session)}` : ""}</span>
          </span>
          <span className="shrink-0 text-[11px] text-ink-3">{t("tasksPage.clickHint")}</span>
        </header>
        <DagCanvas group={group} onOpenTask={openTask} />
      </motion.section>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {group.tasks.map((task, index) => {
          const meta = STATUS_META[task.status] ?? STATUS_META.queued;
          return (
            <motion.button
              key={task.id}
              type="button"
              onClick={() => openTask(group, task)}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 240, damping: 24, delay: 0.25 + index * 0.05 }}
              className="group flex items-center gap-3 rounded-xl border border-line bg-card px-4 py-3 text-left transition-all hover:border-accent/40 hover:shadow-pop focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
            >
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: meta.color }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{task.title}</span>
                <span className="block truncate text-[11px] text-ink-3">{task.memberName ?? "—"}</span>
              </span>
              <StatusChip
                tone={meta.tone}
                pulse={meta.active}
                label={t(`sessions.taskStatus.${task.status}` as Parameters<typeof t>[0])}
              />
            </motion.button>
          );
        })}
      </div>
    </>
  );
}
