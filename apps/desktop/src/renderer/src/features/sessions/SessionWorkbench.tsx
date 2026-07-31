import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GitFork, FileDiff, Package, SquareTerminal } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { TimelineEventView } from "../timeline/Timeline";
import { StatusChip } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Composer } from "./Composer";
import { ArtifactsDrawer, DagDrawer, SubagentDrawer, TerminalDrawer } from "./Drawers";
import { RunActivityIndicator } from "./RunActivityIndicator";
import { sessionTargetName } from "./SessionListPanel";
import { useSessionsStore } from "../../stores/sessions";
import { InteractionCards } from "./InteractionCards";
import { useFilePreviewStore } from "../../stores/file-preview";
import { useProjectsStore } from "../../stores/projects";
import { useTeamsStore } from "../../stores/teams";
import { useAgentsStore } from "../../stores/agents";
import { toast } from "../../stores/toast";
import { hasRunningDelegatedTask, isActiveLifecycle, visibleSessionStatus } from "../../lib/session-lifecycle";
import { collectChangedFiles } from "../../lib/changed-files";
import { latestTodoGoal } from "../../lib/todo-goal";
import { requestCore } from "../../lib/bridge";
import type { CheckpointRevertPreview, TimelineEvent } from "../../lib/types";
import { TodoGoalCard } from "./TodoGoalCard";

export type DrawerKind = "terminal" | "artifacts" | "dag" | null;

// Stable fallbacks: `?? []` inside a selector would return a fresh array on
// every store update and re-render subscribers of empty sessions each token.
const NO_EVENTS: TimelineEvent[] = [];
const NO_TASKS: never[] = [];
const NO_CHECKPOINTS: never[] = [];

