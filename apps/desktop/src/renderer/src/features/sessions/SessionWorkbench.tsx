import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ClipboardList, ChevronDown, GitFork, FileDiff, Package, SquareTerminal } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { TimelineEventView, TimelineViewport } from "../timeline/Timeline";
import { StatusChip } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Composer } from "./Composer";
import { QueuedFollowUpBar } from "./QueuedFollowUpBar";
import { ArtifactsDrawer, DagDrawer, SubagentDrawer, TerminalDrawer } from "./Drawers";
import { RunActivityIndicator } from "./RunActivityIndicator";
import { sessionTargetName } from "./SessionListPanel";
import { useSessionsStore } from "../../stores/sessions";
import { InteractionCards } from "./InteractionCards";
import { useFilePreviewStore } from "../../stores/file-preview";
import { useProjectsStore } from "../../stores/projects";
import { useTeamsStore } from "../../stores/teams";
import { useAgentsStore } from "../../stores/agents";
import { hasRunningDelegatedTask, isActiveLifecycle, visibleSessionStatus } from "../../lib/session-lifecycle";
import { cn } from "../../lib/utils";
import { collectChangedFiles } from "../../lib/changed-files";
import { latestTodoGoal } from "../../lib/todo-goal";
import type { SessionTask, TimelineEvent } from "../../lib/types";
import { TodoGoalCard } from "./TodoGoalCard";

export type DrawerKind = "terminal" | "artifacts" | "dag" | null;

// Stable fallbacks: `?? []` inside a selector would return a fresh array on
// every store update and re-render subscribers of empty sessions each token.
const NO_EVENTS: TimelineEvent[] = [];
const NO_TASKS: never[] = [];

/**
 * Every theme: a turn renders as prompt → ticking fold row → final answer.
 * The last agent message is the final answer and stays visible; everything
 * before it (reasoning, tool cards, intermediate text) folds away.
 */
function ProcessTurnView({
  items,
  live,
  zh,
  renderItem
}: {
  items: TimelineEvent[];
  live: boolean;
  zh: boolean;
  renderItem: (event: TimelineEvent) => ReactNode;
}): JSX.Element {
  let answerStart = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const data = items[index]!.data;
    if (data.kind === "message" && data.sender === "agent") {
      answerStart = index;
      break;
    }
  }
  const process = answerStart >= 0 ? items.slice(0, answerStart) : items;
  const answer = answerStart >= 0 ? items.slice(answerStart) : [];
  return (
    <>
      {process.length > 0 && (
        <ProcessFold items={process} live={live} zh={zh} endTimestamp={items[items.length - 1]?.timestamp}>
          {process.map(renderItem)}
        </ProcessFold>
      )}
      {answer.length > 0 && (
        <div className="mt-4 flex flex-col gap-4">{answer.map(renderItem)}</div>
      )}
    </>
  );
}

/**
 * "已处理 N 秒 ›" — one quiet row that folds a turn's whole middle process.
 * While the turn is live the row ticks upward every second and stays open;
 * when the turn ends it collapses, leaving only the final answer visible.
 */
