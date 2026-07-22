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
import type { ApprovalScope, RunLifecycle, SessionArtifact, SessionTask, TimelineEvent, TimelinePayload, UiSession, UiTeam } from "./types";
import { compactOrchestrationTimeline, hiddenCompletionRunIds, hiddenInternalRunIds, isVisibleTimelineMessage } from "./orchestration-timeline-policy";
import { useAgentsStore } from "../stores/agents";
import { useProjectsStore } from "../stores/projects";
import { useSessionsStore } from "../stores/sessions";
import { useTeamsStore } from "../stores/teams";

const projectPollers = new Map<string, ReturnType<typeof setTimeout>>();
const projectSessionSubscriptions = new Map<string, string>();
const standaloneStreams = new Map<string, { cancelled: boolean }>();
const standaloneSubscriptions = new Map<string, string>();
const standaloneSequences = new Map<string, number>();
const standaloneEventCache = new Map<string, RuntimeEvent[]>();
const standaloneMessageCache = new Map<string, Message[]>();
const standaloneArtifactCache = new Map<string, Artifact[]>();

export async function resumeWorkbenchRuns(): Promise<void> {
  if (!getBridge()) return;
  for (const project of useProjectsStore.getState().projects) {
    try {
      const runs = await requestCore<ProjectRun[]>("projectRun.list", { projectId: project.id });
      for (const projectRun of runs.filter((run) => !["completed", "failed", "cancelled"].includes(run.status))) {
        await hydrateProjectRun(projectRun.id);
        if (shouldPoll(projectRun)) schedulePoll(projectRun.id);
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

export async function sendWorkbenchMessage(sessionId: string, text: string): Promise<void> {
  const state = useSessionsStore.getState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  if (!getBridge()) {
    state._append(sessionId, { kind: "error", code: "CORE_UNAVAILABLE", message: "Core Daemon 仅在 Electron 桌面端可用。", retryable: false });
    return;
  }
  state._append(sessionId, { kind: "message", sender: "user", text });
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
        const result = await requestCore<{ accepted: true; runId: string }>("session.send", { sessionId, text });
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
        sessionId: session.id
      });
      state._upsertExternalSession(toUiSession(result.mainSession, result.projectRun, team));
      state._setRunning(sessionId, { status: "running" });
      await hydrateProjectRun(result.projectRun.id);
      schedulePoll(result.projectRun.id);
      return;
    }

    const domainSession = toDomainSession(session);
    await requestCore<DomainSession>("session.upsert", domainSession);
    const result = await requestCore<{ accepted: true; runId: string }>("session.send", { sessionId, text });
    state._setActiveAgentRun(sessionId, result.runId);
    await hydrateStandaloneSession(session, result.runId);
    scheduleStandalonePoll(sessionId, result.runId);
  } catch (error) {
    state._append(sessionId, { kind: "error", code: "IPC_INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error), retryable: true });
    state._setForeground(sessionId, { status: "failed", reason: error instanceof Error ? error.message : String(error) });
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
    await requestCore<ProjectRun>("orchestration.cancel", { projectRunId: session.projectRunId });
    await hydrateProjectRun(session.projectRunId);
    return;
  }
  const stream = standaloneStreams.get(sessionId);
  if (stream) stream.cancelled = true;
  standaloneStreams.delete(sessionId);
  await hydrateStandaloneSession(session, runId);
}

export async function configureWorkbenchSession(
  sessionId: string,
  patch: { model?: string; reasoningEffort?: string; serviceTier?: string }
): Promise<void> {
  const updated = useSessionsStore.getState()._configureSession(sessionId, patch);
  if (!updated || !getBridge()) return;
  await requestCore<DomainSession>("session.upsert", toDomainSession(updated));
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
    agentInstanceId: session.target.type === "agent" ? session.target.instanceId : undefined,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    serviceTier: session.serviceTier,
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
  const run = (knownRunId ? runs.find((item) => item.id === knownRunId) : undefined) ?? runs[0];
  const store = useSessionsStore.getState();
  standaloneMessageCache.set(uiSession.id, detail.messages);
  standaloneEventCache.set(uiSession.id, replay.events);
  standaloneArtifactCache.set(uiSession.id, artifacts);
  store._upsertExternalSession(toStandaloneUiSession(detail.session));
  renderStandaloneCache(uiSession.id);
  store._setRunning(uiSession.id, standaloneLifecycle(detail.session, run));
  store._setForeground(uiSession.id, standaloneLifecycle(detail.session, run));
  store._setActiveAgentRun(uiSession.id, run && shouldPollAgentRun(run) ? run.id : undefined);
  return run;
}

function mergeStandaloneEvents(sessionId: string, events: RuntimeEvent[]): void {
  if (!events.length) return;
  const current = standaloneEventCache.get(sessionId) ?? [];
  const known = new Set(current.map((event) => event.eventId));
  standaloneEventCache.set(sessionId, [...current, ...events.filter((event) => !known.has(event.eventId))]);
  renderStandaloneCache(sessionId);
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

async function hydrateProjectRun(projectRunId: string): Promise<ProjectRun> {
  const { projectRun } = await requestCore<{ projectRun: ProjectRun; mainSession: DomainSession }>("projectRun.get", { projectRunId });
  const team = requireUiTeam(String(projectRun.teamId));
  const legacyMain = team.members.find((member) => member.id === projectRun.mainMemberId);
  const mainAgent = useAgentsStore.getState().instances.find((instance) => instance.id === (projectRun.mainAgentInstanceId ?? legacyMain?.agentInstanceId));
  useProjectsStore.getState().setActiveRun(projectRun.projectId, ["completed", "failed", "cancelled"].includes(projectRun.status) ? undefined : {
    id: projectRun.id,
    goal: projectRun.goal,
    status: toActiveRunStatus(projectRun),
    agentName: mainAgent?.displayName ?? legacyMain?.displayName ?? projectRun.mainMemberId,
    startedAt: projectRun.createdAt
  });
  const [allSessions, tasks, artifacts, verifications, runs] = await Promise.all([
    requestCore<DomainSession[]>("session.list", { projectId: projectRun.projectId }),
    requestCore<Task[]>("task.list", { projectRunId }),
    requestCore<Artifact[]>("artifact.list", { projectRunId }),
    requestCore<VerificationResult[]>("verification.list", { projectRunId }),
    requestCore<AgentRun[]>("run.list", { projectRunId })
  ]);
  const sessions = allSessions.filter((session) => session.projectRunId === projectRunId);
  const store = useSessionsStore.getState();

  for (const session of sessions) {
    const [detail, replay] = await Promise.all([
      requestCore<{ session: DomainSession; messages: Message[] }>("session.get", { sessionId: session.id }),
      replayProjectSessionEvents(session.id)
    ]);
    const uiSession = toUiSession(detail.session, projectRun, team);
    const sessionArtifacts = artifacts.filter((artifact) => artifact.sessionId === session.id);
    store._upsertExternalSession(uiSession);
    store._replaceEvents(session.id, buildTimeline(detail.messages, replay.events, projectRun, team, tasks, sessionArtifacts, verifications, session.id === projectRun.mainSessionId));
    store._replaceContextUsage(session.id, latestContextUsage(replay.events));
    store._replaceTasks(session.id, session.id === projectRun.mainSessionId ? tasks.map((task) => toUiTask(task, team)) : tasks.filter((task) => task.id === session.taskId).map((task) => toUiTask(task, team)));
    store._replaceArtifacts(session.id, sessionArtifacts.flatMap(toUiArtifact));
    store._replaceRawLog(session.id, buildRawLog(replay.events, sessionArtifacts));
    const activeRun = runs.find((run) => run.sessionId === session.id && shouldPollAgentRun(run));
    store._setForeground(session.id, activeRun ? standaloneLifecycle(detail.session, activeRun) : undefined);
    store._setActiveAgentRun(session.id, activeRun?.id);
  }
  const root = projectRun.mainSessionId;
  if (root) store._setRunning(root, projectLifecycle(projectRun));
  return projectRun;
}

async function replayProjectSessionEvents(sessionId: string): Promise<{ events: RuntimeEvent[] }> {
  let subscriptionId = projectSessionSubscriptions.get(sessionId);
  if (!subscriptionId) {
    const subscription = await requestCore<{ subscriptionId: string }>("event.subscribe", { sessionId });
    subscriptionId = subscription.subscriptionId;
    projectSessionSubscriptions.set(sessionId, subscriptionId);
  }
  try {
    return await requestCore<{ events: RuntimeEvent[] }>("event.replay", { subscriptionId, afterSequence: 0 });
  } catch {
    projectSessionSubscriptions.delete(sessionId);
    const subscription = await requestCore<{ subscriptionId: string }>("event.subscribe", { sessionId });
    projectSessionSubscriptions.set(sessionId, subscription.subscriptionId);
    return requestCore<{ events: RuntimeEvent[] }>("event.replay", { subscriptionId: subscription.subscriptionId, afterSequence: 0 });
  }
}

function schedulePoll(projectRunId: string): void {
  const existing = projectPollers.get(projectRunId);
  if (existing) clearTimeout(existing);
  const tick = async (): Promise<void> => {
    try {
      const projectRun = await hydrateProjectRun(projectRunId);
      if (!shouldPoll(projectRun)) {
        projectPollers.delete(projectRunId);
        return;
      }
    } catch (error) {
      console.error("Failed to synchronize orchestration run", error);
    }
    projectPollers.set(projectRunId, setTimeout(() => void tick(), 500));
  };
  projectPollers.set(projectRunId, setTimeout(() => void tick(), 250));
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
          if (!run || !shouldPollAgentRun(run)) break;
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

function buildStandaloneTimeline(messages: Message[], events: RuntimeEvent[], artifacts: Artifact[]): TimelineEvent[] {
  const timeline = messageTimeline(messages);
  appendRuntimeEvents(timeline, messages, events, (event) => runtimePayload(event, undefined, [], new Map(), new Map(artifacts.map((artifact) => [artifact.id, artifact])), new Map(), new Map()));
  return timeline
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sequence - right.sequence)
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
  const timeline = messageTimeline(messages, team);
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
  return compactOrchestrationTimeline(timeline, projectRun.mainSessionId)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sequence - right.sequence)
    .map((event, index) => ({ ...event, sequence: index + 1 }));
}

function appendRuntimeEvents(
  timeline: TimelineEvent[],
  messages: Message[],
  events: RuntimeEvent[],
  mapPayload: (event: RuntimeEvent) => TimelinePayload | undefined
): void {
  const finalMessageRuns = new Set(messages.map((message) => message.runId).filter((runId): runId is string => Boolean(runId)));
  const hiddenCompletions = hiddenCompletionRunIds(messages);
  const hiddenInternalRuns = hiddenInternalRunIds(messages);
  const terminalRuns = new Set(events.filter((event) => event.type === "run.completed" || event.type === "run.failed").map((event) => String(event.runId ?? "")));
  const streaming = new Map<string, number>();
  const reasoning = new Map<string, number>();
  const latestReasoning = new Map<string, string>();
  const tools = new Map<string, number>();
  const commands = new Map<string, number>();
  const retryableCommands = new Map<string, number>();
  const latestTool = new Map<string, string>();
  const latestCommand = new Map<string, string>();
  const runningRows = new Map<number, string>();

  const push = (event: RuntimeEvent, data: TimelinePayload): number => {
    timeline.push({ id: event.eventId, sessionId: String(event.sessionId), sequence: event.sequence, timestamp: event.timestamp, data });
    return timeline.length - 1;
  };

  for (const event of events) {
    const runId = String(event.runId ?? "session");
    if (hiddenInternalRuns.has(runId)) continue;
    if (event.type === "run.completed" && hiddenCompletions.has(runId)) continue;
    if (event.type === "agent.message_delta") {
      if (finalMessageRuns.has(runId)) continue;
      const key = `${runId}:${event.payload.messageId}`;
      const index = streaming.get(key);
      if (index === undefined) {
        streaming.set(key, push(event, { kind: "message", sender: "agent", text: event.payload.text, streaming: true, messageId: event.payload.messageId }));
      } else {
        const current = timeline[index].data;
        if (current.kind === "message") timeline[index] = { ...timeline[index], data: { ...current, text: current.text + event.payload.text } };
      }
      continue;
    }
    if (event.type === "agent.thinking_delta") {
      const key = `${runId}:${event.payload.messageId}`;
      const index = reasoning.get(key);
      latestReasoning.set(runId, key);
      if (index === undefined) reasoning.set(key, push(event, { kind: "reasoning", text: event.payload.text, streaming: true }));
      else {
        const current = timeline[index].data;
        if (current.kind === "reasoning") timeline[index] = { ...timeline[index], data: { ...current, text: current.text + event.payload.text } };
      }
      continue;
    }
    if (event.type === "agent.thinking_summary") {
      const key = event.payload.messageId ? `${runId}:${event.payload.messageId}` : latestReasoning.get(runId);
      const index = key ? reasoning.get(key) : undefined;
      if (index === undefined) {
        const row = push(event, { kind: "reasoning", text: event.payload.text, streaming: false });
        if (key) reasoning.set(key, row);
      } else {
        const current = timeline[index].data;
        if (current.kind === "reasoning") timeline[index] = {
          ...timeline[index],
          data: { ...current, text: event.payload.text || current.text, streaming: false }
        };
      }
      continue;
    }
    if (event.type === "tool.started" || event.type === "tool.finished") {
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
          input: event.type === "tool.started" ? event.payload.inputSummary : undefined,
          output: event.type === "tool.finished" ? event.payload.outputSummary : undefined
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
            input: event.type === "tool.started" ? event.payload.inputSummary ?? current.input : current.input,
            output: event.type === "tool.finished" ? event.payload.outputSummary ?? current.output : current.output
          }
        };
        if (event.type === "tool.finished") runningRows.delete(index);
      }
      continue;
    }
    if (event.type === "command.started" || event.type === "command.finished") {
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
      continue;
    }
    const data = mapPayload(event);
    if (data) push(event, data);
  }

  for (const [index, runId] of runningRows) {
    if (!terminalRuns.has(runId)) continue;
    const current = timeline[index].data;
    if (current.kind === "tool_activity") timeline[index] = { ...timeline[index], data: { ...current, status: "done" } };
    if (current.kind === "command") timeline[index] = { ...timeline[index], data: { ...current, status: "done" } };
  }
}

