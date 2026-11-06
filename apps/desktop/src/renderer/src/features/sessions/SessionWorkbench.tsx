import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ClipboardList, Users, ListChecks, GitFork, FileDiff, Package, SquareTerminal } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { TimelineEventView, type TimelineRow, TimelineViewport } from "../timeline/Timeline";
import { ConversationTurnView } from "../timeline/ConversationTurnView";
import { StatusChip } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Composer } from "./Composer";
import { providerUiState } from "../../lib/provider-ui";
import { useNativeTerminalStatus } from "../../lib/use-native-terminal";
import { ArtifactsDrawer, DagDrawer, SubagentDrawer, TerminalDrawer } from "./Drawers";
import { RunActivityIndicator } from "./RunActivityIndicator";
import { sessionTargetName } from "./SessionListPanel";
import { useSessionsStore, SESSION_EMPTY } from "../../stores/sessions";
import { InteractionCards } from "./InteractionCards";
import { useFilePreviewStore } from "../../stores/file-preview";
import { useProjectsStore } from "../../stores/projects";
import { useTeamsStore } from "../../stores/teams";
import { useAgentsStore } from "../../stores/agents";
import { hasRunningDelegatedTask, isActiveLifecycle, visibleSessionStatus } from "../../lib/session-lifecycle";
import {
  ensureProjectRunHydrated,
  ensureStandaloneSessionHydrated,
  registerProjectSessionView,
  registerStandaloneSessionView
} from "../../lib/orchestration-runtime";
import { conversationRows } from "../../lib/conversation-timeline";
import { cachedChangedFileCount } from "../../lib/changed-files";
import { latestTodoGoal } from "../../lib/todo-goal";
import type { SessionTask, TimelineEvent } from "../../lib/types";
import { TodoGoalCard } from "./TodoGoalCard";
import { requestCore } from "../../lib/bridge";

const pendingTitles = new Map<string, Promise<{ title?: string }>>();

export type DrawerKind = "terminal" | "artifacts" | "dag" | null;

