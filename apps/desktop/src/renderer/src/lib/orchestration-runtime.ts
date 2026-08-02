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
import { getBridge, requestCore } from "./bridge";
import { toDomainAgent, toDomainProject, toDomainTeam, toStandaloneUiSession } from "./core-mappers";
import type { DesktopAttachment } from "../types/bridge";
import type { ApprovalScope, QueuedFollowUp, RunLifecycle, SessionArtifact, SessionTask, SessionTarget, TimelineEvent, TimelinePayload, UiSession, UiTeam } from "./types";
import type { ActiveRunSummary } from "./types";
import { compactOrchestrationTimeline, hiddenCompletionRunIds, hiddenInternalRunIds, isVisibleTimelineMessage } from "./orchestration-timeline-policy";
import { groupToolTimeline } from "./tool-timeline-groups";
import { collectSubagentActivities, subagentDispatchIdOf } from "./subagent-activities";
import { useAgentsStore } from "../stores/agents";
import { ingestInteractionEvents, useInteractionsStore } from "../stores/interactions";
import { useProjectsStore } from "../stores/projects";
import { useSessionsStore } from "../stores/sessions";
import { useTeamsStore } from "../stores/teams";

const projectPollers = new Map<string, ReturnType<typeof setTimeout>>();
const projectSessionSubscriptions = new Map<string, string>();
const projectSessionSequences = new Map<string, number>();
const projectSessionEventCache = new Map<string, RuntimeEvent[]>();
const projectSessionBuilt = new Set<string>();
const standaloneStreams = new Map<string, { cancelled: boolean }>();
const standaloneSubscriptions = new Map<string, string>();
const standaloneSequences = new Map<string, number>();
const standaloneEventCache = new Map<string, RuntimeEvent[]>();
const standaloneMessageCache = new Map<string, Message[]>();
const standaloneArtifactCache = new Map<string, Artifact[]>();
const standaloneRenderFrames = new Map<string, number>();
// Sessions whose daemon queue has been fetched once; afterwards the
// session.follow_up_queued/cancelled events keep the store list in sync.
const followUpListSynced = new Set<string>();
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

const STREAMING_DELTA_TYPES = new Set(["agent.message_delta", "agent.thinking_delta"]);

export async function resumeWorkbenchRuns(): Promise<void> {
  if (!getBridge()) return;
  // A terminal-looking project run can still own live child sessions (the
  // daemon finalizes delegation waves independently), so resume polling for any
  // run with an active AgentRun, not just non-terminal statuses.
  const agentRuns = await requestCore<AgentRun[]>("run.list", {}).catch(() => [] as AgentRun[]);
  const activeProjectRunIds = new Set(agentRuns.filter(shouldPollAgentRun).map((run) => run.projectRunId).filter(Boolean));
  for (const project of useProjectsStore.getState().projects) {
    try {
      const runs = await requestCore<ProjectRun[]>("projectRun.list", { projectId: project.id });
      for (const projectRun of runs.filter((run) => !["completed", "failed", "cancelled"].includes(run.status) || activeProjectRunIds.has(run.id))) {
        const hydrated = await hydrateProjectRun(projectRun.id);
        if (shouldPollProjectRun(hydrated)) schedulePoll(projectRun.id);
      }
    } catch (error) {
      console.error(`Failed to restore runs for project ${project.id}`, error);
    }
  }
}

/** Loads persisted sessions/messages/runs into the three-pane workbench. */
export async function hydrateWorkbenchSessions(): Promise<void> {
  if (!getBridge()) return;
  const projects = useProjectsStore.getState().projects;
  const teams = useTeamsStore.getState().teams;
  const instances = useAgentsStore.getState().instances;
  const uiSessions: UiSession[] = [];
  const runIds = new Set<string>();

  for (const project of projects) {
    const [domainSessions, projectRuns] = await Promise.all([
      requestCore<DomainSession[]>("session.list", { projectId: project.id }),
      requestCore<ProjectRun[]>("projectRun.list", { projectId: project.id })
    ]);
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
      } else {
        uiSessions.push(toStandaloneUiSession(session));
      }
    }
  }

  useSessionsStore.getState()._replaceSessions(uiSessions);
  for (const session of uiSessions.filter((item) => !item.projectRunId)) {
    const run = await hydrateStandaloneSession(session);
    if (run && shouldPollAgentRun(run)) scheduleStandalonePoll(session.id, run.id);
  }
  for (const projectRunId of runIds) await hydrateProjectRun(projectRunId);
}

