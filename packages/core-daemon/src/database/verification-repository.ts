import type { VerificationResult } from "@agenthub/domain";
import type { DatabaseSync } from "node:sqlite";
type Row = Record<string, unknown>;

export class VerificationRepository {
  constructor(private readonly db: DatabaseSync) {}
  save(result: VerificationResult): void {
    this.db.prepare("INSERT OR REPLACE INTO verification_results(id, project_run_id, task_id, data, created_at) VALUES(?, ?, ?, ?, ?)")
      .run(result.id, result.projectRunId, result.taskId ?? null, JSON.stringify(result), result.createdAt);
  }
  list(projectRunId: string, taskId?: string): VerificationResult[] {
    const rows = (taskId
      ? this.db.prepare("SELECT data FROM verification_results WHERE project_run_id = ? AND task_id = ? ORDER BY created_at").all(projectRunId, taskId)
      : this.db.prepare("SELECT data FROM verification_results WHERE project_run_id = ? ORDER BY created_at").all(projectRunId)) as Row[];
    return rows.map((row) => JSON.parse(String(row.data)) as VerificationResult);
  }
  listAll(): VerificationResult[] {
    return (this.db.prepare("SELECT data FROM verification_results ORDER BY created_at").all() as Row[])
      .map((row) => JSON.parse(String(row.data)) as VerificationResult);
  }
}
