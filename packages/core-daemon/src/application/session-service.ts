import { bindNewSession } from "../runtime/runtime-connection.js";
import { assertSessionIdentityUpdate } from "../runtime/session-binding-guard.js";
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
  /** Sessions whose journal was already scanned for orphaned queued
   * follow-ups in this process — the scan is idempotent, so run it once. */
  private readonly healedFollowUpSessions = new Set<string>();
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
    let session: Session = { id: randomUUID(), projectId: input.projectId, memberId: input.memberId, connectionId: input.connectionId, connectionRevision: input.connectionRevision, title: input.title ?? "New session", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
    if (session.connectionId) session = bindNewSession(this.database, session, this.members.resolveSession(session));
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
    this.healFollowUps(input.sessionId);
    const session = this.database.sessions.get(input.sessionId);
    if (!session) throw new CoreError("IPC_NOT_FOUND", { resource: "session", id: input.sessionId });

    // Only providers with an in-flight steer channel (currently Codex's
    // turn/steer) can inject mid-turn. Every other CLI takes the queue path:
    // the follow-up runs as the next turn right after the active one settles,
    // so Enter behaves the same across providers instead of erroring out.
    if (input.mode === "steer" && this.runs.canSteer(session.id)) {
      await this.runs.steerSession(session.id, text);
      this.database.sessions.saveMessage(followUpMessage(session, text, input.messageId));
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
      fullHistory: session.connectionContextRebuildRequired,
      recoverProviderContext: !!session.connectionContextRebuildRequired || !session.providerSessionId || !session.providerContextSyncedAt || this.runs.requiresProviderRecovery(session, agent),
      workspaceRoot: this.database.projects.get(session.projectId)?.rootPath
    });
    const message = followUpMessage(session, text, input.messageId);
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
      // Not pending in this process: either the turn already started (reject,
      // same as before) or the entry is a replayed zombie from before a
      // daemon restart — that one can never start, so journal the
      // cancellation and let the user withdraw it.
      const hasActiveRun = this.database.runs.list().some((run) =>
        run.sessionId === input.sessionId && !["completed", "failed", "timed_out", "crashed", "cancelled"].includes(run.status)
      );
      if (hasActiveRun) {
        throw new CoreError("IPC_INVALID_REQUEST", { field: "messageId", reason: "Follow-up is no longer queued; it may have already started." });
      }
      this.events.appendForSession(session, { projectRunId: session.projectRunId, taskId: session.taskId }, "session.follow_up_cancelled", { messageId: input.messageId });
      this.database.sessions.deleteMessage(input.sessionId, input.messageId);
      return { cancelled: true };
    }
    if (!this.runs.cancelQueued(input.sessionId, input.messageId)) {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "messageId", reason: "Follow-up is already being sent." });
    }
    this.untrackPendingFollowUp(input.sessionId, input.messageId);
    this.database.sessions.deleteMessage(input.sessionId, input.messageId);
    this.events.appendForSession(session, { projectRunId: session.projectRunId, taskId: session.taskId }, "session.follow_up_cancelled", { messageId: input.messageId });
    return { cancelled: true };
  }
  async followUpSteer(input: IpcRequestMap["session.followUp.steer"]["input"]): Promise<{ accepted: true; mode: "steer" | "queue" }> {
    const session = this.database.sessions.get(input.sessionId);
    if (!session) throw new CoreError("IPC_NOT_FOUND", { resource: "session", id: input.sessionId });
    const entry = this.pendingFollowUps.get(session.id)?.find((item) => item.messageId === input.messageId);
    if (!entry) throw new CoreError("IPC_INVALID_REQUEST", { field: "messageId", reason: "Follow-up is no longer queued." });
    if (!this.runs.canSteer(session.id)) return { accepted: true, mode: "queue" };
    if (!await this.runs.steerQueued(session.id, entry.messageId, entry.text)) {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "messageId", reason: "Follow-up is already being sent." });
    }
    this.untrackPendingFollowUp(session.id, entry.messageId);
    this.events.appendForSession(session, { projectRunId: session.projectRunId, taskId: session.taskId }, "session.follow_up_steered", { messageId: entry.messageId });
    return { accepted: true, mode: "steer" };
  }
  /**
   * Journals session.follow_up_cancelled for every queued follow-up in this
   * session's journal that was never cancelled and is not pending in THIS
   * process. The pending queue is in-memory, so a daemon restart orphans the
   * journaled entries and every full replay would show them as queued
   * forever. Messages are NOT deleted here — an orphaned entry may belong to
   * a turn that actually ran before the restart. Best-effort, once per
   * session per process.
   */
  healFollowUps(sessionId: string): void {
    if (!sessionId || this.healedFollowUpSessions.has(sessionId)) return;
    this.healedFollowUpSessions.add(sessionId);
    try {
      const rows = this.database.connection.raw
        .prepare(
          "SELECT data FROM runtime_events WHERE session_id = ? \
           AND json_extract(data, '$.type') IN ('session.follow_up_queued', 'session.follow_up_cancelled', 'session.follow_up_steered') \
           ORDER BY sequence, rowid"
        )
        .all(sessionId) as Array<{ data: string }>;
      const live = new Set((this.pendingFollowUps.get(sessionId) ?? []).map((entry) => entry.messageId));
      const open = new Map<string, true>();
      for (const row of rows) {
        const event = JSON.parse(row.data) as { type?: string; payload?: { messageId?: string } };
        const messageId = event.payload?.messageId;
        if (!messageId || live.has(messageId)) continue;
        open.delete(messageId);
        if (event.type === "session.follow_up_queued") open.set(messageId, true);
      }
      if (!open.size) return;
      const session = this.database.sessions.get(sessionId);
      if (!session) return;
      for (const messageId of open.keys()) {
        this.events.appendForSession(session, { projectRunId: session.projectRunId, taskId: session.taskId }, "session.follow_up_cancelled", { messageId });
      }
    } catch {
      // Best-effort: the next daemon start retries the heal.
    }
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
    const { permissionMode, connectionId, connectionRevision, confirmConnectionChange, connectionContextRebuildRequired: _untrustedRebuild, ...metadata } = input;
    let normalized: Session = {
      ...metadata,
      ...(Object.prototype.hasOwnProperty.call(input, "connectionId") ? { connectionId: connectionId ?? undefined, connectionRevision: connectionId === null ? undefined : connectionRevision ?? undefined } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "permissionMode")
        ? { permissionMode: permissionMode?.trim() || undefined } : {})
    };
    const current = this.database.sessions.get(normalized.id);
    if (!current) {
      if (normalized.connectionId) normalized = bindNewSession(this.database, normalized, this.members.resolveSession(normalized));
      this.database.sessions.save(normalized);
      return normalized;
    }

    assertSessionIdentityUpdate(current, normalized, this.database);
    if (!Object.prototype.hasOwnProperty.call(input, "connectionId")) {
      normalized.connectionId = current.connectionId;
      normalized.connectionRevision = current.connectionRevision;
    } else if (normalized.connectionId) {
      normalized = bindNewSession(this.database, normalized, this.members.resolveSession({ ...current, ...normalized }));
    }
    const connectionChanged = current.connectionId !== normalized.connectionId || current.connectionRevision !== normalized.connectionRevision;
    const hasHistory = Boolean(current.providerSessionId) || this.database.runs.list().some((run) => run.sessionId === current.id) || this.database.sessions.messages(current.id).length > 0;
    if (connectionChanged) {
      if ((hasHistory || current.connectionId) && confirmConnectionChange !== true) throw new CoreError("IPC_INVALID_REQUEST", { field: "confirmConnectionChange", reason: "Confirm rebuilding text context when switching account or supplier" });
      const active = this.database.runs.list().some((run) => run.sessionId === current.id && !["completed", "failed", "cancelled", "crashed", "timed_out"].includes(run.status));
      if (active || (this.pendingFollowUps.get(current.id)?.length ?? 0) > 0) throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionId", reason: "Wait for active and queued turns before changing connection" });
      const bytes = Buffer.byteLength(this.database.sessions.messages(current.id).map((message) => message.text).join("\n"), "utf8");
      if (bytes > 1024 * 1024) throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionId", reason: "History is too large to rebuild safely (1 MiB). Create a new conversation with an explicit summary instead" });
    }

    // The orchestrator temporarily rebinds `memberId` from the renderer's
    // agent-instance id to the selected team-member id. That is presentation /
    // routing metadata, not a provider-thread boundary. Reset the native
    // provider session only when the project or actual CLI instance changes.
    const sameProviderBinding = current.projectId === normalized.projectId
      && current.agentInstanceId === normalized.agentInstanceId && !connectionChanged;
    const updated: Session = {
      ...current,
      ...normalized,
      createdAt: current.createdAt,
      projectRunId: normalized.projectRunId ?? current.projectRunId,
      parentSessionId: normalized.parentSessionId ?? current.parentSessionId,
      taskId: normalized.taskId ?? current.taskId,
      providerSessionId: sameProviderBinding
        ? current.providerSessionId ?? normalized.providerSessionId
        : connectionChanged ? undefined : normalized.providerSessionId,
      providerContextSyncedAt: sameProviderBinding ? current.providerContextSyncedAt : undefined,
      runtimeToolVersion: sameProviderBinding
        ? current.runtimeToolVersion ?? normalized.runtimeToolVersion
        : connectionChanged ? undefined : normalized.runtimeToolVersion,
      connectionContextRebuildRequired: (connectionChanged && hasHistory) || current.connectionContextRebuildRequired,
      providerContextWindow: connectionChanged ? undefined : current.providerContextWindow
    };
    this.database.sessions.save(updated);
    return updated;
  }
  async send(input: IpcRequestMap["session.send"]["input"]): Promise<{ accepted: true; runId: string }> {
    // Heal replayed zombie queue entries before this run's events make the
    // renderer re-read the journal (see healFollowUps).
    this.healFollowUps(input.sessionId);
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
      fullHistory: session.connectionContextRebuildRequired,
      recoverProviderContext: !!session.connectionContextRebuildRequired || !session.providerSessionId || !session.providerContextSyncedAt || needsRuntimeToolMigration || this.runs.requiresProviderRecovery(session, agent),
      workspaceRoot: this.database.projects.get(session.projectId)?.rootPath
    });
    const message: Message = editedMessage
      ? { ...editedMessage, text: input.text, attachmentIds: currentAttachments.map((artifact) => artifact.id), editedAt: new Date().toISOString() }
      : { id: input.messageId || randomUUID(), sessionId: session.id, sender: "user", kind: "chat", projectRunId: session.projectRunId, taskId: session.taskId, toMemberId: session.memberId, text: input.text, attachmentIds: currentAttachments.map((artifact) => artifact.id), createdAt: new Date().toISOString() };
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

function followUpMessage(session: Session, text: string, messageId?: string): Message {
  return {
    id: messageId || randomUUID(),
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
