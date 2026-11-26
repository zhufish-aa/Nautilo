import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { conversationLocations, type ConversationLocation } from "../../lib/conversation-navigation";
import { ClipboardList, FolderOpen } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { TimelineEventView, type TimelineRow, TimelineViewport } from "../timeline/Timeline";
import { ConversationTurnView } from "../timeline/ConversationTurnView";
import { ProcessDisclosure } from "../timeline/ProcessDisclosure";
import { TurnProcess } from "../timeline/ToolStepGroup";
import { StatusChip } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Composer } from "./Composer";
import { providerUiState } from "../../lib/provider-ui";
import { useNativeTerminalState } from "../../lib/use-native-terminal";
import { ArtifactsDrawer, DagDrawer, SubagentDrawer, TerminalDrawer } from "./Drawers";
import { RunActivityIndicator } from "./RunActivityIndicator";
import { sessionTargetName } from "./SessionListPanel";
import { useSessionsStore, SESSION_EMPTY } from "../../stores/sessions";
import { InteractionCards } from "./InteractionCards";
import type { CapabilityReference, InteractionRequest, WorkflowMention } from "@agenthub/domain";
import { useFilePreviewStore } from "../../stores/file-preview";
import { useProjectsStore } from "../../stores/projects";
import { useTeamsStore } from "../../stores/teams";
import { useAgentsStore } from "../../stores/agents";
import { hasRunningDelegatedTask, isActiveLifecycle, visibleSessionStatus } from "../../lib/session-lifecycle";
import {
  ensureProjectRunHydrated,
  ensureStandaloneSessionHydrated,
  registerProjectSessionView,
  registerStandaloneSessionView, timelineBlockEvent, watchChildSessions
} from "../../lib/orchestration-runtime";
import { timelineEntries } from "../../lib/session-timeline";
import { useSessionTimeline } from "../../lib/use-session-timeline";
import type { TimelineBlock } from "@agenthub/schemas";
import { cachedChangedFileCount } from "../../lib/changed-files";
import { latestTodoGoal } from "../../lib/todo-goal";
import type { SessionTask, TimelineEvent } from "../../lib/types";
import { TodoGoalCard } from "./TodoGoalCard";
import { SessionInspector } from "./SessionInspector";
import { SessionToolsInventory } from "./SessionToolsInventory";
import { SessionActivityRail } from "./SessionActivityRail";
import { WorkspaceDrawer } from "./WorkspaceDrawer";
import { BrowserDrawer } from "./BrowserDrawer";
import { getBridge, requestCore } from "../../lib/bridge";
import { SourceControlDrawer } from "./SourceControlDrawer";
import { WorkflowExecutionDrawer } from "./WorkflowExecutionDrawer";
import { WorkflowDispatchContext, useWorkflowDispatches, workflowDispatchPrompt } from "../workflows/workflow-dispatch";
import { useCoreFeatures } from "../../lib/use-core-features";
import { toast } from "../../stores/toast";

const pendingTitles = new Map<string, Promise<{ title?: string }>>();

export type DrawerKind = "inspector" | "agents" | "terminal" | "artifacts" | "dag" | "source-control" | "browser" | "workflow" | "tools" | null;

// Stable fallbacks: `?? []` inside a selector would return a fresh array on
// every store update and re-render subscribers of empty sessions each token.
const NO_EVENTS: TimelineEvent[] = [];
const NO_TASKS: never[] = [];

function estimateShortMessageHeight(event: TimelineEvent): number | undefined {
  const { data } = event;
  if (data.kind !== "message" || data.sender === "system" || data.attachments?.length || data.references?.length || data.workflowRef
    || data.text.length > 36 || /[\r\n]/.test(data.text)) return undefined;
  return data.sender === "user" ? 71 : 50;
}

