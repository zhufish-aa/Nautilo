import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./helpers/orchestration-runtime-harness.mjs";

const users = (h) => h.state.events.s.filter((event) => event.data.kind === "message" && event.data.sender === "user");

test("sending displays immediately, survives old history and keeps its identity after saving", async () => {
  const h = createHarness();
  let release;
  h.runtime.sessionConfigWrites.set("s", new Promise((resolve) => { release = resolve; }));
  const sending = h.runtime.sendWorkbenchMessage("s", "Hello");
  const bubble = users(h)[0];
  assert.equal(bubble.data.text, "Hello");
  assert.equal(h.calls.length, 0, "message is visible before any IPC or pending config save");
  h.runtime.replaceSessionTimeline("s", []);
  assert.equal(users(h)[0].id, bubble.id, "old empty history cannot erase the bubble");
  release();
  await h.advance(500);
  await sending;
  assert.equal(users(h).length, 1);
  const { messageId } = h.calls.find((call) => call.method === "session.send").params;
  assert.equal(messageId, bubble.data.messageId);
  h.replies["session.get"] = { session: h.session, messages: [{ id: messageId, sessionId: "s", sender: "user", kind: "chat", text: "Hello", createdAt: h.session.createdAt }] };
  const refresh = h.runtime.refreshStandaloneSessionState(h.session);
  await h.advance(100);
  await refresh;
  assert.equal(users(h).length, 1);
  assert.equal(users(h)[0].id, bubble.id, "persistence must not remount the message");
  assert.equal(h.runtime.pendingMessages.has("s"), false);
});

test("identical queued messages have independent identities and remain visible before acknowledgement", async () => {
  const h = createHarness();
  h.replies["session.followUp"] = { accepted: true, mode: "queue" };
  const first = h.runtime.sendWorkbenchFollowUp("s", "again", "queue");
  const second = h.runtime.sendWorkbenchFollowUp("s", "again", "queue");
  const bubbles = users(h);
  assert.equal(bubbles.length, 2);
  assert.notEqual(bubbles[0].id, bubbles[1].id);
  h.runtime.replaceSessionTimeline("s", [bubbles[0]]);
  assert.deepEqual(Array.from(users(h), (row) => row.id), Array.from(bubbles, (row) => row.id));
  await h.advance(100);
  await Promise.all([first, second]);
});

test("a late standalone history read cannot reset a conversation that just became a team run", async () => {
  const h = createHarness();
  const oldRead = h.runtime.hydrateStandaloneSession(h.session);
  const current = { ...h.session, projectRunId: "new-team-run", title: "Current goal" };
  h.state._upsertExternalSession(current);
  await h.advance(200);
  await oldRead;
  assert.equal(h.state.sessions[0].projectRunId, "new-team-run");
  assert.equal(h.state.sessions[0].title, "Current goal");
  assert.equal(h.renders.length, 0);
});

test("first team message materializes on the already-mounted workbench without reopening it", async () => {
  const h = createHarness();
  h.session.target.teamId = "t";
  const projectRun = { id: "pr", projectId: "p", teamId: "t", mainAgentInstanceId: "a0", mainSessionId: "s", status: "executing", createdAt: h.session.createdAt, updatedAt: h.session.createdAt };
  h.replies["task.list"] = [];
  h.replies["verification.list"] = [];
  h.replies["projectRun.get"] = { projectRun };
  h.replies["orchestration.start"] = ({ messageId, goal }) => {
    const mainSession = { ...h.session, projectRunId: "pr", agentInstanceId: "a0", teamId: "t" };
    h.replies["session.get"] = { session: mainSession, messages: [{ id: messageId, sessionId: "s", sender: "user", kind: "chat", text: goal, createdAt: h.session.createdAt }] };
    h.replies["session.list"] = [mainSession];
    return { projectRun, mainSession };
  };
  const unregister = h.runtime.registerStandaloneSessionView("s");
  const sending = h.runtime.sendWorkbenchMessage("s", "Use my team");
  const firstId = users(h)[0].id;
  await h.advance(650);
  await sending;
  assert.equal(h.state.sessions.find((session) => session.id === "s").projectRunId, "pr");
  assert.equal(h.runtime.projectSessionBuilt.has("s"), true);
  assert.equal(users(h).length, 1);
  assert.equal(users(h)[0].id, firstId);
  assert.equal(h.runtime.pendingMessages.has("s"), false, "the displayed bubble is now the durable message");
  unregister();
});

test("streamed assistant reply keeps its row key after being saved", () => {
  const h = createHarness();
  const stream = { schemaVersion: 1, eventId: "delta", sessionId: "s", projectId: "p", runId: "r", sequence: 1, timestamp: "2026-11-03T00:00:01Z", type: "agent.message_delta", payload: { messageId: "provider-item", text: "Hello" } };
  const before = h.runtime.buildStandaloneTimeline([], [stream], []);
  const after = h.runtime.buildStandaloneTimeline([{ id: "saved-message", sessionId: "s", runId: "r", sender: "agent", kind: "chat", text: "Hello", createdAt: stream.timestamp }], [stream], []);
  assert.equal(before[0].id, after[0].id);
  assert.equal(after.length, 1);
  assert.equal(after[0].data.streaming, undefined);
});

for (const outcome of ['steer', 'queue', 'error']) {
  test(`promoting queued message ${outcome} does not resend or remount its bubble`, async () => {
    const h = createHarness({ failMethod: outcome === 'error' ? 'session.followUp.steer' : undefined });
    h.state._append('s', { kind: 'message', sender: 'user', messageId: 'q', text: 'later' });
    h.state._addQueuedFollowUp('s', { messageId: 'q', text: 'later', queuedAt: h.session.createdAt });
    h.replies['session.followUp.steer'] = { accepted: true, mode: outcome };
    const original = users(h)[0];
    const sent = h.runtime.steerWorkbenchQueuedFollowUp('s', 'q');
    const checked = outcome === 'error' ? assert.rejects(sent, /simulated IPC failure/) : sent;
    assert.equal(h.state.queuedFollowUps.s.length, 1, 'keep queue visible while waiting for acknowledgement');
    await h.advance(100);
    await checked;
    assert.equal(h.state.queuedFollowUps.s.length, outcome === 'steer' ? 0 : 1);
    assert.equal(users(h)[0], original);
    assert.deepEqual(h.calls.map(call => call.method), ['session.followUp.steer']);
  });
}