export async function sendWorkbenchMessage(sessionId: string, text: string, attachments: DesktopAttachment[] = [], editMessageId?: string): Promise<void> {
  const state = useSessionsStore.getState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  if (!getBridge()) {
    state._append(sessionId, { kind: "error", code: "CORE_UNAVAILABLE", message: "Core Daemon 仅在 Electron 桌面端可用。", retryable: false });
    return;
  }
  const attachmentViews = attachments.map((attachment) => ({ ...attachment }));
  if (editMessageId) state._patchEvent(sessionId, `message-${editMessageId}`, { text, attachments: attachmentViews, editedAt: new Date().toISOString() });
  else state._append(sessionId, { kind: "message", sender: "user", text, attachments: attachmentViews });
  state._append(sessionId, { kind: "activity", phase: "queued" });
  state._setForeground(sessionId, { status: "running" });

  try {
    await syncProjectAndAgents(session);
    if (session.target.type === "agent" && session.target.teamId) {
      const activeProjectRunId = useProjectsStore.getState().projects
        .find((project) => project.id === session.projectId)?.activeRun?.id;
      if (session.projectRunId && activeProjectRunId === session.projectRunId) {
        const domainSession = toDomainSession(session);
        await requestCore<DomainSession>("session.upsert", domainSession);
        const result = await requestCore<{ accepted: true; runId: string }>("session.send", { sessionId, text, attachments, editMessageId });
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
        attachments
      });
      state._upsertExternalSession(toUiSession(result.mainSession, result.projectRun, team));
      state._setRunning(sessionId, { status: "running" });
      await hydrateProjectRun(result.projectRun.id);
      schedulePoll(result.projectRun.id);
      return;
    }

    const domainSession = toDomainSession(session);
    await requestCore<DomainSession>("session.upsert", domainSession);
    const result = await requestCore<{ accepted: true; runId: string }>("session.send", { sessionId, text, attachments, editMessageId });
    state._setActiveAgentRun(sessionId, result.runId);
    await hydrateStandaloneSession(session, result.runId);
    scheduleStandalonePoll(sessionId, result.runId);
  } catch (error) {
    state._append(sessionId, { kind: "error", code: "IPC_INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error), retryable: true });
    state._setForeground(sessionId, { status: "failed", reason: error instanceof Error ? error.message : String(error) });
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
  const { mode: appliedMode } = await requestCore<{ accepted: true; mode: "steer" | "queue" }>("session.followUp", { sessionId, text, mode });
  store._append(sessionId, { kind: "message", sender: "user", text });
  if (appliedMode === "queue") {
    // The daemon's session.follow_up_queued event adds the entry to the
    // store-backed queue list; nothing to track locally anymore.
    store._append(sessionId, { kind: "activity", phase: "queued", detail: "Follow-up queued" });
  }
  return appliedMode;
}

/** Withdraws a queued follow-up; the daemon deletes its saved message too. */
export async function cancelWorkbenchFollowUp(sessionId: string, messageId: string): Promise<void> {
  if (!getBridge()) throw new Error("Core Daemon is only available in the desktop shell");
  useSessionsStore.getState()._removeQueuedFollowUp(sessionId, messageId);
  try {
    await requestCore<{ cancelled: true }>("session.followUp.cancel", { sessionId, messageId });
  } catch (error) {
    // Resync from the daemon so a failed withdraw restores the entry.
    followUpListSynced.delete(sessionId);
    await syncQueuedFollowUps(sessionId);
    throw error;
  }
}

/** Mirrors daemon queue events into the store-backed queued-follow-up list. */
function ingestFollowUpEvents(sessionId: string, events: RuntimeEvent[]): void {
  const store = useSessionsStore.getState();
  for (const event of events) {
    if (event.type === "session.follow_up_queued") {
      store._addQueuedFollowUp(sessionId, { messageId: event.payload.messageId, text: event.payload.text, queuedAt: event.timestamp });
    } else if (event.type === "session.follow_up_cancelled") {
      store._removeQueuedFollowUp(sessionId, event.payload.messageId);
    }
  }
}

/** Fetches the authoritative queue once per session; events keep it in sync after. */
async function syncQueuedFollowUps(sessionId: string): Promise<void> {
  if (followUpListSynced.has(sessionId)) return;
  followUpListSynced.add(sessionId);
  try {
    const { items } = await requestCore<{ items: QueuedFollowUp[] }>("session.followUp.list", { sessionId });
    useSessionsStore.getState()._replaceQueuedFollowUps(sessionId, items);
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
  useSessionsStore.getState()._updateApproval(sessionId, approvalId, approved ? "approved" : "rejected");
  if (approvalKind === "command") {
    await requestCore("approval.resolve", { approvalId, decision: approved ? "approved" : "rejected", scope });
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

export async function configureWorkbenchSession(
  sessionId: string,
  patch: { model?: string; reasoningEffort?: string; serviceTier?: string; permissionMode?: string }
): Promise<void> {
  const updated = useSessionsStore.getState()._configureSession(sessionId, patch);
  if (!updated || !getBridge()) return;
  await requestCore<DomainSession>("session.upsert", toDomainSession(updated));
}

/**
 * Rebinds a session to another agent instance of the same provider (i.e. a
 * different API source). The Core Daemon treats an agentInstanceId change as a
 * provider-thread boundary: it resets the native thread and replays the message
 * history into the new instance on the next send.
 */
export async function switchWorkbenchSessionInstance(sessionId: string, instanceId: string): Promise<void> {
  const session = useSessionsStore.getState().sessions.find((item) => item.id === sessionId);
  if (!session || session.target.type !== "agent") throw new Error(`Session ${sessionId} is not an agent session`);
  const target = session.target;
  if (target.instanceId === instanceId) return;
  const agents = useAgentsStore.getState();
  const current = agents.instances.find((item) => item.id === target.instanceId);
  const next = agents.instances.find((item) => item.id === instanceId);
  if (!next) throw new Error(`Agent instance ${instanceId} is missing`);
  if (current && current.providerId !== next.providerId) {
    throw new Error(`Instance ${next.displayName} belongs to a different provider`);
  }
  const updated = useSessionsStore.getState()._setSessionInstance(sessionId, instanceId);
  if (updated && getBridge()) {
    await requestCore<AgentInstance>("agent.upsert", toDomainAgent(next));
    await requestCore<DomainSession>("session.upsert", toDomainSession(updated));
  }
  await agents.loadModels(instanceId);
}

function clearSessionRuntime(sessionId: string): void {
  const stream = standaloneStreams.get(sessionId);
  if (stream) stream.cancelled = true;
  standaloneStreams.delete(sessionId);
  standaloneSubscriptions.delete(sessionId);
  standaloneSequences.delete(sessionId);
  standaloneEventCache.delete(sessionId);
  standaloneMessageCache.delete(sessionId);
  standaloneArtifactCache.delete(sessionId);
  // Cancel a coalesced render still waiting for its animation frame; letting it
  // fire would rebuild a timeline for a session that no longer exists.
  const frame = standaloneRenderFrames.get(sessionId);
  if (frame !== undefined) cancelAnimationFrame(frame);
  standaloneRenderFrames.delete(sessionId);
  projectSessionSubscriptions.delete(sessionId);
  projectSessionSequences.delete(sessionId);
  projectSessionEventCache.delete(sessionId);
  projectSessionBuilt.delete(sessionId);
  followUpListSynced.delete(sessionId);
  useInteractionsStore.getState()._removeSessions([sessionId]);
}

async function syncProjectAndAgents(session: UiSession): Promise<void> {
  const project = useProjectsStore.getState().projects.find((item) => item.id === session.projectId);
  if (!project) throw new Error(`Project ${session.projectId} is missing`);
  const domainProject = toDomainProject(project);
  await requestCore<Project>("project.upsert", domainProject);

  const agents = useAgentsStore.getState();
  const target = session.target;
  let requiredIds: string[];
  if (target.type === "team") requiredIds = requireUiTeam(target.teamId).members.filter((member) => member.enabled).map((member) => member.agentInstanceId);
  else if (target.type === "agent") requiredIds = [
    target.instanceId,
    ...(target.teamId ? requireUiTeam(target.teamId).members.filter((member) => member.enabled).map((member) => member.agentInstanceId) : [])
  ];
  else requiredIds = [requireUiTeam(target.teamId).members.find((member) => member.id === target.memberId)?.agentInstanceId ?? ""];
  for (const instanceId of new Set(requiredIds.filter(Boolean))) {
    const instance = agents.instances.find((item) => item.id === instanceId);
    if (!instance) throw new Error(`Agent instance ${instanceId} is missing`);
    if (!instance.executable) throw new Error(`${instance.displayName}: CLI executable has not been configured`);
    await requestCore<AgentInstance>("agent.upsert", toDomainAgent(instance));
  }
}

function toDomainSession(session: UiSession, _team?: UiTeam): DomainSession {
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
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    serviceTier: session.serviceTier,
    permissionMode: session.permissionMode?.trim() || undefined,
    mode: session.mode,
    title: session.title,
    status: session.status,
    unreadCount: session.unreadCount,
    lastMessageAt: session.lastMessageAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

async function hydrateStandaloneSession(uiSession: UiSession, knownRunId?: string): Promise<AgentRun | undefined> {
  const [detail, replay, runs, artifacts] = await Promise.all([
    requestCore<{ session: DomainSession; messages: Message[] }>("session.get", { sessionId: uiSession.id }),
    replayStandaloneEvents(uiSession.id),
    requestCore<AgentRun[]>("run.list", { sessionId: uiSession.id }),
    requestCore<Artifact[]>("artifact.list", { sessionId: uiSession.id })
  ]);
  const knownRun = knownRunId ? runs.find((item) => item.id === knownRunId) : undefined;
  const activeRun = runs.find(shouldPollAgentRun);
  const run = knownRun && shouldPollAgentRun(knownRun) ? knownRun : activeRun ?? knownRun ?? runs[0];
  const store = useSessionsStore.getState();
  standaloneMessageCache.set(uiSession.id, detail.messages);
  standaloneEventCache.set(uiSession.id, replay.events);
  standaloneArtifactCache.set(uiSession.id, artifacts);
  ingestInteractionEvents(replay.events);
  ingestFollowUpEvents(uiSession.id, replay.events);
  await syncQueuedFollowUps(uiSession.id);
  store._upsertExternalSession(toStandaloneUiSession(detail.session));
  renderStandaloneCache(uiSession.id);
  store._setRunning(uiSession.id, standaloneLifecycle(detail.session, run));
  store._setForeground(uiSession.id, standaloneLifecycle(detail.session, run));
  store._setActiveAgentRun(uiSession.id, run && shouldPollAgentRun(run) ? run.id : undefined);
  // A new run after the known one means the oldest queued follow-up started.
  if (run && shouldPollAgentRun(run) && knownRunId && run.id !== knownRunId) store._shiftQueuedFollowUp(uiSession.id);
  return run;
}

function mergeStandaloneEvents(sessionId: string, events: RuntimeEvent[]): void {
  if (!events.length) return;
  const current = standaloneEventCache.get(sessionId) ?? [];
  const known = new Set(current.map((event) => event.eventId));
  const fresh = events.filter((event) => !known.has(event.eventId));
  if (!fresh.length) return;
  standaloneEventCache.set(sessionId, [...current, ...fresh]);
  ingestInteractionEvents(fresh);
  ingestFollowUpEvents(sessionId, fresh);
  // Keep the event -> render edge synchronous for streaming text. The
  // workbench follows the rendered timeline height; queueing deltas here can
  // leave the UI with a stale event array for a frame and, more importantly,
  // makes nested reasoning updates invisible to a last-row scroll trigger.
  // Structural bursts still use the coalesced full rebuild below.
  if (fresh.every((event) => STREAMING_DELTA_TYPES.has(event.type)) && applyStandaloneDeltas(sessionId, fresh)) return;
  scheduleStandaloneRender(sessionId);
}

/**
 * Coalesces structural timeline rebuilds to one per animation frame. Streaming
 * deltas take the direct patch path above so the live text and its scroll
 * height are observable immediately.
 */
function scheduleStandaloneRender(sessionId: string): void {
  if (standaloneRenderFrames.has(sessionId)) return;
  const frame = requestAnimationFrame(() => {
    standaloneRenderFrames.delete(sessionId);
    renderStandaloneCache(sessionId);
  });
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
    next[index] = { ...next[index], data: { ...row, text: row.text + event.payload.text } };
  }
  if (next) store._replaceEvents(sessionId, next);
  return true;
}

function renderStandaloneCache(sessionId: string): void {
  const events = standaloneEventCache.get(sessionId) ?? [];
  const messages = standaloneMessageCache.get(sessionId) ?? [];
  const artifacts = standaloneArtifactCache.get(sessionId) ?? [];
  const store = useSessionsStore.getState();
  store._replaceEvents(sessionId, buildStandaloneTimeline(messages, events, artifacts));
  store._replaceContextUsage(sessionId, latestContextUsage(events));
  store._replaceArtifacts(sessionId, artifacts.flatMap(toUiArtifact));
  store._replaceRawLog(sessionId, buildRawLog(events, artifacts));
}

async function replayStandaloneEvents(sessionId: string): Promise<{ events: RuntimeEvent[]; lastSequence: number }> {
  let subscriptionId = standaloneSubscriptions.get(sessionId);
  if (!subscriptionId) {
    const subscription = await requestCore<{ subscriptionId: string }>("event.subscribe", { sessionId });
    subscriptionId = subscription.subscriptionId;
    standaloneSubscriptions.set(sessionId, subscriptionId);
  }
  try {
    const replay = await requestCore<{ events: RuntimeEvent[]; lastSequence: number }>("event.replay", { subscriptionId, afterSequence: 0 });
    standaloneSequences.set(sessionId, replay.lastSequence);
    return replay;
  } catch {
    standaloneSubscriptions.delete(sessionId);
    const subscription = await requestCore<{ subscriptionId: string }>("event.subscribe", { sessionId });
    standaloneSubscriptions.set(sessionId, subscription.subscriptionId);
    const replay = await requestCore<{ events: RuntimeEvent[]; lastSequence: number }>("event.replay", { subscriptionId: subscription.subscriptionId, afterSequence: 0 });
    standaloneSequences.set(sessionId, replay.lastSequence);
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
    return artifact.id === other.id && artifact.kind === other.kind && artifact.name === other.name && artifact.content === other.content;
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
  return current.title === next.title && current.model === next.model
    && current.reasoningEffort === next.reasoningEffort && current.serviceTier === next.serviceTier
    && current.permissionMode === next.permissionMode
    && current.mode === next.mode && current.status === next.status
    && current.parentSessionId === next.parentSessionId && current.taskId === next.taskId
    && current.projectRunId === next.projectRunId
    && current.runId === next.runId && current.unreadCount === next.unreadCount
    && current.lastMessageAt === next.lastMessageAt && current.updatedAt === next.updatedAt
    && sameTarget(current.target, next.target);
}

async function hydrateProjectRun(projectRunId: string): Promise<ProjectRun> {
  const { projectRun } = await requestCore<{ projectRun: ProjectRun; mainSession: DomainSession }>("projectRun.get", { projectRunId });
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
  const [allSessions, tasks, artifacts, verifications, runs] = await Promise.all([
    requestCore<DomainSession[]>("session.list", { projectId: projectRun.projectId }),
    requestCore<Task[]>("task.list", { projectRunId }),
    requestCore<Artifact[]>("artifact.list", { projectRunId }),
    requestCore<VerificationResult[]>("verification.list", { projectRunId }),
    requestCore<AgentRun[]>("run.list", { projectRunId })
  ]);
  const sessions = allSessions.filter((session) => session.projectRunId === projectRunId);
  const store = useSessionsStore.getState();
  let activeRunCount = 0;

  for (const session of sessions) {
    const [detail, feed] = await Promise.all([
      requestCore<{ session: DomainSession; messages: Message[] }>("session.get", { sessionId: session.id }),
      projectSessionEvents(session.id),
      syncQueuedFollowUps(session.id)
    ]);
    const uiSession = toUiSession(detail.session, projectRun, team);
    const sessionArtifacts = artifacts.filter((artifact) => artifact.sessionId === session.id);
    const currentSession = store.sessions.find((item) => item.id === session.id);
    if (!currentSession || !sameUiSession(currentSession, uiSession)) {
      changed = true;
      store._upsertExternalSession(uiSession);
    }
    if (feed.hasNew) changed = true;
    // Rebuilding the timeline walks the full event history; skip it entirely
    // on poll ticks that delivered no new events for this session.
    const timelineDirty = feed.hasNew || !projectSessionBuilt.has(session.id);
    if (timelineDirty) {
      store._replaceEvents(session.id, buildTimeline(detail.messages, feed.events, projectRun, team, tasks, sessionArtifacts, verifications, session.id === projectRun.mainSessionId));
      store._replaceContextUsage(session.id, latestContextUsage(feed.events));
      store._replaceRawLog(session.id, buildRawLog(feed.events, sessionArtifacts));
      projectSessionBuilt.add(session.id);
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
    // Runs in one provider session are serialized. A newer terminal run must
    // supersede any stale historical row that was left marked as running.
    const latestRun = runs.find((run) => run.sessionId === session.id);
    const activeRun = latestRun && shouldPollAgentRun(latestRun) ? latestRun : undefined;
    if (activeRun) activeRunCount += 1;
    if (!sameLifecycle(store.foreground[session.id], activeRun ? standaloneLifecycle(detail.session, activeRun) : undefined)) {
      changed = true;
      store._setForeground(session.id, activeRun ? standaloneLifecycle(detail.session, activeRun) : undefined);
    }
    if (store.activeAgentRunIds[session.id] !== activeRun?.id) {
      changed = true;
      store._setActiveAgentRun(session.id, activeRun?.id);
    }
    // A transition to a different run id means the oldest queued follow-up
    // started its turn; previousRunId undefined is first hydrate (no shift).
    const previousRunId = store.activeAgentRunIds[session.id];
    if (activeRun && previousRunId && activeRun.id !== previousRunId) store._shiftQueuedFollowUp(session.id);
  }
  const root = projectRun.mainSessionId;
  projectRunActiveRuns.set(projectRunId, activeRunCount);
  if (root) {
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
  let subscriptionId = projectSessionSubscriptions.get(sessionId);
  if (!subscriptionId) {
    const subscription = await requestCore<{ subscriptionId: string }>("event.subscribe", { sessionId });
    subscriptionId = subscription.subscriptionId;
    projectSessionSubscriptions.set(sessionId, subscriptionId);
  }
  try {
    return await requestCore<{ events: RuntimeEvent[]; lastSequence: number }>("event.replay", { subscriptionId, afterSequence: projectSessionSequences.get(sessionId) ?? 0 });
  } catch {
    projectSessionSubscriptions.delete(sessionId);
    // A fresh subscription may have lost events; restart from the beginning.
    projectSessionSequences.delete(sessionId);
    projectSessionEventCache.delete(sessionId);
    projectSessionBuilt.delete(sessionId);
    const subscription = await requestCore<{ subscriptionId: string }>("event.subscribe", { sessionId });
    projectSessionSubscriptions.set(sessionId, subscription.subscriptionId);
    return requestCore<{ events: RuntimeEvent[]; lastSequence: number }>("event.replay", { subscriptionId: subscription.subscriptionId, afterSequence: 0 });
  }
}

/**
 * Incremental event feed for a project session: replays only events after the
 * last seen sequence and keeps the full history in a local cache so timeline
 * rebuilds stay possible without re-transferring everything every poll tick.
 */
async function projectSessionEvents(sessionId: string): Promise<{ events: RuntimeEvent[]; hasNew: boolean }> {
  const replay = await replayProjectSessionEvents(sessionId);
  projectSessionSequences.set(sessionId, replay.lastSequence);
  const cached = projectSessionEventCache.get(sessionId) ?? [];
  if (!replay.events.length) return { events: cached, hasNew: false };
  const known = new Set(cached.map((event) => event.eventId));
  const fresh = replay.events.filter((event) => !known.has(event.eventId));
  if (fresh.length) {
    ingestInteractionEvents(fresh);
    ingestFollowUpEvents(sessionId, fresh);
  }
  const events = fresh.length ? [...cached, ...fresh] : cached;
  projectSessionEventCache.set(sessionId, events);
  return { events, hasNew: fresh.length > 0 };
}

const POLL_FIRST_TICK_MS = 250;
const POLL_BASE_MS = 500;
const POLL_MAX_MS = 2000;
// Idle ticks tolerated at the base interval before the backoff starts.
const POLL_IDLE_THRESHOLD = 4;

function schedulePoll(projectRunId: string): void {
  const existing = projectPollers.get(projectRunId);
  if (existing) clearTimeout(existing);
  let idleStreak = 0;
  const tick = async (): Promise<void> => {
    try {
      const activityBefore = projectRunActivity.get(projectRunId) ?? 0;
      const projectRun = await hydrateProjectRun(projectRunId);
      if (!shouldPollProjectRun(projectRun) && !hasQueuedFollowUpForProject(projectRunId)) {
        projectPollers.delete(projectRunId);
        projectRunActivity.delete(projectRunId);
        projectRunUpdatedAt.delete(projectRunId);
        projectRunActiveRuns.delete(projectRunId);
        return;
      }
      // Any change observed by the tick resets the streak; otherwise back off
      // gradually (500ms → 1s → 2s cap) so idle runs stop hammering the daemon.
      idleStreak = (projectRunActivity.get(projectRunId) ?? 0) !== activityBefore ? 0 : idleStreak + 1;
    } catch (error) {
      console.error("Failed to synchronize orchestration run", error);
    }
    const interval = idleStreak < POLL_IDLE_THRESHOLD
      ? POLL_BASE_MS
      : Math.min(POLL_BASE_MS * 2 ** (idleStreak - POLL_IDLE_THRESHOLD + 1), POLL_MAX_MS);
    projectPollers.set(projectRunId, setTimeout(() => void tick(), interval));
  };
  projectPollers.set(projectRunId, setTimeout(() => void tick(), POLL_FIRST_TICK_MS));
}

function scheduleStandalonePoll(sessionId: string, runId: string): void {
  const existing = standaloneStreams.get(sessionId);
  if (existing) existing.cancelled = true;
  const controller = { cancelled: false };
  standaloneStreams.set(sessionId, controller);
  void (async () => {
    while (!controller.cancelled) {
      try {
        const session = useSessionsStore.getState().sessions.find((item) => item.id === sessionId);
        if (!session) break;
        if (!standaloneSubscriptions.has(sessionId)) await replayStandaloneEvents(sessionId);
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
        const needsPersistenceSync = update.events.some((event) => event.type === "agent.message" || event.type === "artifact.created" || event.type === "run.completed" || event.type === "run.failed");
        if (needsPersistenceSync) {
          const run = await hydrateStandaloneSession(session, runId);
          if (!run || !shouldPollAgentRun(run)) {
            if ((useSessionsStore.getState().queuedFollowUps[sessionId]?.length ?? 0) > 0) {
              await new Promise((resolve) => setTimeout(resolve, 200));
              continue;
            }
            break;
          }
        }
      } catch (error) {
        if (controller.cancelled) break;
        console.error("Failed to stream standalone Agent run", error);
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
  const changedFiles = new Map(artifacts.flatMap(parseDiffArtifact).map((file) => [file.path, file]));
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
  const changedFiles = new Map(artifacts.flatMap(parseDiffArtifact).map((file) => [file.path, file]));
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
    .filter((event) => event.type === "run.completed" || event.type === "run.failed")
    .map((event) => [String(event.runId ?? ""), event.type === "run.failed" ? "failed" as const : "done" as const]));
  const streaming = new Map<string, number>();
  const deltaSegments = new Map<string, string[]>();
  const reasoning = new Map<string, number>();
  const latestReasoning = new Map<string, string>();
  const reasoningGeneration = new Map<string, number>();
  const runningReasoningRows = new Map<number, string>();
  const tools = new Map<string, number>();
  const commands = new Map<string, number>();
  const retryableCommands = new Map<string, number>();
  const latestTool = new Map<string, string>();
  const latestCommand = new Map<string, string>();
  const runningRows = new Map<number, string>();
  // Streaming message rows per run; closed below once the run reaches a
  // terminal event so a killed run cannot leave a row blinking forever.
  const streamingMessageRows = new Map<number, string>();

  const push = (event: RuntimeEvent, data: TimelinePayload): number => {
    timeline.push({ id: event.eventId, sessionId: String(event.sessionId), sequence: event.sequence, timestamp: event.timestamp, data });
    return timeline.length - 1;
  };

  // Provider-native sub-agent activity is attached to its dispatch card
  // instead of appearing as top-level rows.
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
    if (subagentDispatchIdOf(event)) continue;
    if (hiddenInternalRuns.has(runId)) continue;
    if (event.type === "run.completed" && hiddenCompletions.has(runId)) continue;
    if (event.type === "agent.message_delta") {
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
      if (index === undefined) {
        const row = push(event, { kind: "message", sender: "agent", text: event.payload.text, streaming: true, messageId: event.payload.messageId });
        streaming.set(key, row);
        streamingMessageRows.set(row, runId);
      } else {
        const current = timeline[index].data;
        if (current.kind === "message") timeline[index] = { ...timeline[index], data: { ...current, text: current.text + event.payload.text } };
      }
      continue;
    }
    if (event.type === "agent.thinking_delta") {
      const generation = reasoningGeneration.get(runId) ?? 0;
      const key = `${runId}:${event.payload.messageId}:${generation}`;
      const index = reasoning.get(key);
      if (index === undefined) {
        if (!event.payload.text.trim()) continue;
        const row = push(event, { kind: "reasoning", text: event.payload.text, streaming: true, messageId: event.payload.messageId });
        reasoning.set(key, row);
        latestReasoning.set(runId, key);
        runningReasoningRows.set(row, runId);
      } else {
        const current = timeline[index].data;
        if (current.kind === "reasoning") timeline[index] = { ...timeline[index], data: { ...current, text: current.text + event.payload.text } };
      }
      continue;
    }
    if (event.type === "agent.thinking_summary") {
      const key = latestReasoning.get(runId) ?? (event.payload.messageId
        ? `${runId}:${event.payload.messageId}:${reasoningGeneration.get(runId) ?? 0}`
        : undefined);
      const index = key ? reasoning.get(key) : undefined;
      if (index === undefined) {
        if (!event.payload.text.trim()) continue;
        const row = push(event, { kind: "reasoning", text: event.payload.text, streaming: false, messageId: event.payload.messageId });
        if (key) reasoning.set(key, row);
      } else {
        const current = timeline[index].data;
        if (current.kind === "reasoning") timeline[index] = {
          ...timeline[index],
          data: { ...current, text: current.text || event.payload.text, streaming: false }
        };
        runningReasoningRows.delete(index);
      }
      continue;
    }
    if (event.type === "tool.started" || event.type === "tool.finished") {
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
          output: event.type === "tool.finished" ? event.payload.outputSummary : undefined,
          fileDiff: event.payload.fileDiff,
          subagent: withActivities(event.payload.subagent, suppliedCallId)
        });
        tools.set(key, row);
        if (event.type === "tool.started") runningRows.set(row, runId);
      } else {
        const current = timeline[index].data;
        if (current.kind === "tool_activity") timeline[index] = {
          ...timeline[index],
          data: {
            ...current,
            toolName: current.toolName === "tool" ? event.payload.toolName : current.toolName,
            status: event.type === "tool.finished" ? (event.payload.success ? "done" : "failed") : current.status,
            input: event.payload.inputSummary ?? current.input,
            output: event.type === "tool.finished" ? event.payload.outputSummary ?? current.output : current.output,
            fileDiff: event.payload.fileDiff ?? current.fileDiff,
            subagent: withActivities(event.payload.subagent ?? current.subagent, suppliedCallId)
          }
        };
        if (event.type === "tool.finished") runningRows.delete(index);
      }
      if (event.type === "tool.started") reasoningGeneration.set(runId, (reasoningGeneration.get(runId) ?? 0) + 1);
      continue;
    }
    if (event.type === "command.started" || event.type === "command.finished") {
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
    const terminalStatus = terminalRuns.get(runId);
    if (!terminalStatus) continue;
    const current = timeline[index].data;
    if (current.kind === "tool_activity") timeline[index] = { ...timeline[index], data: { ...current, status: terminalStatus } };
    if (current.kind === "command") timeline[index] = { ...timeline[index], data: { ...current, status: terminalStatus } };
  }
  for (const [index, runId] of runningReasoningRows) {
    if (!terminalRuns.has(runId)) continue;
    const current = timeline[index].data;
    if (current.kind === "reasoning") timeline[index] = { ...timeline[index], data: { ...current, streaming: false } };
  }
  for (const [index, runId] of streamingMessageRows) {
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
  return messages.filter(isVisibleTimelineMessage).map((message, index) => ({
    id: `message-${message.id}`,
    sessionId: message.sessionId,
    sequence: index + 1,
    timestamp: message.createdAt,
    data: {
      kind: "message",
      sender: message.sender,
      authorName: message.fromMemberId ? team?.members.find((member) => member.id === message.fromMemberId)?.displayName : undefined,
      text: message.text,
      messageId: message.id,
      editedAt: message.editedAt,
      attachments: message.attachmentIds?.flatMap((id) => {
        const artifact = artifactsById.get(id);
        return artifact ? [{
          id: artifact.id,
          name: artifact.name,
          path: artifact.path,
          kind: artifact.kind === "image" ? "image" as const : "file" as const,
          mimeType: typeof artifact.metadata?.mimeType === "string" ? artifact.metadata.mimeType : undefined,
          sizeBytes: typeof artifact.metadata?.sizeBytes === "number" ? artifact.metadata.sizeBytes : undefined
        }] : [];
      })
    }
  }));
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
  if (event.type === "run.started") return undefined;
  if (event.type === "agent.status") {
    if (event.payload.phase === "turn_started") return { kind: "activity", phase: "thinking" };
    if (event.payload.phase === "turn_completed") return undefined;
    return { kind: "activity", phase: "completed", detail: "turn_failed" };
  }
  if (event.type === "tool.started") return {
    kind: "tool_activity",
    toolName: event.payload.toolName,
    status: "running",
    input: event.payload.inputSummary,
    fileDiff: event.payload.fileDiff,
    subagent: event.payload.subagent
  };
  if (event.type === "tool.finished") return {
    kind: "tool_activity",
    toolName: event.payload.toolName,
    status: event.payload.success ? "done" : "failed",
    input: event.payload.inputSummary,
    output: event.payload.outputSummary,
    fileDiff: event.payload.fileDiff,
    subagent: event.payload.subagent
  };
  // Usage events are state updates for the composer context indicator. Rendering
  // every update in the timeline produces a stream of meaningless token rows.
  if (event.type === "usage.updated" || event.type === "provider.commands_updated") return undefined;
  if (event.type === "artifact.created") {
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
    return { kind: "task_update", taskId: event.payload.taskId, title: task?.title ?? event.payload.taskId, memberName: team?.members.find((member) => member.id === event.payload.assignedMemberId)?.displayName, status: event.payload.status as Task["status"] };
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
      createdAt: event.timestamp
    }
  };
  if (event.type === "approval.resolved") return { kind: "approval_resolved", approvalId: event.payload.approvalId, decision: event.payload.decision, scope: event.payload.scope };
  if (event.type === "command.started") return { kind: "command", command: event.payload.command, status: "running", output: "" };
  if (event.type === "command.finished") return {
    kind: "command",
    command: event.payload.command ?? "command",
    status: event.payload.exitCode === 0 ? "done" : "failed",
    exitCode: event.payload.exitCode,
    output: event.payload.outputSummary ?? ""
  };
  if (event.type === "file.changed") {
    const file = changedFiles.get(event.payload.path);
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
    const output = event.payload.outputArtifactId ? artifacts.get(event.payload.outputArtifactId)?.content ?? "" : "";
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
    projectId: session.projectId,
    target: isMain ? { type: "agent", instanceId: mainAgentInstanceId, teamId: team.id } : { type: "member", teamId: team.id, memberId: session.memberId },
    title: session.title,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
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
    ? parseDiffArtifact(artifact).map((file) => file.diff).join("\n")
    : artifact.content ?? "";
  return [{ id: artifact.id, kind: artifact.kind as SessionArtifact["kind"], name: artifact.name, content }];
}

function buildRawLog(events: RuntimeEvent[], artifacts: Artifact[]): string[] {
  const lines = events.flatMap((event) => {
    if (event.type === "command.started") return [`$ ${event.payload.command}`];
    if (event.type === "command.finished") return [`[exit ${event.payload.exitCode}] ${event.payload.durationMs}ms`];
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
