import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Circle, Loader2, Lock, Workflow, XCircle } from "lucide-react";
import type { TaskStatus } from "@agenthub/domain";
import { PageHeader } from "../../components/layout/AppShell";
import { EmptyState } from "../../components/ui/EmptyState";
import { SelectField } from "../../components/ui/Select";
import { useI18n } from "../../lib/i18n";
import { cn, formatRelativeTime } from "../../lib/utils";
import type { SessionTask, UiSession } from "../../lib/types";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";

/* ---------------------------------------------------------------------------
 * /tasks — orchestration stage. Every run (a main session that planned tasks)
 * gets a live DAG on a dotted stage: gradient dependency edges that flow when
 * feeding an active task, glass nodes with a rotating conic border while
 * running, STAGE column markers, and a side rail with a progress ring.
 * ------------------------------------------------------------------------ */

const NODE_W = 232;
const NODE_H = 96;
const GAP_X = 110;
const GAP_Y = 40;
const PAD_X = 56;
const PAD_TOP = 64;
const PAD_BOTTOM = 48;

const STATUS_META: Record<TaskStatus, { tone: "ok" | "warn" | "danger" | "info" | "muted" | "accent"; color: string; active: boolean }> = {
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

function statusIcon(task: SessionTask, className: string): JSX.Element {
  const meta = STATUS_META[task.status] ?? STATUS_META.queued;
  const style = { color: meta.color };
  if (meta.active) return <Loader2 className={cn(className, "animate-spin")} style={style} aria-hidden />;
  if (task.status === "completed") return <CheckCircle2 className={className} style={style} aria-hidden />;
  if (task.status === "failed" || task.status === "cancelled") return <XCircle className={className} style={style} aria-hidden />;
  if (task.status === "blocked_dependency") return <Lock className={className} style={style} aria-hidden />;
  if (task.status === "waiting_user" || task.status === "waiting_approval") return <AlertTriangle className={className} style={style} aria-hidden />;
  return <Circle className={className} style={style} aria-hidden />;
}

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
    return { x: PAD_X + level * (NODE_W + GAP_X), y: PAD_TOP + row * (NODE_H + GAP_Y), level };
  });
}

