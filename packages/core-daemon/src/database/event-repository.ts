import type { RuntimeEvent } from "@agenthub/event-protocol";
import type { DatabaseSync } from "node:sqlite";
type Row = Record<string, unknown>;
export class EventRepository {
  constructor(private readonly db: DatabaseSync) {}
  nextSequence(sessionId?: string, runId?: string): number {
    if (!sessionId && !runId) return 1;
    const row = sessionId
      ? this.db.prepare("SELECT MAX(sequence) AS value FROM runtime_events WHERE session_id = ?").get(sessionId) as Row
      : this.db.prepare("SELECT MAX(sequence) AS value FROM runtime_events WHERE run_id = ?").get(String(runId)) as Row;
    return Number(row?.value ?? 0) + 1;
  }
  append(event: RuntimeEvent): void { this.db.prepare("INSERT OR REPLACE INTO runtime_events(event_id, sequence, session_id, project_run_id, run_id, data, timestamp) VALUES(?, ?, ?, ?, ?, ?, ?)").run(event.eventId, event.sequence, event.sessionId ?? null, event.projectRunId ?? null, event.runId ?? null, JSON.stringify(event), event.timestamp); }
  deleteBefore(timestamp: string): number { return Number(this.db.prepare("DELETE FROM runtime_events WHERE timestamp < ?").run(timestamp).changes); }
  replay(input: { sessionId?: string; projectRunId?: string; runId?: string; afterSequence?: number }): RuntimeEvent[] {
    const after = input.afterSequence ?? 0;
    let rows: Row[];
    if (input.sessionId) rows = this.db.prepare("SELECT data FROM runtime_events WHERE session_id = ? AND sequence > ? ORDER BY sequence").all(input.sessionId, after) as Row[];
    else if (input.projectRunId) rows = this.db.prepare("SELECT data FROM runtime_events WHERE project_run_id = ? AND sequence > ? ORDER BY sequence").all(input.projectRunId, after) as Row[];
    else if (input.runId) rows = this.db.prepare("SELECT data FROM runtime_events WHERE run_id = ? AND sequence > ? ORDER BY sequence").all(input.runId, after) as Row[];
    else rows = this.db.prepare("SELECT data FROM runtime_events WHERE sequence > ? ORDER BY timestamp, sequence").all(after) as Row[];
    return rows.map((row) => JSON.parse(String(row.data)) as RuntimeEvent);
  }
}
