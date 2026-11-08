import { useUsageStore } from "../stores/usage";
import { applyLiveProviderUi } from "./provider-ui";
import type {
  AgentInstance,
  AgentRun,
  Artifact,
  GitChangedFile,
  Message,
  Project,
  ProjectRun,
  Session as DomainSession,
  Task,
  TeamDefinition,
  VerificationResult
} from "@agenthub/domain";
import type { RuntimeEvent } from "@agenthub/event-protocol";
import type { HistoryCursor, HistoryItem, HistoryProjection, SessionHistory, ProjectEventCursor, ProjectPollInput, ProjectPollSnapshot, ProjectPollResult, SessionUpsertInput } from "@agenthub/schemas";
import { getBridge, requestCore } from "./bridge";
import { newId } from "./utils";
import { parseProviderDiff } from "./provider-diff";
import { toDomainAgent, toDomainProject, toDomainTeam, toStandaloneUiSession } from "./core-mappers";
import type { DesktopAttachment } from "../types/bridge";
import type { ApprovalScope, QueuedFollowUp, RunLifecycle, SessionArtifact, SessionTask, SessionTarget, TimelineEvent, TimelinePayload, UiSession, UiTeam } from "./types";
import type { ActiveRunSummary } from "./types";
import { compactOrchestrationTimeline, hiddenCompletionRunIds, hiddenInternalRunIds, isVisibleTimelineMessage } from "./orchestration-timeline-policy";
import { groupToolTimeline } from "./tool-timeline-groups";
import { collectSubagentActivities, subagentDispatchIdOf } from "./subagent-activities";
import { mergeCodeExecution } from "./process-display";
import { useAgentsStore } from "../stores/agents";
import { ingestInteractionEvents, useInteractionsStore } from "../stores/interactions";
import { useProjectsStore } from "../stores/projects";
import { useSessionsStore } from "../stores/sessions";
import { useTeamsStore } from "../stores/teams";

// Deletion/eviction fences all asynchronous consumers, not just the projection
// cache. Keeping a lightweight generation tombstone also protects reused ids.
const sessionRuntimeGenerations = new Map<string, number>();
const standaloneStateReadVersions = new Map<string, number>();
const projectRunReadVersions = new Map<string, number>();
function sessionGeneration(sessionId: string): number { return sessionRuntimeGenerations.get(sessionId) ?? 0; }
function currentSessionGeneration(sessionId: string, generation: number): boolean { return sessionGeneration(sessionId) === generation; }

const projectPollers = new Map<string, ReturnType<typeof setTimeout>>();
const projectSessionSubscriptions = new Map<string, string>();
const projectIdleStreams = new Map<string, {cancelled:boolean}>();
const projectSessionSequences = new Map<string, number>();
const projectEventCursors = new Map<string, ProjectEventCursor>();
const projectSessionEventCache = new Map<string, RuntimeEvent[]>();
const projectSessionBuilt = new Set<string>();
const projectSessionRenderedEvents = new Map<string, RuntimeEvent[]>();
const projectRunRenderedArtifacts = new Map<string, Artifact[]>();
const projectSessionDetails = new Map<string, { session: DomainSession; messages: Message[] }>();
// Project-run view caches mirror the standalone LRU: a run keeps its
// materialized event journal while it is displayed, recently opened, or still
// being polled (live). Completed runs the user navigated away from are evicted
// so long chat histories don't pin renderer memory for the app's lifetime.
const projectRunRecent: string[] = [];
const projectRunDisplayed = new Map<string, number>();
const projectRunHydrated = new Set<string>();
// Session-level display tracking for project sessions. hydrateProjectRun only
// materializes timelines for sessions a workbench is actually showing (plus
// their descendants), so poll ticks stop rebuilding every session of a run.
const projectSessionDisplayed = new Map<string, number>();
const standaloneStreams = new Map<string, { cancelled: boolean }>();
const standaloneSubscriptions = new Map<string, string>();
const standaloneSequences = new Map<string, number>();
const standaloneEventCache = new Map<string, RuntimeEvent[]>();
const standaloneMessageCache = new Map<string, Message[]>();
const standaloneArtifactCache = new Map<string, Artifact[]>();
const standaloneRenderFrames = new Map<string, number>();
// Sessions whose full runtime view (event replay + messages + timeline) is
// materialized. Startup hydrates lazily: only sessions with a live run are
// built up front, everything else on first open — replaying every session's
// journal at launch pinned all of them in memory for the app's lifetime.
const standaloneHydrated = new Set<string>();
// Most-recently-opened standalone sessions (current first, max 2). The
// previous session stays cached so switching back is instant; anything older
// without a live poll is evicted.
const standaloneRecent: string[] = [];
// Refcount of mounted workbenches currently displaying a session (Sessions
// and Work pages stay mounted at the same time). An evicted-but-displayed
// session would blank its chat until reopened, so display wins over LRU.
const standaloneDisplayed = new Map<string, number>();
// Sessions whose daemon queue has been fetched once; afterwards the
// session.follow_up_queued/cancelled events keep the store list in sync.
const followUpListSynced = new Set<string>();
// Keep outgoing bubbles until their exact durable IDs appear in history.
// An older/in-flight history snapshot must never remove a just-sent message.
const pendingMessages = new Map<string, Map<string, TimelineEvent>>();

function appendPendingMessage(sessionId: string, text: string, attachments: DesktopAttachment[] = []): string {
  const messageId = newId("msg");
  const event = useSessionsStore.getState()._append(sessionId, { kind: "message", sender: "user", text, messageId, attachments: attachments.map((item) => ({ ...item })) });
  const pending = pendingMessages.get(sessionId) ?? new Map<string, TimelineEvent>();
  pending.set(messageId, event);
  pendingMessages.set(sessionId, pending);
  return messageId;
}

function replaceSessionTimeline(sessionId: string, timeline: TimelineEvent[]): void {
  const pending = pendingMessages.get(sessionId);
  if (pending) {
    for (const event of timeline) {
      if (event.data.kind === "message" && event.data.messageId) pending.delete(event.data.messageId);
    }
    if (!pending.size) pendingMessages.delete(sessionId);
    else timeline = [...timeline, ...pending.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence);
  }
  useSessionsStore.getState()._replaceEvents(sessionId, timeline);
}
// Poll-activity bookkeeping: a monotonically increasing counter per run that
// hydrateProjectRun bumps whenever a poll tick actually changed something, so
// the scheduler can back off while a run is idle.
const projectRunActivity = new Map<string, number>();
const projectRunUpdatedAt = new Map<string, string>();
// Sessions with an active AgentRun per project run, refreshed by every
// hydrateProjectRun tick. The daemon can keep delegated child sessions running
// after it finalizes the project run, so liveness must come from the sessions,
// not the project run status alone.
const projectRunActiveRuns = new Map<string, number>();
const projectRunAwaitingOutput = new Map<string, boolean>();

const STREAMING_DELTA_TYPES = new Set(["agent.message_delta", "agent.thinking_delta"]);
const SNAPSHOT_EVENT_TYPES = new Set([...STREAMING_DELTA_TYPES, "run.diff_updated"]);

/** Stream identity for delta upserts: run + kind + message segment. */
function streamKeyOf(event: RuntimeEvent): string {
  const messageId = (event.payload as { messageId?: string } | undefined)?.messageId ?? "";
  return JSON.stringify([event.sessionId, event.runId ?? "", event.type, messageId]);
}

/**
 * Appends fresh events to a session cache. Streaming deltas are cumulative
 * snapshots: the daemon coalesces them into one journal row and re-issues
 * each merge with a NEW eventId and sequence, so appending them would store
 * every intermediate streaming state and grow the cache quadratically
 * mid-turn. The cached row for the same stream is replaced instead — keeping
 * the FIRST eventId/timestamp, because timeline rows are keyed by eventId and
 * a changing key remounts the card on every rebuild (visible as flicker).
 * Provider diffs also replace by run, but retain the latest timestamp so
 * cross-run file aggregation respects the snapshot update order.
 */
function mergeEventCache(current: RuntimeEvent[], fresh: RuntimeEvent[]): RuntimeEvent[] {
  if (!fresh.some((event) => SNAPSHOT_EVENT_TYPES.has(event.type))) return [...current, ...fresh];
  const next = [...current];
  const streamIndex = new Map<string, number>();
  for (let index = 0; index < current.length; index += 1) {
    const event = current[index]!;
    if (SNAPSHOT_EVENT_TYPES.has(event.type)) streamIndex.set(streamKeyOf(event), index);
  }
  for (const event of fresh) {
    if (SNAPSHOT_EVENT_TYPES.has(event.type)) {
      const existing = streamIndex.get(streamKeyOf(event));
      if (existing !== undefined) {
        const previous = next[existing]!;
        if (event.type === "run.diff_updated" && previous.sequence > event.sequence) continue;
        next[existing] = { ...event, eventId: previous.eventId, timestamp: event.type === "run.diff_updated" ? event.timestamp : previous.timestamp };
        continue;
      }
      streamIndex.set(streamKeyOf(event), next.length);
    }
    next.push(event);
  }
  return next;
}

/** Reasoning streams are display-only and can run to hundreds of KB. The
 * collapsed preview reads the latest line, so oversized text is capped at the
 * TAIL (newest content) rather than the head. The daemon caps too; this is a
 * defensive bound for older daemons / replayed journals. */
function capReasoningText(text: string, limit = 20_000): string {
  return text.length > limit ? text.slice(-limit) : text;
}

export async function resumeWorkbenchRuns(): Promise<void> {
  resetHistoryCapabilities();
  if (!getBridge()) return;
  // A terminal-looking project run can still own live child sessions (the
  // daemon finalizes delegation waves independently), so resume polling for any
  // run with an active AgentRun, not just non-terminal statuses.
  const agentRuns = await requestCore<AgentRun[]>("run.list", {}).catch(() => [] as AgentRun[]);
  const activeProjectRunIds = new Set(agentRuns.filter(shouldPollAgentRun).map((run) => run.projectRunId).filter(Boolean));
  const projects = useProjectsStore.getState().projects;
  for (let offset = 0; offset < projects.length; offset += 4) {
    // Fresh indexes, not the earlier startup snapshot: a new run may have
    // appeared while standalone sessions were restoring. Only reads overlap.
    const indexes = await Promise.all(projects.slice(offset, offset + 4).map(async (project) => {
      try {
        return { project, runs: await requestCore<ProjectRun[]>("projectRun.list", { projectId: project.id }) };
      } catch (error) {
        console.error(`Failed to restore runs for project ${project.id}`, error);
        return { project, runs: [] as ProjectRun[] };
      }
    }));
    for (const { project, runs } of indexes) {
      try {
        for (const projectRun of runs.filter((run) => !["completed", "failed", "cancelled"].includes(run.status) || activeProjectRunIds.has(run.id))) {
          const hydrated = await hydrateProjectRun(projectRun.id);
          if (shouldPollProjectRun(hydrated)) schedulePoll(projectRun.id);
        }
      } catch (error) {
        console.error(`Failed to restore runs for project ${project.id}`, error);
      }
    }
  }
}

/** Loads persisted sessions/messages/runs into the three-pane workbench. */
export async function hydrateWorkbenchSessions({ hydrateActiveProjectRuns = true }: { hydrateActiveProjectRuns?: boolean } = {}): Promise<void> {
  resetHistoryCapabilities();
  const generations = new Map(sessionRuntimeGenerations);
  const isCurrent = (id: string) => currentSessionGeneration(id, generations.get(id) ?? 0);
  if (!getBridge()) return;
  const projects = useProjectsStore.getState().projects;
  const teams = useTeamsStore.getState().teams;
  const instances = useAgentsStore.getState().instances;
  const uiSessions: UiSession[] = [];
  const runIds = new Set<string>();
  const terminalRunIds = new Set<string>();

  // Read independent project indexes in bounded batches, then commit them
  // in project order. No session replay/hydration or writes are parallelized.
  const indexes: Array<{ project: (typeof projects)[number]; domainSessions: DomainSession[]; projectRuns: ProjectRun[] }> = [];
  for (let offset = 0; offset < projects.length; offset += 4) {
    indexes.push(...await Promise.all(projects.slice(offset, offset + 4).map(async (project) => {
      const [domainSessions, projectRuns] = await Promise.all([
        requestCore<DomainSession[]>("session.list", { projectId: project.id }),
        requestCore<ProjectRun[]>("projectRun.list", { projectId: project.id })
      ]);
      return { project, domainSessions, projectRuns };
    })));
  }
  for (const { project, domainSessions, projectRuns } of indexes) {
    const runs = new Map(projectRuns.map((run) => [run.id, run]));
    const active = projectRuns.find((run) => !["completed", "failed", "cancelled"].includes(run.status));
    const activeTeam = active?.teamId ? teams.find((team) => team.id === active.teamId) : undefined;
    const legacyMain = activeTeam?.members.find((member) => member.id === active?.mainMemberId);
    const activeAgent = instances.find((instance) => instance.id === (active?.mainAgentInstanceId ?? legacyMain?.agentInstanceId));
    useProjectsStore.getState().setActiveRun(project.id, active ? {
      id: active.id,
      goal: active.goal,
      status: toActiveRunStatus(active),
      agentName: activeAgent?.displayName ?? legacyMain?.displayName ?? active.mainMemberId,
      startedAt: active.createdAt
    } : undefined);
    for (const session of domainSessions) {
      const run = session.projectRunId ? runs.get(session.projectRunId) : undefined;
      const team = run?.teamId ? teams.find((item) => item.id === run.teamId) : undefined;
      if (run && team) {
        uiSessions.push(toUiSession(session, run, team));
        runIds.add(run.id);
        if (["completed", "failed", "cancelled"].includes(run.status)) terminalRunIds.add(run.id);
      } else {
        uiSessions.push(toStandaloneUiSession(session));
      }
    }
  }

  useSessionsStore.getState()._replaceSessions(uiSessions.filter((session) => isCurrent(session.id)));
  // Lazy hydration: one run.list finds the sessions with a live run; only
  // those get the full event replay at startup (polling needs it). Every
  // other session hydrates on first open via ensureStandaloneSessionHydrated.
  const allRuns = await requestCore<AgentRun[]>("run.list", {}).catch(() => [] as AgentRun[]);
  const liveRunBySession = new Map(allRuns.filter(shouldPollAgentRun).map((run) => [run.sessionId, run]));
  for (const session of uiSessions.filter((item) => !item.projectRunId && isCurrent(item.id))) {
    const liveRun = liveRunBySession.get(session.id);
    if (!liveRun) continue;
    const run = await hydrateStandaloneSession(session, liveRun.id);
    if (run && shouldPollAgentRun(run)) scheduleStandalonePoll(session.id, run.id);
  }
  // Completed runs hydrate lazily on open (see ensureProjectRunHydrated);
  // materializing every run's journal at startup pinned them all in memory
  // for the app's lifetime. resumeWorkbenchRuns() right after this handles
  // the live runs (non-terminal or with active child AgentRuns).
  const activeProjectRunIds = new Set(allRuns.filter(shouldPollAgentRun).map((run) => run.projectRunId).filter(Boolean));
  for (const projectRunId of hydrateActiveProjectRuns ? runIds : []) {
    if (!terminalRunIds.has(projectRunId) || activeProjectRunIds.has(projectRunId)) {
      await hydrateProjectRun(projectRunId);
    }
  }
}

/** A delivery from the persistent assistant enters the same live workbench as a composer submission. */
export async function refreshAssistantTarget(sessionId: string): Promise<void> {
  const page = await requestCore<import("@agenthub/schemas").AssistantSessionPage>("assistant.sessions", {sessionId});
  const entry = page.items[0];
  if (!entry) return;
  const sessions = await requestCore<DomainSession[]>("session.list", {projectId:entry.projectId});
  const session = sessions.find(item => item.id === sessionId);
  if (!session) return;
  if (session.projectRunId) {
    await hydrateProjectRun(session.projectRunId);
    schedulePoll(session.projectRunId);
  } else {
    const ui = toStandaloneUiSession(session);
    useSessionsStore.getState()._upsertExternalSession(ui);
    scheduleStandalonePoll(sessionId, undefined, true);
  }
}

