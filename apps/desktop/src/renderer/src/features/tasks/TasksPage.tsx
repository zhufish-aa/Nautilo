import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  Circle,
  Loader2,
  Lock,
  Workflow,
  XCircle
} from "lucide-react";
import type { TaskStatus } from "@agenthub/domain";
import { PageHeader } from "../../components/layout/AppShell";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { SelectField } from "../../components/ui/Select";
import { useI18n } from "../../lib/i18n";
import { sessionLocation } from "../../lib/sidebar-navigation";
import { cn, formatRelativeTime } from "../../lib/utils";
import type { SessionTask, UiSession } from "../../lib/types";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import {
  DAG_NODE_WIDTH as NODE_W,
  DAG_NODE_HEIGHT as NODE_H,
  DAG_PADDING,
  layoutDag
} from "./task-layout";

const STATUS_META: Record<TaskStatus, { color: string; active: boolean }> = {
  draft: { color: "var(--ink-3)", active: false },
  ready: { color: "var(--ink-3)", active: false },
  queued: { color: "var(--ink-3)", active: false },
  blocked_dependency: { color: "var(--warn)", active: false },
  waiting_user: { color: "var(--warn)", active: false },
  waiting_approval: { color: "var(--warn)", active: false },
  running: { color: "var(--ink-2)", active: true },
  verifying: { color: "var(--ink-2)", active: true },
  review_required: { color: "var(--ink-3)", active: false },
  merge_ready: { color: "var(--ink-3)", active: false },
  completed: { color: "var(--ok)", active: false },
  failed: { color: "var(--danger)", active: false },
  cancelled: { color: "var(--ink-3)", active: false }
};
function statusIcon(task: SessionTask, className: string): JSX.Element {
  const meta = STATUS_META[task.status] ?? STATUS_META.queued;
  const style = { color: meta.color };
  if (meta.active)
    return (
      <Loader2 className={cn(className, "motion-safe:animate-spin")} style={style} aria-hidden />
    );
  if (task.status === "completed")
    return <CheckCircle2 className={className} style={style} aria-hidden />;
  if (task.status === "failed" || task.status === "cancelled")
    return <XCircle className={className} style={style} aria-hidden />;
  if (task.status === "blocked_dependency")
    return <Lock className={className} style={style} aria-hidden />;
  if (task.status === "waiting_user" || task.status === "waiting_approval")
    return <AlertTriangle className={className} style={style} aria-hidden />;
  return <Circle className={className} style={style} aria-hidden />;
}
interface RunGroup {
  session: UiSession;
  tasks: SessionTask[];
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
  const { locale } = useI18n();
  const { tasks } = group;
  const positions = useMemo(() => layoutDag(tasks), [tasks]);
  const indexOf = useMemo(() => new Map(tasks.map((task, index) => [task.id, index])), [tasks]);
  const maxX = Math.max(0, ...positions.map((pos) => pos.x)) + NODE_W + DAG_PADDING;
  const maxY = Math.max(0, ...positions.map((pos) => pos.y)) + NODE_H + DAG_PADDING;
  return (
    <div
      className="max-h-[440px] overflow-auto rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      tabIndex={0}
      role="region"
      aria-label={locale === "zh-CN" ? "任务依赖图，可滚动" : "Task dependencies, scrollable"}
    >
      <div className="relative mx-auto my-6" style={{ width: maxX, height: maxY }}>
        <svg
          width={maxX}
          height={maxY}
          className="pointer-events-none absolute inset-0"
          aria-hidden
        >
          {tasks.flatMap((task, index) =>
            Array.from(new Set(task.dependencies)).map((dep) => {
              const from = positions[indexOf.get(dep) ?? -1];
              const to = positions[index];
              if (!from || !to || dep === task.id) return null;
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x - 5;
              const y2 = to.y + NODE_H / 2;
              const midX = (x1 + x2) / 2;
              return (
                <g key={`${dep}-${task.id}`}>
                  <path
                    d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke="var(--ink-3)"
                    strokeOpacity="0.6"
                    strokeWidth="1.2"
                  />
                  <path
                    d={`M ${x2 - 4} ${y2 - 4} L ${x2} ${y2} L ${x2 - 4} ${y2 + 4}`}
                    fill="none"
                    stroke="var(--ink-3)"
                    strokeOpacity="0.6"
                    strokeWidth="1.2"
                  />
                </g>
              );
            })
          )}
        </svg>
        {tasks.map((task, index) => (
          <button
            key={task.id}
            type="button"
            onClick={() => onOpenTask(group, task)}
            title={`${task.title} · ${statusText(task)}${task.memberName ? ` · ${task.memberName}` : ""}`}
            aria-label={`${task.title} · ${statusText(task)}`}
            style={{
              left: positions[index]!.x,
              top: positions[index]!.y,
              width: NODE_W,
              height: NODE_H
            }}
            className="absolute flex items-center gap-3 rounded-xl border border-line-strong bg-card px-4 text-left transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {statusIcon(task, "h-4 w-4 shrink-0")}
            <span className="line-clamp-2 text-sm leading-snug text-ink">{task.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function TasksPage(): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const navigate = useNavigate();
  const sessions = useSessionsStore((state) => state.sessions);
  const tasksBySession = useSessionsStore((state) => state.tasks);
  const projects = useProjectsStore((state) => state.projects);
  const setActiveSession = useSessionsStore((state) => state.setActiveSession);
  const [selectedId, setSelectedId] = useState<string>();
  const groups = useMemo<RunGroup[]>(
    () =>
      sessions
        .filter((session) => (tasksBySession[session.id]?.length ?? 0) > 0)
        .map((session) => ({ session, tasks: tasksBySession[session.id]! }))
        .sort((a, b) =>
          (b.session.lastMessageAt ?? b.session.updatedAt).localeCompare(
            a.session.lastMessageAt ?? a.session.updatedAt
          )
        ),
    [sessions, tasksBySession]
  );
  const group = groups.find((item) => item.session.id === selectedId) ?? groups[0];
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  );
  const statusText = (task: SessionTask): string =>
    t(`sessions.taskStatus.${task.status}` as Parameters<typeof t>[0]);
  const openTask = (owner: RunGroup, task: SessionTask): void => {
    const child = sessions.find(
      (item) => item.parentSessionId === owner.session.id && item.taskId === task.id
    );
    setActiveSession((child ?? owner.session).id);
    navigate(sessionLocation(child ?? owner.session));
  };
  const total = group?.tasks.length ?? 0;
  const done = group?.tasks.filter((task) => task.status === "completed").length ?? 0;
  const active = group?.tasks.filter((task) => STATUS_META[task.status]?.active).length ?? 0;
  const failed =
    group?.tasks.filter((task) => task.status === "failed" || task.status === "cancelled").length ??
    0;
  return (
    <div className="mx-auto max-w-5xl py-3 sm:py-6">
      <PageHeader title={t("tasksPage.title")} />
      {!group ? (
        <EmptyState
          icon={Workflow}
          title={t("tasksPage.empty")}
          description={t("tasksPage.emptyHint")}
        />
      ) : (
        <>
          <div className="mt-8 mb-7 flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="shrink-0 text-sm text-ink-3">{zh ? "会话" : "Conversation"}</span>
              <div className="w-72 max-w-[60vw]">
                <SelectField
                  value={group.session.id}
                  onValueChange={setSelectedId}
                  aria-label={zh ? "选择任务会话" : "Choose task conversation"}
                  options={groups.map((item) => ({
                    value: item.session.id,
                    label: item.session.title || t("tasksPage.untitled"),
                    hint: [
                      projectNames.get(item.session.projectId),
                      formatRelativeTime(
                        item.session.lastMessageAt ?? item.session.updatedAt,
                        locale
                      )
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  }))}
                />
              </div>
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setActiveSession(group.session.id);
                navigate(sessionLocation(group.session));
              }}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              {zh ? "返回会话" : "Open conversation"}
            </Button>
          </div>
          <dl className="grid grid-cols-2 gap-y-4 border-t border-line py-5 sm:grid-cols-4">
            {[
              { label: zh ? "全部" : "Total", value: total },
              { label: zh ? "进行中" : "Active", value: active },
              { label: zh ? "已完成" : "Completed", value: done },
              { label: zh ? "待处理" : "Pending", value: total - done - active - failed }
            ].map((stat) => (
              <div
                key={stat.label}
                className="flex items-baseline gap-3 border-line px-4 first:pl-0 sm:border-l sm:first:border-0"
              >
                <dd className="text-xl tabular-nums text-ink">{stat.value}</dd>
                <dt className="text-sm text-ink-3">{stat.label}</dt>
              </div>
            ))}
          </dl>
          {failed > 0 && (
            <p role="status" className="flex items-center gap-2 text-sm text-danger">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              {t("tasksPage.statsFailed", { count: failed })}
            </p>
          )}
          <DagCanvas group={group} statusText={statusText} onOpenTask={openTask} />
          <div className="mt-7">
            <div
              className="grid grid-cols-[minmax(0,1fr)_120px] gap-5 border-b border-line py-3 text-sm text-ink-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_160px]"
              aria-hidden
            >
              <span>{zh ? "任务" : "Task"}</span>
              <span className="hidden sm:block">{zh ? "成员" : "Member"}</span>
              <span>{zh ? "状态" : "Status"}</span>
            </div>
            <ul className="divide-y divide-line border-b border-line">
              {group.tasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={() => openTask(group, task)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_120px] items-center gap-5 rounded-lg py-4 text-left transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_160px]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium" title={task.title}>
                        {task.title}
                      </span>
                      <span className="mt-1 block text-sm text-ink-3 sm:hidden">
                        {task.memberName || "—"}
                      </span>
                    </span>
                    <span className="hidden min-w-0 items-center gap-2 text-sm text-ink-3 sm:flex">
                      <Bot className="h-4 w-4 shrink-0" aria-hidden />
                      <span className="truncate">{task.memberName || "—"}</span>
                    </span>
                    <span className="flex items-center gap-2 text-sm text-ink-2">
                      {statusIcon(task, "h-4 w-4 shrink-0")}
                      {statusText(task)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