// Stable fallbacks: `?? []` inside a selector would return a fresh array on
// every store update and re-render subscribers of empty sessions each token.
const NO_EVENTS: TimelineEvent[] = [];
const NO_TASKS: never[] = [];

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
    <article className="overflow-hidden rounded-xl border border-line bg-card">
      <div className="flex items-start gap-3 px-4 py-3">
        <span aria-hidden className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-card-hover text-ink-2">
          <ClipboardList className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium text-ink-2">{t("sessions.taskContext.heading")}</p>
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
        <div className="border-t border-line px-4 py-3">
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
  headerActions,
  onOpenLocalFile,
  onToggleAgents,
  agentsOpen = false
}: {
  sessionId: string;
  /** False while the page is kept alive but hidden; gates side effects. */
  active?: boolean;
  drawer: DrawerKind;
  onOpenDrawer: (drawer: DrawerKind) => void;
  onCloseDrawer: () => void;
  onOpenSession: (sessionId: string) => void;
  /** Legacy persisted mode; all conversations share the same capabilities. */
  mode?: "code" | "work";
  /** Extra controls rendered on the right side of the header (e.g. ModeSwitch). */
  headerActions?: ReactNode;
  /** Local file clicks open the contextual document preview. */
  onOpenLocalFile?: (path: string) => void;
  onToggleAgents?: () => void;
  agentsOpen?: boolean;
}): JSX.Element {
  const { t, locale } = useI18n();
  const session = useSessionsStore((state) => state.sessions.find((item) => item.id === sessionId));
  const events = useSessionsStore((state) => state.events[sessionId] ?? NO_EVENTS);
  const extensionUi = useMemo(() => providerUiState(events), [events]);
  const nativeOwnsSession = useNativeTerminalStatus(sessionId, active);
  const queuedFollowUps = useSessionsStore((state) => state.queuedFollowUps[sessionId]);
  const visibleEvents = useMemo(() => {
    if (!queuedFollowUps?.length) return events;
    const queuedIds = new Set(queuedFollowUps.map((item) => item.messageId));
    return events.filter((event) => event.data.kind !== "message" || !event.data.messageId || !queuedIds.has(event.data.messageId));
  }, [events, queuedFollowUps]);
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
    for (let index = visibleEvents.length - 1; index >= 0; index -= 1) {
      const event = visibleEvents[index];
      if (event.data.kind === "message" && event.data.sender === "user") return event.id;
    }
    return undefined;
  }, [visibleEvents]);

  const lastCompletedReplyId = useMemo(() => [...events].reverse().find(event =>
    event.data.kind === "message" && event.data.sender === "agent" && !event.data.streaming)?.id, [events]);
  useEffect(() => {
    if (!active || !session || !lastCompletedReplyId) return;
    let disposed = false;
    const previousTitle = session.title;
    const key = `${sessionId}:${lastCompletedReplyId}`;
    let request = pendingTitles.get(key);
    if (!request) {
      request = requestCore<{ title?: string }>("session.generateTitle", { sessionId });
      pendingTitles.set(key, request);
      void request.finally(() => pendingTitles.delete(key)).catch(() => {});
    }
    void request.then(({ title }) => {
      const current = useSessionsStore.getState().sessions.find(item => item.id === sessionId);
      if (!disposed && title && current?.title === previousTitle && title !== current.title) useSessionsStore.getState()._configureSession(sessionId, { title });
    }).catch(() => {});
    return () => { disposed = true; };
  }, [active, sessionId, lastCompletedReplyId]);

  // Relative file references in messages resolve against the project root.
  // The single workspace owns file resolution only while visible.
  const previewRootPath = projects.find((item) => item.id === session?.projectId)?.rootPath;
  const setPreviewBasePaths = useFilePreviewStore((state) => state.setBasePaths);
  useEffect(() => {
    if (!active) return;
    setPreviewBasePaths(previewRootPath ? [previewRootPath] : []);
  }, [active, previewRootPath, setPreviewBasePaths]);

  // Lazy hydration: standalone sessions load their event journal on first
  // display instead of all at startup (memory); project sessions hydrate
  // their whole run on demand. Older views are evicted LRU, but anything
  // displayed by a mounted workbench is never evicted.
  const projectRunId = session?.projectRunId;
  useEffect(() => {
    if (!active) return;
    if (projectRunId) {
      const unregister = registerProjectSessionView(sessionId, projectRunId);
      void ensureProjectRunHydrated(projectRunId);
      return unregister;
    }
    const unregister = registerStandaloneSessionView(sessionId);
    void ensureStandaloneSessionHydrated(sessionId);
    return unregister;
  }, [active, sessionId, projectRunId]);

  // File the artifacts drawer should focus when opened via a "view diff" entry.
  const [diffFocusPath, setDiffFocusPath] = useState<string | null>(null);
  // Dispatch card currently opened in the sub-agent detail drawer.
  const [subagentEventId, setSubagentEventId] = useState<string>();
  const [showTodos, setShowTodos] = useState(false);
  useEffect(() => { setShowTodos(false); setSubagentEventId(undefined); }, [sessionId]);

  // Only the numeric badge is subscribed. Streaming text in another session
  // cannot invalidate this page; immutable child timelines reuse their count.
  const changedFileCount = useSessionsStore((state) =>
    cachedChangedFileCount(state.events[sessionId] ?? SESSION_EMPTY.events)
      + state.sessions.filter((item) => item.parentSessionId === sessionId)
        .reduce((count, sub) => count + cachedChangedFileCount(state.events[sub.id] ?? SESSION_EMPTY.events), 0)
  );

  // Latest TodoList/TodoWrite/update_plan call drives the floating goal card.
  const todoGoal = useMemo(() => latestTodoGoal(events), [events]);

  // Keep the provider's event order. A tool burst is expanded into its own
  // virtual rows instead of swallowing intermediate assistant messages.

  const handleEditMessage = useCallback(
    (messageId: string, text: string): void => startEditingMessage(sessionId, messageId, text),
    [sessionId, startEditingMessage]
  );
  const handleOpenSubagent = useCallback((eventId: string): void => {
    onOpenDrawer(null);
    setSubagentEventId(eventId);
  }, [onOpenDrawer]);
  useEffect(() => { if (drawer) setSubagentEventId(undefined); }, [drawer]);
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
  // Event IDs are stable across streaming patches. Only the changed row
  // updates; completed Markdown and closed tool details stay untouched.
  const shell = (key: string, node: ReactNode): TimelineRow => ({
    key,
    render: () => (
      <div className="conversation-message-row mx-auto w-full max-w-3xl px-5 py-2 sm:px-8">
        {node}
      </div>
    )
  });
  const timelineRows: TimelineRow[] = [];
  if (delegatedTask) timelineRows.push(shell("delegated", <DelegatedTaskCard task={delegatedTask} />));
  const timelineActions = { onEditMessage: handleEditMessage, onViewDiff: handleViewDiff, onOpenSession, onOpenSubagent: handleOpenSubagent, onOpenLocalFile };
  conversationRows(visibleEvents, workbenchRunning).forEach((row) => {
    timelineRows.push(row.kind === "event"
      ? shell(row.event.id, <TimelineEventView event={row.event} {...timelineActions} />)
      : shell(row.turn.id, <ConversationTurnView turn={row.turn} {...timelineActions} />));
  });
  if (workbenchRunning) timelineRows.push(shell("live-activity", (
    <RunActivityIndicator lifecycle={visibleLifecycle} events={visibleEvents} waitingForDelegates={waitingForDelegates} />
  )));
  timelineRows.push(shell("interactions", <InteractionCards sessionId={sessionId} />));
  if (events.length === 0 && !workbenchRunning) {
    timelineRows.push(shell("empty", (
      <p className="py-16 text-center text-xl font-medium tracking-tight text-ink">
        {locale === "zh-CN" ? "我们要做什么？" : "What shall we work on?"}
      </p>
    )));
  }

  return (
    <div className="conversation-workspace relative flex h-full min-h-0 min-w-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="workspace-conversation-header relative flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-3 sm:px-7">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 title={`${project?.name ?? ""} · ${targetName}`} className="truncate text-[15px] font-medium text-ink">{session.title || t("sessions.header.untitled")}</h1>
            <span data-testid="session-fixed-agent" title={locale === "zh-CN" ? "会话 Agent 已固定；账号、供应商和模型可在下方选择，下一轮生效。" : "Agent is fixed for this conversation. Change account, provider or model below for the next message."} className="inline-flex max-w-48 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface/50 px-2 py-1 text-xs text-muted"><span aria-hidden>◈</span><span className="truncate">{targetName}</span></span>
            {(visibleStatus === "running" || visibleStatus === "waiting_approval" || visibleStatus === "failed") && <StatusChip
              tone={visibleStatus === "running" ? "accent" : visibleStatus === "waiting_approval" ? "warn" : visibleStatus === "failed" ? "danger" : "muted"}
              label={t(`sessions.status.${visibleStatus}` as MessageKey)}
              pulse={visibleStatus === "running"}
            />}
          </div>

        </div>
        <div className="flex shrink-0 items-center gap-1">
          {todoGoal && (
            <Button variant="ghost" size="icon" aria-label={t("sessions.todo.goal")} title={t("sessions.todo.goal")} aria-pressed={showTodos} onClick={() => setShowTodos((open) => !open)}>
              <ListChecks className="h-4 w-4" aria-hidden />
            </Button>
          )}
          {hasPlan && (
            <Button variant="ghost" size="icon" title={t("sessions.header.dag")} aria-label={t("sessions.header.dag")} onClick={() => onOpenDrawer("dag")}>
              <GitFork className="h-4 w-4" aria-hidden />
            </Button>
          )}
          {changedFileCount > 0 && (
            <Button variant="ghost" size="sm" onClick={() => { setDiffFocusPath(null); onOpenDrawer("artifacts"); }}>
              <FileDiff className="h-4 w-4" aria-hidden />
              {t("sessions.header.changes")}
              <span className="ml-0.5 rounded-full bg-card-hover px-1.5 py-px text-[11px] font-medium text-ink-2">{changedFileCount}</span>
            </Button>
          )}
          {(
            <Button variant="ghost" size="icon" title={t("sessions.header.artifacts")} aria-label={t("sessions.header.artifacts")} onClick={() => onOpenDrawer("artifacts")}>
              <Package className="h-4 w-4" aria-hidden />
            </Button>
          )}
          {(
            <Button variant="ghost" size="icon" title={t("sessions.header.terminal")} aria-label={t("sessions.header.terminal")} onClick={() => onOpenDrawer("terminal")}>
              <SquareTerminal className="h-4 w-4" aria-hidden />
            </Button>
          )}
          {headerActions}
          {onToggleAgents && <Button variant="ghost" size="icon" title={locale === "zh-CN" ? "Agent 分配" : "Agent assignment"} aria-label={locale === "zh-CN" ? "Agent 分配" : "Agent assignment"} aria-pressed={agentsOpen} aria-expanded={agentsOpen} aria-controls={agentsOpen ? "session-agent-inspector" : undefined} onClick={onToggleAgents}>
            <Users className="h-4 w-4" aria-hidden />
          </Button>}
        </div>
      </header>

      <div className="relative min-h-0 flex-1" data-run-state={waitingForApproval ? "waiting" : workbenchRunning ? "running" : session.status === "failed" ? "failed" : "idle"}>
      <TimelineViewport
        rows={timelineRows}
        sessionKey={sessionId}
        contentKey={visibleEvents}
        forceFollowKey={lastUserMessageId}
        active={active}
      />
      {todoGoal && showTodos && <TodoGoalCard todos={todoGoal} />}
      </div>

      {(extensionUi.title || extensionUi.widgets.length > 0 || extensionUi.statuses.length > 0) && <div className="mx-auto w-full max-w-[1000px] shrink-0 px-5 pb-2 text-[13px] leading-5 text-ink-2" aria-label={extensionUi.title || "Extension status"} aria-live="polite">
        {extensionUi.title && <div>{extensionUi.title}</div>}
        {extensionUi.widgets.map((text, index) => <div key={`widget-${index}`} className="whitespace-pre-wrap">{text}</div>)}
        {extensionUi.statuses.length > 0 && <div className="flex flex-wrap gap-x-4">{extensionUi.statuses.map((text, index) => <span key={index}>{text}</span>)}</div>}
      </div>}
      {nativeOwnsSession && <div className="mx-auto flex w-full max-w-[1000px] items-center justify-between gap-3 px-5 pb-2 text-[13px] text-ink-2"><span>{locale === "zh-CN" ? "会话正在原生终端中运行" : "Session is active in the native terminal"}</span><Button variant="ghost" size="sm" onClick={() => onOpenDrawer("terminal")}>{locale === "zh-CN" ? "返回终端" : "Open terminal"}</Button></div>}
      <Composer
        sessionId={sessionId}
        targetName={targetName}
        running={workbenchRunning}
        disabled={session.status === "archived" || nativeOwnsSession}
      />

      {<TerminalDrawer open={drawer === "terminal"} onClose={onCloseDrawer} sessionId={sessionId} />}
      </div>
      {<ArtifactsDrawer open={drawer === "artifacts"} onClose={onCloseDrawer} sessionId={sessionId} focusPath={diffFocusPath} />}
      <DagDrawer open={drawer === "dag"} onClose={onCloseDrawer} tasks={tasks} />
      <SubagentDrawer open={!!subagentEventId} onClose={() => setSubagentEventId(undefined)} sessionId={sessionId} eventId={subagentEventId} />
    </div>
  );
}
