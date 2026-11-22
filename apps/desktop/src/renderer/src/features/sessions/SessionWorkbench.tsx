import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { conversationLocations, type ConversationLocation } from "../../lib/conversation-navigation";
import { ClipboardList, PanelRight } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { TimelineEventView, type TimelineRow, TimelineViewport } from "../timeline/Timeline";
import { ConversationTurnView, isTurnTraceStep, turnEventAlwaysVisible } from "../timeline/ConversationTurnView";
import { workflowTool } from "../timeline/WorkflowToolActivity";
import { StatusChip } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Composer } from "./Composer";
import { providerUiState } from "../../lib/provider-ui";
import { useNativeTerminalState } from "../../lib/use-native-terminal";
import { ArtifactsDrawer, DagDrawer, SubagentDrawer, TerminalDrawer } from "./Drawers";
import { RunActivityIndicator, SessionActivityPill } from "./RunActivityIndicator";
import { sessionTargetName } from "./SessionListPanel";
import { useSessionsStore, SESSION_EMPTY } from "../../stores/sessions";
import { InteractionCards } from "./InteractionCards";
import { useInteractionsStore } from "../../stores/interactions";
import type { InteractionRequest, WorkflowMention } from "@agenthub/domain";
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
import { conversationRows, conversationRunSummaries, type ConversationTurn } from "../../lib/conversation-timeline";
import { cachedChangedFileCount } from "../../lib/changed-files";
import { latestTodoGoal } from "../../lib/todo-goal";
import type { SessionTask, TimelineEvent } from "../../lib/types";
import { TodoGoalCard } from "./TodoGoalCard";
import { SessionInspector } from "./SessionInspector";
import { SessionToolsInventory } from "./SessionToolsInventory";
import { SessionWorkspaceMenu } from "./SessionWorkspaceMenu";
import { BrowserDrawer } from "./BrowserDrawer";
import { getBridge, requestCore } from "../../lib/bridge";
import { SourceControlDrawer } from "./SourceControlDrawer";
import { WorkflowExecutionDrawer } from "./WorkflowExecutionDrawer";
import { WorkflowDispatchCard } from "../workflows/WorkflowDispatchCard";
import { WorkflowDispatchContext, useWorkflowDispatches } from "../workflows/workflow-dispatch";
import { useCoreFeatures } from "../../lib/use-core-features";
import { toast } from "../../stores/toast";

const pendingTitles = new Map<string, Promise<{ title?: string }>>();

export type DrawerKind = "terminal" | "artifacts" | "dag" | "source-control" | "browser" | "workflow" | "tools" | null;

// Stable fallbacks: `?? []` inside a selector would return a fresh array on
// every store update and re-render subscribers of empty sessions each token.
const NO_EVENTS: TimelineEvent[] = [];
const NO_INTERACTIONS: InteractionRequest[] = [];
const NO_TASKS: never[] = [];

