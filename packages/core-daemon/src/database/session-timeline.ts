import type { DatabaseSync } from "node:sqlite";
import type { TimelineBlock, TimelineChanges, TimelineSnapshot, TimelineTurn } from "@agenthub/schemas";
import { setTimeout as delay } from "node:timers/promises";
import { CoreError } from "../errors.js";
import { readSnapshot } from "./history-projection.js";

/** The retained Node daemon can read the same projection. Rust owns its writes. */
export function openSessionTimeline(db: DatabaseSync, sessionId: string): TimelineSnapshot {
  return readSnapshot(db, () => {
    if (!db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId)) {
      throw new CoreError("IPC_NOT_FOUND", { resource: "session", id: sessionId });
    }
    const blocks = db.prepare(`SELECT seq, block_id AS blockId, run_id AS runId, kind, content, sealed, status, result
      FROM timeline_blocks WHERE session_id=? ORDER BY seq`).all(sessionId) as unknown as Array<
        Omit<TimelineBlock, "content" | "result" | "sealed"> & { content: string; result: string | null; sealed: number }
      >;
    const turns = db.prepare(`SELECT run_id AS runId, status, duration_ms AS durationMs, final_block_id AS finalBlockId
      FROM timeline_turns WHERE session_id=?`).all(sessionId) as unknown as TimelineTurn[];
    const watermark = db.prepare("SELECT COALESCE(MAX(revision),0) AS revision FROM timeline_changes WHERE session_id=?")
      .get(sessionId) as { revision: number };
    return { ...watermark, turns, blocks: blocks.map(block => ({
      ...block, content: JSON.parse(block.content), sealed: block.sealed !== 0, result: block.result === null ? null : JSON.parse(block.result)
    })) };
  });
}

export async function waitSessionTimeline(db: DatabaseSync, sessionId: string, revision: number, timeoutMs = 25_000): Promise<TimelineChanges> {
  const deadline = Date.now() + Math.max(50, Math.min(25_000, timeoutMs));
  for (;;) {
    const page = readSnapshot(db, () => {
      const range = db.prepare("SELECT MIN(revision) AS first, MAX(revision) AS last FROM timeline_changes WHERE session_id=?")
        .get(sessionId) as { first: number | null; last: number | null };
      if (!Number.isSafeInteger(revision) || revision < 0 || revision < (range.first ?? 1) - 1 || revision > (range.last ?? 0)) {
        return { revision, reset: true, changes: [] };
      }
      const rows = db.prepare("SELECT revision,data FROM timeline_changes WHERE session_id=? AND revision>? ORDER BY revision LIMIT 128")
        .all(sessionId, revision) as Array<{ revision: number; data: string }>;
      return { revision: rows.at(-1)?.revision ?? revision, reset: false, changes: rows.map(row => JSON.parse(row.data)) };
    });
    if (page.reset || page.revision !== revision || Date.now() >= deadline) return page;
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
}
