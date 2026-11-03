import type { ArtifactChangesInput, HistoryProjection } from "@agenthub/schemas";
import { readHistoryProjection, readSnapshot } from "./history-projection.js";
import { CoreError } from "../errors.js";
import type { Artifact } from "@agenthub/domain";
import type { DatabaseSync } from "node:sqlite";
type Row = Record<string, unknown>;
export class ArtifactRepository {
  constructor(private readonly db: DatabaseSync) {}
  save(artifact: Artifact, createdAt = new Date().toISOString(), sizeBytes = 0): void { this.db.prepare("INSERT INTO artifacts(id, kind, project_run_id, task_id, session_id, data, created_at, size_bytes) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, project_run_id=excluded.project_run_id, task_id=excluded.task_id, session_id=excluded.session_id, data=excluded.data, created_at=excluded.created_at, size_bytes=excluded.size_bytes").run(artifact.id, artifact.kind, artifact.projectRunId ?? null, artifact.taskId ?? null, artifact.sessionId ?? null, JSON.stringify(artifact), createdAt, sizeBytes); }
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
  changes(input: ArtifactChangesInput): HistoryProjection<Artifact> {
    if (Boolean(input.sessionId) === Boolean(input.projectRunId)) throw new CoreError("IPC_INVALID_REQUEST", { reason: "artifact.changes requires exactly one sessionId or projectRunId" });
    const scope = input.sessionId ? `artifacts:session:${input.sessionId}` : `artifacts:projectRun:${input.projectRunId}`;
    return readSnapshot(this.db, () => readHistoryProjection<Artifact>(this.db, "artifacts", scope, input.cursor));
  }
  deleteBefore(timestamp: string): number { return Number(this.db.prepare("DELETE FROM artifacts WHERE created_at < ?").run(timestamp).changes); }
}
