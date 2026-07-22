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
  saveMessage(message: Message): void { this.db.prepare("INSERT OR REPLACE INTO messages(id, session_id, data, created_at) VALUES(?, ?, ?, ?)").run(message.id, message.sessionId, JSON.stringify(message), message.createdAt); }
  messages(sessionId: string): Message[] { return (this.db.prepare("SELECT data FROM messages WHERE session_id = ? ORDER BY created_at").all(sessionId) as Row[]).map((row) => JSON.parse(String(row.data)) as Message); }
}
