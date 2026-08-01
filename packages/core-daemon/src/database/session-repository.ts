import type { Message, Session } from "@agenthub/domain";
import type { DatabaseSync } from "node:sqlite";
type Row = Record<string, unknown>;

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}
  save(session: Session): void {
    this.db.prepare(`INSERT INTO sessions(id, project_id, member_id, data, updated_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, member_id=excluded.member_id, data=excluded.data, updated_at=excluded.updated_at`)
      .run(session.id, session.projectId, session.memberId, JSON.stringify(session), session.updatedAt);
  }
  get(id: string): Session | undefined { const row = this.db.prepare("SELECT data FROM sessions WHERE id = ?").get(id) as Row | undefined; return row ? JSON.parse(String(row.data)) as Session : undefined; }
  list(projectId: string, memberId?: string): Session[] {
    const rows = (memberId
      ? this.db.prepare("SELECT data FROM sessions WHERE project_id = ? AND member_id = ? ORDER BY updated_at DESC").all(projectId, memberId)
      : this.db.prepare("SELECT data FROM sessions WHERE project_id = ? ORDER BY updated_at DESC").all(projectId)) as Row[];
    return rows.map((row) => JSON.parse(String(row.data)) as Session);
  }
  listAll(): Session[] { return (this.db.prepare("SELECT data FROM sessions ORDER BY updated_at DESC").all() as Row[]).map((row) => JSON.parse(String(row.data)) as Session); }
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
  saveMessage(message: Message): void { this.db.prepare("INSERT OR REPLACE INTO messages(id, session_id, data, created_at) VALUES(?, ?, ?, ?)").run(message.id, message.sessionId, JSON.stringify(message), message.createdAt); }
  messages(sessionId: string): Message[] { return (this.db.prepare("SELECT data FROM messages WHERE session_id = ? ORDER BY created_at").all(sessionId) as Row[]).map((row) => JSON.parse(String(row.data)) as Message); }
  deleteMessage(sessionId: string, messageId: string): void { this.db.prepare("DELETE FROM messages WHERE session_id = ? AND id = ?").run(sessionId, messageId); }
}