function estimateShortMessageHeight(event: TimelineEvent): number | undefined {
  const { data } = event;
  if (data.kind !== "message" || data.sender === "system" || data.attachments?.length || data.workflowRef
    || data.text.length > 36 || /[\r\n]/.test(data.text)) return undefined;
  return data.sender === "user" ? 71 : 50;
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
  onToggleInspector,
  inspectorOpen = false,
  focusKey
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
  onToggleInspector?: () => void;
  inspectorOpen?: boolean;
  focusKey?: string;
}): JSX.Element {
  const { t, locale } = useI18n();
  const navigationLocations = useRef<ConversationLocation[]>([]);
  const [turnExpansions, setTurnExpansions] = useState<Record<string, { completed: boolean; open: boolean }>>({});
  const coreFeatures = useCoreFeatures();
  const interactions = useInteractionsStore(state => state.bySession[sessionId] ?? NO_INTERACTIONS);
  const loadInteractions = useInteractionsStore(state => state.loadPending);
  useEffect(() => { if (active) void loadInteractions(sessionId); }, [sessionId, active, loadInteractions]);
  const session = useSessionsStore((state) => state.sessions.find((item) => item.id === sessionId));
  const activeAgentRunId = useSessionsStore(state => state.activeAgentRunIds[sessionId]);
  const workflowDispatches = useWorkflowDispatches(sessionId, active && Boolean(session?.parentSessionId), activeAgentRunId, session?.status);
  const events = useSessionsStore((state) => state.events[sessionId] ?? NO_EVENTS);
  const extensionUi = useMemo(() => providerUiState(events), [events]);
  const nativeTerminal = useNativeTerminalState(sessionId, active);
  const nativeOwnsSession = nativeTerminal.nativeActive;
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

  const [workflowInspection, setWorkflowInspection] = useState<{ sessionId: string; runId: string }>();
  // Dispatch card currently opened in the sub-agent detail drawer.
  const [subagentEventId, setSubagentEventId] = useState<string>();
  const [showTodos, setShowTodos] = useState(false);
  const workspaceTrigger = useRef<HTMLButtonElement>(null);
  const [compactTarget, setCompactTarget] = useState<HTMLSpanElement | null>(null);
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
    (messageId: string, text: string, workflowRef?: WorkflowMention): void => startEditingMessage(sessionId, messageId, text, workflowRef),
    [sessionId, startEditingMessage]
  );
  const handleOpenSubagent = useCallback((eventId: string): void => {
    onOpenDrawer(null);
    setSubagentEventId(eventId);
  }, [onOpenDrawer]);
  useEffect(() => { if (drawer) setSubagentEventId(undefined); }, [drawer]);
  const handleOpenWorkflow = useCallback((runId: string): void => {
    setWorkflowInspection({ sessionId, runId });
    onOpenDrawer("workflow");
  }, [sessionId, onOpenDrawer]);
  const openWorkflowConversation = useCallback((id: string): void => {
    onCloseDrawer();
    if (id !== sessionId) onOpenSession(id);
  }, [onCloseDrawer, onOpenSession, sessionId]);

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
  const bridge = getBridge();
  const toggleDrawer = (view: Exclude<DrawerKind, null>): void => onOpenDrawer(drawer === view ? null : view);
  const browserWindows = drawer !== "browser" ? bridge?.panels : undefined;
  const browserAction = browserWindows
    ? { external: true, run: () => { void browserWindows.open({ kind: "browser", sessionId }).catch(error => toast.error(String(error))); } }
    : { checked: drawer === "browser", run: () => toggleDrawer("browser") };
  // Event IDs are stable across streaming patches. Only the changed row
  // updates; completed Markdown and closed tool details stay untouched.
  type StepLinks = { turnId: string; before: boolean; after: boolean };
  type WorkbenchRow = TimelineRow & { step?: StepLinks };
  const shell = (key: string, node: ReactNode, { process = false, result = false, stepTurn, estimatedHeight }: {
    process?: boolean; result?: boolean; stepTurn?: string; estimatedHeight?: number;
  } = {}): WorkbenchRow => {
    const step = stepTurn === undefined ? undefined : { turnId: stepTurn, before: false, after: false };
    return { key, result, step, estimatedHeight: estimatedHeight ?? (step ? 30 : undefined), render: () => (
      <div className="conversation-message-row mx-auto w-full" data-process={process || undefined}
        data-trace-step={step ? true : undefined}>
        {step ? <div className="conversation-process-row" data-turn-id={step.turnId} data-trace-step
          data-trace-prev={step.before || undefined} data-trace-next={step.after || undefined}>{node}</div> : node}
      </div>
    ) };
  };
  const timelineRows: WorkbenchRow[] = [];
  const requests = interactions.filter(item => item.kind === "question" || item.status === "pending").sort((a,b) => a.createdAt.localeCompare(b.createdAt));
  let nextRequest = 0;
  const addInteractions = (before: string): void => {
    while (nextRequest < requests.length && requests[nextRequest].createdAt <= before) {
      const request = requests[nextRequest++];
      timelineRows.push(shell(`interaction:${request.id}`, <InteractionCards sessionId={sessionId} interactionId={request.id}/>));
    }
  };
  if (delegatedTask) timelineRows.push(shell("delegated", <DelegatedTaskCard task={delegatedTask} />));
  const timelineActions = { onEditMessage: handleEditMessage, onOpenSession, onOpenSubagent: handleOpenSubagent, onOpenWorkflow: handleOpenWorkflow, onOpenLocalFile };
  const conversation = conversationRows(visibleEvents, workbenchRunning);
  const summaries = conversationRunSummaries(conversation);
  const isExpanded = (summary: ConversationTurn): boolean => {
    const choice = turnExpansions[`${sessionId}:${summary.id}`];
    return choice?.completed === summary.completed ? choice.open : !summary.completed;
  };
  conversation.forEach((row) => {
    if (row.kind === "event") {
      addInteractions(row.event.timestamp);
      const owner = summaries.get(row.event.id);
      if (owner && !isExpanded(owner)) return;
      timelineRows.push(shell(row.event.id, <TimelineEventView event={row.event} {...timelineActions} />, {
        result: row.event.data.kind === "message" && row.event.data.sender === "agent" && !row.event.data.streaming,
        estimatedHeight: estimateShortMessageHeight(row.event),
      }));
      return;
    }
    const turn = row.turn;
    const summary = summaries.get(turn.id) ?? turn;
    const key = `${sessionId}:${summary.id}`;
    const expanded = isExpanded(summary);
    if (turn.id === summary.id) timelineRows.push(shell(turn.id, <ConversationTurnView turn={summary} {...timelineActions} summaryOnly expanded={expanded}
      onToggle={() => setTurnExpansions(previous => Object.fromEntries([
        ...Object.entries(previous).filter(([id]) => id !== key), [key, { completed: summary.completed, open: !expanded }]
      ].slice(-500)))} />, { estimatedHeight: 65 }));
    // A single turn may contain hundreds of activities. Each visible activity
    // participates in the viewport's one virtualizer, rather than one huge row.
    for (const event of turn.events) {
      addInteractions(event.timestamp);
      if (!expanded && !turnEventAlwaysVisible(summary, event)) continue;
      const content = <TimelineEventView event={event} {...timelineActions} showAuthor={false} />;
      const result = event === turn.result;
      const compact = event.data.kind === "provider_ui" || event.data.kind === "tool_activity" && !event.data.subagent;
      if (isTurnTraceStep(event)) timelineRows.push(shell(event.id, content, {
        process: true, stepTurn: turn.id, estimatedHeight: event.data.kind === "tool_activity" && workflowTool(event.data.toolName) ? 38 : undefined,
      }));
      else timelineRows.push(shell(event.id, <div className={result ? "conversation-result" : "conversation-process-row"} data-turn-id={turn.id}>{content}</div>, {
        process: compact, result, estimatedHeight: compact ? 30 : estimateShortMessageHeight(event),
      }));
    }
  });
  if (workbenchRunning) timelineRows.push(shell("live-activity", (
    <RunActivityIndicator lifecycle={visibleLifecycle} events={visibleEvents} waitingForDelegates={waitingForDelegates} />
  ), { estimatedHeight: 30 }));
  addInteractions("\uffff");
  if (events.length === 0 && !workbenchRunning) {
    timelineRows.push(shell("empty", (
      <p className="py-16 text-center text-xl font-medium tracking-tight text-ink">
        {locale === "zh-CN" ? "我们要做什么？" : "What shall we work on?"}
      </p>
    )));
  }
  // Connect neighbors after inserting interaction cards, so a rail never crosses a separate card or a turn boundary.
  let previousStep: StepLinks | undefined;
  for (const { step } of timelineRows) {
    if (step && previousStep?.turnId === step.turnId) {
      previousStep.after = true;
      step.before = true;
    }
    previousStep = step;
  }
  navigationLocations.current = conversationLocations(visibleEvents, timelineRows, navigationLocations.current);

  const workspaceMenu = <SessionWorkspaceMenu key={sessionId} trigger={workspaceTrigger} project={project}
    openFolder={bridge?.shell && project?.rootPath ? () => {
      void bridge.shell.openPath(project.rootPath).then(error => { if (error) toast.error(error); }).catch(error => toast.error(String(error)));
    } : undefined}
    actions={{
      terminal: { checked: drawer === "terminal", run: () => toggleDrawer("terminal") },
      browser: bridge?.browser ? browserAction : undefined,
      "source-control": coreFeatures.sourceControl ? { checked: drawer === "source-control", run: () => toggleDrawer("source-control") } : undefined,
      artifacts: {
        checked: drawer === "artifacts", detail: changedFileCount > 0 ? String(changedFileCount) : undefined,
        run: () => toggleDrawer("artifacts")
      },
      goals: todoGoal ? {
        checked: showTodos, detail: `${todoGoal.filter(item => item.status === "done").length}/${todoGoal.length}`,
        run: () => setShowTodos(open => !open)
      } : undefined,
      dag: tasks.length > 0 ? { checked: drawer === "dag", detail: String(tasks.length), run: () => toggleDrawer("dag") } : undefined,
      workflows: coreFeatures.workflows === 1 && !session.parentSessionId ? { run: () => {
        const query = new URLSearchParams({ session: sessionId });
        void requestCore<Array<{ id: string }>>("workflow.list", { sessionId }).then(runs => {
          if (runs[0]) query.set("run", runs[0].id);
          window.location.hash = "#/workflows?" + query;
        }).catch(error => toast.error(String(error)));
      } } : undefined,
      agents: onToggleInspector ? { checked: inspectorOpen, run: onToggleInspector } : undefined,
      tools: { run: () => onOpenDrawer("tools") }
    }} />;

  return (
    <div className="conversation-workspace relative flex h-full min-h-0 min-w-0 flex-1">
      <div className="session-chat-column relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="workspace-conversation-header relative flex min-h-14 shrink-0 items-center justify-between gap-x-3 px-5 py-3 sm:px-7">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 title={`${project?.name ?? ""} · ${targetName}`} className="truncate text-[15px] font-medium text-ink">{session.title || t("sessions.header.untitled")}</h1>
            <span data-testid="session-fixed-agent" title={locale === "zh-CN" ? "会话 Agent 已固定；账号、供应商和模型可在下方选择，下一轮生效。" : "Agent is fixed for this conversation. Change account, provider or model below for the next message."} className="inline-flex max-w-48 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface/50 px-2 py-1 text-xs text-muted"><span aria-hidden>◈</span><span className="truncate">{targetName}</span></span>
            {(visibleStatus === "waiting_approval" || visibleStatus === "failed") && <StatusChip
              tone={visibleStatus === "waiting_approval" ? "warn" : "danger"}
              label={t(`sessions.status.${visibleStatus}` as MessageKey)}
            />}
          </div>

        </div>
        {active && drawer !== "workflow" && <SessionActivityPill key={sessionId} lifecycle={visibleLifecycle} events={visibleEvents}
          waitingForDelegates={waitingForDelegates} foreground={foregroundLifecycle} orchestration={orchestrationLifecycle} />}
        <div className="flex shrink-0 items-center gap-2">
          {headerActions}
          {active && onToggleInspector && <button type="button" className="session-inspector-toggle" aria-pressed={inspectorOpen}
            aria-label={locale === "zh-CN" ? "会话信息栏" : "Conversation details"} title={locale === "zh-CN" ? "会话信息栏" : "Conversation details"}
            onClick={onToggleInspector}><PanelRight size={16} aria-hidden /></button>}
          {active && !inspectorOpen && workspaceMenu}
        </div>
      </header>

      {workflowDispatches.dispatches.length > 0 && <WorkflowDispatchCard key={sessionId} dispatches={workflowDispatches.dispatches} zh={locale === "zh-CN"} />}
      <div className="session-chat-timeline relative min-h-0 flex-1" data-run-state={waitingForApproval ? "waiting" : workbenchRunning ? "running" : session.status === "failed" ? "failed" : "idle"}>
      <WorkflowDispatchContext.Provider value={workflowDispatches}><TimelineViewport
        focusKey={focusKey}
        rows={timelineRows}
        sessionKey={sessionId}
        contentKey={visibleEvents}
        forceFollowKey={lastUserMessageId}
        locations={navigationLocations.current}
        active={active}
        className="session-chat-scroll"
      /></WorkflowDispatchContext.Provider>
      {todoGoal && showTodos && <TodoGoalCard todos={todoGoal} onClose={() => {
        setShowTodos(false);
        workspaceTrigger.current?.focus({ preventScroll: true });
      }} />}
      </div>

      {(extensionUi.title || extensionUi.widgets.length > 0 || extensionUi.statuses.length > 0) && <div className="mx-auto w-full max-w-[1000px] shrink-0 px-5 pb-2 text-[13px] leading-5 text-ink-2" aria-label={extensionUi.title || "Extension status"} aria-live="polite">
        {extensionUi.title && <div>{extensionUi.title}</div>}
        {extensionUi.widgets.map((text, index) => <div key={`widget-${index}`} className="whitespace-pre-wrap">{text}</div>)}
        {extensionUi.statuses.length > 0 && <div className="flex flex-wrap gap-x-4">{extensionUi.statuses.map((text, index) => <span key={index}>{text}</span>)}</div>}
      </div>}
      {nativeOwnsSession && <div className="mx-auto flex w-full max-w-[1000px] items-center justify-between gap-3 px-5 pb-2 text-[13px] text-ink-2"><span>{nativeTerminal.historySync?.status === "failed" ? (locale === "zh-CN" ? "原生历史同步失败，请在终端中重试" : "Native history sync failed. Retry in the terminal.") : nativeTerminal.historySync?.status === "syncing" ? (locale === "zh-CN" ? "正在同步原生会话历史" : "Syncing native session history") : (locale === "zh-CN" ? "会话正在原生终端中运行" : "Session is active in the native terminal")}</span><Button variant="ghost" size="sm" onClick={() => onOpenDrawer("terminal")}>{locale === "zh-CN" ? "返回终端" : "Open terminal"}</Button></div>}
      <Composer
        sessionId={sessionId}
        compactTarget={compactTarget}
        targetName={targetName}
        running={workbenchRunning}
        disabled={session.status === "archived" || nativeOwnsSession}
      />

      {<TerminalDrawer open={drawer === "terminal" && active} onClose={onCloseDrawer} sessionId={sessionId} />}
      </div>
      {active && inspectorOpen && <SessionInspector session={session} events={visibleEvents} menu={workspaceMenu} onOpenSession={onOpenSession} compactSlot={setCompactTarget} />}
      <ArtifactsDrawer open={drawer === "artifacts" && active} onClose={onCloseDrawer} sessionId={sessionId} />
      {drawer === "browser" && active && getBridge()?.browser && <BrowserDrawer key={sessionId} sessionId={sessionId} onClose={onCloseDrawer} />}
      <SourceControlDrawer open={drawer === "source-control" && active && !!coreFeatures.sourceControl} onClose={onCloseDrawer} sessionId={sessionId} projectId={project?.id} />
      <AnimatePresence initial={false}>
        {drawer === "workflow" && active && workflowInspection?.sessionId === sessionId && <WorkflowExecutionDrawer
          key={workflowInspection.runId} runId={workflowInspection.runId} onClose={onCloseDrawer} onOpenSession={openWorkflowConversation} />}
      </AnimatePresence>
      <DagDrawer open={drawer === "dag"} onClose={onCloseDrawer} tasks={tasks} />
      <Dialog open={active && drawer === "tools"} onOpenChange={onCloseDrawer} title={locale === "zh-CN" ? "本次会话工具" : "Session tools"}>
        {active && drawer === "tools" && <SessionToolsInventory key={sessionId} sessionId={sessionId} />}
      </Dialog>
      <SubagentDrawer open={!!subagentEventId} onClose={() => setSubagentEventId(undefined)} sessionId={sessionId} eventId={subagentEventId} />
    </div>
  );
}