export async function sendWorkbenchMessage(sessionId: string, text: string, attachments: DesktopAttachment[] = [], editMessageId?: string): Promise<void> {
  const state = useSessionsStore.getState();
  const initialSession = state.sessions.find((item) => item.id === sessionId);
  if (!initialSession) throw new Error(`Session ${sessionId} is missing`);
  let session = initialSession;
  if (!getBridge()) {
    state._append(sessionId, { kind: "error", code: "CORE_UNAVAILABLE", message: "Core Daemon 仅在 Electron 桌面端可用。", retryable: false });
    throw new Error("Core Daemon is unavailable");
  }
  const attachmentViews = attachments.map((attachment) => ({ ...attachment }));
  if (editMessageId) state._patchEvent(sessionId, `message-${editMessageId}`, { text, attachments: attachmentViews, editedAt: new Date().toISOString() });
  const messageId = editMessageId ?? appendPendingMessage(sessionId, text, attachments);
  state._append(sessionId, { kind: "activity", phase: "queued" });
  state._setForeground(sessionId, { status: "running", startedAt: new Date().toISOString() });

  let acceptedRunId: string | undefined;
  let acceptedProjectRunId: string | undefined;
  try {
    await sessionConfigWrites.get(sessionId);
    session = useSessionsStore.getState().sessions.find((item) => item.id === sessionId) ?? session;
    await syncProjectAndAgents(session);
    if (session.target.type === "agent" && session.target.teamId) {
      const activeProjectRunId = useProjectsStore.getState().projects
        .find((project) => project.id === session.projectId)?.activeRun?.id;
      if (session.projectRunId && activeProjectRunId === session.projectRunId) {
        const domainSession = toDomainSession(session);
        await requestCore<DomainSession>("session.upsert", domainSession);
        const result = await requestCore<{ accepted: true; runId: string }>("session.send", { sessionId, text, messageId, attachments, editMessageId });
        acceptedRunId = result.runId;
        acceptedProjectRunId = session.projectRunId;
        state._setActiveAgentRun(sessionId, result.runId);
        await hydrateProjectRun(session.projectRunId);
        schedulePoll(session.projectRunId);
        return;
      }

      const team = requireUiTeam(session.target.teamId);
      await requestCore<TeamDefinition>("team.upsert", toDomainTeam(team));
      await requestCore<DomainSession>("session.upsert", toDomainSession(session, team));
      const result = await requestCore<{ projectRun: ProjectRun; mainSession: DomainSession }>("orchestration.start", {
        projectId: session.projectId,
        teamId: team.id,
        agentInstanceId: session.target.instanceId,
        goal: text,
        sessionId: session.id,
        messageId,
        attachments
      });
      acceptedProjectRunId = result.projectRun.id;
      state._upsertExternalSession(toUiSession(result.mainSession, result.projectRun, team));
      state._setRunning(sessionId, { status: "running" });
      await hydrateProjectRun(result.projectRun.id);
      schedulePoll(result.projectRun.id);
      return;
    }

    const domainSession = toDomainSession(session);
    await requestCore<DomainSession>("session.upsert", domainSession);
    const result = await requestCore<{ accepted: true; runId: string }>("session.send", { sessionId, text, messageId, attachments, editMessageId });
    acceptedRunId = result.runId;
    state._setActiveAgentRun(sessionId, result.runId);
    await hydrateStandaloneSession(session, result.runId);
    scheduleStandalonePoll(sessionId, result.runId);
  } catch (error) {
    // Acceptance and view synchronization are different outcomes. A failed
    // hydrate must not invite the composer to resend an already accepted turn.
    if (acceptedRunId || acceptedProjectRunId) {
      appendSyncErrorThrottled(sessionId, `前端同步失败: ${error instanceof Error ? error.message : String(error)}`);
      if (acceptedProjectRunId) schedulePoll(acceptedProjectRunId);
      else if (acceptedRunId) scheduleStandalonePoll(sessionId, acceptedRunId, true);
      return;
    }
    state._append(sessionId, { kind: "error", code: "IPC_INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error), retryable: true });
    state._setForeground(sessionId, { status: "failed", reason: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Sends immediate steering or queues a follow-up without stopping the active turn. Returns the mode actually applied. */
export async function sendWorkbenchFollowUp(sessionId: string, text: string, mode: "steer" | "queue"): Promise<"steer" | "queue" | undefined> {
  const store = useSessionsStore.getState();
  const session = store.sessions.find((item) => item.id === sessionId);
  if (!session || !text.trim()) return undefined;
  if (!getBridge()) throw new Error("Core Daemon is only available in the desktop shell");

  // The daemon may downgrade "steer" to "queue" when the provider lacks a
  // mid-turn injection channel; honor the mode it actually applied.
  const messageId = appendPendingMessage(sessionId, text);
  if (mode === "queue") store._addQueuedFollowUp(sessionId, { messageId, text, queuedAt: new Date().toISOString() });
  const { mode: appliedMode } = await requestCore<{ accepted: true; mode: "steer" | "queue" }>("session.followUp", { sessionId, text, messageId, mode }).catch((error) => {
    store._removeQueuedFollowUp(sessionId, messageId);
    pendingMessages.get(sessionId)?.delete(messageId);
    storeRemoveMessage(sessionId, messageId);
    store._append(sessionId, { kind: "error", code: "IPC_INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error), retryable: true });
    throw error;
  });
  if (appliedMode === "queue") {
    store._addQueuedFollowUp(sessionId, { messageId, text, queuedAt: new Date().toISOString() });
  }
  return appliedMode;
}

/** Withdraws a queued follow-up; the daemon deletes its saved message too. */
export async function cancelWorkbenchFollowUp(sessionId: string, messageId: string): Promise<void> {
  if (!getBridge()) throw new Error("Core Daemon is only available in the desktop shell");
  try {
    await requestCore<{ cancelled: true }>("session.followUp.cancel", { sessionId, messageId });
    pendingMessages.get(sessionId)?.delete(messageId);
    storeRemoveMessage(sessionId, messageId);
    useSessionsStore.getState()._removeQueuedFollowUp(sessionId, messageId);
  } catch (error) {
    // Resync from the daemon so a failed withdraw restores the entry.
    followUpListSynced.delete(sessionId);
    await syncQueuedFollowUps(sessionId);
    throw error;
  }
}

/** Promote the existing queue entry, preserving the original message ID.
 * The daemon retains the queued turn if native steering fails. */
export async function steerWorkbenchQueuedFollowUp(sessionId: string, messageId: string): Promise<"steer" | "queue"> {
  const { mode } = await requestCore<{ accepted: true; mode: "steer" | "queue" }>("session.followUp.steer", { sessionId, messageId });
  if (mode === "steer") useSessionsStore.getState()._removeQueuedFollowUp(sessionId, messageId);
  return mode;
}

function storeRemoveMessage(sessionId: string, messageId: string): void {
  const store = useSessionsStore.getState();
  store._replaceEvents(sessionId, (store.events[sessionId] ?? []).filter((event) => event.data.kind !== "message" || event.data.messageId !== messageId));
}

/** Mirrors daemon queue events into the store-backed queued-follow-up list. */
function ingestFollowUpEvents(sessionId: string, events: RuntimeEvent[]): void {
  const store = useSessionsStore.getState();
  for (const event of events) {
    if (event.type === "session.follow_up_queued") {
      store._addQueuedFollowUp(sessionId, { messageId: event.payload.messageId, text: event.payload.text, queuedAt: event.timestamp });
    } else if (event.type === "session.follow_up_cancelled" || event.type === "session.follow_up_steered") {
      store._removeQueuedFollowUp(sessionId, event.payload.messageId);
    }
  }
}

/** Fetches the authoritative queue once per session; events keep it in sync after. */
async function syncQueuedFollowUps(sessionId: string): Promise<void> {
  const generation = sessionGeneration(sessionId);
  if (followUpListSynced.has(sessionId)) return;
  followUpListSynced.add(sessionId);
  try {
    const { items } = await requestCore<{ items: QueuedFollowUp[] }>("session.followUp.list", { sessionId });
    if (currentSessionGeneration(sessionId, generation)) useSessionsStore.getState()._replaceQueuedFollowUps(sessionId, items);
  } catch (error) {
    console.warn(`Failed to load queued follow-ups for session ${sessionId}`, error);
  }
}

export async function resolveWorkbenchApproval(sessionId: string, approvalId: string, approved: boolean, scope: ApprovalScope): Promise<void> {
  if (!getBridge()) {
    throw new Error("Core Daemon is unavailable");
  }
  const session = useSessionsStore.getState().sessions.find((item) => item.id === sessionId);
  if (!session) return;
  const approvalEvent = useSessionsStore.getState().events[sessionId]?.find(
    (event) => event.data.kind === "approval" && event.data.approval.id === approvalId
  );
  const approvalKind = approvalEvent?.data.kind === "approval" ? approvalEvent.data.approval.kind : undefined;
  if (approvalKind === "command") {
    await requestCore("approval.resolve", { approvalId, decision: approved ? "approved" : "rejected", scope });
    useSessionsStore.getState()._updateApproval(sessionId, approvalId, approved ? "approved" : "rejected");
    if (session.projectRunId) await hydrateProjectRun(session.projectRunId);
    else {
      const run = await hydrateStandaloneSession(session);
      if (run && shouldPollAgentRun(run)) scheduleStandalonePoll(session.id, run.id);
    }
    return;
  }
  if (!session.projectRunId) return;
  const detail = await requestCore<{ projectRun: ProjectRun; mainSession: DomainSession }>("projectRun.get", { projectRunId: session.projectRunId });
  const isMergeApproval = approvalKind === "merge" || detail.projectRun.mergeApprovalId === approvalId;
  const projectRun = isMergeApproval
    ? await requestCore<ProjectRun>("orchestration.resolveMerge", { projectRunId: session.projectRunId, approved, scope })
    : await requestCore<ProjectRun>("orchestration.resolveDelegation", { projectRunId: session.projectRunId, approved, scope });
  useSessionsStore.getState()._updateApproval(sessionId, approvalId, approved ? "approved" : "rejected");
  await hydrateProjectRun(session.projectRunId);
  if (shouldPoll(projectRun)) schedulePoll(session.projectRunId);
}

export async function stopWorkbenchRun(sessionId: string): Promise<void> {
  if (!getBridge()) {
    throw new Error("Core Daemon is unavailable");
  }
  const session = useSessionsStore.getState().sessions.find((item) => item.id === sessionId);
  if (!session) return;
  const store = useSessionsStore.getState();
  if (session.projectRunId && !session.parentSessionId) {
    // Cancelling can fail (e.g. the daemon already finalized the run); the
    // rehydrate below is what repairs local state, so never bail out early.
    await requestCore<ProjectRun>("orchestration.cancel", { projectRunId: session.projectRunId })
      .catch((error) => console.error("Failed to cancel orchestration run", error));
    store._setForeground(sessionId, { status: "cancelled" });
    await hydrateProjectRun(session.projectRunId);
    return;
  }
  let runId = store.activeAgentRunIds[sessionId];
  if (!runId) {
    const runs = await requestCore<AgentRun[]>("run.list", { sessionId });
    runId = runs.find(shouldPollAgentRun)?.id;
  }
  if (runId) {
    await requestCore<{ cancelled: true }>("run.cancel", { runId });
    store._setForeground(sessionId, { status: "cancelled" });
    if (session.projectRunId) {
      await hydrateProjectRun(session.projectRunId);
      return;
    }
  } else if (session.projectRunId) {
    await requestCore<ProjectRun>("orchestration.cancel", { projectRunId: session.projectRunId })
      .catch((error) => console.error("Failed to cancel orchestration run", error));
    await hydrateProjectRun(session.projectRunId);
    return;
  }
  const stream = standaloneStreams.get(sessionId);
  if (stream) stream.cancelled = true;
  standaloneStreams.delete(sessionId);
  await hydrateStandaloneSession(session, runId);
}

/** Permanently removes a completed conversation and all of its sub-sessions. */
export async function deleteWorkbenchSession(sessionId: string): Promise<void> {
  const store = useSessionsStore.getState();
  const localSessions = store.sessions;
  const deleted = new Set<string>([sessionId]);
  let added = true;
  while (added) {
    added = false;
    for (const session of localSessions) {
      if (session.parentSessionId && deleted.has(session.parentSessionId) && !deleted.has(session.id)) {
        deleted.add(session.id);
        added = true;
      }
    }
  }

  if (getBridge()) {
    const result = await requestCore<{ removed: true; sessionIds: string[] }>("session.delete", { sessionId });
    for (const id of result.sessionIds) clearSessionRuntime(id);
    store.removeSessions(result.sessionIds);
    return;
  }

  for (const id of deleted) clearSessionRuntime(id);
  store.removeSessions([...deleted]);
}

const sessionConfigWrites = new Map<string, Promise<void>>();

export async function configureWorkbenchSession(
  sessionId: string,
  patch: { agentMode?: string; model?: string; reasoningEffort?: string; serviceTier?: string; permissionMode?: string; connectionId?: string | null; connectionRevision?: number; confirmConnectionChange?: boolean }
): Promise<void> {
  const previous = sessionConfigWrites.get(sessionId) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const state = useSessionsStore.getState();
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error(`Session ${sessionId} is missing`);
    if (!getBridge()) throw new Error("Core Daemon is unavailable");
    if ([state.running[sessionId]?.status, state.foreground[sessionId]?.status].some(status => status === "running" || status === "waiting_approval") || (state.queuedFollowUps[sessionId]?.length ?? 0) > 0) throw new Error("Wait for the current request and queued messages to finish before changing configuration");
    try {
      // Serialize edits and only publish a configuration the daemon saved.
      // Failed permission changes leave the previous visible value intact.
      const { confirmConnectionChange, connectionId, ...configuration } = patch;
      const hasConnection = Object.prototype.hasOwnProperty.call(patch, "connectionId");
      const input = toDomainSession({ ...session, ...configuration, ...(hasConnection ? { connectionId: connectionId ?? undefined } : {}) });
      const saved = await requestCore<DomainSession>("session.upsert", { ...input, ...(hasConnection ? { connectionId: connectionId ?? null } : {}), ...(confirmConnectionChange ? { confirmConnectionChange: true } : {}) });
      state._configureSession(sessionId, { ...configuration, ...(hasConnection ? { connectionId: saved.connectionId, connectionRevision: saved.connectionRevision } : {}) });
    } catch (error) {
      state._append(sessionId, { kind: "error", code: "SESSION_CONFIG_FAILED", message: error instanceof Error ? error.message : String(error), retryable: true });
      throw error;
    }
  });
  sessionConfigWrites.set(sessionId, write);
  try { await write; }
  finally { if (sessionConfigWrites.get(sessionId) === write) sessionConfigWrites.delete(sessionId); }
}

/** Session Agent identity is immutable; create a new conversation to change it. */
export async function switchWorkbenchSessionInstance(sessionId: string, instanceId: string): Promise<void> {
  const session = useSessionsStore.getState().sessions.find(item => item.id === sessionId);
  if (session?.target.type === "agent" && session.target.instanceId === instanceId) return;
  throw new Error("Agent is fixed for this conversation. Start a new conversation to change Agent.");
}

function clearSessionRuntime(sessionId: string): void {
  const idle=projectIdleStreams.get(sessionId);if(idle)idle.cancelled=true;projectIdleStreams.delete(sessionId);
  pendingMessages.delete(sessionId);
  forgetSessionHistory(sessionId);
  const stream = standaloneStreams.get(sessionId);
  if (stream) stream.cancelled = true;
  standaloneStreams.delete(sessionId);
  standaloneSubscriptions.delete(sessionId);
  standaloneSequences.delete(sessionId);
  standaloneEventCache.delete(sessionId);
  standaloneMessageCache.delete(sessionId);
  standaloneArtifactCache.delete(sessionId);
  standaloneHydrated.delete(sessionId);
  standaloneDisplayed.delete(sessionId);
  const recentIndex = standaloneRecent.indexOf(sessionId);
  if (recentIndex !== -1) standaloneRecent.splice(recentIndex, 1);
  // Cancel a coalesced render still waiting for its timer; letting it
  // fire would rebuild a timeline for a session that no longer exists.
  const frame = standaloneRenderFrames.get(sessionId);
  if (frame !== undefined) clearTimeout(frame);
  standaloneRenderFrames.delete(sessionId);
  projectSessionSubscriptions.delete(sessionId);
  projectSessionSequences.delete(sessionId);
  projectEventCursors.delete(sessionId);
  projectSessionEventCache.delete(sessionId);
  projectSessionBuilt.delete(sessionId);
  projectSessionRenderedEvents.delete(sessionId);
  projectSessionDetails.delete(sessionId);
  followUpListSynced.delete(sessionId);
  useInteractionsStore.getState()._removeSessions([sessionId]);
}

/**
 * Materializes a standalone session's runtime view on first open and evicts
 * older hydrated sessions (LRU: current + previous stay). Sessions with a
 * live poll keep their caches regardless — a background run must keep
 * streaming into its timeline.
 */
export async function ensureStandaloneSessionHydrated(sessionId: string): Promise<void> {
  const generation = sessionGeneration(sessionId);
  if (!getBridge()) return;
  touchStandaloneRecent(sessionId);
  if (!standaloneHydrated.has(sessionId)) {
    const session = useSessionsStore.getState().sessions.find((item) => item.id === sessionId);
    if (session && !session.projectRunId) {
      standaloneHydrated.add(sessionId);
      try {
        const run = await hydrateStandaloneSession(session);
        if (currentSessionGeneration(sessionId, generation) && (run && shouldPollAgentRun(run) || standaloneDisplayed.has(sessionId))) scheduleStandalonePoll(session.id, run?.id);
      } catch (error) {
        if (!currentSessionGeneration(sessionId, generation)) return;
        standaloneHydrated.delete(sessionId);
        console.error(`Failed to hydrate session ${sessionId}`, error);
      }
    }
  }
  if (currentSessionGeneration(sessionId, generation) && standaloneDisplayed.has(sessionId) && !standaloneStreams.has(sessionId)) {
    const session=useSessionsStore.getState().sessions.find((item)=>item.id===sessionId);
    if (session && !session.projectRunId) scheduleStandalonePoll(sessionId, useSessionsStore.getState().activeAgentRunIds[sessionId], true);
  }
  evictStandaloneViewCaches();
}

function touchStandaloneRecent(sessionId: string): void {
  const index = standaloneRecent.indexOf(sessionId);
  if (index !== -1) standaloneRecent.splice(index, 1);
  standaloneRecent.unshift(sessionId);
  if (standaloneRecent.length > 2) standaloneRecent.pop();
}

/** Marks a session as displayed by a mounted workbench; returns the unregister. */
export function registerStandaloneSessionView(sessionId: string): () => void {
  standaloneDisplayed.set(sessionId, (standaloneDisplayed.get(sessionId) ?? 0) + 1);
  return () => {
    const count = (standaloneDisplayed.get(sessionId) ?? 1) - 1;
    if (count <= 0) standaloneDisplayed.delete(sessionId);
    else standaloneDisplayed.set(sessionId, count);
  };
}

function evictStandaloneViewCaches(): void {
  const keep = new Set(standaloneRecent);
  for (const sessionId of [...standaloneHydrated]) {
    if (keep.has(sessionId)) continue;
    if (standaloneDisplayed.has(sessionId)) continue;
    if (standaloneStreams.has(sessionId)) continue;
    standaloneHydrated.delete(sessionId);
    forgetSessionHistory(sessionId);
    standaloneEventCache.delete(sessionId);
    standaloneMessageCache.delete(sessionId);
    standaloneArtifactCache.delete(sessionId);
    standaloneSubscriptions.delete(sessionId);
    standaloneSequences.delete(sessionId);
    useSessionsStore.getState()._evictSessionView(sessionId);
  }
}

/** Marks a project run as displayed by a mounted workbench; returns unregister. */
export function registerProjectRunView(projectRunId: string): () => void {
  projectRunDisplayed.set(projectRunId, (projectRunDisplayed.get(projectRunId) ?? 0) + 1);
  return () => {
    const count = (projectRunDisplayed.get(projectRunId) ?? 1) - 1;
    if (count <= 0) projectRunDisplayed.delete(projectRunId);
    else projectRunDisplayed.set(projectRunId, count);
  };
}

/**
 * Marks one session of a project run as displayed by a mounted workbench
 * (plus its run). hydrateProjectRun materializes timelines only for displayed
 * sessions and their descendants, so this must be kept in sync on open/close.
 */
export function registerProjectSessionView(sessionId: string, projectRunId: string): () => void {
  const unregisterRun = registerProjectRunView(projectRunId);
  projectSessionDisplayed.set(sessionId, (projectSessionDisplayed.get(sessionId) ?? 0) + 1);
  return () => {
    const count = (projectSessionDisplayed.get(sessionId) ?? 1) - 1;
    if (count <= 0) projectSessionDisplayed.delete(sessionId);
    else projectSessionDisplayed.set(sessionId, count);
    if(count<=0){const idle=projectIdleStreams.get(sessionId);if(idle)idle.cancelled=true;projectIdleStreams.delete(sessionId);}
    unregisterRun();
  };
}

function touchProjectRunRecent(projectRunId: string): void {
  const index = projectRunRecent.indexOf(projectRunId);
  if (index !== -1) projectRunRecent.splice(index, 1);
  projectRunRecent.unshift(projectRunId);
  if (projectRunRecent.length > 2) projectRunRecent.pop();
}

function sessionsOfProjectRun(projectRunId: string): UiSession[] {
  return useSessionsStore.getState().sessions.filter((session) => session.projectRunId === projectRunId);
}

/**
 * Drops the materialized view caches (raw event journal + store timelines) of
 * project runs that are neither displayed, recently opened, nor being polled.
 * A live poll re-materializes every tick, so only terminal/idle runs qualify.
 * Reopening re-hydrates via the incremental replay (cache starts empty).
 */
function evictProjectRunViewCaches(): void {
  for (const runId of [...projectRunHydrated]) {
    if (projectRunRecent.includes(runId)) continue;
    if (projectRunDisplayed.has(runId)) continue;
    if (projectPollers.has(runId)) continue;
    const sessions = sessionsOfProjectRun(runId);
    if (sessions.some((session) => standaloneDisplayed.has(session.id))) continue;
    projectRunHydrated.delete(runId);
    projectRunReadVersions.set(runId, (projectRunReadVersions.get(runId) ?? 0) + 1);
    projectRunRenderedArtifacts.delete(runId);
    forgetPersistedHistory(`artifacts:projectRun:${runId}`);
    projectRunAwaitingOutput.delete(runId);
    for (const session of sessions) {
      forgetSessionHistory(session.id);
      projectSessionEventCache.delete(session.id);
      projectSessionSequences.delete(session.id);
      projectEventCursors.delete(session.id);
      projectSessionSubscriptions.delete(session.id);
      projectSessionBuilt.delete(session.id);
      projectSessionRenderedEvents.delete(session.id);
      projectSessionDetails.delete(session.id);
      followUpListSynced.delete(session.id);
      useSessionsStore.getState()._evictSessionView(session.id);
    }
  }
}

/**
 * Hydrates a project run on demand (opening one of its sessions). Completed
 * runs are otherwise left alone at startup and only materialized here, so the
 * renderer never pins every run's full journal at once.
 */
export async function ensureProjectRunHydrated(projectRunId: string): Promise<void> {
  if (!getBridge()) return;
  // Explicit open/refresh must observe edits even when legacy metadata has
  // no reliable revision timestamp (or two updates share a millisecond).
  for (const session of sessionsOfProjectRun(projectRunId)) projectSessionDetails.delete(session.id);
  touchProjectRunRecent(projectRunId);
  projectRunHydrated.add(projectRunId);
  try {
    const projectRun = await hydrateProjectRun(projectRunId);
    if (shouldPollProjectRun(projectRun) || hasQueuedFollowUpForProject(projectRunId)) {
      schedulePoll(projectRunId);
    } else watchDisplayedProjectSessions(projectRunId);
  } catch (error) {
    projectRunHydrated.delete(projectRunId);
    console.error(`Failed to hydrate project run ${projectRunId}`, error);
  }
  evictProjectRunViewCaches();
}

async function syncProjectAndAgents(session: UiSession): Promise<void> {
  const project = useProjectsStore.getState().projects.find((item) => item.id === session.projectId);
  if (!project) throw new Error(`Project ${session.projectId} is missing`);
  const domainProject = toDomainProject(project);
  const agents = useAgentsStore.getState();
  const target = session.target;
  let requiredIds: string[];
  if (target.type === "team") requiredIds = requireUiTeam(target.teamId).members.filter((member) => member.enabled).map((member) => member.agentInstanceId);
  else if (target.type === "agent") requiredIds = [
    target.instanceId,
    ...(target.teamId ? requireUiTeam(target.teamId).members.filter((member) => member.enabled).map((member) => member.agentInstanceId) : [])
  ];
  else requiredIds = [requireUiTeam(target.teamId).members.find((member) => member.id === target.memberId)?.agentInstanceId ?? ""];
  const domainAgents = [...new Set(requiredIds.filter(Boolean))].map((instanceId) => {
    const instance = agents.instances.find((item) => item.id === instanceId);
    if (!instance) throw new Error(`Agent instance ${instanceId} is missing`);
    if (!instance.executable) throw new Error(`${instance.displayName}: CLI executable has not been configured`);
    return toDomainAgent(instance);
  });
  // Independent prerequisites: do not add one IPC round trip per agent to
  // every turn. Validate the complete set before writing, and still await all
  // writes before session.upsert/send (which depend on these entities).
  await Promise.all([
    requestCore<Project>("project.upsert", domainProject),
    ...domainAgents.map((agent) => requestCore<AgentInstance>("agent.upsert", agent))
  ]);
}

function toDomainSession(session: UiSession, _team?: UiTeam): SessionUpsertInput {
  const memberId = session.target.type === "member"
    ? session.target.memberId
    : session.target.type === "agent" ? session.target.instanceId : "legacy-team-main";
  return {
    id: session.id,
    projectId: session.projectId,
    memberId,
    teamId: session.target.teamId,
    projectRunId: session.projectRunId,
    parentSessionId: session.parentSessionId,
    taskId: session.taskId,
    agentInstanceId: session.target.type === "agent" ? session.target.instanceId : undefined,
    connectionId: session.connectionId,
    connectionRevision: session.connectionRevision,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    agentMode: session.agentMode,
    serviceTier: session.serviceTier,
    permissionMode: session.permissionMode?.trim() || null,
    mode: session.mode,
    title: session.title,
    status: session.status,
    unreadCount: session.unreadCount,
    lastMessageAt: session.lastMessageAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

// Persistence cursors never share state with the event replay cursor. A failed
// sibling request can therefore be retried without acknowledging unseen rows.
type PersistedValue = Message | Artifact;
type PersistedSnapshot = { cursor?: HistoryCursor; rows: Map<string, HistoryItem<PersistedValue>>; values: PersistedValue[] };
const persistedHistory = new Map<string, PersistedSnapshot>();
const persistedReads = new Map<string, Promise<unknown>>();
const unsupportedHistoryMethods = new Set<string>();
let historyBridge = getBridge();

function resetHistoryCapabilities(): void { unsupportedHistoryMethods.clear(); }
function forgetPersistedHistory(scope: string): void {
  persistedHistory.delete(scope);
  persistedReads.delete(scope);
}
function forgetSessionHistory(sessionId: string): void {
  sessionRuntimeGenerations.set(sessionId, sessionGeneration(sessionId) + 1);
  forgetPersistedHistory(`messages:session:${sessionId}`);
  forgetPersistedHistory(`artifacts:session:${sessionId}`);
}
function unsupportedHistoryMethod(error: unknown): boolean {
  // Old shell bridges flatten structured daemon errors into message strings.
  const message = error instanceof Error ? error.message : String(error);
  return /IPC_NOT_FOUND|unknown method|method not found|请求的资源不存在/i.test(message);
}

async function readPersistedHistory<T extends PersistedValue, R>(
  scope: string, method: string, input: object,
  legacy: () => Promise<{ values: T[]; extra: R }>,
  extra: (response: HistoryProjection<T> & R) => R,
  fetchProjection?: (cursor?: HistoryCursor) => Promise<HistoryProjection<T> & R>
): Promise<{ values: T[]; extra: R; changed: boolean }> {
  const bridge = getBridge();
  if (historyBridge !== bridge) { historyBridge = bridge; resetHistoryCapabilities(); }
  const running = persistedReads.get(scope);
  if (running) {
    // A newer persistence event may arrive while an older snapshot is in
    // flight. Serialize and read again, rather than treating the old response
    // as proof the new durable message was observed.
    await running.catch(() => {});
    return readPersistedHistory(scope, method, input, legacy, extra, fetchProjection);
  }
  let pending!: Promise<{ values: T[]; extra: R; changed: boolean }>;
  pending = (async () => {
    const previous = persistedHistory.get(scope);
    if (!unsupportedHistoryMethods.has(method)) {
      try {
        const response = await (fetchProjection ? fetchProjection(previous?.cursor)
          : requestCore<HistoryProjection<T> & R>(method, { ...input, cursor: previous?.cursor }));
        if (response.cursor.scope !== scope) throw new Error(`Invalid history scope for ${method}`);
        // A server epoch change or malformed continuation must never merge two
        // unrelated databases. Reject before committing any cursor or rows.
        if (!response.reset && (!previous?.cursor || response.cursor.epoch !== previous.cursor.epoch
          || response.cursor.revision < previous.cursor.revision)) throw new Error(`Invalid history continuation for ${method}`);
        const changed = response.reset || response.items.length > 0;
        const rows = response.reset ? new Map<string, HistoryItem<PersistedValue>>()
          : response.items.length ? new Map(previous!.rows) : previous!.rows;
        for (const item of response.items) rows.set(item.value.id, item);
        const values = changed ? [...rows.values()].sort((a, b) =>
          (a.order.createdAt < b.order.createdAt ? -1 : a.order.createdAt > b.order.createdAt ? 1 : 0) || a.order.ordinal - b.order.ordinal
        ).map((item) => item.value) : previous!.values;
        if (persistedReads.get(scope) === pending) persistedHistory.set(scope, { cursor: response.cursor, rows, values });
        return { values: values as T[], extra: extra(response), changed };
      } catch (error) {
        if (!unsupportedHistoryMethod(error)) throw error;
        // Only a successful legacy read proves this is an unsupported method,
        // rather than a deleted/missing session. Transient errors still surface.
      }
    }
    const result = await legacy();
    unsupportedHistoryMethods.add(method);
    const changed = !previous || JSON.stringify(previous.values) !== JSON.stringify(result.values);
    const values = changed ? result.values : previous!.values as T[];
    if (persistedReads.get(scope) === pending) persistedHistory.set(scope, { rows: new Map(), values });
    return { values, extra: result.extra, changed };
  })();
  persistedReads.set(scope, pending);
  try { return await pending; }
  finally { if (persistedReads.get(scope) === pending) persistedReads.delete(scope); }
}

async function readSessionHistory(sessionId: string, fetchProjection?: (cursor?: HistoryCursor) => Promise<SessionHistory>): Promise<{ session: DomainSession; messages: Message[]; changed: boolean }> {
  const result = await readPersistedHistory<Message, { session: DomainSession }>(
    `messages:session:${sessionId}`, "session.history", { sessionId },
    async () => {
      const detail = await requestCore<{ session: DomainSession; messages: Message[] }>("session.get", { sessionId });
      return { values: detail.messages, extra: { session: detail.session } };
    }, (response) => ({ session: response.session }), fetchProjection
  );
  return { ...result.extra, messages: result.values, changed: result.changed };
}

/** Coalesce a project's visible histories into bounded IPC reads. Per-session
 * cursors/cache commits remain independent; event replay is not reordered. */
function readSessionHistoryBatch(sessionIds: string[]): Map<string, ReturnType<typeof readSessionHistory>> {
  const histories = new Map<string, ReturnType<typeof readSessionHistory>>();
  for (let offset = 0; offset < sessionIds.length; offset += 64) {
    const requests: Array<{ sessionId: string; cursor?: HistoryCursor; resolve: (value: SessionHistory) => void; reject: (error: unknown) => void }> = [];
    for (const sessionId of sessionIds.slice(offset, offset + 64)) {
      const pending = persistedReads.has(`messages:session:${sessionId}`)
        ? readSessionHistory(sessionId)
        : readSessionHistory(sessionId, (cursor) => new Promise((resolve, reject) => requests.push({ sessionId, cursor, resolve, reject })));
      // A later session can fail before the serial event loop reaches it.
      // Observe now, then preserve the rejection for its actual consumer.
      void pending.catch(() => {});
      histories.set(sessionId, pending);
    }
    if (!requests.length) continue;
    void (async () => {
      const individually = async (): Promise<boolean> => {
        const outcomes = await Promise.all(requests.map(async (request) => {
          try {
            const item = await requestCore<SessionHistory>("session.history", { sessionId: request.sessionId, cursor: request.cursor });
            if (item.session.id !== request.sessionId) throw new Error("Invalid session.history response");
            request.resolve(item);
            return true;
          } catch (error) { request.reject(error); return false; }
        }));
        return outcomes.every(Boolean);
      };
      try {
        if (unsupportedHistoryMethods.has("session.historyBatch")) { await individually(); return; }
        let items: SessionHistory[];
        try {
          ({ items } = await requestCore<{ items: SessionHistory[] }>("session.historyBatch", { items: requests.map(({ sessionId, cursor }) => ({ sessionId, cursor })) }));
        } catch (error) {
          if (!unsupportedHistoryMethod(error)) throw error;
          // One deleted session can fail a snapshot batch. Resolve each fallback
          // independently, so it never disables projections for healthy peers.
          if (await individually()) unsupportedHistoryMethods.add("session.historyBatch");
          return;
        }
        if (items.length !== requests.length || items.some((item, index) => item.session.id !== requests[index]!.sessionId)) {
          throw new Error("Invalid session.historyBatch response");
        }
        for (let index = 0; index < requests.length; index += 1) requests[index]!.resolve(items[index]!);
      } catch (error) {
        for (const request of requests) request.reject(error);
      }
    })();
  }
  return histories;
}

async function readArtifactHistory(input: { sessionId: string } | { projectRunId: string }, fetchProjection?: (cursor?: HistoryCursor) => Promise<HistoryProjection<Artifact>>): Promise<{ artifacts: Artifact[]; changed: boolean }> {
  const scope = "sessionId" in input ? `artifacts:session:${input.sessionId}` : `artifacts:projectRun:${input.projectRunId}`;
  const result = await readPersistedHistory<Artifact, object>(scope, "artifact.changes", input,
    async () => ({ values: await requestCore<Artifact[]>("artifact.list", input), extra: {} }), () => ({}), fetchProjection);
  return { artifacts: result.values, changed: result.changed };
}

async function hydrateStandaloneSession(uiSession: UiSession, knownRunId?: string): Promise<AgentRun | undefined> {
  const generation = sessionGeneration(uiSession.id);
  const readVersion = (standaloneStateReadVersions.get(uiSession.id) ?? 0) + 1;
  standaloneStateReadVersions.set(uiSession.id, readVersion);
  const isCurrent = () => currentSessionGeneration(uiSession.id, generation) && standaloneStateReadVersions.get(uiSession.id) === readVersion
    && !useSessionsStore.getState().sessions.find((item) => item.id === uiSession.id)?.projectRunId;
  const reads = [
    readSessionHistory(uiSession.id),
    replayStandaloneEvents(uiSession.id).then((replay) => {
      // Commit the replay alongside its cursor even if another metadata read
      // fails. A retry must not skip already acknowledged historical events.
      if (!currentSessionGeneration(uiSession.id, generation)) return;
      const cached = standaloneEventCache.get(uiSession.id) ?? [];
      const knownIds = new Set(cached.map((event) => event.eventId));
      standaloneEventCache.set(uiSession.id, mergeEventCache(cached, replay.events.filter((event) => !knownIds.has(event.eventId))));
      ingestInteractionEvents(replay.events);
      ingestFollowUpEvents(uiSession.id, replay.events);
    }),
    requestCore<AgentRun[]>("run.list", { sessionId: uiSession.id }),
    readArtifactHistory({ sessionId: uiSession.id })
  ] as const;
  const result = await Promise.all(reads).catch(async (error: unknown) => {
    // Do not overlap recovery with an earlier replay still committing its
    // cursor/cache. All reads are finite metadata/replay requests, not waits.
    await Promise.allSettled(reads);
    if (!isCurrent()) return undefined;
    throw error;
  });
  if (!result || !isCurrent()) return undefined;
  const [detail, , runs, artifactHistory] = result;
  if (!isCurrent()) return undefined;
  await syncQueuedFollowUps(uiSession.id);
  if (!isCurrent()) return undefined;
  const knownRun = knownRunId ? runs.find((item) => item.id === knownRunId) : undefined;
  const activeRun = runs.find(shouldPollAgentRun);
  const run = knownRun && shouldPollAgentRun(knownRun) ? knownRun : activeRun ?? knownRun ?? runs[0];
  const store = useSessionsStore.getState();
  // Generation checks above prevent deleted/evicted reads from repopulating
  // either store membership or any of the materialized history caches.
  standaloneHydrated.add(uiSession.id);
  standaloneMessageCache.set(uiSession.id, detail.messages);
  // replayStandaloneEvents is INCREMENTAL (resumes at the last seen
  // sequence): merge into the existing cache. A bare replace would shrink
  // the journal to just the newest events and wipe every older turn's fold
  // content from the timeline.
  standaloneArtifactCache.set(uiSession.id, artifactHistory.artifacts);
  store._upsertExternalSession(toStandaloneUiSession(detail.session));
  renderStandaloneCache(uiSession.id);
  store._setRunning(uiSession.id, standaloneLifecycle(detail.session, run));
  store._setForeground(uiSession.id, standaloneLifecycle(detail.session, run));
  store._setActiveAgentRun(uiSession.id, run && shouldPollAgentRun(run) ? run.id : undefined);
  // A new run after the known one means the oldest queued follow-up started.
  if (run && shouldPollAgentRun(run) && knownRunId && run.id !== knownRunId) store._shiftQueuedFollowUp(uiSession.id);
  return run;
}

/**
 * Persistence resync for an actively polled session — skips the event replay
 * entirely: the poll loop is already merging every event incrementally, so
 * re-reading the whole journal here (per assistant message!) only re-parses
 * megabytes of JSON and doubles as GC churn. Refreshes messages/artifacts/run
 * state and re-renders from the existing event cache.
 */
async function refreshStandaloneSessionState(uiSession: UiSession, knownRunId?: string): Promise<AgentRun | undefined> {
  const generation = sessionGeneration(uiSession.id);
  const readVersion = (standaloneStateReadVersions.get(uiSession.id) ?? 0) + 1;
  standaloneStateReadVersions.set(uiSession.id, readVersion);
  const isCurrent = () => currentSessionGeneration(uiSession.id, generation) && standaloneStateReadVersions.get(uiSession.id) === readVersion
    && !useSessionsStore.getState().sessions.find((item) => item.id === uiSession.id)?.projectRunId;
  const result = await Promise.all([
    readSessionHistory(uiSession.id),
    requestCore<AgentRun[]>("run.list", { sessionId: uiSession.id }),
    readArtifactHistory({ sessionId: uiSession.id })
  ]).catch((error: unknown) => { if (!isCurrent()) return undefined; throw error; });
  if (!result || !isCurrent()) return undefined;
  const [detail, runs, artifactHistory] = result;
  if (!isCurrent()) return undefined;
  await syncQueuedFollowUps(uiSession.id);
  if (!isCurrent()) return undefined;
  const knownRun = knownRunId ? runs.find((item) => item.id === knownRunId) : undefined;
  const activeRun = runs.find(shouldPollAgentRun);
  const run = knownRun && shouldPollAgentRun(knownRun) ? knownRun : activeRun ?? knownRun ?? runs[0];
  const store = useSessionsStore.getState();
  standaloneMessageCache.set(uiSession.id, detail.messages);
  standaloneArtifactCache.set(uiSession.id, artifactHistory.artifacts);
  store._upsertExternalSession(toStandaloneUiSession(detail.session));
  if (standaloneHydrated.has(uiSession.id)) renderStandaloneCache(uiSession.id);
  store._setRunning(uiSession.id, standaloneLifecycle(detail.session, run));
  store._setForeground(uiSession.id, standaloneLifecycle(detail.session, run));
  store._setActiveAgentRun(uiSession.id, run && shouldPollAgentRun(run) ? run.id : undefined);
  if (run && shouldPollAgentRun(run) && knownRunId && run.id !== knownRunId) store._shiftQueuedFollowUp(uiSession.id);
  return run;
}

function mergeStandaloneEvents(sessionId: string, events: RuntimeEvent[]): void {
  if (!events.length) return;
  const current = standaloneEventCache.get(sessionId) ?? [];
  const known = new Set(current.map((event) => event.eventId));
  const fresh = events.filter((event) => !known.has(event.eventId));
  if (!fresh.length) return;
  standaloneEventCache.set(sessionId, mergeEventCache(current, fresh));
  ingestInteractionEvents(fresh);
  fresh.forEach((event) => applyLiveProviderUi(sessionId, event));
  ingestFollowUpEvents(sessionId, fresh);
  ingestProviderCommandEvents(sessionId, fresh);
  // Keep the event -> render edge synchronous for streaming text. The
  // workbench follows the rendered timeline height; queueing deltas here can
  // leave the UI with a stale event array for a frame and, more importantly,
  // makes nested reasoning updates invisible to a last-row scroll trigger.
  // Structural bursts still use the coalesced full rebuild below.
  if (fresh.every((event) => STREAMING_DELTA_TYPES.has(event.type)) && applyStandaloneDeltas(sessionId, fresh)) return;
  // The first text/reasoning row cannot use the patch path. Do not leave
  // that first visible output behind an already queued structural rebuild.
  // Limit this exception to the first stream of each kind per run, not every
  // segment/tool transition; sustained structural traffic remains throttled.
  const firstOutput = fresh.some((event) => STREAMING_DELTA_TYPES.has(event.type)
    && !current.some((previous) => previous.runId === event.runId && previous.type === event.type));
  if (firstOutput && standaloneHydrated.has(sessionId)) {
    const frame = standaloneRenderFrames.get(sessionId);
    if (frame !== undefined) clearTimeout(frame);
    standaloneRenderFrames.delete(sessionId);
    standaloneLastRebuildAt.set(sessionId, Date.now());
    renderStandaloneCache(sessionId);
    return;
  }
  scheduleStandaloneRender(sessionId);
}

/**
 * Coalesces structural timeline rebuilds. Streaming deltas take the direct
 * patch path below, so full rebuilds only carry structural changes (tool
 * cards, statuses) — those are capped at ~5/s: during a heavy turn the rAF
 * cadence rebuilt the entire timeline of a multi-thousand-event session up to
 * 60 times per second, which dominated the renderer's transient memory churn.
 */
const STANDALONE_REBUILD_MIN_INTERVAL_MS = 200;
const standaloneLastRebuildAt = new Map<string, number>();

function scheduleStandaloneRender(sessionId: string): void {
  const generation = sessionGeneration(sessionId);
  if (standaloneRenderFrames.has(sessionId)) return;
  const elapsed = Date.now() - (standaloneLastRebuildAt.get(sessionId) ?? 0);
  const delay = Math.max(0, STANDALONE_REBUILD_MIN_INTERVAL_MS - elapsed);
  const frame = window.setTimeout(() => {
    if (!currentSessionGeneration(sessionId, generation)) return;
    standaloneRenderFrames.delete(sessionId);
    standaloneLastRebuildAt.set(sessionId, Date.now());
    // The session may have been evicted while the frame was pending; rendering
    // it now would re-create store entries nobody will clean up.
    if (standaloneHydrated.has(sessionId)) renderStandaloneCache(sessionId);
  }, delay);
  standaloneRenderFrames.set(sessionId, frame);
}

/**
 * Applies a delta-only batch to the newest streaming timeline row. Returns
 * false when no matching streaming row exists (a full rebuild must create it),
 * so callers can fall back to renderStandaloneCache.
 */
function applyStandaloneDeltas(sessionId: string, events: RuntimeEvent[]): boolean {
  const store = useSessionsStore.getState();
  const timeline = store.events[sessionId];
  if (!timeline?.length) return false;
  let next: TimelineEvent[] | undefined;
  for (const event of events) {
    if (event.type !== "agent.message_delta" && event.type !== "agent.thinking_delta") return false;
    const wantMessage = event.type === "agent.message_delta";
    const rows = next ?? timeline;
    let index = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const data = rows[i].data;
      if (data.kind !== (wantMessage ? "message" : "reasoning")) continue;
      // Only the newest row of this kind is eligible; a finalized row means
      // the delta starts a new stream and needs the full builder.
      if ((data.kind === "message" || data.kind === "reasoning") && data.streaming && data.messageId === event.payload.messageId) index = i;
      break;
    }
    if (index === -1) return false;
    const row = rows[index].data;
    if (row.kind !== "message" && row.kind !== "reasoning") return false;
    if (!next) next = [...timeline];
    // The daemon coalesces delta rows by ACCUMULATING chunk text, so every
    // delta payload carries the full text so far — replace, don't append.
    next[index] = { ...next[index], data: { ...row, text: event.payload.text } };
  }
  if (next) replaceSessionTimeline(sessionId, next);
  return true;
}

function renderStandaloneCache(sessionId: string): void {
  const events = standaloneEventCache.get(sessionId) ?? [];
  const messages = standaloneMessageCache.get(sessionId) ?? [];
  const artifacts = standaloneArtifactCache.get(sessionId) ?? [];
  const store = useSessionsStore.getState();
  replaceSessionTimeline(sessionId, buildStandaloneTimeline(messages, events, artifacts));
  store._replaceContextUsage(sessionId, latestContextUsage(events));
  useUsageStore.getState().ingest(sessionId, events);
  store._replaceArtifacts(sessionId, artifacts.flatMap(toUiArtifact));
  store._replaceRawLog(sessionId, buildRawLog(events, artifacts));
}

async function replayStandaloneEvents(sessionId: string): Promise<{ events: RuntimeEvent[]; lastSequence: number }> {
  const generation = sessionGeneration(sessionId);
  const stale = () => !currentSessionGeneration(sessionId, generation);
  const empty = { events: [] as RuntimeEvent[], lastSequence: 0 };
  let subscriptionId = standaloneSubscriptions.get(sessionId);
  if (!subscriptionId) {
    const subscription = await requestCore<{ subscriptionId: string }>("event.subscribe", { sessionId });
    if (stale()) return empty;
    subscriptionId = subscription.subscriptionId;
    standaloneSubscriptions.set(sessionId, subscriptionId);
  }
  const afterSequence = standaloneSequences.get(sessionId) ?? 0;
  try {
    const replay = await requestCore<{ events: RuntimeEvent[]; lastSequence: number }>("event.replay", { subscriptionId, afterSequence });
    if (stale()) return empty;
    standaloneSequences.set(sessionId, Math.max(standaloneSequences.get(sessionId) ?? 0, replay.lastSequence));
    return replay;
  } catch {
    if (stale()) return empty;
    resetHistoryCapabilities();
    standaloneSubscriptions.delete(sessionId);
    const subscription = await requestCore<{ subscriptionId: string }>("event.subscribe", { sessionId });
    if (stale()) return empty;
    standaloneSubscriptions.set(sessionId, subscription.subscriptionId);
    const replay = await requestCore<{ events: RuntimeEvent[]; lastSequence: number }>("event.replay", { subscriptionId: subscription.subscriptionId, afterSequence });
    if (stale()) return empty;
    standaloneSequences.set(sessionId, Math.max(standaloneSequences.get(sessionId) ?? 0, replay.lastSequence));
    return replay;
  }
}

/**
 * Cheap equality helpers for poll-tick store writes. Polls rebuild these
 * values from scratch every tick, so unchanged data would arrive as fresh
 * object identities and notify every Zustand subscriber; comparing by content
 * lets hydrateProjectRun skip no-op writes and detect real activity.
 */
function sameLifecycle(current: RunLifecycle | undefined, next: RunLifecycle | undefined): boolean {
  if (current === next) return true;
  if (!current || !next) return false;
  return current.status === next.status && current.reason === next.reason && current.startedAt === next.startedAt;
}

function sameTasks(current: SessionTask[] | undefined, next: SessionTask[]): boolean {
  return !!current && current.length === next.length && current.every((task, index) => {
    const other = next[index];
    return task.id === other.id && task.title === other.title && task.objective === other.objective
      && task.memberId === other.memberId && task.memberName === other.memberName && task.status === other.status
      && task.dependencies.join("") === other.dependencies.join("");
  });
}

function sameArtifacts(current: SessionArtifact[] | undefined, next: SessionArtifact[]): boolean {
  return !!current && current.length === next.length && current.every((artifact, index) => {
    const other = next[index];
    return artifact.id === other.id && artifact.kind === other.kind && artifact.name === other.name && artifact.content === other.content
      && artifact.comparisonUnavailable === other.comparisonUnavailable && artifact.diffSource === other.diffSource;
  });
}

function sameActiveRun(current: ActiveRunSummary | undefined, next: ActiveRunSummary | undefined): boolean {
  if (current === next) return true;
  if (!current || !next) return false;
  return current.id === next.id && current.goal === next.goal && current.status === next.status
    && current.agentName === next.agentName && current.startedAt === next.startedAt;
}

function sameTarget(current: SessionTarget, next: SessionTarget): boolean {
  if (current.type !== next.type) return false;
  if (current.type === "agent" && next.type === "agent") return current.instanceId === next.instanceId && current.teamId === next.teamId;
  if (current.type === "member" && next.type === "member") return current.teamId === next.teamId && current.memberId === next.memberId;
  if (current.type === "team" && next.type === "team") return current.teamId === next.teamId;
  return false;
}

/** Compares the persisted fields rendered by the workbench. */
function sameUiSession(current: UiSession, next: UiSession): boolean {
  return current.connectionId === next.connectionId && current.connectionRevision === next.connectionRevision && current.title === next.title && current.model === next.model
    && current.agentMode === next.agentMode && current.reasoningEffort === next.reasoningEffort && current.serviceTier === next.serviceTier
    && current.permissionMode === next.permissionMode
    && current.mode === next.mode && current.status === next.status
    && current.parentSessionId === next.parentSessionId && current.taskId === next.taskId
    && current.projectRunId === next.projectRunId
    && current.runId === next.runId && current.unreadCount === next.unreadCount
    && current.lastMessageAt === next.lastMessageAt && current.updatedAt === next.updatedAt
    && sameTarget(current.target, next.target);
}

/** One server snapshot removes per-session IPC round trips without sharing
 * sequence numbers across sessions or bypassing legacy full-replay healing. */
async function readProjectPoll(projectRunId: string): Promise<{ snapshot?: ProjectPollSnapshot; fallback?: ProjectRun }> {
  if (unsupportedHistoryMethods.has("projectRun.poll")) return {};
  const sessions = sessionsOfProjectRun(projectRunId);
  if (sessions.length > 64) return {}; // bounded protocol; legacy path remains available
  const input: ProjectPollInput = {
    projectRunId,
    visibleSessionIds: sessions.filter((session) => projectSessionDisplayed.has(session.id)).map((session) => session.id),
    sessions: sessions.map((session) => ({ sessionId: session.id, eventCursor: projectEventCursors.get(session.id), historyCursor: persistedHistory.get(`messages:session:${session.id}`)?.cursor })),
    artifactCursor: persistedHistory.get(`artifacts:projectRun:${projectRunId}`)?.cursor
  };
  try {
    const response = await requestCore<ProjectPollResult>("projectRun.poll", input);
    if ("fallback" in response) return { fallback: response.projectRun };
    const snapshot = response;
    const ids = new Set(snapshot.sessions.map((session) => session.id));
    if (snapshot.projectRun.id !== projectRunId || ids.size !== snapshot.sessions.length
      || snapshot.sessions.some((session) => session.projectRunId !== projectRunId)
      || snapshot.feeds.some((feed) => !ids.has(feed.sessionId) || feed.cursor.scope !== `events:session:${feed.sessionId}` || feed.events.some((event) => event.sessionId !== feed.sessionId))
      || snapshot.histories.some((history) => !ids.has(history.session.id) || history.cursor.scope !== `messages:session:${history.session.id}`)
      || snapshot.followUps.some((entry) => !ids.has(entry.sessionId) || entry.interactions?.some((interaction) => interaction.sessionId !== entry.sessionId))
      || snapshot.artifacts.cursor.scope !== `artifacts:projectRun:${projectRunId}`) throw new Error("Invalid projectRun.poll scope");
    return { snapshot };
  } catch (error) {
    if (!unsupportedHistoryMethod(error)) throw error;
    // The legacy project read must succeed before caching a capability miss.
    // A genuinely missing/deleted project never disables the endpoint globally.
    const { projectRun } = await requestCore<{ projectRun: ProjectRun }>("projectRun.get", { projectRunId });
    unsupportedHistoryMethods.add("projectRun.poll");
    return { fallback: projectRun };
  }
}

function resetProjectSessionFeed(sessionId: string): void {
  projectSessionSubscriptions.delete(sessionId);
  projectSessionSequences.delete(sessionId);
  projectEventCursors.delete(sessionId);
  projectSessionEventCache.delete(sessionId);
  projectSessionBuilt.delete(sessionId);
  projectSessionRenderedEvents.delete(sessionId);
  useInteractionsStore.getState()._removeSessions([sessionId]);
  useSessionsStore.getState()._replaceQueuedFollowUps(sessionId, []);
  useSessionsStore.getState()._bumpProviderCommands(sessionId);
  followUpListSynced.delete(sessionId);
}

function consumeProjectPollFeed(feed: ProjectPollSnapshot["feeds"][number]): { events: RuntimeEvent[]; hasNew: boolean } {
  const sessionId = feed.sessionId;
  if (feed.reset) resetProjectSessionFeed(sessionId);
  projectEventCursors.set(sessionId, feed.cursor);
  projectSessionSequences.set(sessionId, feed.cursor.sequence);
  const cached = projectSessionEventCache.get(sessionId) ?? [];
  const known = new Set(cached.map((event) => event.eventId));
  const fresh = feed.events.filter((event) => !known.has(event.eventId));
  if (fresh.length) {
    ingestInteractionEvents(fresh);
    if (!feed.reset) fresh.forEach((event) => applyLiveProviderUi(sessionId, event));
    ingestFollowUpEvents(sessionId, fresh);
    ingestProviderCommandEvents(sessionId, fresh);
  }
  const events = fresh.length ? mergeEventCache(cached, fresh) : cached;
  projectSessionEventCache.set(sessionId, events);
  return { events, hasNew: feed.reset || fresh.length > 0 };
}

async function hydrateProjectRun(projectRunId: string): Promise<ProjectRun> {
  const readVersion = (projectRunReadVersions.get(projectRunId) ?? 0) + 1;
  projectRunReadVersions.set(projectRunId, readVersion);
  const generations = new Map(sessionRuntimeGenerations);
  const isLatest = () => projectRunReadVersions.get(projectRunId) === readVersion;
  const isCurrent = (id: string) => isLatest() && currentSessionGeneration(id, generations.get(id) ?? 0);
  projectRunHydrated.add(projectRunId);
  const { snapshot, fallback } = await readProjectPoll(projectRunId);
  const projectRun = snapshot?.projectRun ?? fallback ?? (await requestCore<{ projectRun: ProjectRun }>("projectRun.get", { projectRunId })).projectRun;
  if (!isLatest()) return projectRun;
  const legacyResetIds = new Set<string>();
  if (!snapshot) for (const session of sessionsOfProjectRun(projectRunId)) {
    if (projectEventCursors.has(session.id)) {
      legacyResetIds.add(session.id);
      resetProjectSessionFeed(session.id);
    }
  }
  const team = requireUiTeam(String(projectRun.teamId));
  const legacyMain = team.members.find((member) => member.id === projectRun.mainMemberId);
  const mainAgent = useAgentsStore.getState().instances.find((instance) => instance.id === (projectRun.mainAgentInstanceId ?? legacyMain?.agentInstanceId));
  // Tracks whether this tick observed anything new; bumps the activity counter
  // the poll scheduler uses for idle backoff.
  let changed = projectRunUpdatedAt.get(projectRunId) !== projectRun.updatedAt;
  projectRunUpdatedAt.set(projectRunId, projectRun.updatedAt);
  const nextActiveRun = ["completed", "failed", "cancelled"].includes(projectRun.status) ? undefined : {
    id: projectRun.id,
    goal: projectRun.goal,
    status: toActiveRunStatus(projectRun),
    agentName: mainAgent?.displayName ?? legacyMain?.displayName ?? projectRun.mainMemberId,
    startedAt: projectRun.createdAt
  };
  const projectsState = useProjectsStore.getState();
  const currentActiveRun = projectsState.projects.find((project) => project.id === projectRun.projectId)?.activeRun;
  if (!sameActiveRun(currentActiveRun, nextActiveRun)) {
    changed = true;
    projectsState.setActiveRun(projectRun.projectId, nextActiveRun);
  }
  const [allSessions, tasks, artifactHistory, verifications, runs] = snapshot ? [
    snapshot.sessions, snapshot.tasks, await readArtifactHistory({ projectRunId }, () => Promise.resolve(snapshot.artifacts)), snapshot.verifications, snapshot.runs
  ] as const : await Promise.all([
    requestCore<DomainSession[]>("session.list", { projectId: projectRun.projectId }),
    requestCore<Task[]>("task.list", { projectRunId }),
    readArtifactHistory({ projectRunId }),
    requestCore<VerificationResult[]>("verification.list", { projectRunId }),
    requestCore<AgentRun[]>("run.list", { projectRunId })
  ]);
  if (!isLatest()) return projectRun;
  const artifacts = artifactHistory.artifacts;
  const artifactsChanged = projectRunRenderedArtifacts.get(projectRunId) !== artifacts;
  const sessions = allSessions.filter((session) => session.projectRunId === projectRunId && isCurrent(session.id));
  const store = useSessionsStore.getState();
  let activeRunCount = 0;
  let awaitingOutput = false;

  // Only sessions a workbench is showing (plus their descendants) need a
  // materialized timeline. Everything else still streams its raw event
  // journal into the cache and keeps lightweight state in sync, but skips
  // the full-history rebuild until it is actually opened.
  const neededSessionIds = new Set<string>();
  const childrenByParent = new Map<string, string[]>();
  for (const session of sessions) {
    if (session.parentSessionId) {
      const list = childrenByParent.get(session.parentSessionId) ?? [];
      list.push(session.id);
      childrenByParent.set(session.parentSessionId, list);
    }
  }
  const expandNeeded = (id: string): void => {
    if (neededSessionIds.has(id)) return;
    neededSessionIds.add(id);
    for (const childId of childrenByParent.get(id) ?? []) expandNeeded(childId);
  };
  for (const session of sessions) {
    // The first orchestration response can arrive before React switches the
    // mounted workbench from its standalone registration to the project run.
    if (projectSessionDisplayed.has(session.id) || standaloneDisplayed.has(session.id)) expandNeeded(session.id);
  }

  const histories = snapshot ? new Map(snapshot.histories.filter((history) => isCurrent(history.session.id)).map((history) => {
    const pending = readSessionHistory(history.session.id, () => Promise.resolve(history));
    void pending.catch(() => {});
    return [history.session.id, pending] as const;
  })) : readSessionHistoryBatch([...neededSessionIds]);
  const feeds = new Map(snapshot?.feeds.map((feed) => [feed.sessionId, feed]));
  const queues = new Map(snapshot?.followUps.map((queue) => [queue.sessionId, queue]));
  for (const session of sessions) {
    if (!isCurrent(session.id)) continue;
    const needed = neededSessionIds.has(session.id);
    const cached = projectSessionDetails.get(session.id);
    // Fetch a small revision projection even for idle displayed histories:
    // edits/deletes can share timestamps and do not always emit an event.
    // Event replay remains parallel, preserving the first-token path.
    const snapshotFeed = feeds.get(session.id);
    const [feed, , refreshed] = await Promise.all([
      snapshotFeed ? Promise.resolve(consumeProjectPollFeed(snapshotFeed)) : projectSessionEvents(session.id),
      snapshot && queues.has(session.id) ? Promise.resolve() : syncQueuedFollowUps(session.id),
      histories.get(session.id) ?? Promise.resolve(undefined)
    ]);
    if (!isCurrent(session.id)) continue;
    if (legacyResetIds.has(session.id)) {
      // The fresh subscription's full replay heals queues. Read its authority
      // after replay, rather than letting historical queued events restore one.
      followUpListSynced.delete(session.id);
      await syncQueuedFollowUps(session.id);
      if (!isCurrent(session.id)) continue;
    }
    if (queues.has(session.id)) {
      const queue = queues.get(session.id)!;
      store._replaceQueuedFollowUps(session.id, queue.items);
      // The in-memory queue was read before the DB snapshot. Replay newer
      // queue mutations so that an earlier empty list cannot erase a new item.
      const newer = snapshotFeed?.events.filter((event) => event.sequence > queue.afterSequence) ?? [];
      ingestFollowUpEvents(session.id, newer);
      if (queue.interactions) {
        const interactions = useInteractionsStore.getState();
        interactions._removeSessions([session.id]);
        for (const interaction of queue.interactions) interactions._upsert(interaction);
        ingestInteractionEvents(newer);
      }
      followUpListSynced.add(session.id);
    }
    if (refreshed) projectSessionDetails.set(session.id, refreshed);
    const detail = refreshed ?? (needed ? cached : undefined) ?? { session, messages: [] };
    // Metadata comes from this tick even when its unchanged message history
    // can be reused. Waiting/terminal/cancel/permission state never goes stale.
    const domainSession = refreshed?.session ?? session;
    const uiSession = toUiSession(domainSession, projectRun, team);
    const sessionArtifacts = artifacts.filter((artifact) => artifact.sessionId === session.id);
    const currentSession = store.sessions.find((item) => item.id === session.id);
    if (!currentSession || !sameUiSession(currentSession, uiSession)) {
      changed = true;
      store._upsertExternalSession(uiSession);
    }
    if (feed.hasNew) changed = true;
    // Rebuilding the timeline walks the full event history; skip it entirely
    // on poll ticks that delivered no new events, and for sessions no
    // workbench is showing (their timeline materializes on first open).
    const messageRevisionChanged = refreshed && (!cached || refreshed.messages !== cached.messages);
    const timelineDirty = needed && (feed.hasNew || projectSessionRenderedEvents.get(session.id) !== feed.events || messageRevisionChanged || artifactsChanged || !projectSessionBuilt.has(session.id));
    if (timelineDirty) {
      replaceSessionTimeline(session.id, buildTimeline(detail.messages, feed.events, projectRun, team, tasks, sessionArtifacts, verifications, session.id === projectRun.mainSessionId));
      store._replaceContextUsage(session.id, latestContextUsage(feed.events));
      useUsageStore.getState().ingest(session.id, feed.events);
      store._replaceRawLog(session.id, buildRawLog(feed.events, sessionArtifacts));
      projectSessionBuilt.add(session.id);
      projectSessionRenderedEvents.set(session.id, feed.events);
    }
    // Poll ticks rarely change tasks/artifacts/foreground; writing identical
    // data would still notify every Zustand subscriber, so skip no-op writes.
    const nextTasks = session.id === projectRun.mainSessionId ? tasks.map((task) => toUiTask(task, team)) : tasks.filter((task) => task.id === session.taskId).map((task) => toUiTask(task, team));
    if (!sameTasks(store.tasks[session.id], nextTasks)) {
      changed = true;
      store._replaceTasks(session.id, nextTasks);
    }
    const nextArtifacts = sessionArtifacts.flatMap(toUiArtifact);
    if (!sameArtifacts(store.artifacts[session.id], nextArtifacts)) {
      changed = true;
      store._replaceArtifacts(session.id, nextArtifacts);
    }
    // Runs in one provider session are serialized. Pick the newest run that
    // is still active. run.list returns runs ordered by updated_at DESC, and
    // terminal-state writes (e.g. a cancel persisting after the next run was
    // created) can push a finished run ahead of the one actually running —
    // picking "the first run if it is active" would then report the session
    // as idle while the turn is still executing (stop button gone, "done"
    // state shown, follow-ups sent as brand-new runs instead of queued).
    const sessionRuns = runs.filter((run) => run.sessionId === session.id);
    const activeRun = sessionRuns.find(shouldPollAgentRun);
    if (activeRun) activeRunCount += 1;
    if (neededSessionIds.has(session.id) && isAwaitingFirstOutput(activeRun, feed.events)) awaitingOutput = true;
    if (!sameLifecycle(store.foreground[session.id], activeRun ? standaloneLifecycle(domainSession, activeRun) : undefined)) {
      changed = true;
      store._setForeground(session.id, activeRun ? standaloneLifecycle(domainSession, activeRun) : undefined);
    }
    const previousRunId = store.activeAgentRunIds[session.id];
    if (previousRunId !== activeRun?.id) {
      changed = true;
      store._setActiveAgentRun(session.id, activeRun?.id);
    }
    // A transition to a different run id means the oldest queued follow-up
    // started its turn; previousRunId undefined is first hydrate (no shift).
    if (!queues.has(session.id) && activeRun && previousRunId && activeRun.id !== previousRunId) store._shiftQueuedFollowUp(session.id);
  }
  if (!isLatest()) return projectRun;
  projectRunRenderedArtifacts.set(projectRunId, artifacts);
  const root = projectRun.mainSessionId;
  projectRunActiveRuns.set(projectRunId, activeRunCount);
  projectRunAwaitingOutput.set(projectRunId, awaitingOutput);
  if (root && isCurrent(root)) {
    const nextRunning = projectLifecycle(projectRun);
    if (!sameLifecycle(store.running[root], nextRunning)) {
      changed = true;
      store._setRunning(root, nextRunning);
    }
  }
  if (changed) projectRunActivity.set(projectRunId, (projectRunActivity.get(projectRunId) ?? 0) + 1);
  return projectRun;
}

async function replayProjectSessionEvents(sessionId: string): Promise<{ events: RuntimeEvent[]; lastSequence: number }> {
  const generation = sessionGeneration(sessionId);
  const stale = () => !currentSessionGeneration(sessionId, generation);
  const empty = { events: [] as RuntimeEvent[], lastSequence: 0 };
  let subscriptionId = projectSessionSubscriptions.get(sessionId);
  if (!subscriptionId) {
    const subscription = await requestCore<{ subscriptionId: string }>("event.subscribe", { sessionId });
    if (stale()) return empty;
    subscriptionId = subscription.subscriptionId;
    projectSessionSubscriptions.set(sessionId, subscriptionId);
  }
  try {
    const replay = await requestCore<{ events: RuntimeEvent[]; lastSequence: number }>("event.replay", { subscriptionId, afterSequence: projectSessionSequences.get(sessionId) ?? 0 });
    return stale() ? empty : replay;
  } catch {
    if (stale()) return empty;
    resetHistoryCapabilities();
    projectSessionSubscriptions.delete(sessionId);
    projectSessionSequences.delete(sessionId);
  projectEventCursors.delete(sessionId);
    projectSessionEventCache.delete(sessionId);
    projectSessionBuilt.delete(sessionId);
    projectSessionRenderedEvents.delete(sessionId);
    projectSessionDetails.delete(sessionId);
    const subscription = await requestCore<{ subscriptionId: string }>("event.subscribe", { sessionId });
    if (stale()) return empty;
    projectSessionSubscriptions.set(sessionId, subscription.subscriptionId);
    const replay = await requestCore<{ events: RuntimeEvent[]; lastSequence: number }>("event.replay", { subscriptionId: subscription.subscriptionId, afterSequence: 0 });
    return stale() ? empty : replay;
  }
}

/**
 * Incremental event feed for a project session: replays only events after the
 * last seen sequence and keeps the full history in a local cache so timeline
 * rebuilds stay possible without re-transferring everything every poll tick.
 */
async function projectSessionEvents(sessionId: string): Promise<{ events: RuntimeEvent[]; hasNew: boolean }> {
  const generation = sessionGeneration(sessionId);
  const replay = await replayProjectSessionEvents(sessionId);
  if (!currentSessionGeneration(sessionId, generation)) return { events: [], hasNew: false };
  projectSessionSequences.set(sessionId, Math.max(projectSessionSequences.get(sessionId) ?? 0, replay.lastSequence));
  const cached = projectSessionEventCache.get(sessionId) ?? [];
  if (!replay.events.length) {
    projectSessionEventCache.set(sessionId, cached);
    return { events: cached, hasNew: false };
  }
  const known = new Set(cached.map((event) => event.eventId));
  const fresh = replay.events.filter((event) => !known.has(event.eventId));
  if (fresh.length) {
    ingestInteractionEvents(fresh);
    ingestFollowUpEvents(sessionId, fresh);
    ingestProviderCommandEvents(sessionId, fresh);
  }
  const events = fresh.length ? mergeEventCache(cached, fresh) : cached;
  projectSessionEventCache.set(sessionId, events);
  return { events, hasNew: fresh.length > 0 };
}

function ingestProviderCommandEvents(sessionId: string, events: RuntimeEvent[]): void {
  if (events.some((event) => event.type === "provider.commands_updated")) {
    useSessionsStore.getState()._bumpProviderCommands(sessionId);
  }
}

const POLL_FIRST_TICK_MS = 250;
const POLL_BASE_MS = 500;
const POLL_MAX_MS = 2000;
// Idle ticks tolerated at the base interval before the backoff starts.
const POLL_IDLE_THRESHOLD = 4;

// Identical sync failures are surfaced at most once per minute per session —
// a dead daemon would otherwise flood the timeline with an error row per tick.
const SYNC_ERROR_THROTTLE_MS = 60_000;
const lastSyncErrorShown = new Map<string, { at: number; message: string }>();

function appendSyncErrorThrottled(sessionId: string, message: string): void {
  const last = lastSyncErrorShown.get(sessionId);
  const now = Date.now();
  if (last && last.message === message && now - last.at < SYNC_ERROR_THROTTLE_MS) return;
  lastSyncErrorShown.set(sessionId, { at: now, message });
  useSessionsStore.getState()._append(sessionId, {
    kind: "error",
    code: "FRONTEND_SYNC_FAILED",
    message,
    retryable: true
  });
}

/** Keep visible starting turns responsive without accelerating idle/approval
 * waits or background sessions. Match by run id so an older turn's output
 * cannot hide the next queued turn's first-token wait. */
function isAwaitingFirstOutput(run: AgentRun | undefined, events: RuntimeEvent[]): boolean {
  if (!run || !["created", "starting", "running"].includes(run.status)) return false;
  return !events.some((event) => event.runId === run.id && (
    STREAMING_DELTA_TYPES.has(event.type) || event.type === "agent.message"
    || event.type === "agent.thinking_summary" || event.type === "tool.started"
    || event.type === "command.started" || event.type === "run.diff_updated"
  ));
}

function schedulePoll(projectRunId: string): void {
  for(const session of sessionsOfProjectRun(projectRunId)){const idle=projectIdleStreams.get(session.id);if(idle)idle.cancelled=true;projectIdleStreams.delete(session.id);}
  const existing = projectPollers.get(projectRunId);
  if (existing) clearTimeout(existing);
  let idleStreak = 0;
  const tick = async (): Promise<void> => {
    let projectRun: ProjectRun | undefined;
    try {
      const activityBefore = projectRunActivity.get(projectRunId) ?? 0;
      projectRun = await hydrateProjectRun(projectRunId);
      if (!shouldPollProjectRun(projectRun) && !hasQueuedFollowUpForProject(projectRunId)) {
        projectPollers.delete(projectRunId);
        projectRunActivity.delete(projectRunId);
        projectRunUpdatedAt.delete(projectRunId);
        projectRunActiveRuns.delete(projectRunId);
        projectRunAwaitingOutput.delete(projectRunId);
        // A run that just went terminal no longer re-materializes itself on
        // poll ticks; drop its caches now unless it is displayed or recent.
        evictProjectRunViewCaches();
        watchDisplayedProjectSessions(projectRunId);
        return;
      }
      // Any change observed by the tick resets the streak; otherwise back off
      // gradually (500ms → 1s → 2s cap) so idle runs stop hammering the daemon.
      idleStreak = (projectRunActivity.get(projectRunId) ?? 0) !== activityBefore
        || projectRunAwaitingOutput.get(projectRunId) ? 0 : idleStreak + 1;
    } catch (error) {
      console.error("Failed to synchronize orchestration run", error);
      // Surface frontend sync failures in the timeline: a silent poll error
      // looks exactly like "the assistant stopped responding" (no messages,
      // no state change), so make it visible instead of console-only.
      const root = projectRun?.mainSessionId ?? useSessionsStore.getState().sessions
        .find((session) => session.projectRunId === projectRunId)?.id;
      if (root) {
        appendSyncErrorThrottled(root, `前端同步失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const interval = idleStreak < POLL_IDLE_THRESHOLD
      ? POLL_BASE_MS
      : Math.min(POLL_BASE_MS * 2 ** (idleStreak - POLL_IDLE_THRESHOLD + 1), POLL_MAX_MS);
    projectPollers.set(projectRunId, setTimeout(() => void tick(), interval));
  };
  projectPollers.set(projectRunId, setTimeout(() => void tick(), POLL_FIRST_TICK_MS));
}

/** Terminal foreground state is not a native session event boundary. Use a
 * per-session cursor: project sessions allocate independent event sequences. */
function watchDisplayedProjectSessions(projectRunId:string):void {
  for(const session of sessionsOfProjectRun(projectRunId)) {
    if(!projectSessionDisplayed.has(session.id) || projectIdleStreams.has(session.id))continue;
    const controller={cancelled:false};projectIdleStreams.set(session.id,controller);
    void(async()=>{
      while(!controller.cancelled && projectSessionDisplayed.has(session.id) && !projectPollers.has(projectRunId)) {
        try {
          let subscriptionId=projectSessionSubscriptions.get(session.id);
          if(!subscriptionId){const subscribed=await requestCore<{subscriptionId:string}>("event.subscribe",{sessionId:session.id});subscriptionId=subscribed.subscriptionId;projectSessionSubscriptions.set(session.id,subscriptionId);}
          if(controller.cancelled)break;
          const update=await requestCore<{events:RuntimeEvent[];lastSequence:number}>("event.wait",{subscriptionId,afterSequence:projectSessionSequences.get(session.id)??0,timeoutMs:20_000});
          if(controller.cancelled)break;
          if(update.events.length)await hydrateProjectRun(projectRunId);
        } catch(error) {
          if(controller.cancelled)break;
          projectSessionSubscriptions.delete(session.id);
          appendSyncErrorThrottled(session.id,`前端同步失败: ${error instanceof Error?error.message:String(error)}`);
          await new Promise(resolve=>setTimeout(resolve,250));
        }
      }
      if(projectIdleStreams.get(session.id)===controller)projectIdleStreams.delete(session.id);
    })();
  }
}

function needsStandalonePersistenceSync(events: RuntimeEvent[]): boolean {
  // Native diff snapshots already contain the live view. Re-fetching all
  // messages/artifacts for each snapshot defeats structural render batching.
  // Message/terminal syncs still load the final raw diff artifact.
  return events.some((event) => event.type === "agent.message"
    || event.type === "session.native_history_synced"
    || (event.type === "artifact.created" && event.payload.kind !== "diff")
    || event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled");
}

function scheduleStandalonePoll(sessionId: string, runId?: string, hydrateBeforeWait = false): void {
  const existing = standaloneStreams.get(sessionId);
  if (existing) existing.cancelled = true;
  const controller = { cancelled: false };
  standaloneStreams.set(sessionId, controller);
  let foregroundActive=true;
  void (async () => {
    while (!controller.cancelled) {
      try {
        const session = useSessionsStore.getState().sessions.find((item) => item.id === sessionId);
        if (!session) break;
        if (!foregroundActive && !standaloneDisplayed.has(sessionId) && !(useSessionsStore.getState().queuedFollowUps[sessionId]?.length)) break;
        if (hydrateBeforeWait) {
          const run = await hydrateStandaloneSession(session, runId);
          hydrateBeforeWait = false;
          foregroundActive=Boolean(run && shouldPollAgentRun(run));
          if (!foregroundActive && !standaloneDisplayed.has(sessionId) && !(useSessionsStore.getState().queuedFollowUps[sessionId]?.length)) break;
          if (controller.cancelled) break;
        }
        if (!standaloneSubscriptions.has(sessionId)) {
          const run = await hydrateStandaloneSession(session, runId);
          if (controller.cancelled) break;
          foregroundActive=Boolean(run && shouldPollAgentRun(run));
          if (!foregroundActive && !standaloneDisplayed.has(sessionId) && !(useSessionsStore.getState().queuedFollowUps[sessionId]?.length)) break;
        }
        const subscriptionId = standaloneSubscriptions.get(sessionId);
        if (!subscriptionId) break;
        const update = await requestCore<{ events: RuntimeEvent[]; lastSequence: number }>("event.wait", {
          subscriptionId,
          afterSequence: standaloneSequences.get(sessionId) ?? 0,
          timeoutMs: 20_000
        });
        if (controller.cancelled) break;
        standaloneSequences.set(sessionId, update.lastSequence);
        if (!update.events.length) continue;
        mergeStandaloneEvents(sessionId, update.events);
        const needsPersistenceSync = needsStandalonePersistenceSync(update.events);
        if (needsPersistenceSync) {
          // Light refresh: the event cache is already fed incrementally by
          // this very poll loop, so a full replay here would only re-transfer
          // the whole journal. Only the persisted side needs a resync.
          const run = await refreshStandaloneSessionState(session, runId);
          foregroundActive=Boolean(run && shouldPollAgentRun(run));
          if (!run || !shouldPollAgentRun(run)) {
            if ((useSessionsStore.getState().queuedFollowUps[sessionId]?.length ?? 0) > 0) {
              await new Promise((resolve) => setTimeout(resolve, 200));
              continue;
            }
            if (!standaloneDisplayed.has(sessionId)) break;
          }
        }
      } catch (error) {
        if (controller.cancelled) break;
        resetHistoryCapabilities();
        console.error("Failed to stream standalone Agent run", error);
        appendSyncErrorThrottled(sessionId, `前端同步失败: ${error instanceof Error ? error.message : String(error)}`);
        standaloneSubscriptions.delete(sessionId);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (standaloneStreams.get(sessionId) === controller) standaloneStreams.delete(sessionId);
  })();
}

function hasQueuedFollowUpForProject(projectRunId: string): boolean {
  const state = useSessionsStore.getState();
  return state.sessions.some((session) =>
    session.projectRunId === projectRunId && (state.queuedFollowUps[session.id]?.length ?? 0) > 0
  );
}

function buildStandaloneTimeline(messages: Message[], events: RuntimeEvent[], artifacts: Artifact[]): TimelineEvent[] {
  const timeline = messageTimeline(messages, undefined, artifacts);
  const changedFiles = diffArtifactsByScope(artifacts);
  appendRuntimeEvents(timeline, messages, events, (event) => runtimePayload(event, undefined, [], new Map(), new Map(artifacts.map((artifact) => [artifact.id, artifact])), new Map(), changedFiles));
  return groupToolTimeline(timeline
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sequence - right.sequence))
    .map((event, index) => ({ ...event, sequence: index + 1 }));
}

function latestContextUsage(events: RuntimeEvent[]): Extract<RuntimeEvent, { type: "usage.updated" }>["payload"] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "usage.updated") return event.payload;
  }
  return undefined;
}

function buildTimeline(
  messages: Message[],
  events: RuntimeEvent[],
  projectRun: ProjectRun,
  team: UiTeam | undefined,
  tasks: Task[],
  artifacts: Artifact[],
  verifications: VerificationResult[],
  isMain: boolean
): TimelineEvent[] {
  const resolvedApprovals = new Map(events.filter((event) => event.type === "approval.resolved").map((event) => [event.payload.approvalId, event.payload.decision]));
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const verificationsById = new Map(verifications.map((verification) => [verification.id, verification]));
  const changedFiles = diffArtifactsByScope(artifacts);
  const timeline = messageTimeline(messages, team, artifacts);
  appendRuntimeEvents(timeline, messages, events, (event) => runtimePayload(event, team, tasks, resolvedApprovals, artifactsById, verificationsById, changedFiles));
  if (isMain) {
    timeline.push({
      id: `project-run-${projectRun.id}-${projectRun.status}`,
      sessionId: String(projectRun.mainSessionId),
      sequence: Number.MAX_SAFE_INTEGER,
      timestamp: projectRun.updatedAt,
      data: { kind: "run_status", run: projectLifecycle(projectRun) ?? { status: "running" } }
    });
  }
  return groupToolTimeline(compactOrchestrationTimeline(timeline, projectRun.mainSessionId)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sequence - right.sequence))
    .map((event, index) => ({ ...event, sequence: index + 1 }));
}

function appendRuntimeEvents(
  timeline: TimelineEvent[],
  messages: Message[],
  events: RuntimeEvent[],
  mapPayload: (event: RuntimeEvent) => TimelinePayload | undefined
): void {
  // Persisted agent messages per run. A run's text segments flush (and
  // persist) in order, so only the first N delta segments of a run are
  // already rendered as persisted messages — later segments of the same run
  // must still stream. (Deduping per run id would mute every segment after
  // the first tool call.)
  const persistedSegmentsByRun = new Map<string, number>();
  for (const message of messages) {
    if (message.sender !== "agent" || !message.runId) continue;
    persistedSegmentsByRun.set(message.runId, (persistedSegmentsByRun.get(message.runId) ?? 0) + 1);
  }
  const hiddenCompletions = hiddenCompletionRunIds(messages);
  const hiddenInternalRuns = hiddenInternalRunIds(messages);
  const terminalRuns = new Map(events
    .filter((event) => event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled")
    .map((event) => [String(event.runId ?? ""), event.type === "run.failed" ? "failed" as const : "done" as const]));
  const latestTerminalEvents = new Map(events
    .filter((event) => event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled")
    .map((event) => [String(event.runId ?? ""), event.eventId]));
  const streaming = new Map<string, number>();
  const deltaSegments = new Map<string, string[]>();
  const reasoning = new Map<string, number>();
  const latestReasoning = new Map<string, string>();
  const reasoningGeneration = new Map<string, number>();
  const runningReasoningRows = new Map<number, string>();
  const tools = new Map<string, number>();
  const commands = new Map<string, number>();
  const approvalRows = new Map<string, number>();
  const pendingCommandApprovals = new Map<string, number>();
  const retryableCommands = new Map<string, number>();
  const latestTool = new Map<string, string>();
  const latestCommand = new Map<string, string>();
  const runningRows = new Map<number, string>();
  const backgroundRows = new Set<number>();
  // Streaming message rows per run; closed below once the run reaches a
  // terminal event so a killed run cannot leave a row blinking forever.
  const streamingMessageRows = new Map<number, string>();

  const push = (event: RuntimeEvent, data: TimelinePayload): number => {
    timeline.push({ id: event.eventId, sessionId: String(event.sessionId), runId: event.runId, background: event.background, sequence: event.sequence, timestamp: event.timestamp, data });
    if (event.background) backgroundRows.add(timeline.length-1);
    return timeline.length - 1;
  };

  // Provider-native sub-agent activity is attached to its dispatch card
  // instead of appearing as top-level rows.
  const nativeDiffs = new Map<string, RuntimeEvent>();
  for (const event of events) {
    if (event.type === "run.diff_updated") nativeDiffs.set(JSON.stringify([event.sessionId, event.runId]), event);
  }
  const subagentActivities = collectSubagentActivities(events);
  const withActivities = (subagent: Extract<TimelinePayload, { kind: "tool_activity" }>["subagent"], callId?: string): typeof subagent => {
    if (!subagent) return subagent;
    const activities = callId ? subagentActivities.get(callId) : undefined;
    return activities?.length ? { ...subagent, activities } : subagent;
  };

  const finishLatestReasoning = (runId: string): void => {
    const key = latestReasoning.get(runId);
    const index = key ? reasoning.get(key) : undefined;
    if (index === undefined) return;
    const current = timeline[index].data;
    if (current.kind === "reasoning" && current.streaming) {
      timeline[index] = { ...timeline[index], data: { ...current, streaming: false } };
    }
    runningReasoningRows.delete(index);
  };

  for (const event of events) {
    const runId = String(event.runId ?? "session");
    if (event.type === "approval.requested") {
      if (approvalRows.has(event.payload.approvalId)) continue;
      const key = JSON.stringify([event.sessionId, event.projectRunId, event.taskId, event.payload.operation ?? event.payload.summary]);
      const existing = event.payload.category === "command" ? pendingCommandApprovals.get(key) : undefined;
      if (existing !== undefined) {
        approvalRows.set(event.payload.approvalId, existing);
        continue;
      }
      const data = mapPayload(event);
      if (data) {
        const index = push(event, data);
        approvalRows.set(event.payload.approvalId, index);
        if (event.payload.category === "command") pendingCommandApprovals.set(key, index);
      }
      continue;
    }
    if (event.type === "approval.resolved") {
      const index = approvalRows.get(event.payload.approvalId);
      const current = index === undefined ? undefined : timeline[index];
      if (current?.data.kind === "approval") {
        timeline[index!] = { ...current, data: { ...current.data, approval: { ...current.data.approval, status: event.payload.decision, decisionScope: event.payload.scope } } };
        for (const [key, value] of pendingCommandApprovals) if (value === index) pendingCommandApprovals.delete(key);
      }
      continue;
    }
    const nativeDiff = nativeDiffs.get(JSON.stringify([event.sessionId, event.runId]));
    if (nativeDiff && (event.type === "file.changed" || (event.type === "run.diff_updated" && nativeDiff !== event))) continue;
    if (subagentDispatchIdOf(event)) continue;
    if (hiddenInternalRuns.has(runId)) continue;
    if ((event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled")
      && latestTerminalEvents.get(runId) !== event.eventId) continue;
    if (event.type === "run.completed" && hiddenCompletions.has(runId)) continue;
    if (event.type === "agent.message_delta") {
      // The model has moved on to final text output: whatever reasoning
      // row is still streaming for this run is done now (pi/omp emit no
      // thinking_summary in this path, so without this the row would stay
      // "thinking…" forever).
      finishLatestReasoning(runId);
      // Skip exactly the delta segments that already have a persisted
      // message (segments flush in order); anything newer keeps streaming.
      let order = deltaSegments.get(runId);
      if (!order) {
        order = [];
        deltaSegments.set(runId, order);
      }
      let segmentIndex = order.indexOf(event.payload.messageId);
      if (segmentIndex === -1) {
        order.push(event.payload.messageId);
        segmentIndex = order.length - 1;
      }
      if (segmentIndex < (persistedSegmentsByRun.get(runId) ?? 0)) continue;
      const key = `${runId}:${event.payload.messageId}`;
      const index = streaming.get(key);
      // Delta payloads are cumulative (the daemon accumulates chunk text when
      // coalescing), so each event REPLACES the row text — appending would
      // duplicate everything.
      if (index === undefined) {
        const row = push(event, { kind: "message", sender: "agent", text: event.payload.text, streaming: true, messageId: event.payload.messageId });
        timeline[row] = { ...timeline[row], id: `agent-message-${runId}-${segmentIndex}` };
        streaming.set(key, row);
        streamingMessageRows.set(row, runId);
      } else {
        const current = timeline[index].data;
        if (event.background) backgroundRows.add(index);
        if (current.kind === "message") timeline[index] = { ...timeline[index], data: { ...current, text: event.payload.text } };
      }
      continue;
    }
    if (event.type === "agent.thinking_delta") {
      const generation = reasoningGeneration.get(runId) ?? 0;
      const key = `${runId}:${event.payload.messageId}:${generation}`;
      const index = reasoning.get(key);
      if (index === undefined) {
        const text = capReasoningText(event.payload.text);
        if (!text.trim()) continue;
        const row = push(event, { kind: "reasoning", text, streaming: true, messageId: event.payload.messageId });
        reasoning.set(key, row);
        latestReasoning.set(runId, key);
        runningReasoningRows.set(row, runId);
      } else {
        const current = timeline[index].data;
        if (event.background) backgroundRows.add(index);
        // Cumulative payload — replace (see agent.message_delta above).
        if (current.kind === "reasoning") timeline[index] = { ...timeline[index], data: { ...current, text: capReasoningText(event.payload.text) } };
      }
      continue;
    }
    if (event.type === "agent.thinking_summary") {
      const explicitKey = event.payload.messageId
        ? `${runId}:${event.payload.messageId}:${reasoningGeneration.get(runId) ?? 0}`
        : undefined;
      const key = explicitKey && reasoning.has(explicitKey) ? explicitKey : latestReasoning.get(runId) ?? explicitKey;
      const index = key ? reasoning.get(key) : undefined;
      if (index === undefined) {
        const text = capReasoningText(event.payload.text);
        if (!text.trim()) continue;
        const row = push(event, { kind: "reasoning", text, streaming: false, messageId: event.payload.messageId });
        if (key) reasoning.set(key, row);
      } else {
        const current = timeline[index].data;
        if (current.kind === "reasoning") timeline[index] = {
          ...timeline[index],
          data: { ...current, text: capReasoningText(event.payload.text || current.text), streaming: false }
        };
        runningReasoningRows.delete(index);
      }
      continue;
    }
    if (event.type === "tool.started" || event.type === "tool.updated" || event.type === "tool.finished") {
      if (event.type === "tool.started") finishLatestReasoning(runId);
      const fallback = `${runId}:${event.payload.toolName}`;
      const suppliedCallId = event.payload.callId;
      const key = suppliedCallId ? `${runId}:${suppliedCallId}` : event.type === "tool.finished" ? latestTool.get(fallback) ?? `${fallback}:${event.sequence}` : `${fallback}:${event.sequence}`;
      if (event.type === "tool.started") latestTool.set(fallback, key);
      const index = tools.get(key);
      if (index === undefined) {
        const row = push(event, {
          kind: "tool_activity",
          toolName: event.payload.toolName,
          status: event.type === "tool.finished" ? (event.payload.success ? "done" : "failed") : "running",
          input: event.payload.inputSummary,
          output: event.type !== "tool.started" ? event.payload.outputSummary : undefined,
          codeExecution: mergeCodeExecution(undefined, event.payload.codeExecution),
          fileDiff: event.payload.fileDiff,
          subagent: withActivities(event.payload.subagent, suppliedCallId)
        });
        tools.set(key, row);
        if (event.type === "tool.started") runningRows.set(row, runId);
      } else {
        const current = timeline[index].data;
        if (event.background) backgroundRows.add(index);
        if (current.kind === "tool_activity") timeline[index] = {
          ...timeline[index],
          data: {
            ...current,
            toolName: current.toolName === "tool" ? event.payload.toolName : current.toolName,
            status: event.type === "tool.finished" ? (event.payload.success ? "done" : "failed") : current.status,
            input: event.payload.inputSummary ?? current.input,
            output: event.type === "tool.finished" || (event.type === "tool.updated" && current.status === "running") ? event.payload.outputSummary ?? current.output : current.output,
            fileDiff: event.payload.fileDiff ?? current.fileDiff,
            codeExecution: mergeCodeExecution(current.codeExecution, event.payload.codeExecution),
            subagent: withActivities(event.payload.subagent ?? current.subagent, suppliedCallId)
          }
        };
        if (event.type === "tool.finished") runningRows.delete(index);
      }
      if (event.type === "tool.started") reasoningGeneration.set(runId, (reasoningGeneration.get(runId) ?? 0) + 1);
      continue;
    }
    if (event.type === "command.started" || event.type === "command.updated" || event.type === "command.finished") {
      if (event.type === "command.started") finishLatestReasoning(runId);
      const fallback = `${runId}:${event.payload.command ?? "command"}`;
      const suppliedCallId = event.payload.callId;
      const key = suppliedCallId ? `${runId}:${suppliedCallId}` : event.type === "command.finished" ? latestCommand.get(fallback) ?? `${fallback}:${event.sequence}` : `${fallback}:${event.sequence}`;
      if (event.type === "command.started") latestCommand.set(fallback, key);
      let index = commands.get(key);
      const retryKey = event.payload.command ? `${runId}:${normalizeCommandForRetry(event.payload.command)}` : undefined;
      if (index === undefined && event.type === "command.started" && retryKey) {
        const retryIndex = retryableCommands.get(retryKey);
        const previous = retryIndex === undefined ? undefined : timeline[retryIndex]?.data;
        if (retryIndex !== undefined && previous?.kind === "command" && previous.status !== "done") {
          index = retryIndex;
          commands.set(key, retryIndex);
          timeline[retryIndex] = {
            ...timeline[retryIndex],
            data: {
              ...previous,
              command: event.payload.command,
              status: "running",
              exitCode: undefined,
              attempts: (previous.attempts ?? 1) + 1
            }
          };
          runningRows.set(retryIndex, runId);
        }
      }
      if (index === undefined) {
        const data = mapPayload(event);
        if (data) {
          if (data.kind === "command" && event.type === "command.started") data.attempts = 1;
          const row = push(event, data);
          commands.set(key, row);
          if (retryKey && event.type === "command.started") retryableCommands.set(retryKey, row);
          if (event.type === "command.started") runningRows.set(row, runId);
        }
      } else {
        const current = timeline[index].data;
        if (event.background) backgroundRows.add(index);
        if (current.kind === "command" && current.status === "running" && event.type === "command.updated") timeline[index] = { ...timeline[index], data: { ...current, output: event.payload.outputSummary ?? current.output } };
        if (current.kind === "command" && event.type === "command.finished") timeline[index] = {
          ...timeline[index],
          data: { ...current, status: event.payload.exitCode === 0 ? "done" : "failed", exitCode: event.payload.exitCode, output: event.payload.outputSummary ?? current.output }
        };
        if (event.type === "command.finished") runningRows.delete(index);
      }
      if (event.type === "command.started") reasoningGeneration.set(runId, (reasoningGeneration.get(runId) ?? 0) + 1);
      continue;
    }
    const data = mapPayload(event);
    if (data) push(event, data);
  }

  for (const [index, runId] of runningRows) {
    if (backgroundRows.has(index)) continue;
    const terminalStatus = terminalRuns.get(runId);
    if (!terminalStatus) continue;
    const current = timeline[index].data;
    if (current.kind === "tool_activity") timeline[index] = { ...timeline[index], data: { ...current, status: terminalStatus } };
    if (current.kind === "command") timeline[index] = { ...timeline[index], data: { ...current, status: terminalStatus } };
  }
  for (const [index, runId] of runningReasoningRows) {
    if (backgroundRows.has(index)) continue;
    if (!terminalRuns.has(runId)) continue;
    const current = timeline[index].data;
    if (current.kind === "reasoning") timeline[index] = { ...timeline[index], data: { ...current, streaming: false } };
  }
  for (const [index, runId] of streamingMessageRows) {
    if (backgroundRows.has(index)) continue;
    if (!terminalRuns.has(runId)) continue;
    const current = timeline[index].data;
    if (current.kind === "message" && current.streaming) timeline[index] = { ...timeline[index], data: { ...current, streaming: false } };
  }
}

function normalizeCommandForRetry(command: string): string {
  return command.replaceAll("\\\\", "\\").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function messageTimeline(messages: Message[], team?: UiTeam, artifacts: Artifact[] = []): TimelineEvent[] {
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const segments = new Map<string, number>();
  return messages.filter(isVisibleTimelineMessage).map((message, index) => {
    let id = `message-${message.id}`;
    if (message.sender === "agent" && message.runId) {
      const segment = segments.get(message.runId) ?? 0;
      segments.set(message.runId, segment + 1);
      id = `agent-message-${message.runId}-${segment}`;
    }
    return {
      id,
      sessionId: message.sessionId,
      runId: message.runId,
      background: message.background,
      sequence: index + 1,
      timestamp: message.createdAt,
      data: {
        kind: "message",
        sender: message.sender,
        authorName: message.fromMemberId ? team?.members.find((member) => member.id === message.fromMemberId)?.displayName : undefined,
        text: message.text,
        messageId: message.id,
        editedAt: message.editedAt,
        streaming: message.sender === "agent" && message.nativeIdentity?.turnStatus === "running" && !message.nativeIdentity.completed,
        attachments: [...(message.attachmentIds?.flatMap((id) => {
          const artifact = artifactsById.get(id);
          return artifact ? [{
            id: artifact.id,
            name: artifact.name,
            path: artifact.path,
            kind: artifact.kind === "image" ? "image" as const : "file" as const,
            mimeType: typeof artifact.metadata?.mimeType === "string" ? artifact.metadata.mimeType : undefined,
            sizeBytes: typeof artifact.metadata?.sizeBytes === "number" ? artifact.metadata.sizeBytes : undefined
          }] : [];
        }) ?? []), ...(message.nativeFiles?.map(file => ({ id: file.id, name: file.name, kind: "file" as const, unavailable: true })) ?? [])]
      }
    };
  });
}

function runtimePayload(
  event: RuntimeEvent,
  team: UiTeam | undefined,
  tasks: Task[],
  approvals: Map<string, "approved" | "rejected">,
  artifacts: Map<string, Artifact>,
  verifications: Map<string, VerificationResult>,
  changedFiles: Map<string, GitChangedFile>
): TimelinePayload | undefined {
  if (event.type === "agent.message") return undefined;
  if (event.type === "agent.message_delta" || event.type === "agent.thinking_delta" || event.type === "agent.thinking_summary") return undefined;
  if (event.type === "run.started") return { kind: "activity", phase: "starting" };
  if (event.type === "provider.extension_ui") {
    const raw = event.payload.raw as { url?: unknown; launchUrl?: unknown; instructions?: unknown } | undefined;
    const url = typeof raw?.url === "string" && /^https?:\/\//i.test(raw.url) ? raw.url : undefined;
    return { kind: "provider_ui", method: event.payload.method, key: event.payload.key, text: event.payload.text || (typeof raw?.instructions === "string" ? raw.instructions : ""), url };
  }
  if (event.type === "provider.background_error") return {kind:"error",code:"BACKGROUND_RUNTIME_ERROR",message:event.payload.message,retryable:true};
  if (event.type === "provider.runtime_closed") return undefined;
  if (event.type === "agent.status") {
    if (event.payload.phase === "provider_queued") return { kind: "activity", phase: "provider_queued" };
    if (event.payload.phase === "provider_starting") return { kind: "activity", phase: "starting" };
    if (event.payload.phase === "turn_started") return { kind: "activity", phase: "thinking" };
    if (event.payload.phase === "turn_completed") return undefined;
    return { kind: "activity", phase: "completed", detail: "turn_failed" };
  }
  if (event.type === "tool.updated") return { kind: "tool_activity", toolName:event.payload.toolName, status:"running", input:event.payload.inputSummary, output:event.payload.outputSummary, subagent:event.payload.subagent, codeExecution:event.payload.codeExecution };
  if (event.type === "tool.started") return {
    kind: "tool_activity",
    toolName: event.payload.toolName,
    status: "running",
    input: event.payload.inputSummary,
    fileDiff: event.payload.fileDiff,
    codeExecution: event.payload.codeExecution,
    subagent: event.payload.subagent
  };
  if (event.type === "tool.finished") return {
    kind: "tool_activity",
    toolName: event.payload.toolName,
    status: event.payload.success ? "done" : "failed",
    input: event.payload.inputSummary,
    output: event.payload.outputSummary,
    fileDiff: event.payload.fileDiff,
    codeExecution: event.payload.codeExecution,
    subagent: event.payload.subagent
  };
  // Usage events are state updates for the composer context indicator. Rendering
  // every update in the timeline produces a stream of meaningless token rows.
  if (event.type === "usage.updated" || event.type === "provider.commands_updated") return undefined;
  if (event.type === "artifact.created") {
    if (event.payload.kind === "diff") return undefined;
    const artifact = artifacts.get(event.payload.artifactId);
    return {
      kind: "artifact",
      artifactType: event.payload.kind,
      name: event.payload.name,
      mimeType: event.payload.mimeType,
      content: artifact?.content,
      path: event.payload.path ?? artifact?.path
    };
  }
  if (event.type === "run.completed") return { kind: "activity", phase: "completed", detail: event.payload.summary };
  if (event.type === "run.cancelled") return { kind: "activity", phase: "stopped" };
  if (event.type === "session.checkpoint_reverted") return {
    kind: "checkpoint_reverted",
    checkpointId: event.payload.checkpointId,
    restored: event.payload.restored,
    removed: event.payload.removed,
    skipped: event.payload.skipped,
    ...(event.payload.warning ? { warning: event.payload.warning } : {})
  };
  if (event.type === "planner.decision") return { kind: "planner_decision", mode: event.payload.mode, rationale: event.payload.rationale };
  if (event.type === "recovery.decision") return { kind: "recovery_decision", action: event.payload.action, taskId: event.payload.taskId, rationale: event.payload.rationale };
  if (event.type === "task.updated") {
    const task = tasks.find((item) => item.id === event.payload.taskId);
    return { kind: "task_update", taskId: event.payload.taskId, title: task?.title ?? event.payload.taskId, objective: task?.objective, memberId: event.payload.assignedMemberId ?? task?.assignedMemberId, memberName: team?.members.find((member) => member.id === event.payload.assignedMemberId)?.displayName, status: event.payload.status as Task["status"] };
  }
  if (event.type === "handoff.created") return {
    kind: "handoff",
    taskId: event.payload.taskId,
    fromName: team?.members.find((member) => member.id === event.payload.fromMemberId)?.displayName ?? event.payload.fromMemberId,
    toName: team?.members.find((member) => member.id === event.payload.toMemberId)?.displayName ?? event.payload.toMemberId,
    summary: event.payload.summary,
    sessionId: event.payload.targetSessionId
  };
  if (event.type === "approval.requested") return {
    kind: "approval",
    approval: {
      id: event.payload.approvalId,
      title: event.payload.category === "delegate" ? "主 Agent 请求委派" : event.payload.category === "merge" ? "请求合并到项目分支" : "运行审批",
      description: event.payload.summary,
      kind: event.payload.category === "delegate" ? "delegate" : event.payload.category === "merge" ? "merge" : "command",
      status: approvals.get(event.payload.approvalId) ?? "pending",
      ...(event.payload.category === "command" ? {
        availableScopes: ["once", "run", ...(event.taskId ? ["task" as const] : []), ...(event.projectId ? ["project" as const] : []), "global"] as ApprovalScope[],
        runScope: event.projectRunId ? "run" as const : "session" as const
      } : {}),
      createdAt: event.timestamp
    }
  };
  if (event.type === "approval.resolved") return { kind: "approval_resolved", approvalId: event.payload.approvalId, decision: event.payload.decision, scope: event.payload.scope };
  if (event.type === "command.updated") return { kind:"command", command:event.payload.command, status:"running", output:event.payload.outputSummary ?? "" };
  if (event.type === "command.started") return { kind: "command", command: event.payload.command, status: "running", output: "" };
  if (event.type === "command.finished") return {
    kind: "command",
    command: event.payload.command ?? "command",
    status: event.payload.exitCode === 0 ? "done" : "failed",
    exitCode: event.payload.exitCode,
    output: event.payload.outputSummary ?? ""
  };
  if (event.type === "run.diff_updated") return {
    kind: "file_change", source: "provider", replace: true, files: parseProviderDiff(event.payload.diff)
  };
  if (event.type === "file.changed") {
    const file = changedFiles.get(JSON.stringify([event.sessionId, event.runId, event.payload.path]));
    return {
      kind: "file_change",
      files: [file
        ? { ...file, changeType: file.changeType === "renamed" ? "modified" : file.changeType }
        : {
            path: event.payload.path,
            changeType: event.payload.changeType === "renamed" ? "modified" : event.payload.changeType,
            additions: event.payload.additions ?? 0,
            deletions: event.payload.deletions ?? 0,
            diff: event.payload.diff
          }]
    };
  }
  if (event.type === "verification.started") {
    if (verifications.has(event.payload.verificationId)) return undefined;
    return { kind: "verification", command: event.payload.commandTemplateId, status: "running", log: "" };
  }
  if (event.type === "verification.finished") {
    const verification = verifications.get(event.payload.verificationId);
    const fullOutput = event.payload.outputArtifactId ? artifacts.get(event.payload.outputArtifactId)?.content ?? "" : "";
    // Verification logs can be huge (test_report artifact content); keep the
    // tail so the failure summary at the end stays visible while bounding
    // the memory held per verification row.
    const output = fullOutput.length > 20_000 ? fullOutput.slice(-20_000) : fullOutput;
    return {
      kind: "verification",
      command: verification ? [verification.command, ...verification.args].join(" ") : event.payload.verificationId,
      status: event.payload.passed ? "passed" : "failed",
      durationMs: event.payload.durationMs,
      log: output
    };
  }
  if (event.type === "git.merge_started") return { kind: "git_merge", status: "running", sourceBranch: event.payload.sourceBranch, targetBranch: event.payload.targetBranch };
  if (event.type === "git.merge_finished") return { kind: "git_merge", status: "completed", sourceBranch: event.payload.sourceBranch, targetBranch: event.payload.targetBranch, commit: event.payload.commit };
  if (event.type === "git.conflict") return { kind: "git_merge", status: "conflict", sourceBranch: event.payload.sourceBranch, targetBranch: event.payload.targetBranch, paths: event.payload.paths };
  if (event.type === "run.failed") return { kind: "error", code: event.payload.code, message: event.payload.message, retryable: event.payload.retryable };
  if (event.type === "run.waiting") return { kind: "run_status", run: { status: event.payload.reason === "approval" ? "waiting_approval" : "running", reason: event.payload.reason } };
  return undefined;
}

function toUiSession(session: DomainSession, projectRun: ProjectRun, team: UiTeam): UiSession {
  const isMain = session.id === projectRun.mainSessionId;
  const legacyMain = team.members.find((member) => member.id === projectRun.mainMemberId);
  const mainAgentInstanceId = session.agentInstanceId ?? projectRun.mainAgentInstanceId ?? legacyMain?.agentInstanceId ?? session.memberId;
  return {
    id: session.id,
    connectionId: session.connectionId,
    connectionRevision: session.connectionRevision,
    projectId: session.projectId,
    target: isMain ? { type: "agent", instanceId: mainAgentInstanceId, teamId: team.id } : { type: "member", teamId: team.id, memberId: session.memberId },
    title: session.title,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    agentMode: session.agentMode,
    serviceTier: session.serviceTier,
    permissionMode: session.permissionMode?.trim() || undefined,
    mode: session.mode,
    // A ProjectRun may remain executing while delegated child sessions work in
    // the background. Preserve the provider session's own status so the main
    // conversation becomes available as soon as its planning turn finishes.
    status: session.status,
    parentSessionId: session.parentSessionId,
    taskId: session.taskId,
    projectRunId: projectRun.id,
    runId: projectRun.id,
    unreadCount: session.unreadCount,
    lastMessageAt: session.lastMessageAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

function toUiTask(task: Task, team: UiTeam): SessionTask {
  return { id: task.id, title: task.title, objective: task.objective, memberId: task.assignedMemberId, memberName: team.members.find((member) => member.id === task.assignedMemberId)?.displayName, status: task.status, dependencies: task.dependencies };
}

function projectLifecycle(projectRun: ProjectRun): RunLifecycle | undefined {
  if (projectRun.status === "waiting_user" || projectRun.status === "merge_ready" || projectRun.status === "paused") return { status: "waiting_approval", reason: projectRun.recoveryReason };
  if (projectRun.status === "completed") return { status: "completed" };
  if (projectRun.status === "failed" || projectRun.status === "review_required") return { status: "failed", reason: projectRun.status };
  if (projectRun.status === "cancelled") return { status: "cancelled" };
  return { status: "running", reason: projectRun.status };
}

function shouldPoll(projectRun: ProjectRun): boolean {
  return !["completed", "failed", "cancelled", "waiting_user", "paused", "merge_ready", "review_required"].includes(projectRun.status);
}

/** A foreground chat turn can outlive a paused or review-required orchestration. */
function shouldPollProjectRun(projectRun: ProjectRun): boolean {
  const mainSessionId = projectRun.mainSessionId;
  const activeAgentRunId = mainSessionId
    ? useSessionsStore.getState().activeAgentRunIds[mainSessionId]
    : undefined;
  // The daemon may finalize the project run while delegated child sessions are
  // still working; keep polling while any session of the run is active.
  return Boolean(activeAgentRunId) || (projectRunActiveRuns.get(projectRun.id) ?? 0) > 0 || shouldPoll(projectRun);
}

function shouldPollAgentRun(run: AgentRun): boolean {
  return !["completed", "failed", "timed_out", "crashed", "cancelled"].includes(run.status);
}

function standaloneLifecycle(session: DomainSession, run?: AgentRun): RunLifecycle | undefined {
  if (!run) {
    if (session.status === "running" || session.status === "waiting_input") return { status: "running" };
    if (session.status === "waiting_approval") return { status: "waiting_approval" };
    if (session.status === "completed") return { status: "completed" };
    if (session.status === "failed") return { status: "failed" };
    return undefined;
  }
  if (["created", "starting", "running", "waiting_input", "cancelling"].includes(run.status)) {
    return { status: "running", reason: run.status === "cancelling" ? "cancelling" : undefined, startedAt: run.startedAt };
  }
  if (run.status === "waiting_approval") return { status: "waiting_approval" };
  if (run.status === "completed") return { status: "completed" };
  if (run.status === "cancelled") return { status: "cancelled" };
  return { status: "failed", reason: run.failureCode };
}

function toActiveRunStatus(projectRun: ProjectRun): "planning" | "executing" | "verifying" | "waiting_user" {
  if (projectRun.status === "planning" || projectRun.status === "plan_review") return "planning";
  if (projectRun.status === "verifying") return "verifying";
  if (["waiting_user", "paused", "merge_ready", "review_required"].includes(projectRun.status)) return "waiting_user";
  return "executing";
}

function diffArtifactsByScope(artifacts: Artifact[]): Map<string, GitChangedFile> {
  return new Map(artifacts.flatMap((artifact) => parseDiffArtifact(artifact).map((file) => [
    JSON.stringify([artifact.sessionId, artifact.metadata?.runId, file.path]), file
  ] as const)));
}

function diffArtifactText(artifact: Artifact): string {
  try {
    const parsed = JSON.parse(artifact.content ?? "") as { diff?: unknown };
    if (typeof parsed.diff === "string") return parsed.diff;
  } catch { /* Legacy artifacts may only carry their per-file patches. */ }
  return parseDiffArtifact(artifact).map((file) => file.diff).join("\n");
}

function parseDiffArtifact(artifact: Artifact): GitChangedFile[] {
  if (artifact.kind !== "diff" || !artifact.content) return [];
  try {
    const parsed = JSON.parse(artifact.content) as { files?: GitChangedFile[] };
    return Array.isArray(parsed.files) ? parsed.files : [];
  } catch {
    return [];
  }
}

function toUiArtifact(artifact: Artifact): SessionArtifact[] {
  if (!["diff", "api_contract", "test_report", "commit", "image", "file"].includes(artifact.kind)) return [];
  const content = artifact.kind === "diff"
    ? diffArtifactText(artifact)
    : artifact.content ?? "";
  return [{ id: artifact.id, kind: artifact.kind as SessionArtifact["kind"], name: artifact.name, content,
    diffSource: artifact.kind === "diff" && (artifact.metadata?.source === "provider" || artifact.metadata?.source === "filesystem") ? artifact.metadata.source : undefined,
    comparisonUnavailable: artifact.kind === "diff" && (artifact.metadata?.comparisonUnavailable === true || parseDiffArtifact(artifact).some((file) => file.comparisonUnavailable)) || undefined }];
}

function buildRawLog(events: RuntimeEvent[], artifacts: Artifact[]): string[] {
  const lines = events.flatMap((event) => {
    if (event.type === "command.started") return [`$ ${event.payload.command}`];
    if (event.type === "command.finished") return [`[exit ${event.payload.exitCode}] ${event.payload.durationMs}ms`];
    if (event.type === "run.cancelled") return ["Stopped by user"];
    if (event.type === "run.failed") return [`[${event.payload.code}] ${event.payload.message}`];
    return [];
  });
  for (const artifact of artifacts.filter((item) => item.kind === "test_report" && item.content)) {
    lines.push(`--- ${artifact.name} ---`, ...(artifact.content ?? "").split("\n"));
  }
  return lines;
}

function requireUiTeam(teamId: string): UiTeam {
  const team = useTeamsStore.getState().teams.find((item) => item.id === teamId);
  if (!team) throw new Error(`Team ${teamId} is missing`);
  return team;
}
