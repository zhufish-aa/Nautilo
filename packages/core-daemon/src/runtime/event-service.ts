import { randomUUID } from "node:crypto";
import type { AgentRun, ProjectRunId, Session, TaskId } from "@agenthub/domain";
import type { RuntimeEvent, RuntimeEventPayloadMap, RuntimeEventType } from "@agenthub/event-protocol";
import { Database } from "../database/index.js";
import { RedactionService } from "./security/redaction-service.js";

export class EventService {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  constructor(private readonly database: Database, private readonly redaction = new RedactionService()) {}
  append<TType extends RuntimeEventType>(session: Session, run: AgentRun, type: TType, payload: RuntimeEventPayloadMap[TType]): RuntimeEvent {
    return this.appendForSession<TType>(session, { runId: run.id, projectRunId: run.projectRunId, taskId: run.taskId }, type, payload);
  }
  appendForSession<TType extends RuntimeEventType>(
    session: Session,
    context: { runId?: string; projectRunId?: ProjectRunId; taskId?: TaskId },
    type: TType,
    payload: RuntimeEventPayloadMap[TType]
  ): RuntimeEvent {
    // Allocate the sequence and insert under one IMMEDIATE transaction: the
    // write lock is held before MAX(sequence) is read, so a second daemon
    // process sharing the data dir cannot allocate the same sequence (which
    // the renderer's `sequence > afterSequence` polling would silently drop).
    this.database.connection.raw.exec("BEGIN IMMEDIATE");
    let event: RuntimeEvent;
    try {
      event = { schemaVersion: 1 as const, eventId: randomUUID(), sequence: this.database.events.nextSequence(session.id), projectId: session.projectId, runId: context.runId, projectRunId: context.projectRunId, taskId: context.taskId, sessionId: session.id, type, timestamp: new Date().toISOString(), payload: this.redaction.value(payload) } as RuntimeEvent;
      this.database.events.append(event);
      this.database.connection.raw.exec("COMMIT");
    } catch (error) {
      try { this.database.connection.raw.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
      throw error;
    }
    for (const listener of this.listeners) listener(event);
    return event;
  }
  replay(input: { sessionId?: string; projectRunId?: string; runId?: string; afterSequence?: number }): RuntimeEvent[] { return this.database.events.replay(input); }
  onAppend(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
