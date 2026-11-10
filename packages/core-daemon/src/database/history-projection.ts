import type { DatabaseSync } from "node:sqlite";
import type { HistoryCursor, HistoryProjection } from "@agenthub/schemas";

/** A read transaction keeps the watermark and payload on the same WAL snapshot,
 * including when another daemon is writing this shared database. */
export function readSnapshot<T>(db: DatabaseSync, read: () => T): T {
  db.exec("SAVEPOINT history_projection_read");
  try {
    const result = read();
    db.exec("RELEASE history_projection_read");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO history_projection_read; RELEASE history_projection_read");
    throw error;
  }
}

export function readHistoryProjection<T>(db: DatabaseSync, table: "messages" | "artifacts", scope: string, cursor?: HistoryCursor): HistoryProjection<T> {
  const clock = db.prepare("SELECT epoch, revision FROM read_projection_clock WHERE id = 1").get() as { epoch: string; revision: number };
  const invalidation = db.prepare("SELECT revision FROM read_projection_invalidations WHERE scope = ?").get(scope) as { revision: number } | undefined;
  const reset = !cursor || cursor.epoch !== clock.epoch || cursor.scope !== scope
    || !Number.isSafeInteger(cursor.revision) || cursor.revision < 0 || cursor.revision > clock.revision
    || cursor.revision < (invalidation?.revision ?? 0);
  const scopeGuard = table === "messages" ? "revision.scope = 'messages:session:' || entity.session_id"
    : "(revision.scope = 'artifacts:session:' || entity.session_id OR revision.scope = 'artifacts:projectRun:' || entity.project_run_id)";
  const rows = db.prepare(`SELECT entity.data, entity.created_at, entity.rowid AS ordinal
    FROM read_projection_rows AS revision JOIN ${table} AS entity ON entity.id = revision.item_id
    WHERE revision.scope = ? AND revision.revision > ? AND ${scopeGuard} ORDER BY entity.created_at, entity.rowid`)
    .all(scope, reset ? -1 : cursor!.revision) as Array<{ data: string; created_at: string; ordinal: number }>;
  return {
    cursor: { ...clock, scope }, reset,
    items: rows.map((row) => ({ value: JSON.parse(row.data) as T, order: { createdAt: row.created_at, ordinal: row.ordinal } }))
  };
}
