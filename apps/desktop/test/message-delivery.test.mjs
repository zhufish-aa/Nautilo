import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./helpers/orchestration-runtime-harness.mjs";

const users = (h) => h.state.events.s.filter((event) => event.data.kind === "message" && event.data.sender === "user");

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
  await h.advance(650);
  await sending;
  assert.equal(h.state.sessions.find((session) => session.id === "s").projectRunId, "pr");
  assert.equal(h.runtime.projectSessionBuilt.has("s"), true);
  assert.equal(users(h).length, 1);
  assert.equal(users(h)[0].data.text, "Use my team");
  unregister();
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
