import type { AgentRun } from "@agenthub/domain";
import type { DatabaseSync } from "node:sqlite";
type Row = Record<string, unknown>;
export class RunRepository {
  constructor(private readonly db: DatabaseSync) {}
  save(run: AgentRun): void { const updatedAt = run.endedAt ?? run.startedAt ?? new Date().toISOString(); this.db.prepare("INSERT INTO runs(id, session_id, data, updated_at) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, data=excluded.data, updated_at=excluded.updated_at").run(run.id, run.sessionId, JSON.stringify(run), updatedAt); }
  get(id: string): AgentRun | undefined { const row = this.db.prepare("SELECT data FROM runs WHERE id = ?").get(id) as Row | undefined; return row ? JSON.parse(String(row.data)) as AgentRun : undefined; }
  list(): AgentRun[] { return (this.db.prepare("SELECT data FROM runs ORDER BY updated_at DESC").all() as Row[]).map((row) => JSON.parse(String(row.data)) as AgentRun); }
}
