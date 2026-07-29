import test from "node:test";
import assert from "node:assert/strict";
import { CoreDaemon } from "../dist/index.js";

const now = new Date().toISOString();

function session(id, parentSessionId) {
  return {
    id,
    projectId: "project-1",
    memberId: "agent-1",
    title: id,
    status: "completed",
    unreadCount: 0,
    parentSessionId,
    createdAt: now,
    updatedAt: now
  };
}

test("deleting a session permanently removes its descendants and session-scoped records", async () => {
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  const root = session("session-root");
  const child = session("session-child", root.id);
  const unrelated = session("session-unrelated");
  for (const item of [root, child, unrelated]) daemon.database.sessions.save(item);
  daemon.database.sessions.saveMessage({ id: "message-root", sessionId: root.id, sender: "user", text: "root", createdAt: now });
  daemon.database.sessions.saveMessage({ id: "message-child", sessionId: child.id, sender: "agent", text: "child", createdAt: now });
  daemon.database.runs.save({ id: "run-root", sessionId: root.id, agentInstanceId: "agent-1", mode: "headless_text", status: "completed", startedAt: now, endedAt: now });
  daemon.database.events.append({ eventId: "event-root", sequence: 1, sessionId: root.id, data: { type: "run.completed" }, timestamp: now });
  daemon.database.artifacts.save({ id: "artifact-child", kind: "file", name: "child.txt", sessionId: child.id });

  const response = await daemon.gateway.dispatch({ method: "session.delete", input: { sessionId: root.id } });
  assert.equal(response.ok, true);
  assert.deepEqual(new Set(response.data.sessionIds), new Set([root.id, child.id]));
  assert.equal(daemon.database.sessions.get(root.id), undefined);
  assert.equal(daemon.database.sessions.get(child.id), undefined);
  assert.equal(daemon.database.sessions.get(unrelated.id)?.id, unrelated.id);
  assert.deepEqual(daemon.database.sessions.messages(root.id), []);
  assert.deepEqual(daemon.database.sessions.messages(child.id), []);
  assert.deepEqual(daemon.database.events.replay({ sessionId: root.id }), []);
  assert.deepEqual(daemon.database.artifacts.list({ sessionId: child.id }), []);
  assert.equal(daemon.database.runs.list().some((run) => run.sessionId === root.id), false);
  await daemon.stop();
});

test("an active session cannot be deleted before it is stopped", async () => {
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  const active = { ...session("session-active"), status: "running" };
  daemon.database.sessions.save(active);
  daemon.database.runs.save({ id: "run-active", sessionId: active.id, agentInstanceId: "agent-1", mode: "headless_text", status: "running", startedAt: now });

  const response = await daemon.gateway.dispatch({ method: "session.delete", input: { sessionId: active.id } });
  assert.equal(response.ok, false);
  assert.equal(daemon.database.sessions.get(active.id)?.id, active.id);
  assert.equal(response.error.details?.reason, "Stop the active run before deleting this session.");
  await daemon.stop();
});