function DagCanvas({
  group,
  statusText,
  onOpenTask
}: {
  group: RunGroup;
  statusText: (task: SessionTask) => string;
  onOpenTask: (group: RunGroup, task: SessionTask) => void;
}): JSX.Element {
  const { t } = useI18n();
  const { tasks } = group;
  const positions = useMemo(() => layoutDag(tasks), [tasks]);
  const indexOf = useMemo(() => new Map(tasks.map((task, index) => [task.id, index])), [tasks]);
  const levels = useMemo(() => [...new Set(positions.map((pos) => pos.level))].sort((a, b) => a - b), [positions]);
  const maxX = Math.max(0, ...positions.map((pos) => pos.x)) + NODE_W + PAD_X;
  const maxY = Math.max(0, ...positions.map((pos) => pos.y)) + NODE_H + PAD_BOTTOM;

  return (
    <div className="max-h-[58vh] overflow-auto">
      <div className="flex min-h-[420px] w-max min-w-full items-center justify-center">
        <svg width={maxX} height={maxY} role="img" aria-label={t("tasksPage.title")} className="shrink-0">
          <defs>
            {tasks.flatMap((task, index) =>
              task.dependencies.map((dep) => {
                const depTask = tasks[indexOf.get(dep) ?? -1];
                if (!depTask) return null;
                const fromColor = (STATUS_META[depTask.status] ?? STATUS_META.queued).color;
                const toColor = (STATUS_META[task.status] ?? STATUS_META.queued).color;
                return (
                  <linearGradient key={`eg-${dep}-${task.id}`} id={`eg-${dep}-${task.id}`} gradientUnits="userSpaceOnUse"
                    x1={positions[indexOf.get(dep)!]!.x + NODE_W} y1={0} x2={positions[index]!.x} y2={0}>
                    <stop offset="0" style={{ stopColor: fromColor }} />
                    <stop offset="1" style={{ stopColor: toColor }} />
                  </linearGradient>
                );
              })
            )}
          </defs>

          {/* STAGE column markers */}
          {levels.map((level) => (
            <motion.text
              key={level}
              x={PAD_X + level * (NODE_W + GAP_X)}
              y={30}
              fontSize={10}
              fontWeight={700}
              fill="var(--ink-3)"
              opacity={0.65}
              style={{ letterSpacing: "0.22em" }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.65 }}
              transition={{ delay: 0.15 + level * 0.1 }}
            >
              {`STAGE ${String(level + 1).padStart(2, "0")}`}
            </motion.text>
          ))}

          {/* dependency edges */}
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
                  stroke={`url(#eg-${dep}-${task.id})`}
                  strokeWidth={active ? 2.2 : 1.4}
                  strokeOpacity={active ? 0.95 : 0.45}
                  className={active ? "dag-edge-flow" : undefined}
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ duration: 0.4, delay: 0.25 + from.level * 0.14, ease: "easeInOut" }}
                />
              );
            })
          )}

          {/* nodes */}
          {tasks.map((task, index) => {
            const pos = positions[index]!;
            const meta = STATUS_META[task.status] ?? STATUS_META.queued;
            return (
              <motion.g
                key={task.id}
                style={{ cursor: "pointer" }}
                role="button"
                tabIndex={0}
                aria-label={`${task.title} · ${statusText(task)}`}
                onClick={() => onOpenTask(group, task)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpenTask(group, task);
                  }
                }}
                initial={{ opacity: 0, scale: 0.85, x: pos.x, y: pos.y + 18 }}
                animate={{ opacity: 1, scale: 1, x: pos.x, y: pos.y }}
                transition={{ type: "spring", stiffness: 240, damping: 31, delay: 0.35 + pos.level * 0.14 + index * 0.04 }}
              >
                <foreignObject width={NODE_W} height={NODE_H}>
                  <div
                    className={cn(
                      "dag-node flex h-full w-full flex-col rounded-2xl border bg-card/85 px-3.5 py-2.5 shadow-card backdrop-blur-sm transition-[border-color,box-shadow]",
                      meta.active
                        ? "run-border run-border-active border-accent/40"
                        : "border-line hover:border-accent/35 hover:shadow-pop"
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      {statusIcon(task, "h-3 w-3 shrink-0")}
                      <span className="text-[10px] font-semibold tracking-wider" style={{ color: meta.color }}>
                        {statusText(task)}
                      </span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug font-semibold text-ink">{task.title}</div>
                    <div className="mt-auto truncate text-[10.5px] text-ink-3">{task.memberName ?? "—"}</div>
                  </div>
                </foreignObject>
              </motion.g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function ProgressRing({ done, total }: { done: number; total: number }): JSX.Element {
  const R = 26;
  const C = 2 * Math.PI * R;
  const pct = total ? done / total : 0;
  return (
    <div className="relative h-16 w-16">
      <svg width={64} height={64} viewBox="0 0 64 64">
        <circle cx={32} cy={32} r={R} fill="none" stroke="var(--line)" strokeWidth={5} />
        <motion.circle
          cx={32}
          cy={32}
          r={R}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray={C}
          transform="rotate(-90 32 32)"
          initial={{ strokeDashoffset: C }}
          animate={{ strokeDashoffset: C * (1 - pct) }}
          transition={{ type: "spring", stiffness: 60, damping: 20 }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[13px] font-bold tabular-nums text-ink">
        {done}/{total}
      </span>
    </div>
  );
}

export function TasksPage(): JSX.Element {
  const { t, locale } = useI18n();
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

  const statusText = (task: SessionTask): string =>
    t(`sessions.taskStatus.${task.status}` as Parameters<typeof t>[0]);

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
            <div className="w-72">
              <SelectField
                value={group.session.id}
                onValueChange={setSelectedId}
                aria-label={t("tasksPage.title")}
                options={groups.map((item) => ({
                  value: item.session.id,
                  label: item.session.title || t("tasksPage.untitled"),
                  hint: `${projectName(item.session)} · ${t("tasksPage.statsTotal", { count: item.tasks.length })} · ${formatRelativeTime(item.session.lastMessageAt ?? item.session.updatedAt, locale)}`
                }))}
              />
            </div>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        {/* stage */}
        <motion.section
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 200, damping: 28, delay: 0.06 }}
          className="overflow-hidden rounded-2xl border border-line bg-card/60 shadow-card"
        >
          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <span className="min-w-0 truncate text-[13px] font-medium text-ink-2">
              {group.session.title || t("tasksPage.untitled")}
              <span className="text-ink-3">{projectName(group.session) ? ` · ${projectName(group.session)}` : ""}</span>
            </span>
            <span className="shrink-0 text-[11px] text-ink-3">{t("tasksPage.clickHint")}</span>
          </header>
          <div
            className="dag-stage"
            style={{
              backgroundImage: "radial-gradient(var(--grid-line) 1px, transparent 1px)",
              backgroundSize: "22px 22px"
            }}
          >
            <DagCanvas group={group} statusText={statusText} onOpenTask={openTask} />
          </div>
        </motion.section>

        {/* rail */}
        <motion.aside
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 200, damping: 28, delay: 0.14 }}
          className="flex flex-col overflow-hidden rounded-2xl border border-line bg-card/60 shadow-card"
        >
          <header className="flex items-center gap-3 border-b border-line px-4 py-3">
            <ProgressRing done={done} total={total} />
            <div className="min-w-0">
              <p className="text-[10px] font-bold tracking-[0.18em] text-ink-3 uppercase">{t("tasksPage.railTitle")}</p>
              <p className="mt-1 text-xs text-ink-2">
                {t("tasksPage.statsActive", { count: active })}
                {failed > 0 ? ` · ${t("tasksPage.statsFailed", { count: failed })}` : ""}
              </p>
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
            {group.tasks.map((task, index) => {
              const meta = STATUS_META[task.status] ?? STATUS_META.queued;
              return (
                <motion.button
                  key={task.id}
                  type="button"
                  onClick={() => openTask(group, task)}
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ type: "spring", stiffness: 240, damping: 31, delay: 0.3 + index * 0.05 }}
                  className="group flex items-center gap-2.5 rounded-xl border border-line bg-card px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow] hover:border-accent/40 hover:shadow-pop focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
                >
                  {statusIcon(task, "h-3.5 w-3.5 shrink-0")}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-ink">{task.title}</span>
                    <span className="block truncate text-[10.5px] text-ink-3">{task.memberName ?? "—"}</span>
                  </span>
                  <span
                    aria-hidden
                    className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.active && "motion-safe:animate-pulse")}
                    style={{ background: meta.color }}
                  />
                </motion.button>
              );
            })}
          </div>
        </motion.aside>
      </div>
    </>
  );
}
