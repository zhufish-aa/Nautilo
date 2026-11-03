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
      // Streaming deltas are coalesced: delta text is INCREMENTAL (the
      // renderer concatenates chunk texts on replay), so the surviving row per
      // (session, run, type, messageId) accumulates every chunk — never just
      // the newest. A terminal run event purges only agent.message_delta rows,
      // whose content also lives in the final agent.message event; thinking
      // deltas have no such final event and must stay. Journaling every delta
      // verbatim grew the event table to millions of rows (97% deltas).
      const typeName = event.type as string;
      if (typeName.endsWith("_delta")) {
        const messageId = (event.payload as { messageId?: string } | undefined)?.messageId ?? "";
        const prior = this.database.connection.raw
          .prepare(
            "SELECT json_extract(data, '$.payload.text') AS text FROM runtime_events \
             WHERE session_id = ? AND COALESCE(run_id, '') = COALESCE(?, '') \
             AND json_extract(data, '$.type') = ? AND json_extract(data, '$.payload.messageId') = ? \
             ORDER BY sequence DESC, rowid DESC LIMIT 1"
          )
          .get(session.id, event.runId ?? null, typeName, messageId) as { text?: string } | undefined;
        if (prior?.text) {
          const chunk = (event.payload as { text?: string }).text ?? "";
          (event.payload as { text: string }).text = prior.text + chunk;
        }
        this.database.connection.raw.prepare("INSERT INTO read_projection_event_coalescing(session_id) VALUES(?)").run(session.id);
        this.database.connection.raw
          .prepare("DELETE FROM runtime_events WHERE session_id = ? AND COALESCE(run_id, '') = COALESCE(?, '') AND json_extract(data, '$.type') = ? AND json_extract(data, '$.payload.messageId') = ?")
          .run(session.id, event.runId ?? null, typeName, messageId);
      } else if (typeName === "run.completed" || typeName === "run.failed") {
        this.database.connection.raw
          .prepare("DELETE FROM runtime_events WHERE session_id = ? AND json_extract(data, '$.type') = 'agent.message_delta'")
          .run(session.id);
      }
      this.database.events.append(event);
      this.database.connection.raw.prepare("DELETE FROM read_projection_event_coalescing WHERE session_id = ?").run(session.id);
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
