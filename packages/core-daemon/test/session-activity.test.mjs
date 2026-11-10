import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SessionRepository } from "../dist/database/session-repository.js";

test("list and detail use message activity even when title, read status or model metadata changes", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT,member_id TEXT,data TEXT,updated_at TEXT); CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,data TEXT,created_at TEXT); CREATE INDEX messages_by_session ON messages(session_id,created_at);");
  const repository = new SessionRepository(db);
  const old = { id:"old",projectId:"project",memberId:"agent",title:"Original",createdAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z" };
  repository.save(old);
  repository.saveMessage({ id:"reply",sessionId:"old",sender:"agent",kind:"chat",text:"Saved reply",createdAt:"2026-01-02T00:00:00Z" });
  repository.save({ ...repository.get("old"), title:"Generated title",unreadCount:0,updatedAt:"2026-11-04T00:00:00Z",lastMessageAt:"2026-11-04T00:00:00Z" });
  for (const session of [repository.get("old"),repository.list("project")[0],repository.listAll()[0]]) assert.equal(session.lastMessageAt,"2026-01-02T00:00:00Z");
  repository.saveMessage({ id:"follow-up",sessionId:"old",sender:"user",kind:"chat",text:"A real new message",createdAt:"2026-11-05T00:00:00Z" });
  assert.equal(repository.get("old").lastMessageAt,"2026-11-05T00:00:00Z");
  repository.deleteMessage("old","follow-up"); assert.equal(repository.get("old").lastMessageAt,"2026-01-02T00:00:00Z");
  repository.save({ ...old,id:"empty",lastMessageAt:"2099-01-01T00:00:00Z" }); assert.equal(repository.get("empty").lastMessageAt,undefined);
});