function ProcessFold({
  items,
  live,
  zh,
  endTimestamp,
  children
}: {
  items: TimelineEvent[];
  live: boolean;
  zh: boolean;
  /** End of the whole turn (the final answer may stream long after the last
   * process event) — the folded duration must cover it too. */
  endTimestamp?: string;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(live);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (live) {
      const timer = window.setInterval(() => setNow(Date.now()), 1000);
      return () => window.clearInterval(timer);
    }
    setOpen(false);
  }, [live]);
  const start = new Date(items[0]!.timestamp).getTime();
  const end = new Date(endTimestamp ?? items[items.length - 1]!.timestamp).getTime();
  const seconds = live
    ? Math.max(0, Math.floor((now - start) / 1000))
    : Math.max(0, Math.round((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const duration =
    seconds >= 60
      ? zh
        ? `${minutes} 分 ${seconds % 60} 秒`
        : `${minutes}m ${seconds % 60}s`
      : zh
        ? `${seconds} 秒`
        : `${seconds}s`;
  return (
    <div className="process-fold mt-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="process-fold-toggle flex w-full items-center gap-1.5 pb-1.5 text-xs text-ink-3 transition-colors hover:text-ink-2"
      >
        <span className={live ? "process-fold-label-live" : undefined}>{zh ? `已处理 ${duration}` : `Processed ${duration}`}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", open && "rotate-180")} aria-hidden />
      </button>
      {open && <div className="mt-3 flex flex-col gap-4">{children}</div>}
    </div>
  );
}

function DelegatedTaskCard({ task }: { task: SessionTask }): JSX.Element {
  const { t } = useI18n();
  const objective = task.objective?.trim();
  const tone = task.status === "failed"
    ? "danger"
    : task.status === "completed"
      ? "ok"
      : task.status === "running"
        ? "accent"
        : "muted";

  return (
    <article className="overflow-hidden rounded-2xl border border-accent/25 bg-accent-soft/35 shadow-sm">
      <div className="flex items-start gap-3 px-4 py-3">
        <span aria-hidden className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent-soft text-accent">
          <ClipboardList className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-semibold text-accent">{t("sessions.taskContext.heading")}</p>
            <StatusChip
              tone={tone}
              label={t(`sessions.taskStatus.${task.status}` as MessageKey)}
              className="h-5 px-1.5 text-[10px]"
            />
          </div>
          <h2 className="mt-1 break-words text-sm font-medium leading-relaxed text-ink">{task.title}</h2>
        </div>
      </div>
      {objective && (
        <div className="border-t border-accent/15 bg-panel/35 px-4 py-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{t("sessions.taskContext.details")}</p>
          <p className="break-words whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">{objective}</p>
        </div>
      )}
    </article>
  );
}

export function SessionWorkbench({
  sessionId,
  active = true,
  drawer,
  onOpenDrawer,
  onCloseDrawer,
  onOpenSession,
  mode = "code",
  headerActions,
  onOpenLocalFile
}: {
  sessionId: string;
  /** False while the page is kept alive but hidden; gates side effects. */
  active?: boolean;
  drawer: DrawerKind;
  onOpenDrawer: (drawer: DrawerKind) => void;
  onCloseDrawer: () => void;
  onOpenSession: (sessionId: string) => void;
  /** "work" hides code-centric affordances (diffs, terminal). */
  mode?: "code" | "work";
  /** Extra controls rendered on the right side of the header (e.g. ModeSwitch). */
  headerActions?: ReactNode;
  /** Work mode only: local file clicks in the timeline open in the preview pane. */
  onOpenLocalFile?: (path: string) => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const isWork = mode === "work";
  const session = useSessionsStore((state) => state.sessions.find((item) => item.id === sessionId));
  const events = useSessionsStore((state) => state.events[sessionId] ?? NO_EVENTS);
  const tasks = useSessionsStore((state) => state.tasks[sessionId] ?? NO_TASKS);
  const foregroundLifecycle = useSessionsStore((state) => state.foreground[sessionId]);
  const orchestrationLifecycle = useSessionsStore((state) => state.running[sessionId]);
  const startEditingMessage = useSessionsStore((state) => state.startEditingMessage);
  const teams = useTeamsStore((state) => state.teams);
  const instances = useAgentsStore((state) => state.instances);
  const projects = useProjectsStore((state) => state.projects);

  // Streaming can update a row that is not the final top-level row (for
  // example, a reasoning row inside a tool group followed by a status row).
  // The event log is immutable, so its array identity is the reliable signal
  // that any rendered timeline content changed.
  const lastUserMessageId = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.data.kind === "message" && event.data.sender === "user") return event.id;
    }
    return undefined;
  }, [events]);

  // Relative file references in messages resolve against the project root.
  // Both workbenches stay mounted; only the visible one owns the resolver.
  const previewRootPath = projects.find((item) => item.id === session?.projectId)?.rootPath;
  const setPreviewBasePaths = useFilePreviewStore((state) => state.setBasePaths);
  useEffect(() => {
    if (!active) return;
    setPreviewBasePaths(previewRootPath ? [previewRootPath] : []);
  }, [active, previewRootPath, setPreviewBasePaths]);

  // File the artifacts drawer should focus when opened via a "view diff" entry.
  const [diffFocusPath, setDiffFocusPath] = useState<string | null>(null);
  // Dispatch card currently opened in the sub-agent detail drawer.
  const [subagentEventId, setSubagentEventId] = useState<string>();

  // Changed-file count for the header badge: this session plus all delegated
  // sub-sessions (kimi edits surface via tool fileDiff, codex via file_change).
  // Subscribing to the whole events map would re-render this page on every
  // token of *any* session; a compact stamp (child id + event count) keeps the
  // subscription cheap while still tracking child activity.
  const childActivityStamp = useSessionsStore((state) =>
    state.sessions
      .filter((item) => item.parentSessionId === sessionId)
      .map((item) => `${item.id}:${state.events[item.id]?.length ?? 0}`)
      .join("|")
  );
  const changedFileCount = useMemo(() => {
    const { sessions: allSessions, events: eventsById } = useSessionsStore.getState();
    return (
      collectChangedFiles(events).length +
      allSessions
        .filter((item) => item.parentSessionId === sessionId)
        .reduce((count, sub) => count + collectChangedFiles(eventsById[sub.id] ?? []).length, 0)
    );
  }, [events, childActivityStamp, sessionId]);

  // Latest TodoList/TodoWrite/update_plan call drives the floating goal card.
  const todoGoal = useMemo(() => latestTodoGoal(events), [events]);

  // Turn stream: each user prompt starts a block; everything until the next
  // prompt hangs from it (agent output, tool track, status lines).
  const turns = useMemo(() => {
    const groups: Array<{ key: string; header?: TimelineEvent; items: TimelineEvent[] }> = [];
    for (const event of events) {
      if (event.data.kind === "message" && event.data.sender === "user") {
        groups.push({ key: event.id, header: event, items: [] });
      } else if (groups.length === 0) {
        groups.push({ key: "preamble", items: [event] });
      } else {
        groups[groups.length - 1]!.items.push(event);
      }
    }
    return groups;
  }, [events]);

  const handleEditMessage = useCallback(
    (messageId: string, text: string): void => startEditingMessage(sessionId, messageId, text),
    [sessionId, startEditingMessage]
  );
  const handleViewDiff = useCallback(
    (path?: string): void => { setDiffFocusPath(path ?? null); onOpenDrawer("artifacts"); },
    [onOpenDrawer]
  );

  if (!session) return <div className="flex-1" />;

  // A child session is scoped to one persisted task. The task list is already
  // filtered to that task by the orchestration runtime; the one-item fallback
  // also keeps older sessions (created before taskId was exposed to the UI)
  // useful after they are rehydrated.
  const delegatedTask = session.parentSessionId
    ? (session.taskId ? tasks.find((task) => task.id === session.taskId) : undefined) ?? (tasks.length === 1 ? tasks[0] : undefined)
    : undefined;
  const foregroundRunning = isActiveLifecycle(foregroundLifecycle);
  const orchestrationRunning = isActiveLifecycle(orchestrationLifecycle);
  const waitingForDelegates = orchestrationRunning && !foregroundRunning && hasRunningDelegatedTask(tasks);
  const waitingForApproval = orchestrationLifecycle?.status === "waiting_approval";
  const verifyingInBackground = orchestrationLifecycle?.status === "running" && orchestrationLifecycle.reason === "verifying";
  const workbenchRunning = foregroundRunning || waitingForDelegates || waitingForApproval || verifyingInBackground;
  const visibleLifecycle = foregroundRunning
    ? foregroundLifecycle
    : waitingForDelegates || waitingForApproval || verifyingInBackground
      ? orchestrationLifecycle
      : undefined;
  const visibleStatus = visibleSessionStatus(session.status, orchestrationLifecycle);
  const project = projects.find((item) => item.id === session.projectId);
  const targetName = sessionTargetName(session, teams, instances);
  const hasPlan = tasks.length > 0;

  return (
    <>
      <header className="relative flex shrink-0 items-center justify-between gap-3 overflow-hidden border-b border-line bg-panel px-5 py-3 backdrop-blur-xl">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold text-ink">{session.title || t("sessions.header.untitled")}</h1>
            <StatusChip
              tone={visibleStatus === "running" ? "accent" : visibleStatus === "waiting_approval" ? "warn" : visibleStatus === "failed" ? "danger" : "muted"}
              label={t(`sessions.status.${visibleStatus}` as MessageKey)}
              pulse={visibleStatus === "running"}
            />
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-3">
            {project?.name} · {targetName}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {hasPlan && (
            <Button variant="ghost" size="sm" onClick={() => onOpenDrawer("dag")}>
              <GitFork className="h-4 w-4" aria-hidden />
              {t("sessions.header.dag")}
            </Button>
          )}
          {!isWork && changedFileCount > 0 && (
            <Button variant="ghost" size="sm" onClick={() => { setDiffFocusPath(null); onOpenDrawer("artifacts"); }}>
              <FileDiff className="h-4 w-4" aria-hidden />
              {t("sessions.header.changes")}
              <span className="ml-0.5 rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-semibold text-accent">{changedFileCount}</span>
            </Button>
          )}
          {!isWork && (
            <Button variant="ghost" size="sm" onClick={() => onOpenDrawer("artifacts")}>
              <Package className="h-4 w-4" aria-hidden />
              {t("sessions.header.artifacts")}
            </Button>
          )}
          {!isWork && (
            <Button variant="ghost" size="sm" onClick={() => onOpenDrawer("terminal")}>
              <SquareTerminal className="h-4 w-4" aria-hidden />
              {t("sessions.header.terminal")}
            </Button>
          )}
          {headerActions}
        </div>
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-accent/35 to-transparent" />
      </header>

      <div className="energy-field relative min-h-0 flex-1" data-run-state={waitingForApproval ? "waiting" : workbenchRunning ? "running" : session.status === "failed" ? "failed" : "idle"}>
      <TimelineViewport
        sessionKey={sessionId}
        contentKey={events}
        forceFollowKey={lastUserMessageId}
        active={active}
      >
        <div className={cn("mx-auto flex w-full flex-col px-5 py-7", isWork ? "max-w-3xl gap-8" : "max-w-4xl gap-9")}>
          {delegatedTask && <DelegatedTaskCard task={delegatedTask} />}
          {turns.map((turn, index) => {
            const live = index === turns.length - 1
              ? waitingForApproval ? "waiting" : workbenchRunning ? "running" : undefined
              : undefined;
            return (
              <section key={turn.key} className="turn-block pl-6 motion-safe:animate-[rise-in_0.28s_ease-out_both]" data-live={live}>
                {turn.header && (
                  <TimelineEventView
                    event={turn.header}
                    onEditMessage={handleEditMessage}
                    onOpenLocalFile={onOpenLocalFile}
                  />
                )}
                {/* Live progress sits at the top of the active turn, right
                    under the user's message. Once events start streaming,
                    the "已处理" fold row takes over. */}
                {live && turn.items.length === 0 && (
                  <RunActivityIndicator lifecycle={visibleLifecycle} events={events} waitingForDelegates={waitingForDelegates} />
                )}
                {turn.items.length > 0 && (
                  <ProcessTurnView
                    items={turn.items}
                    live={Boolean(live)}
                    zh={locale === "zh-CN"}
                    renderItem={(event) => (
                      <TimelineEventView
                        key={event.id}
                        event={event}
                        onViewDiff={handleViewDiff}
                        onOpenSession={onOpenSession}
                        onOpenSubagent={setSubagentEventId}
                        onOpenLocalFile={onOpenLocalFile}
                      />
                    )}
                  />
                )}
              </section>
            );
          })}
          <InteractionCards sessionId={sessionId} />
          {events.length === 0 && (
            <p className="py-16 text-center text-sm text-ink-3">{t("sessions.noSelection")}</p>
          )}
        </div>
      </TimelineViewport>
      {todoGoal && <TodoGoalCard todos={todoGoal} />}
      </div>

      <QueuedFollowUpBar sessionId={sessionId} />
      <Composer
        sessionId={sessionId}
        targetName={targetName}
        running={workbenchRunning}
        disabled={session.status === "archived"}
      />

      {!isWork && <TerminalDrawer open={drawer === "terminal"} onClose={onCloseDrawer} sessionId={sessionId} />}
      {!isWork && <ArtifactsDrawer open={drawer === "artifacts"} onClose={onCloseDrawer} sessionId={sessionId} focusPath={diffFocusPath} />}
      <DagDrawer open={drawer === "dag"} onClose={onCloseDrawer} tasks={tasks} />
      <SubagentDrawer open={!!subagentEventId} onClose={() => setSubagentEventId(undefined)} sessionId={sessionId} eventId={subagentEventId} />
    </>
  );
}
