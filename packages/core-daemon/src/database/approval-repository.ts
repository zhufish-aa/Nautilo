import type { ApprovalRecord } from "@agenthub/domain";
import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

export class ApprovalRepository {
  constructor(private readonly db: DatabaseSync) {}
  save(record: ApprovalRecord): void {
    this.db.prepare("INSERT OR REPLACE INTO approvals(id, status, project_run_id, data, created_at) VALUES(?, ?, ?, ?, ?)")
      .run(record.id, record.status, record.projectRunId ?? null, JSON.stringify(record), record.createdAt);
  }
  get(id: string): ApprovalRecord | undefined {
    const row = this.db.prepare("SELECT data FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? JSON.parse(String(row.data)) as ApprovalRecord : undefined;
  }
  list(input: { status?: ApprovalRecord["status"]; projectRunId?: string } = {}): ApprovalRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (input.status) { clauses.push("status = ?"); values.push(input.status); }
    if (input.projectRunId) { clauses.push("project_run_id = ?"); values.push(input.projectRunId); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT data FROM approvals${where} ORDER BY created_at DESC`).all(...values) as Row[])
      .map((row) => JSON.parse(String(row.data)) as ApprovalRecord);
  }
}