function normalizeCommandForRetry(command: string): string {
  return command.replaceAll("\\\\", "\\").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function messageTimeline(messages: Message[], team?: UiTeam): TimelineEvent[] {
  return messages.filter(isVisibleTimelineMessage).map((message, index) => ({
    id: `message-${message.id}`,
    sessionId: message.sessionId,
    sequence: index + 1,
    timestamp: message.createdAt,
    data: {
      kind: "message",
      sender: message.sender,
      authorName: message.fromMemberId ? team?.members.find((member) => member.id === message.fromMemberId)?.displayName : undefined,
      text: message.text
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
    input: event.payload.inputSummary
  };
  if (event.type === "tool.finished") return {
    kind: "tool_activity",
    toolName: event.payload.toolName,
    status: event.payload.success ? "done" : "failed",
    output: event.payload.outputSummary
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
        : { path: event.payload.path, changeType: event.payload.changeType === "renamed" ? "modified" : event.payload.changeType, additions: 0, deletions: 0 }]
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
    // A ProjectRun may remain executing while delegated child sessions work in
    // the background. Preserve the provider session's own status so the main
    // conversation becomes available as soon as its planning turn finishes.
    status: session.status,
    parentSessionId: session.parentSessionId,
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
  return { status: "running" };
}

function shouldPoll(projectRun: ProjectRun): boolean {
  return !["completed", "failed", "cancelled", "waiting_user", "paused", "merge_ready", "review_required"].includes(projectRun.status);
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
