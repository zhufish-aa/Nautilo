import { randomUUID } from "node:crypto";
import type { Message, Session } from "@agenthub/domain";
import type { IpcRequestMap } from "@agenthub/schemas";
import { Database } from "../database/index.js";
import { RunService } from "../runtime/run-service.js";
import { CoreError } from "../errors.js";
import { MemberRouter } from "../runtime/orchestration/member-router.js";
import { buildSessionTurnContext } from "./session-context.js";
export class SessionService {
  private readonly members: MemberRouter;
  constructor(private readonly database: Database, private readonly runs: RunService) { this.members = new MemberRouter(database); }
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
      providerContextSyncedAt: sameProviderBinding ? current.providerContextSyncedAt : undefined
    };
    this.database.sessions.save(updated);
    return updated;
  }
  async send(input: IpcRequestMap["session.send"]["input"]): Promise<{ accepted: true; runId: string }> {
    const session = this.database.sessions.get(input.sessionId);
    if (!session) throw new CoreError("IPC_NOT_FOUND", { resource: "session", id: input.sessionId });
    const sessionArtifacts = this.database.artifacts.list({ sessionId: session.id });
    const projectRunArtifacts = session.projectRunId ? this.database.artifacts.list({ projectRunId: session.projectRunId }) : [];
    const artifacts = [...new Map([...sessionArtifacts, ...projectRunArtifacts].map((artifact) => [artifact.id, artifact])).values()];
    const turnContext = buildSessionTurnContext({
      currentText: input.text,
      messages: this.database.sessions.messages(session.id),
      artifacts,
      recoverProviderContext: !session.providerSessionId || !session.providerContextSyncedAt
    });
    const message: Message = { id: randomUUID(), sessionId: session.id, sender: "user", kind: "chat", projectRunId: session.projectRunId, taskId: session.taskId, toMemberId: session.memberId, text: input.text, createdAt: new Date().toISOString() };
    this.database.sessions.saveMessage(message);
    const agent = this.members.resolveSession(session);
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