function DelegatedTaskCard({ description, status }: { description: string; status?: SessionTask["status"] }): JSX.Element {
  const { t } = useI18n();
  const tone = status === "failed"
    ? "danger"
    : status === "completed"
      ? "ok"
      : status === "running"
        ? "accent"
        : "muted";

  return (
    <article className="rounded-xl border border-line bg-card px-4 py-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-ink-2">
        <ClipboardList size={14} aria-hidden />
        <h2 className="text-xs font-medium">{t("sessions.taskContext.details")}</h2>
        {status && <StatusChip tone={tone} label={t(`sessions.taskStatus.${status}` as MessageKey)}
          className="h-5 px-1.5 text-[10px]" />}
      </div>
      <p className="break-words whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">{description}</p>
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
  filePane,
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
  onOpenLocalFile?: (path: string, diff?: string) => void;
  filePane?: ReactNode;
  focusKey?: string;
}): JSX.Element {
  const { t, locale } = useI18n();
  const navigationLocations = useRef<ConversationLocation[]>([]);
  const [processChoices, setProcessChoices] = useState<Record<string, boolean>>({});
  const setProcessChoice = (id: string, open: boolean): void => setProcessChoices(previous => ({ ...previous, [id]: open }));
  const coreFeatures = useCoreFeatures();
  const session = useSessionsStore((state) => state.sessions.find((item) => item.id === sessionId));
  const activeAgentRunId = useSessionsStore(state => state.activeAgentRunIds[sessionId]);
  const workflowDispatches = useWorkflowDispatches(sessionId, active && Boolean(session?.parentSessionId), activeAgentRunId, session?.status);
  const events = useSessionsStore((state) => state.events[sessionId] ?? NO_EVENTS);
  const extensionUi = useMemo(() => providerUiState(events), [events]);
  const nativeTerminal = useNativeTerminalState(sessionId, active);
  const nativeOwnsSession = nativeTerminal.nativeActive;
  const timelineState = useSessionTimeline(sessionId, active);
  const timeline = timelineState?.timeline;
  const entries = useMemo(() => timeline ? timelineEntries(timeline) : [], [timeline]);
  // Only the commit receiving a live append may start from an empty block.
  // Virtualized remounts and snapshots use the existing text as their seed.
  useLayoutEffect(() => { timelineState?.liveStarts?.clear(); }, [timelineState]);
  const eventsByBlock = useMemo(() => new WeakMap<TimelineBlock, TimelineEvent | undefined>(), [sessionId]);
  const projected = useMemo(() => new Map(timeline?.blocks.flatMap(block => {
    if (!eventsByBlock.has(block)) eventsByBlock.set(block, timelineBlockEvent(sessionId, block));
    const event = eventsByBlock.get(block);
    return event ? [[block.blockId, event] as const] : [];
  })), [timeline?.blocks, sessionId, eventsByBlock]);
  const visibleEvents = useMemo(() => Array.from(projected.values()), [projected]);
  const tasks = useSessionsStore((state) => state.tasks[sessionId] ?? NO_TASKS);
  const foregroundLifecycle = useSessionsStore((state) => state.foreground[sessionId]);
  const orchestrationLifecycle = useSessionsStore((state) => state.running[sessionId]);
  const startEditingMessage = useSessionsStore((state) => state.startEditingMessage);
  const teams = useTeamsStore((state) => state.teams);
  const instances = useAgentsStore((state) => state.instances);
  const projects = useProjectsStore((state) => state.projects);

  const lastUserMessageId = timeline?.blocks.filter(block => block.kind === "user_prompt" || block.kind === "user_append").at(-1)?.blockId;
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
  const workspaceRoot = useRef<HTMLDivElement>(null);
  const [compactTarget, setCompactTarget] = useState<HTMLSpanElement | null>(null);
  useEffect(() => { setShowTodos(false); setSubagentEventId(undefined); }, [sessionId]);

  // Only the numeric badge is subscribed. Streaming text in another session
  // cannot invalidate this page; immutable child timelines reuse their count.
  const changedFileCount = useSessionsStore((state) =>
    cachedChangedFileCount(state.events[sessionId] ?? SESSION_EMPTY.events)
      + state.sessions.filter((item) => item.parentSessionId === sessionId)
        .reduce((count, sub) => count + cachedChangedFileCount(state.events[sub.id] ?? SESSION_EMPTY.events), 0)
  );
  const rootSessionId = session?.parentSessionId ?? sessionId;
  const projectId = session?.projectId;
  const watchLineage = active && coreFeatures.workflows === 1 && (drawer === "inspector" || drawer === "agents" || drawer === "workflow");
  useEffect(() => {
    if (watchLineage && projectId) return watchChildSessions(projectId, rootSessionId);
  }, [watchLineage, projectId, rootSessionId]);
  const runningAgents = useSessionsStore(state => state.sessions.some(item => item.parentSessionId === rootSessionId
    && (item.status === "running" || state.running[item.id]?.status === "running" || state.foreground[item.id]?.status === "running")));

  // Latest TodoList/TodoWrite/update_plan call drives the floating goal card.
  const todoGoal = useMemo(() => latestTodoGoal(events), [events]);

  const handleEditMessage = useCallback(
    (messageId: string, text: string, workflowRef?: WorkflowMention, references?: CapabilityReference[]): void =>
      startEditingMessage(sessionId, messageId, text, workflowRef, references),
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
  const latestDispatch = workflowDispatches.dispatches.at(-1);
  const taskDescription = delegatedTask?.objective?.trim()
    || (latestDispatch && workflowDispatchPrompt(latestDispatch)?.trim())
    || delegatedTask?.title.trim();
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
  const title = session.title?.trim();
  const titleRepeatsTask = !!(title && taskDescription?.startsWith(title));
  const bridge = getBridge();
  const toggleDrawer = (view: Exclude<DrawerKind, null>): void => onOpenDrawer(drawer === view ? null : view);
  const openFolder = bridge?.shell && project?.rootPath ? () => {
    void bridge.shell.openPath(project.rootPath).then(error => { if (error) toast.error(error); }).catch(error => toast.error(String(error)));
  } : undefined;
  const showInspector = drawer === "inspector" || drawer === "agents";
  const toolsTitle = locale === "zh-CN" ? "本次会话工具" : "Session tools";
  // Event IDs are stable across streaming patches. Only the changed row
  // updates; completed Markdown and closed tool details stay untouched.
  const shell = (key: string, node: ReactNode, { compact = false, result = false, estimatedHeight }: {
    compact?: boolean; result?: boolean; estimatedHeight?: number;
  } = {}): TimelineRow => ({
    key, result, estimatedHeight, render: () => (
      <div className={`conversation-message-row mx-auto w-full${result ? " conversation-result" : ""}`} data-process={compact || undefined}>{node}</div>
    )
  });
  const timelineRows: TimelineRow[] = [];
  if (taskDescription) timelineRows.push(shell("delegated", <DelegatedTaskCard description={taskDescription} status={delegatedTask?.status} />));
  const timelineActions = { onEditMessage: handleEditMessage, onOpenSession, onOpenSubagent: handleOpenSubagent, onOpenWorkflow: handleOpenWorkflow, onOpenLocalFile };
  const renderEvent = (event: TimelineEvent): JSX.Element =>
    <TimelineEventView event={event} {...timelineActions} showAuthor={false} streamActive={active} liveStarts={timelineState?.liveStarts} />;
  const closedProcessRows = new Set<string>();
  for (const entry of entries) {
    if ("block" in entry) {
      const { block } = entry;
      if (block.kind === "interaction") {
        const data = (block.result ?? block.content).payload as { interaction?: InteractionRequest };
        if (data?.interaction) timelineRows.push(shell(block.blockId, <InteractionCards sessionId={sessionId} request={data.interaction} />));
      } else {
        const event = projected.get(block.blockId);
        if (!event) continue;
        const result = !!block.runId && timeline?.turns.get(block.runId)?.finalBlockId === block.blockId;
        timelineRows.push(shell(block.blockId, renderEvent(event), { result, estimatedHeight: estimateShortMessageHeight(event) }));
      }
    } else if ("summary" in entry) {
      const open = processChoices[entry.summary.runId] ?? false;
      timelineRows.push(shell("process:" + entry.summary.runId,
        <ConversationTurnView turn={entry.summary} expanded={open} onToggle={() => setProcessChoice(entry.summary.runId, !open)} />,
        { compact: true, estimatedHeight: 42 }));
    } else {
      const running = entry.turn.status === "running";
      const open = running || (processChoices[entry.turn.runId] ?? false);
      const key = entry.process[0].blockId;
      if (!open) closedProcessRows.add(key);
      timelineRows.push(shell(key, <ProcessDisclosure className="conversation-turn-process" open={open}>
        <TurnProcess events={entry.process.map(block => projected.get(block.blockId))}
          liveTail={running && entry === entries.at(-1)} choices={processChoices} setChoice={setProcessChoice} renderEvent={renderEvent} />
      </ProcessDisclosure>, { compact: true, estimatedHeight: open ? entry.process.length * 30 : 0 }));
    }
  }
  if (timelineState?.error) timelineRows.push(shell("timeline-error", <p role="alert" className="text-sm text-danger">{timelineState.error}</p>));
  timelineRows.push(shell("live-activity", (
    <RunActivityIndicator lifecycle={active ? visibleLifecycle : undefined} events={visibleEvents}
      runId={foregroundRunning ? activeAgentRunId : undefined} waitingForDelegates={waitingForDelegates} />
  ), { compact: true, estimatedHeight: workbenchRunning ? 30 : 0 }));
  if (timeline?.blocks.length === 0 && !workbenchRunning) {
    timelineRows.push(shell("empty", (
      <p className="py-16 text-center text-xl font-medium tracking-tight text-ink">
        {locale === "zh-CN" ? "我们要做什么？" : "What shall we work on?"}
      </p>
    )));
  }
  navigationLocations.current = conversationLocations(visibleEvents, timelineRows.map(row => closedProcessRows.has(row.key) ? { key: "" } : row), navigationLocations.current);

  const activityRail = <SessionActivityRail key={sessionId} sessionId={sessionId} projectId={session.projectId}
    openFolder={openFolder} fileCount={changedFileCount} nativeTerminal={nativeOwnsSession} terminalTabs={coreFeatures.terminalTabs === 1} runningAgents={runningAgents}
    actions={{
      inspector: { checked: drawer === "inspector", run: () => toggleDrawer("inspector") },
      terminal: { checked: drawer === "terminal", run: () => toggleDrawer("terminal") },
      browser: bridge?.browser ? { checked: drawer === "browser", run: () => toggleDrawer("browser") } : undefined,
      "source-control": coreFeatures.sourceControl ? { checked: drawer === "source-control", run: () => toggleDrawer("source-control") } : undefined,
      artifacts: {
        checked: drawer === "artifacts",
        run: () => toggleDrawer("artifacts")
      },
      goals: todoGoal ? {
        checked: showTodos,
        run: () => setShowTodos(open => !open)
      } : undefined,
      dag: tasks.length > 0 ? { checked: drawer === "dag", run: () => toggleDrawer("dag") } : undefined,
      workflow: coreFeatures.workflows === 1 && !session.parentSessionId || drawer === "workflow" ? { checked: drawer === "workflow", run: () => {
        if (drawer !== "workflow") setWorkflowInspection(undefined);
        toggleDrawer("workflow");
      } } : undefined,
      agents: { checked: drawer === "agents", run: () => toggleDrawer("agents") },
      tools: { checked: drawer === "tools", run: () => toggleDrawer("tools") }
    }} />;

  return (
    <div ref={workspaceRoot} className="session-activity-layout flex h-full min-h-0 min-w-0 flex-1">
    <div className="conversation-workspace relative flex h-full min-h-0 min-w-0 flex-1">
      <div className="session-chat-column relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="workspace-conversation-header relative flex min-h-14 shrink-0 items-center justify-between gap-x-3 px-5 py-3 sm:px-7">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 title={[project?.name, project?.rootPath, targetName].filter(Boolean).join(" · ")} className="truncate text-[15px] font-medium text-ink">{titleRepeatsTask ? targetName : title || t("sessions.header.untitled")}</h1>
            {!titleRepeatsTask && <span data-testid="session-fixed-agent" title={locale === "zh-CN" ? "会话 Agent 已固定；账号、供应商和模型可在下方选择，下一轮生效。" : "Agent is fixed for this conversation. Change account, provider or model below for the next message."} className="inline-flex max-w-48 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface/50 px-2 py-1 text-xs text-muted"><span aria-hidden>◈</span><span className="truncate">{targetName}</span></span>}
            {(visibleStatus === "waiting_approval" || visibleStatus === "failed") && <StatusChip
              tone={visibleStatus === "waiting_approval" ? "warn" : "danger"}
              label={t(`sessions.status.${visibleStatus}` as MessageKey)}
            />}
          </div>

        </div>
        <div className="flex shrink-0 items-center gap-2">
          {headerActions}
          {active && project && openFolder && <button type="button" className="workspace-panel-icon" aria-label={t("sessions.workspace.openFolder", { name: project.name })}
            aria-keyshortcuts="F" title={`${project.name} · ${project.rootPath}`} onClick={openFolder}><FolderOpen size={15} aria-hidden /></button>}
        </div>
      </header>

      <div className="session-chat-timeline relative min-h-0 flex-1" data-run-state={waitingForApproval ? "waiting" : workbenchRunning ? "running" : session.status === "failed" ? "failed" : "idle"}>
      <WorkflowDispatchContext.Provider value={workflowDispatches}><TimelineViewport
        focusKey={focusKey}
        rows={timelineRows}
        sessionKey={sessionId}
        contentKey={timeline?.blocks}
        forceFollowKey={lastUserMessageId}
        locations={navigationLocations.current}
        active={active}
        className="session-chat-scroll"
      /></WorkflowDispatchContext.Provider>
      {todoGoal && showTodos && <TodoGoalCard todos={todoGoal} onClose={() => {
        setShowTodos(false);
        workspaceRoot.current?.querySelector<HTMLButtonElement>('[data-activity="goals"]')?.focus({ preventScroll: true });
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
      <AnimatePresence initial={false}>
        {active && showInspector && <SessionInspector key="inspector" session={session} events={visibleEvents} lineageOnly={drawer === "agents"} onClose={onCloseDrawer} onOpenSession={onOpenSession} compactSlot={setCompactTarget} />}
        {drawer === "workflow" && active && <WorkflowExecutionDrawer
          key={workflowInspection?.sessionId === sessionId ? workflowInspection.runId : `workflow:${sessionId}`} sessionId={sessionId}
          runId={workflowInspection?.sessionId === sessionId ? workflowInspection.runId : undefined} onClose={onCloseDrawer} onOpenSession={openWorkflowConversation} />}
        {active && drawer === "tools" && <WorkspaceDrawer key="tools" open title={toolsTitle} onClose={onCloseDrawer} defaultWidth={380} minWidth={300}
          resizable storageKey="nautilo.sessionTools.width" animateReview="slide" className="session-tools-drawer">
          <SessionToolsInventory key={sessionId} sessionId={sessionId} />
        </WorkspaceDrawer>}
      </AnimatePresence>
      <ArtifactsDrawer open={drawer === "artifacts" && active} onClose={onCloseDrawer} sessionId={sessionId} />
      {drawer === "browser" && active && getBridge()?.browser && <BrowserDrawer key={sessionId} sessionId={sessionId} onClose={onCloseDrawer} />}
      <SourceControlDrawer open={drawer === "source-control" && active && !!coreFeatures.sourceControl} onClose={onCloseDrawer} sessionId={sessionId} projectId={project?.id} />
      <DagDrawer open={active && drawer === "dag"} onClose={onCloseDrawer} tasks={tasks} />
      <SubagentDrawer open={!!subagentEventId} onClose={() => setSubagentEventId(undefined)} sessionId={sessionId} eventId={subagentEventId} />
      {filePane}
    </div>
    {active && activityRail}
    </div>
  );
}
