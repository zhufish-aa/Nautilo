import type { AuditRecord } from "@agenthub/domain";
import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

export class AuditRepository {
  constructor(private readonly db: DatabaseSync) {}
  append(record: AuditRecord): void {
    this.appendMany([record]);
  }
  appendMany(records: AuditRecord[]): void {
    if (!records.length) return;
    const statement = this.db.prepare("INSERT INTO audit_logs(id, action, resource_id, outcome, data, timestamp) VALUES(?, ?, ?, ?, ?, ?)");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        statement.run(record.id, record.action, record.resourceId ?? null, record.outcome, JSON.stringify(record), record.timestamp);
      }
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }
  list(input: { limit?: number; resourceId?: string } = {}): AuditRecord[] {
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 2_000);
    const rows = input.resourceId
      ? this.db.prepare("SELECT data FROM audit_logs WHERE resource_id = ? ORDER BY timestamp DESC LIMIT ?").all(input.resourceId, limit)
      : this.db.prepare("SELECT data FROM audit_logs ORDER BY timestamp DESC LIMIT ?").all(limit);
    return (rows as Row[]).map((row) => JSON.parse(String(row.data)) as AuditRecord);
  }
}
