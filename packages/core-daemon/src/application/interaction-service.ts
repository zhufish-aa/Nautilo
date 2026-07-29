import { randomUUID } from "node:crypto";
import type { InteractionRequest, InteractionResponse, Session } from "@agenthub/domain";
import { Database } from "../database/index.js";
import { CoreError } from "../errors.js";
import { EventService } from "../runtime/event-service.js";

const RESOLVED_HISTORY_LIMIT = 50;

interface PendingInteraction {
  record: InteractionRequest;
  resolve: (response: InteractionResponse) => void;
}

/**
 * Bridges provider-initiated questions/permission prompts to the desktop user.
 * Records are in-memory: a pending interaction cannot outlive its provider
 * process, and a daemon restart kills the process anyway.
 */
export class InteractionService {
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly resolvedHistory: InteractionRequest[] = [];

  constructor(private readonly database: Database, private readonly events: EventService) {}

  /** Called by RunService when an adapter asks for user input; blocks until respond(). */
  request(
    session: Session,
    runId: string | undefined,
    providerId: string,
    input: Pick<InteractionRequest, "kind" | "title" | "detail" | "questions" | "options" | "plan">
  ): Promise<InteractionResponse> {
    const record: InteractionRequest = {
      ...input,
      id: randomUUID(),
      sessionId: session.id,
      runId,
      providerId,
      status: "pending",
      createdAt: new Date().toISOString()
    };
    const resolution = new Promise<InteractionResponse>((resolve) => {
      this.pending.set(record.id, { record, resolve });
    });
    this.events.appendForSession(session, { runId }, "interaction.requested", { interaction: record });
    return resolution;
  }

  respond(interactionId: string, response: InteractionResponse): InteractionRequest {
    const pending = this.pending.get(interactionId);
    if (!pending) throw new CoreError("INTERACTION_NOT_FOUND", { interactionId });
    this.pending.delete(interactionId);
    const record: InteractionRequest = {
      ...pending.record,
      status: response.outcome === "cancelled" ? "cancelled" : "resolved",
      response,
      resolvedAt: new Date().toISOString()
    };
    const session = this.eventsSession(record.sessionId);
    this.events.appendForSession(session, { runId: record.runId }, "interaction.resolved", { interaction: record });
    this.remember(record);
    pending.resolve(response);
    return record;
  }

  list(input: { sessionId?: string; status?: InteractionRequest["status"] } = {}): InteractionRequest[] {
    const all = [
      ...[...this.pending.values()].map((entry) => entry.record),
      ...this.resolvedHistory
    ];
    return all
      .filter((record) => (!input.sessionId || record.sessionId === input.sessionId) && (!input.status || record.status === input.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Auto-cancels everything a finished/cancelled run was still waiting on. */
  cancelForRun(runId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.record.runId !== runId) continue;
      this.pending.delete(id);
      const record: InteractionRequest = {
        ...pending.record,
        status: "cancelled",
        response: { outcome: "cancelled" },
        resolvedAt: new Date().toISOString()
      };
      this.remember(record);
      pending.resolve({ outcome: "cancelled" });
    }
  }

  private remember(record: InteractionRequest): void {
    this.resolvedHistory.push(record);
    if (this.resolvedHistory.length > RESOLVED_HISTORY_LIMIT) this.resolvedHistory.shift();
  }

  /** EventService needs the real session row to route and persist the event. */
  private eventsSession(sessionId: string): Session {
    const session = this.database.sessions.get(sessionId);
    if (!session) throw new CoreError("IPC_NOT_FOUND", { resource: "session", id: sessionId });
    return session;
  }
}
