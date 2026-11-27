import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { conversationLocations, type ConversationLocation } from "../../lib/conversation-navigation";
import { ArrowLeft, Folder, FolderOpen } from "lucide-react";
import { ProviderAvatar } from "../../components/ui/IdentityAvatar";
import { useConnectionsStore } from "../../stores/connections";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { NativeSubagentGroup, TaskUpdateGroup, TimelineEventView, type TimelineRow, TimelineViewport } from "../timeline/Timeline";
import { ConversationTurnView } from "../timeline/ConversationTurnView";
import { ProcessDisclosure } from "../timeline/ProcessDisclosure";
import { TurnProcess } from "../timeline/ToolStepGroup";
import { StatusChip } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { DelegatedTaskCard } from "./DelegatedTaskCard";
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
import type { IpcRequestMap, TimelineBlock } from "@agenthub/schemas";
import { cachedChangedFileCount } from "../../lib/changed-files";
import { latestTodoGoal } from "../../lib/todo-goal";
import type { TimelineEvent } from "../../lib/types";
import { TodoGoalCard } from "./TodoGoalCard";
import { SessionInspector } from "./SessionInspector";
import { SessionToolsInventory } from "./SessionToolsInventory";
import {
  DOCK_TOOL_ICONS,
  SessionHeaderDockControls,
  SessionSideDock,
  type DockActiveTab,
  type DockTabKind,
  type DockToolDescriptor,
} from "./SessionSideDock";
import { useContextUsage } from "./ContextUsageIndicator";
import { sourceControlClient } from "./source-control-client";
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
  const connections = useConnectionsStore((state) => state.connections);
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
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(() => {
    try { return window.localStorage.getItem("nautilo.inspector.open") !== "false"; } catch { return true; }
  });
  const [dockOpen, setDockOpen] = useState(false);
  const [dockTabs, setDockTabs] = useState<DockTabKind[]>([]);
  const [dockActive, setDockActive] = useState<DockActiveTab>("launcher");
  const [gitDirty, setGitDirty] = useState(false);
  const [shellRunning, setShellRunning] = useState(false);
  const workspaceRoot = useRef<HTMLDivElement>(null);
  const [compactTarget, setCompactTarget] = useState<HTMLSpanElement | null>(null);
  const { percentage: contextPercent } = useContextUsage(sessionId);
  useEffect(() => {
    try { window.localStorage.setItem("nautilo.inspector.open", String(inspectorOpen)); } catch { /* Storage optional. */ }
  }, [inspectorOpen]);
  useEffect(() => {
    setShowTodos(false);
    setSubagentEventId(undefined);
  }, [sessionId]);

  const prevExternalDrawer = useRef<DrawerKind>(null);
  useEffect(() => {
    const prev = prevExternalDrawer.current;
    prevExternalDrawer.current = drawer;
    if (drawer === "inspector") {
      setInspectorOpen(true);
    } else if (drawer) {
      const tab = drawer as DockTabKind;
      setDockTabs(current => current.includes(tab) ? current : [...current, tab]);
      setDockActive(tab);
      setDockOpen(true);
    } else if (prev === "inspector") {
      setInspectorOpen(false);
    } else if (prev) {
      setDockOpen(false);
    }
  }, [drawer]);

  const openDockTool = useCallback((tab: DockTabKind, keepWorkflowInspection = false): void => {
    setSubagentEventId(undefined);
    if (tab === "workflow" && !keepWorkflowInspection) setWorkflowInspection(undefined);
    setDockTabs(current => current.includes(tab) ? current : [...current, tab]);
    setDockActive(tab);
    setDockOpen(true);
    onOpenDrawer(tab);
  }, [onOpenDrawer]);

  const toggleDockTool = useCallback((tab: DockTabKind): void => {
    if (dockOpen && dockActive === tab) {
      setDockOpen(false);
      onCloseDrawer();
    } else {
      openDockTool(tab);
    }
  }, [dockOpen, dockActive, onCloseDrawer, openDockTool]);

  const closeDockTab = useCallback((tab: DockTabKind): void => {
    const idx = dockTabs.indexOf(tab);
    if (idx < 0) return;
    const next = dockTabs.filter(item => item !== tab);
    setDockTabs(next);
    if (next.length === 0) {
      setDockOpen(false);
      setDockActive("launcher");
      onCloseDrawer();
    } else if (dockActive === tab) {
      setDockActive(next[Math.min(idx, next.length - 1)]!);
    }
  }, [dockTabs, dockActive, onCloseDrawer]);

  const closeDock = useCallback((): void => {
    setDockOpen(false);
    onCloseDrawer();
  }, [onCloseDrawer]);

  const toggleDock = useCallback((): void => {
    if (dockOpen) {
      setDockOpen(false);
      onCloseDrawer();
    } else {
      if (dockTabs.length === 0) setDockActive("launcher");
      else if (dockActive === "launcher") setDockActive(dockTabs[0]!);
      setDockOpen(true);
    }
  }, [dockOpen, dockTabs, dockActive, onCloseDrawer]);

  const toggleInspector = useCallback((): void => {
    setInspectorOpen(open => {
      const next = !open;
      if (!next && drawer === "inspector") onCloseDrawer();
      return next;
    });
  }, [drawer, onCloseDrawer]);

  const closeInspector = useCallback((): void => {
    setInspectorOpen(false);
    if (drawer === "inspector") onCloseDrawer();
  }, [drawer, onCloseDrawer]);

  // Only the numeric badge is subscribed. Streaming text in another session
  // cannot invalidate this page; immutable child timelines reuse their count.
  const changedFileCount = useSessionsStore((state) =>
    cachedChangedFileCount(state.events[sessionId] ?? SESSION_EMPTY.events)
      + state.sessions.filter((item) => item.parentSessionId === sessionId)
        .reduce((count, sub) => count + cachedChangedFileCount(state.events[sub.id] ?? SESSION_EMPTY.events), 0)
  );
  const rootSessionId = session?.parentSessionId ?? sessionId;
  const projectId = session?.projectId;
  const watchLineage = active && coreFeatures.workflows === 1 && (inspectorOpen || (dockOpen && (dockActive === "agents" || dockActive === "workflow")));
  useEffect(() => {
    if (watchLineage && projectId) return watchChildSessions(projectId, rootSessionId);
  }, [watchLineage, projectId, rootSessionId]);
  const runningAgents = useSessionsStore(state => state.sessions.some(item => item.parentSessionId === rootSessionId
    && (item.status === "running" || state.running[item.id]?.status === "running" || state.foreground[item.id]?.status === "running")));

  // Live Git dirty & running terminal indicators for header overview & dock tabs.
  useEffect(() => {
    if (!active || !projectId) return;
    const scope = { sessionId, projectId };
    let disposed = false;
    let lastGitRead = 0;
    const hasGit = Boolean(coreFeatures.sourceControl);
    const hasTerminalTabs = coreFeatures.terminalTabs === 1;
    const refreshGit = (): void => {
      if (!hasGit || document.hidden) return;
      lastGitRead = Date.now();
      void sourceControlClient.status(scope).then(status => {
        if (!disposed) setGitDirty(status.available && status.changes.length > 0);
      }, () => { if (!disposed) setGitDirty(false); });
    };
    let readingTerminals = false;
    const refreshTerminals = (): void => {
      if (!hasTerminalTabs || document.hidden || readingTerminals) return;
      readingTerminals = true;
      void requestCore<IpcRequestMap["terminal.list"]["output"]>("terminal.list", { sessionId }).then(({ items }) => {
        if (!disposed) setShellRunning(items.some(item => !item.exited));
      }, () => { if (!disposed) setShellRunning(false); }).finally(() => { readingTerminals = false; });
    };
    const refresh = (): void => { refreshGit(); refreshTerminals(); };
    refresh();
    const timer = window.setInterval(() => {
      if (!document.hasFocus()) return;
      if (Date.now() - lastGitRead >= 30_000) refreshGit();
      refreshTerminals();
    }, 10_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("nautilo:source-control-changed", refreshGit);
    window.addEventListener("nautilo:terminal-state", refreshTerminals);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("nautilo:source-control-changed", refreshGit);
      window.removeEventListener("nautilo:terminal-state", refreshTerminals);
    };
  }, [active, coreFeatures.sourceControl, coreFeatures.terminalTabs, sessionId, projectId]);

  const shortcutHandlers = useRef<Record<string, (() => void) | undefined>>({});
  useEffect(() => {
    if (!active) return;
    const onShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      const key = event.key.toUpperCase();
      const run = shortcutHandlers.current[key];
      if (run) {
        event.preventDefault();
        run();
      }
    };
    document.addEventListener("keydown", onShortcut);
    return () => document.removeEventListener("keydown", onShortcut);
  }, [active]);

  // Latest TodoList/TodoWrite/update_plan call drives the floating goal card.
  const todoGoal = useMemo(() => latestTodoGoal(events), [events]);

  const handleEditMessage = useCallback(
    (messageId: string, text: string, workflowRef?: WorkflowMention, references?: CapabilityReference[]): void =>
      startEditingMessage(sessionId, messageId, text, workflowRef, references),
    [sessionId, startEditingMessage]
  );
  const handleOpenSubagent = useCallback((eventId: string): void => {
    setDockOpen(false);
    onOpenDrawer(null);
    setSubagentEventId(eventId);
  }, [onOpenDrawer]);
  useEffect(() => { if (drawer) setSubagentEventId(undefined); }, [drawer]);
  const handleOpenWorkflow = useCallback((runId: string): void => {
    setWorkflowInspection({ sessionId, runId });
    openDockTool("workflow", true);
  }, [sessionId, openDockTool]);
  const openWorkflowConversation = useCallback((id: string): void => {
    closeDock();
    if (id !== sessionId) onOpenSession(id);
  }, [closeDock, onOpenSession, sessionId]);

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
  const sessionProviderId = (() => {
    const target = session.target;
    if (target.type === "agent") {
      const inst = instances.find(item => item.id === target.instanceId);
      if (inst?.providerId) return inst.providerId;
    } else if (target.type === "member") {
      const member = teams.find(team => team.id === target.teamId)?.members.find(m => m.id === target.memberId);
      const inst = member ? instances.find(item => item.id === member.agentInstanceId) : undefined;
      if (inst?.providerId) return inst.providerId;
    }
    return session.connectionId ? connections.find(c => c.id === session.connectionId)?.harness : undefined;
  })();
  const zh = locale === "zh-CN";
  const title = session.title?.trim();
  const titleRepeatsTask = !!(title && taskDescription?.startsWith(title));
  const bridge = getBridge();
  const openFolder = bridge?.shell && project?.rootPath ? () => {
    void bridge.shell.openPath(project.rootPath).then(error => { if (error) toast.error(error); }).catch(error => toast.error(String(error)));
  } : undefined;
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
  const latestDispatchNode = latestDispatch
    ? latestDispatch.run.definition.nodes.find((node) => node.id === latestDispatch.instance.nodeId)
    : undefined;
  if (taskDescription) {
    timelineRows.push(shell(
      "delegated",
      <DelegatedTaskCard
        description={taskDescription}
        status={delegatedTask?.status}
        workflowName={latestDispatch?.run.definition.name}
        nodeName={latestDispatchNode?.name}
        role={latestDispatchNode?.role}
        attempt={latestDispatch?.instance.attempt}
        onOpenParent={session.parentSessionId ? () => onOpenSession(session.parentSessionId!) : undefined}
      />
    ));
  }
  const timelineActions = { onEditMessage: handleEditMessage, onOpenSession, onOpenSubagent: handleOpenSubagent, onOpenWorkflow: handleOpenWorkflow, onOpenLocalFile };
  const renderEvent = (event: TimelineEvent): JSX.Element =>
    <TimelineEventView event={event} {...timelineActions} showAuthor={false} streamActive={active} liveStarts={timelineState?.liveStarts} />;
  const renderSubagentGroup = (group: readonly (TimelineEvent & { data: { kind: "tool_activity" } })[]): JSX.Element | null =>
    <NativeSubagentGroup events={group} onOpenSubagent={handleOpenSubagent} />;
  const closedProcessRows = new Set<string>();
  const pushProcessEntry = (entry: Extract<typeof entries[number], { process: unknown }>): void => {
    const running = entry.turn.status === "running";
    const open = running || (processChoices[entry.turn.runId] ?? false);
    const key = entry.process[0].blockId;
    if (!open) closedProcessRows.add(key);
    timelineRows.push(shell(key, <ProcessDisclosure className="conversation-turn-process" open={open}>
      <TurnProcess events={entry.process.map(block => projected.get(block.blockId))}
        liveTail={running && entry === entries.at(-1)} choices={processChoices} setChoice={setProcessChoice}
        renderEvent={renderEvent} renderSubagentGroup={renderSubagentGroup} />
    </ProcessDisclosure>, { compact: true, estimatedHeight: open ? entry.process.length * 30 : 0 }));
  };
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex]!;
    if ("block" in entry) {
      const { block } = entry;
      if (block.kind === "interaction") {
        const data = (block.result ?? block.content).payload as { interaction?: InteractionRequest };
        if (data?.interaction) timelineRows.push(shell(block.blockId, <InteractionCards sessionId={sessionId} request={data.interaction} />));
      } else {
        const event = projected.get(block.blockId);
        if (!event) continue;
        if (event.data.kind === "task_update") {
          const group: (TimelineEvent & { data: { kind: "task_update" } })[] = [
            event as TimelineEvent & { data: { kind: "task_update" } }
          ];
          const interleavedProcess: Extract<typeof entries[number], { process: unknown }>[] = [];
          let lookahead = entryIndex + 1;
          while (lookahead < entries.length) {
            const candidate = entries[lookahead]!;
            if ("block" in candidate && candidate.block.kind !== "interaction") {
              const nextEvent = projected.get(candidate.block.blockId);
              if (nextEvent && nextEvent.data.kind === "task_update"
                && (!block.runId || !candidate.block.runId || candidate.block.runId === block.runId)) {
                group.push(nextEvent as TimelineEvent & { data: { kind: "task_update" } });
                entryIndex = lookahead;
                lookahead++;
                continue;
              }
              break;
            }
            if ("process" in candidate && block.runId && candidate.turn.runId === block.runId) {
              // Parallel dispatches in one turn interleave tool_call process entries
              // between task.updated blocks; bridge across them only if another task_update follows.
              const hasVisibleCommentary = candidate.process.some((item) => {
                const ev = projected.get(item.blockId);
                return ev?.data.kind === "message" && ev.data.sender === "agent";
              });
              if (hasVisibleCommentary) break;
              interleavedProcess.push(candidate);
              lookahead++;
              continue;
            }
            break;
          }
          // Only hoist process entries that actually sat between grouped tasks (not trailing ones).
          const hoistedCount = interleavedProcess.filter((proc) => entries.indexOf(proc) < entryIndex).length;
          for (let i = 0; i < hoistedCount; i++) pushProcessEntry(interleavedProcess[i]!);
          timelineRows.push(shell(
            block.blockId,
            <TaskUpdateGroup events={group} onOpenSession={onOpenSession} />,
            { estimatedHeight: 72 + group.length * 124 }
          ));
          continue;
        }
        const result = !!block.runId && timeline?.turns.get(block.runId)?.finalBlockId === block.blockId;
        timelineRows.push(shell(block.blockId, renderEvent(event), { result, estimatedHeight: estimateShortMessageHeight(event) }));
      }
    } else if ("summary" in entry) {
      const open = processChoices[entry.summary.runId] ?? false;
      timelineRows.push(shell("process:" + entry.summary.runId,
        <ConversationTurnView turn={entry.summary} expanded={open} onToggle={() => setProcessChoice(entry.summary.runId, !open)} />,
        { compact: true, estimatedHeight: 42 }));
    } else {
      pushProcessEntry(entry);
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

  const dockTools: DockToolDescriptor[] = [
    {
      id: "artifacts",
      label: zh ? "审查 · 文件更改" : "Review · Changes",
      description: zh ? "逐行审阅会话修改、切换合并/并排对比并撤回" : "Review session diffs, compare side-by-side, or revert edits",
      icon: DOCK_TOOL_ICONS.artifacts,
      shortcut: "D",
      available: true,
      badge: changedFileCount > 0 ? (changedFileCount > 99 ? "99+" : changedFileCount) : undefined,
      tone: changedFileCount > 0 ? "accent" : undefined,
    },
    {
      id: "source-control",
      label: t("sessions.workspace.git"),
      description: zh ? "查看工作区 Git 变更、暂存、提交与分支历史" : "Inspect Git status, stage changes, commit, and view history",
      icon: DOCK_TOOL_ICONS["source-control"],
      shortcut: "G",
      available: Boolean(coreFeatures.sourceControl),
      tone: gitDirty ? "warn" : undefined,
    },
    {
      id: "terminal",
      label: t("sessions.workspace.terminal"),
      description: zh ? "交互式终端、原生 CLI 接管与实时运行日志" : "Interactive shell tabs, native CLI handoff, and live logs",
      icon: DOCK_TOOL_ICONS.terminal,
      shortcut: "T",
      available: true,
      tone: nativeOwnsSession || (coreFeatures.terminalTabs === 1 && shellRunning) ? "ok" : undefined,
    },
    {
      id: "tools",
      label: zh ? "本次会话工具" : "Session tools",
      description: zh ? "查看已实际调用、原生加载及已传入的 MCP / 工具清单" : "Inspect called tools, native capabilities, and MCP servers",
      icon: DOCK_TOOL_ICONS.tools,
      shortcut: "M",
      available: true,
    },
    {
      id: "agents",
      label: t("sessions.workspace.agents"),
      description: zh ? "追踪主会话与并行派发的子 Agent 会话谱系" : "Track delegated child sessions and sub-agent execution",
      icon: DOCK_TOOL_ICONS.agents,
      shortcut: "A",
      available: true,
      tone: runningAgents ? "accent" : undefined,
    },
    {
      id: "workflow",
      label: t("nav.workflows"),
      description: zh ? "查看当前会话触发的工作流节点进度与执行记录" : "Inspect workflow run stages and node executions",
      icon: DOCK_TOOL_ICONS.workflow,
      shortcut: "W",
      available: (coreFeatures.workflows === 1 && !session.parentSessionId) || dockTabs.includes("workflow"),
    },
    {
      id: "browser",
      label: t("sessions.workspace.browser"),
      description: zh ? "内置可视化浏览器预览、元素拾取与页面诊断" : "Built-in live browser preview, element picker, and diagnostics",
      icon: DOCK_TOOL_ICONS.browser,
      shortcut: "B",
      available: Boolean(bridge?.browser),
    },
    {
      id: "dag",
      label: t("sessions.header.dag"),
      description: zh ? "可视化查看团队协作任务依赖拓扑与状态" : "Visualize task dependency graph and execution status",
      icon: DOCK_TOOL_ICONS.dag,
      shortcut: "P",
      available: tasks.length > 0 || dockTabs.includes("dag"),
      badge: tasks.length > 0 ? tasks.length : undefined,
    },
  ];

  const availableToolIds = new Set(dockTools.filter(tool => tool.available).map(tool => tool.id));
  const visibleDockTabs = dockTabs.filter(tab => availableToolIds.has(tab));
  const effectiveDockActive: DockActiveTab = dockActive === "launcher"
    ? "launcher"
    : visibleDockTabs.includes(dockActive)
      ? dockActive
      : visibleDockTabs[0] ?? "launcher";

  shortcutHandlers.current = {
    C: toggleInspector,
    D: () => toggleDockTool("artifacts"),
    G: availableToolIds.has("source-control") ? () => toggleDockTool("source-control") : undefined,
    T: () => toggleDockTool("terminal"),
    M: () => toggleDockTool("tools"),
    I: () => toggleDockTool("tools"),
    A: () => toggleDockTool("agents"),
    W: availableToolIds.has("workflow") ? () => toggleDockTool("workflow") : undefined,
    B: availableToolIds.has("browser") ? () => toggleDockTool("browser") : undefined,
    P: availableToolIds.has("dag") ? () => toggleDockTool("dag") : undefined,
    L: todoGoal ? () => setShowTodos(open => !open) : undefined,
    F: openFolder,
  };

  const renderDockTabContent = (tab: DockTabKind, isActive: boolean): ReactNode => {
    switch (tab) {
      case "artifacts":
        return <ArtifactsDrawer open sessionId={sessionId} onClose={() => closeDockTab("artifacts")} />;
      case "source-control":
        return <SourceControlDrawer open={Boolean(coreFeatures.sourceControl)} sessionId={sessionId} projectId={project?.id} onClose={() => closeDockTab("source-control")} />;
      case "terminal":
        return <TerminalDrawer open={active && dockOpen && isActive} sessionId={sessionId} onClose={() => closeDockTab("terminal")} />;
      case "browser":
        return bridge?.browser ? (
          <BrowserDrawer key={sessionId} sessionId={sessionId} surfaceSuspended={!(active && dockOpen && isActive)} onClose={() => closeDockTab("browser")} />
        ) : null;
      case "workflow":
        return (
          <WorkflowExecutionDrawer
            key={workflowInspection?.sessionId === sessionId ? workflowInspection.runId : `workflow:${sessionId}`}
            sessionId={sessionId}
            runId={workflowInspection?.sessionId === sessionId ? workflowInspection.runId : undefined}
            onClose={() => closeDockTab("workflow")}
            onOpenSession={openWorkflowConversation}
          />
        );
      case "agents":
        return (
          <SessionInspector
            session={session}
            events={visibleEvents}
            lineageOnly
            onClose={() => closeDockTab("agents")}
            onOpenSession={onOpenSession}
            compactSlot={() => {}}
          />
        );
      case "tools":
        return <SessionToolsInventory key={sessionId} sessionId={sessionId} />;
      case "dag":
        return <DagDrawer open tasks={tasks} onClose={() => closeDockTab("dag")} />;
      default:
        return null;
    }
  };

  return (
    <div ref={workspaceRoot} className="session-activity-layout flex h-full min-h-0 min-w-0 flex-1">
    <div className="conversation-workspace relative flex h-full min-h-0 min-w-0 flex-1">
      <div className="session-chat-column relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        className="workspace-conversation-header relative flex shrink-0 items-center justify-between gap-x-2.5 px-3 sm:px-4"
        data-run-state={waitingForApproval ? "waiting" : workbenchRunning ? "running" : session.status === "failed" ? "failed" : "idle"}
      >
        {(workbenchRunning || waitingForApproval) && (
          <span className="session-header-runline" data-state={waitingForApproval ? "waiting" : "running"} aria-hidden />
        )}
        <div className="session-header-left">
          {session.parentSessionId && (
            <button
              type="button"
              className="session-header-back"
              onClick={() => onOpenSession(session.parentSessionId!)}
              title={zh ? "返回主会话" : "Back to parent session"}
            >
              <ArrowLeft size={12} aria-hidden />
              <span>{zh ? "主会话" : "Parent"}</span>
            </button>
          )}
          {project && (
            openFolder ? (
              <button
                type="button"
                className="session-header-project"
                onClick={openFolder}
                title={t("sessions.workspace.openFolder", { name: project.name })}
              >
                <Folder size={12} aria-hidden />
                <span>{project.name}</span>
              </button>
            ) : (
              <span className="session-header-project" title={project.rootPath}>
                <Folder size={12} aria-hidden />
                <span>{project.name}</span>
              </span>
            )
          )}
          {project && <span className="session-header-sep" aria-hidden>/</span>}
          <h1
            title={[project?.name, project?.rootPath, targetName].filter(Boolean).join(" · ")}
            className="session-header-title"
          >
            {titleRepeatsTask ? targetName : title || t("sessions.header.untitled")}
          </h1>
          {!titleRepeatsTask && (
            <span
              data-testid="session-fixed-agent"
              title={zh ? "会话 Agent 已固定；账号、供应商和模型可在下方选择，下一轮生效。" : "Agent is fixed for this conversation. Change account, provider or model below for the next message."}
              className="session-header-harness"
            >
              {sessionProviderId ? <ProviderAvatar providerId={sessionProviderId} size="sm" /> : <span aria-hidden>◈</span>}
              <span className="truncate">{targetName}</span>
              {session.model && <span className="session-header-model">· {session.model}</span>}
              {workbenchRunning && <span className="session-header-live-dot" aria-hidden />}
            </span>
          )}
          {(visibleStatus === "waiting_approval" || visibleStatus === "failed") && <StatusChip
            tone={visibleStatus === "waiting_approval" ? "warn" : "danger"}
            label={t(`sessions.status.${visibleStatus}` as MessageKey)}
          />}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {headerActions}
          {active && project && openFolder && <button type="button" className="workspace-panel-icon" aria-label={t("sessions.workspace.openFolder", { name: project.name })}
            aria-keyshortcuts="F" title={`${project.name} · ${project.rootPath}`} onClick={openFolder}><FolderOpen size={15} aria-hidden /></button>}
          {active && (
            <SessionHeaderDockControls
              contextPercent={contextPercent}
              inspectorOpen={inspectorOpen}
              onToggleInspector={toggleInspector}
              dockOpen={dockOpen}
              onToggleDock={toggleDock}
              openTabCount={visibleDockTabs.length}
              tools={dockTools}
              onOpenTool={tab => openDockTool(tab)}
              todoCount={todoGoal ? todoGoal.filter(item => item.status !== "done").length : undefined}
              goalsOpen={showTodos}
              onToggleGoals={todoGoal ? () => setShowTodos(open => !open) : undefined}
            />
          )}
        </div>
      </header>

      <AnimatePresence initial={false}>
        {active && inspectorOpen && (
          <SessionInspector
            key="inspector-float"
            floating
            session={session}
            events={visibleEvents}
            lineageOnly={false}
            onClose={closeInspector}
            onOpenSession={onOpenSession}
            compactSlot={setCompactTarget}
          />
        )}
      </AnimatePresence>

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
      {nativeOwnsSession && <div className="mx-auto flex w-full max-w-[1000px] items-center justify-between gap-3 px-5 pb-2 text-[13px] text-ink-2"><span>{nativeTerminal.historySync?.status === "failed" ? (locale === "zh-CN" ? "原生历史同步失败，请在终端中重试" : "Native history sync failed. Retry in the terminal.") : nativeTerminal.historySync?.status === "syncing" ? (locale === "zh-CN" ? "正在同步原生会话历史" : "Syncing native session history") : (locale === "zh-CN" ? "会话正在原生终端中运行" : "Session is active in the native terminal")}</span><Button variant="ghost" size="sm" onClick={() => openDockTool("terminal")}>{locale === "zh-CN" ? "返回终端" : "Open terminal"}</Button></div>}
      <Composer
        sessionId={sessionId}
        compactTarget={compactTarget}
        targetName={targetName}
        running={workbenchRunning}
        disabled={session.status === "archived" || nativeOwnsSession}
      />
      </div>

      {active && dockOpen && (
        <SessionSideDock
          open
          tabs={visibleDockTabs}
          activeTab={effectiveDockActive}
          tools={dockTools}
          onSelectTab={setDockActive}
          onCloseTab={closeDockTab}
          onOpenTool={tab => openDockTool(tab)}
          onOpenLauncher={() => setDockActive("launcher")}
          onCloseDock={closeDock}
          renderTabContent={renderDockTabContent}
        />
      )}

      <SubagentDrawer open={!!subagentEventId} onClose={() => setSubagentEventId(undefined)} sessionId={sessionId} eventId={subagentEventId} />
      {filePane}
    </div>
    </div>
  );
}
