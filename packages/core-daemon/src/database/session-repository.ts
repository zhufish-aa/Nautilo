import type { HistoryCursor, HistoryProjection, SessionHistoryInput } from "@agenthub/schemas";
import { readHistoryProjection, readSnapshot } from "./history-projection.js";
import { CoreError } from "../errors.js";
import type { Message, Session } from "@agenthub/domain";
import type { DatabaseSync } from "node:sqlite";
type Row = Record<string, unknown>;
const SESSION_PROJECTION = "data, (SELECT MAX(created_at) FROM messages WHERE session_id=sessions.id) AS last_message_at";
function sessionRow(row: Row): Session {
  const session = JSON.parse(String(row.data)) as Session;
  session.lastMessageAt = typeof row.last_message_at === "string" ? row.last_message_at : undefined;
  return session;
}

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}
  save(session: Session): void {
    this.db.prepare(`INSERT INTO sessions(id, project_id, member_id, data, updated_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, member_id=excluded.member_id, data=excluded.data, updated_at=excluded.updated_at`)
      .run(session.id, session.projectId, session.memberId, JSON.stringify(session), session.updatedAt);
  }
  get(id: string): Session | undefined { const row = this.db.prepare(`SELECT ${SESSION_PROJECTION} FROM sessions WHERE id = ?`).get(id) as Row | undefined; return row ? sessionRow(row) : undefined; }
  list(projectId: string, memberId?: string): Session[] {
    const rows = (memberId
      ? this.db.prepare(`SELECT ${SESSION_PROJECTION} FROM sessions WHERE project_id = ? AND member_id = ? ORDER BY updated_at DESC`).all(projectId, memberId)
      : this.db.prepare(`SELECT ${SESSION_PROJECTION} FROM sessions WHERE project_id = ? ORDER BY updated_at DESC`).all(projectId)) as Row[];
    return rows.map(sessionRow);
  }
  listAll(): Session[] { return (this.db.prepare(`SELECT ${SESSION_PROJECTION} FROM sessions ORDER BY updated_at DESC`).all() as Row[]).map(sessionRow); }
  /** Permanently removes a conversation, its nested sub-sessions, and their session-scoped records. */
  deleteTree(id: string): string[] {
    const sessions = this.listAll();
    if (!sessions.some((session) => session.id === id)) return [];
    const sessionIds = new Set<string>([id]);
    let added = true;
    while (added) {
      added = false;
      for (const session of sessions) {
        if (session.parentSessionId && sessionIds.has(session.parentSessionId) && !sessionIds.has(session.id)) {
          sessionIds.add(session.id);
          added = true;
        }
      }
    }
    const ids = [...sessionIds];
    const placeholders = ids.map(() => "?").join(", ");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["messages", "runs", "runtime_events", "artifacts"] as const) {
        this.db.prepare(`DELETE FROM ${table} WHERE session_id IN (${placeholders})`).run(...ids);
      }
      this.db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
      this.db.exec("COMMIT");
      return ids;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  history(sessionId: string, cursor?: HistoryCursor): HistoryProjection<Message> & { session: Session } {
    return readSnapshot(this.db, () => {
      const session = this.get(sessionId);
      if (!session) throw new CoreError("IPC_NOT_FOUND", { resource: "session", id: sessionId });
      return { session, ...readHistoryProjection<Message>(this.db, "messages", `messages:session:${sessionId}`, cursor) };
    });
  }
  historyBatch(items: SessionHistoryInput[]): { items: Array<HistoryProjection<Message> & { session: Session }> } {
    if (!Array.isArray(items) || items.length < 1 || items.length > 64 || items.some((item) => !item || typeof item.sessionId !== "string" || !item.sessionId)) {
      throw new CoreError("IPC_INVALID_REQUEST", { reason: "session.historyBatch requires 1 to 64 session cursors" });
    }
    return readSnapshot(this.db, () => ({ items: items.map((item) => this.history(item.sessionId, item.cursor)) }));
  }
  saveMessage(message: Message): void { this.db.prepare("INSERT INTO messages(id, session_id, data, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, data=excluded.data, created_at=excluded.created_at").run(message.id, message.sessionId, JSON.stringify(message), message.createdAt); }
  messages(sessionId: string): Message[] { return (this.db.prepare("SELECT data FROM messages WHERE session_id = ? ORDER BY created_at").all(sessionId) as Row[]).map((row) => JSON.parse(String(row.data)) as Message); }
  deleteMessage(sessionId: string, messageId: string): void { this.db.prepare("DELETE FROM messages WHERE session_id = ? AND id = ?").run(sessionId, messageId); }
}
