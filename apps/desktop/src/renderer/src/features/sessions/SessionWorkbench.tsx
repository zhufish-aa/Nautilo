import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GitFork, FileDiff, Package, SquareTerminal } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { TimelineEventView } from "../timeline/Timeline";
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
import type { TimelineEvent } from "../../lib/types";
import { TodoGoalCard } from "./TodoGoalCard";

export type DrawerKind = "terminal" | "artifacts" | "dag" | null;

// Stable fallbacks: `?? []` inside a selector would return a fresh array on
// every store update and re-render subscribers of empty sessions each token.
const NO_EVENTS: TimelineEvent[] = [];
const NO_TASKS: never[] = [];

export function SessionWorkbench({
  sessionId,
  active = true,
  drawer,
  onOpenDrawer,
  onCloseDrawer,
  onOpenSession,
  mode = "code",
  headerActions
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
}): JSX.Element {
  const { t } = useI18n();
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  // Depend on the last event object, not just its id: tool-group and streaming
  // rows update in place (stable id, growing content) and must also trigger
  // the scroll-to-bottom.
  const lastEvent = events[events.length - 1];

  useEffect(() => {
    if (!nearBottomRef.current) return;
    // Coalesce to one scroll per animation frame: deltas update the last row
    // many times per second and each scrollTo forces a layout read.
    if (scrollFrameRef.current !== undefined) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      // Re-check at flush time: the user may have scrolled up since scheduling.
      if (nearBottomRef.current) {
        // "auto", not "smooth": deltas arrive many times per second and queued
        // smooth animations are a major source of streaming jank.
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "auto" });
      }
    });
  }, [lastEvent]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useEffect(() => {
    nearBottomRef.current = true;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [sessionId]);

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
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="relative h-full overflow-y-auto"
        aria-live="polite"
      >
        <div className={cn("mx-auto flex w-full flex-col px-5 py-7", isWork ? "max-w-3xl gap-8" : "max-w-4xl gap-9")}>
          {turns.map((turn, index) => {
            const live = index === turns.length - 1
              ? waitingForApproval ? "waiting" : workbenchRunning ? "running" : undefined
              : undefined;
            return (
              <section key={turn.key} className="turn-block pl-6" data-live={live}>
                {turn.header && (
                  <TimelineEventView
                    event={turn.header}
                    onEditMessage={handleEditMessage}
                  />
                )}
                {turn.items.length > 0 && (
                  <div className="mt-4 flex flex-col gap-4">
                    {turn.items.map((event) => (
                      <TimelineEventView
                        key={event.id}
                        event={event}
                        onViewDiff={handleViewDiff}
                        onOpenSession={onOpenSession}
                        onOpenSubagent={setSubagentEventId}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
          <RunActivityIndicator lifecycle={visibleLifecycle} events={events} waitingForDelegates={waitingForDelegates} />
          <InteractionCards sessionId={sessionId} />
          {events.length === 0 && (
            <p className="py-16 text-center text-sm text-ink-3">{t("sessions.noSelection")}</p>
          )}
        </div>
      </div>
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
