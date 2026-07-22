import type { Artifact } from "@agenthub/domain";
import type { DatabaseSync } from "node:sqlite";
type Row = Record<string, unknown>;
export class ArtifactRepository {
  constructor(private readonly db: DatabaseSync) {}
  save(artifact: Artifact, createdAt = new Date().toISOString(), sizeBytes = 0): void { this.db.prepare("INSERT OR REPLACE INTO artifacts(id, kind, project_run_id, task_id, session_id, data, created_at, size_bytes) VALUES(?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.kind, artifact.projectRunId ?? null, artifact.taskId ?? null, artifact.sessionId ?? null, JSON.stringify(artifact), createdAt, sizeBytes); }
  get(id: string): Artifact | undefined { const row = this.db.prepare("SELECT data FROM artifacts WHERE id = ?").get(id) as Row | undefined; return row ? JSON.parse(String(row.data)) as Artifact : undefined; }
  list(input: { projectRunId?: string; taskId?: string; sessionId?: string }): Artifact[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (input.projectRunId) { clauses.push("project_run_id = ?"); values.push(input.projectRunId); }
    if (input.taskId) { clauses.push("task_id = ?"); values.push(input.taskId); }
    if (input.sessionId) { clauses.push("session_id = ?"); values.push(input.sessionId); }
    if (clauses.length === 0) return [];
    return (this.db.prepare(`SELECT data FROM artifacts WHERE ${clauses.join(" AND ")} ORDER BY created_at`).all(...values) as Row[]).map((row) => JSON.parse(String(row.data)) as Artifact);
  }
  deleteBefore(timestamp: string): number { return Number(this.db.prepare("DELETE FROM artifacts WHERE created_at < ?").run(timestamp).changes); }
}
