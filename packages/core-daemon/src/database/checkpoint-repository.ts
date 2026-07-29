import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

export interface CheckpointRow {
  id: string;
  sessionId: string;
  runId?: string;
  createdAt: string;
  /** Snapshot capture hit a bound (file count/size); revert may be incomplete. */
  truncated: boolean;
}

/** Per-turn checkpoint metadata; snapshot payloads live on disk, not in SQLite. */
export class CheckpointRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(row: CheckpointRow): void {
    this.db.prepare("INSERT INTO checkpoints(id, session_id, run_id, created_at, truncated) VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, run_id=excluded.run_id, created_at=excluded.created_at, truncated=excluded.truncated")
      .run(row.id, row.sessionId, row.runId ?? null, row.createdAt, row.truncated ? 1 : 0);
  }

  get(id: string): CheckpointRow | undefined {
    const row = this.db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  list(sessionId: string): CheckpointRow[] {
    return (this.db.prepare("SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC").all(sessionId) as Row[]).map(mapRow);
  }

  delete(ids: string[]): void {
    const statement = this.db.prepare("DELETE FROM checkpoints WHERE id = ?");
    for (const id of ids) statement.run(id);
  }

  addTouched(runId: string, paths: string[]): void {
    const statement = this.db.prepare("INSERT INTO run_touched_files(run_id, path) VALUES(?, ?) ON CONFLICT DO NOTHING");
    for (const path of paths) statement.run(runId, path);
  }

  touchedForRuns(runIds: string[]): string[] {
    if (!runIds.length) return [];
    const placeholders = runIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT DISTINCT path FROM run_touched_files WHERE run_id IN (${placeholders}) ORDER BY path`).all(...runIds) as Row[];
    return rows.map((row) => String(row.path));
  }
}

function mapRow(row: Row): CheckpointRow {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    runId: row.run_id === null || row.run_id === undefined ? undefined : String(row.run_id),
    createdAt: String(row.created_at),
    truncated: Number(row.truncated) === 1
  };
}
