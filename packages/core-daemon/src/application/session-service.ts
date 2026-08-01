import { randomUUID } from "node:crypto";
import type { Message, Session } from "@agenthub/domain";
import type { IpcRequestMap } from "@agenthub/schemas";
import { Database } from "../database/index.js";
import { RunService } from "../runtime/run-service.js";
import { EventService } from "../runtime/event-service.js";
import { CoreError } from "../errors.js";
import { MemberRouter } from "../runtime/orchestration/member-router.js";
import { buildSessionTurnContext } from "./session-context.js";
import { appendAttachmentContext, MessageAttachmentService } from "../runtime/message-attachment-service.js";
import { RUNTIME_TOOL_SCHEMA_VERSION } from "../runtime/runtime-tool-provider.js";
export class SessionService {
  private readonly members: MemberRouter;
  private readonly attachments: MessageAttachmentService;
  /** Follow-ups waiting for the active turn to settle, keyed by session id. */
  private readonly pendingFollowUps = new Map<string, Array<{ messageId: string; text: string; queuedAt: string }>>();
  constructor(private readonly database: Database, private readonly runs: RunService, private readonly events: EventService) {
    this.members = new MemberRouter(database);
    this.attachments = new MessageAttachmentService(database);
  }
  list(input: IpcRequestMap["session.list"]["input"]): Session[] { return this.database.sessions.list(input.projectId, input.memberId); }
  get(id: string): { session: Session; messages: Message[] } {
    const session = this.database.sessions.get(id);
    if (!session) throw new CoreError("IPC_NOT_FOUND", { resource: "session", id });
    return { session, messages: this.database.sessions.messages(id) };
  }
  create(input: IpcRequestMap["session.create"]["input"]): Session {
    const now = new Date().toISOString();
    const session: Session = { id: randomUUID(), projectId: input.projectId, memberId: input.memberId, title: input.title ?? "New session", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
    this.database.sessions.save(session);
    return session;
  }
  delete(input: IpcRequestMap["session.delete"]["input"]): { removed: true; sessionIds: string[] } {
    const session = this.database.sessions.get(input.sessionId);
    if (!session) throw new CoreError("IPC_NOT_FOUND", { resource: "session", id: input.sessionId });
    const sessionIds = descendantSessionIds(this.database.sessions.listAll(), session.id);
    const activeRun = this.database.runs.list().find((run) =>
      sessionIds.includes(run.sessionId) && !["completed", "failed", "timed_out", "crashed", "cancelled"].includes(run.status)
    );
    const activeProjectRun = this.database.sessions.listAll()
      .filter((item) => sessionIds.includes(item.id) && item.projectRunId)
      .map((item) => this.database.projectRuns.get(String(item.projectRunId)))
      .find((run) => run && !["completed", "failed", "cancelled"].includes(run.status));
    if (activeRun || activeProjectRun) {
      throw new CoreError("IPC_INVALID_REQUEST", {
        field: "sessionId",
        reason: "Stop the active run before deleting this session."
      });
    }
    return { removed: true, sessionIds: this.database.sessions.deleteTree(session.id) };
  }
  async followUp(input: IpcRequestMap["session.followUp"]["input"]): Promise<{ accepted: true; mode: "steer" | "queue" }> {
    const text = input.text.trim();
    if (!text) throw new CoreError("IPC_INVALID_REQUEST", { field: "text", reason: "Guidance cannot be empty." });
    const session = this.database.sessions.get(input.sessionId);
    if (!session) throw new CoreError("IPC_NOT_FOUND", { resource: "session", id: input.sessionId });

    // Only providers with an in-flight steer channel (currently Codex's
    // turn/steer) can inject mid-turn. Every other CLI takes the queue path:
    // the follow-up runs as the next turn right after the active one settles,
    // so Enter behaves the same across providers instead of erroring out.
    if (input.mode === "steer" && this.runs.canSteer(session.id)) {
      await this.runs.steerSession(session.id, text);
      this.database.sessions.saveMessage(followUpMessage(session, text));
      return { accepted: true, mode: "steer" };
    }

    const existingMessages = this.database.sessions.messages(session.id);
    const sessionArtifacts = this.database.artifacts.list({ sessionId: session.id });
    const projectRunArtifacts = session.projectRunId ? this.database.artifacts.list({ projectRunId: session.projectRunId }) : [];
    const artifacts = [...new Map([...sessionArtifacts, ...projectRunArtifacts].map((artifact) => [artifact.id, artifact])).values()];
    const agent = this.members.resolveSession(session);
    const turnContext = buildSessionTurnContext({
      currentText: text,
      messages: existingMessages,
      artifacts,
      recoverProviderContext: !session.providerSessionId || !session.providerContextSyncedAt,
      workMode: session.mode === "work",
      workspaceRoot: this.database.projects.get(session.projectId)?.rootPath
    });
    const message = followUpMessage(session, text);
    this.database.sessions.saveMessage(message);
    this.trackPendingFollowUp(session.id, { messageId: message.id, text, queuedAt: message.createdAt });
    this.events.appendForSession(session, { projectRunId: session.projectRunId, taskId: session.taskId }, "session.follow_up_queued", { messageId: message.id, text });
    // RunService serializes turns per session. Do not await here: Queue must
    // acknowledge immediately while the active turn continues uninterrupted.
    // The queueKey lets a withdrawn follow-up skip its launch entirely.
    void this.runs.start(session, agent, turnContext.prompt, {
      projectRunId: session.projectRunId,
      taskId: session.taskId,
      memberId: session.memberId,
      synchronizeProviderContext: turnContext.recovered,
      queueKey: message.id
    }).catch((error) => {
      if (error instanceof Error && error.message.includes("withdrawn")) return;
      console.error("Failed to start queued session follow-up", error);
    }).finally(() => this.untrackPendingFollowUp(session.id, message.id));
    return { accepted: true, mode: "queue" };
  }
  followUpList(input: IpcRequestMap["session.followUp.list"]["input"]): { items: Array<{ messageId: string; text: string; queuedAt: string }> } {
    return { items: [...(this.pendingFollowUps.get(input.sessionId) ?? [])] };
  }
  followUpCancel(input: IpcRequestMap["session.followUp.cancel"]["input"]): { cancelled: true } {
    const session = this.database.sessions.get(input.sessionId);
    if (!session) throw new CoreError("IPC_NOT_FOUND", { resource: "session", id: input.sessionId });
    const pending = this.pendingFollowUps.get(input.sessionId);
    const entry = pending?.find((item) => item.messageId === input.messageId);
    if (!entry) {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "messageId", reason: "Follow-up is no longer queued; it may have already started." });
    }
    this.runs.cancelQueued(input.sessionId, input.messageId);
    this.untrackPendingFollowUp(input.sessionId, input.messageId);
    this.database.sessions.deleteMessage(input.sessionId, input.messageId);
    this.events.appendForSession(session, { projectRunId: session.projectRunId, taskId: session.taskId }, "session.follow_up_cancelled", { messageId: input.messageId });
    return { cancelled: true };
  }
  private trackPendingFollowUp(sessionId: string, entry: { messageId: string; text: string; queuedAt: string }): void {
    const items = this.pendingFollowUps.get(sessionId) ?? [];
    items.push(entry);
    this.pendingFollowUps.set(sessionId, items);
  }
  private untrackPendingFollowUp(sessionId: string, messageId: string): void {
    const items = this.pendingFollowUps.get(sessionId);
    if (!items) return;
    const next = items.filter((item) => item.messageId !== messageId);
    if (next.length) this.pendingFollowUps.set(sessionId, next);
    else this.pendingFollowUps.delete(sessionId);
  }
  /**
   * Applies renderer-owned session metadata without erasing provider runtime state.
   *
   * The renderer intentionally does not know the native CLI session/thread id. A
   * full-row upsert from the renderer must therefore retain that id while the
   * session remains bound to the same project and agent. Otherwise every message
   * would start a new provider thread and lose conversational context.
   */
  upsert(input: IpcRequestMap["session.upsert"]["input"]): Session {
    const current = this.database.sessions.get(input.id);
    if (!current) {
      this.database.sessions.save(input);
      return input;
    }

    // The orchestrator temporarily rebinds `memberId` from the renderer's
    // agent-instance id to the selected team-member id. That is presentation /
    // routing metadata, not a provider-thread boundary. Reset the native
    // provider session only when the project or actual CLI instance changes.
    const sameProviderBinding = current.projectId === input.projectId
      && current.agentInstanceId === input.agentInstanceId;
    const updated: Session = {
      ...current,
      ...input,
      createdAt: current.createdAt,
      projectRunId: input.projectRunId ?? current.projectRunId,
      parentSessionId: input.parentSessionId ?? current.parentSessionId,
      taskId: input.taskId ?? current.taskId,
      providerSessionId: sameProviderBinding
        ? current.providerSessionId ?? input.providerSessionId
        : input.providerSessionId,
      providerContextSyncedAt: sameProviderBinding ? current.providerContextSyncedAt : undefined,
      runtimeToolVersion: sameProviderBinding
        ? current.runtimeToolVersion ?? input.runtimeToolVersion
        : input.runtimeToolVersion
    };
    this.database.sessions.save(updated);
    return updated;
  }
  async send(input: IpcRequestMap["session.send"]["input"]): Promise<{ accepted: true; runId: string }> {
    const session = this.database.sessions.get(input.sessionId);
    if (!session) throw new CoreError("IPC_NOT_FOUND", { resource: "session", id: input.sessionId });
    const existingMessages = this.database.sessions.messages(session.id);
    const editedMessage = input.editMessageId ? existingMessages.find((message) => message.id === input.editMessageId) : undefined;
    if (input.editMessageId && (!editedMessage || editedMessage.sender !== "user")) {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "editMessageId", id: input.editMessageId });
    }
    const currentAttachments = await this.attachments.save(session, input.attachments);
    const sessionArtifacts = this.database.artifacts.list({ sessionId: session.id });
    const projectRunArtifacts = session.projectRunId ? this.database.artifacts.list({ projectRunId: session.projectRunId }) : [];
    const artifacts = [...new Map([...sessionArtifacts, ...projectRunArtifacts].map((artifact) => [artifact.id, artifact])).values()];
    const agent = this.members.resolveSession(session);
    const needsRuntimeToolMigration = agent.providerId === "codex"
      && Boolean(session.teamId && session.projectRunId && !session.parentSessionId)
      && session.runtimeToolVersion !== RUNTIME_TOOL_SCHEMA_VERSION;
    const turnContext = buildSessionTurnContext({
      currentText: appendAttachmentContext(input.editMessageId
        ? `The user edited an earlier message. Treat the following as the corrected instruction:\n\n${input.text}`
        : input.text, currentAttachments),
      messages: existingMessages,
      artifacts,
      currentAttachments,
      recoverProviderContext: !session.providerSessionId || !session.providerContextSyncedAt || needsRuntimeToolMigration,
      workMode: session.mode === "work",
      workspaceRoot: this.database.projects.get(session.projectId)?.rootPath
    });
    const message: Message = editedMessage
      ? { ...editedMessage, text: input.text, attachmentIds: currentAttachments.map((artifact) => artifact.id), editedAt: new Date().toISOString() }
      : { id: randomUUID(), sessionId: session.id, sender: "user", kind: "chat", projectRunId: session.projectRunId, taskId: session.taskId, toMemberId: session.memberId, text: input.text, attachmentIds: currentAttachments.map((artifact) => artifact.id), createdAt: new Date().toISOString() };
    this.database.sessions.saveMessage(message);
    const runId = await this.runs.start(session, agent, turnContext.prompt, {
      projectRunId: session.projectRunId,
      taskId: session.taskId,
      memberId: session.memberId,
      localImagePaths: turnContext.localImagePaths,
      synchronizeProviderContext: turnContext.recovered
    });
    return { accepted: true, runId };
  }
}

function descendantSessionIds(sessions: Session[], rootId: string): string[] {
  const ids = new Set<string>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const session of sessions) {
      if (session.parentSessionId && ids.has(session.parentSessionId) && !ids.has(session.id)) {
        ids.add(session.id);
        added = true;
      }
    }
  }
  return [...ids];
}

function followUpMessage(session: Session, text: string): Message {
  return {
    id: randomUUID(),
    sessionId: session.id,
    sender: "user",
    kind: "chat",
    projectRunId: session.projectRunId,
    taskId: session.taskId,
    toMemberId: session.memberId,
    text,
    createdAt: new Date().toISOString()
  };
}