export function SessionWorkbench({
  sessionId,
  drawer,
  onOpenDrawer,
  onCloseDrawer,
  onOpenSession,
  mode = "code",
  headerActions
}: {
  sessionId: string;
  drawer: DrawerKind;
  onOpenDrawer: (drawer: DrawerKind) => void;
  onCloseDrawer: () => void;
  onOpenSession: (sessionId: string) => void;
  /** "work" hides code-centric affordances (diffs, terminal, checkpoints). */
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
  const checkpoints = useSessionsStore((state) => state.checkpoints[sessionId] ?? NO_CHECKPOINTS);
  const teams = useTeamsStore((state) => state.teams);
  const instances = useAgentsStore((state) => state.instances);
  const projects = useProjectsStore((state) => state.projects);

  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  // Depend on the last event object, not just its id: tool-group and streaming
  // rows update in place (stable id, growing content) and must also trigger
  // the scroll-to-bottom.
  const lastEvent = events[events.length - 1];

  useEffect(() => {
    if (nearBottomRef.current) {
      // "auto", not "smooth": deltas arrive many times per second and queued
      // smooth animations are a major source of streaming jank.
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "auto" });
    }
  }, [lastEvent]);

  useEffect(() => {
    nearBottomRef.current = true;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [sessionId]);

  // Relative file references in messages resolve against the project root.
  const previewRootPath = projects.find((item) => item.id === session?.projectId)?.rootPath;
  const setPreviewBasePaths = useFilePreviewStore((state) => state.setBasePaths);
  useEffect(() => {
    setPreviewBasePaths(previewRootPath ? [previewRootPath] : []);
  }, [previewRootPath, setPreviewBasePaths]);

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

  // Checkpoint revert ("回滚到此轮之前"): click → preview → confirm → revert.
  // Reads the store imperatively so the callback stays referentially stable —
  // memoized timeline rows keep their first-seen props, and a closure over
  // `events`/`checkpoints` would go stale as history grows.
  const [revertTarget, setRevertTarget] = useState<{ checkpointId: string; preview?: CheckpointRevertPreview; loading: boolean; reverting: boolean }>();
  const openRevert = useCallback((messageId: string): void => {
    const state = useSessionsStore.getState();
    const eventsNow = state.events[sessionId] ?? [];
    const checkpointsNow = state.checkpoints[sessionId] ?? [];
    const event = eventsNow.find((item) => item.id === `message-${messageId}`);
    const at = event?.timestamp ?? "";
    // Checkpoints arrive newest-first; this message's run captured its
    // snapshot right after the message landed, i.e. the first checkpoint at
    // or after the message timestamp is "before this turn".
    const checkpoint = [...checkpointsNow].reverse().find((item) => item.createdAt >= at) ?? checkpointsNow[0];
    if (!checkpoint) return;
    setRevertTarget((current) => current?.reverting ? current : { checkpointId: checkpoint.id, loading: true, reverting: false });
    void requestCore<CheckpointRevertPreview>("checkpoint.preview", { checkpointId: checkpoint.id })
      .then((preview) => setRevertTarget((current) => current?.checkpointId === checkpoint.id ? { checkpointId: checkpoint.id, preview, loading: false, reverting: false } : current))
      .catch(() => setRevertTarget(undefined));
  }, [sessionId]);
  const handleEditMessage = useCallback(
    (messageId: string, text: string): void => startEditingMessage(sessionId, messageId, text),
    [sessionId, startEditingMessage]
  );
  const handleViewDiff = useCallback(
    (path?: string): void => { setDiffFocusPath(path ?? null); onOpenDrawer("artifacts"); },
    [onOpenDrawer]
  );
  const confirmRevert = (): void => {
    if (!revertTarget) return;
    const checkpointId = revertTarget.checkpointId;
    setRevertTarget((current) => current ? { ...current, reverting: true } : current);
    void requestCore<CheckpointRevertPreview>("checkpoint.revert", { checkpointId })
      .then((summary) => {
        toast.success(t("sessions.checkpoint.revertDone", { restored: summary.restored.length, removed: summary.removed.length }));
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setRevertTarget(undefined));
  };

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
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-9 px-5 py-7">
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
                    onRevertCheckpoint={!isWork && checkpoints.length > 0 ? openRevert : undefined}
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
      <Dialog
        open={!!revertTarget}
        onOpenChange={(open) => { if (!open && !revertTarget?.reverting) setRevertTarget(undefined); }}
        title={t("sessions.checkpoint.title")}
        description={t("sessions.checkpoint.desc")}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setRevertTarget(undefined)} disabled={revertTarget?.reverting}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={confirmRevert} disabled={!revertTarget || revertTarget.loading || revertTarget.reverting}>
              {revertTarget?.reverting ? t("sessions.checkpoint.reverting") : t("sessions.checkpoint.confirm")}
            </Button>
          </>
        }
      >
        {revertTarget?.loading && <p className="text-sm text-ink-3">{t("sessions.checkpoint.previewLoading")}</p>}
        {revertTarget?.preview && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl border border-line bg-card-hover/40 px-2 py-2.5">
                <p className="text-lg font-semibold text-ok">{revertTarget.preview.restored.length}</p>
                <p className="text-[11px] text-ink-3">{t("sessions.checkpoint.restoreCount")}</p>
              </div>
              <div className="rounded-xl border border-line bg-card-hover/40 px-2 py-2.5">
                <p className="text-lg font-semibold text-danger">{revertTarget.preview.removed.length}</p>
                <p className="text-[11px] text-ink-3">{t("sessions.checkpoint.removeCount")}</p>
              </div>
              <div className="rounded-xl border border-line bg-card-hover/40 px-2 py-2.5">
                <p className="text-lg font-semibold text-ink-3">{revertTarget.preview.skipped.length}</p>
                <p className="text-[11px] text-ink-3">{t("sessions.checkpoint.skipCount")}</p>
              </div>
            </div>
            {revertTarget.preview.warning && (
              <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">{t("sessions.checkpoint.truncatedWarning")}</p>
            )}
            {(revertTarget.preview.restored.length + revertTarget.preview.removed.length) === 0 && (
              <p className="text-xs text-ink-3">{t("sessions.checkpoint.noChanges")}</p>
            )}
            {revertTarget.preview.removed.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-danger">{t("sessions.checkpoint.removedFiles")}</p>
                <ul className="max-h-32 overflow-y-auto rounded-lg border border-line bg-card-hover/30 px-3 py-2 font-mono text-[11px] text-ink-2">
                  {revertTarget.preview.removed.map((path) => <li key={path} className="truncate">{path}</li>)}
                </ul>
              </div>
            )}
            {revertTarget.preview.restored.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-ink-2">{t("sessions.checkpoint.restoredFiles")}</p>
                <ul className="max-h-32 overflow-y-auto rounded-lg border border-line bg-card-hover/30 px-3 py-2 font-mono text-[11px] text-ink-2">
                  {revertTarget.preview.restored.map((path) => <li key={path} className="truncate">{path}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
