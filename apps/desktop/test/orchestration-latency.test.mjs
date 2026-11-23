import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, delta } from "./helpers/orchestration-runtime-harness.mjs";

const texts = (h) => Array.from(h.state.events.s).filter((row) => row.data.kind === "message").map((row) => row.data.text);

test("the workbench picks up newly persisted workflow children and refreshes just their metadata", async () => {
  const h = createHarness();
  const child = { ...h.session, id: "child", parentSessionId: "s", title: "代码探索", status: "running" };
  h.replies["session.list"] = [];
  const close = h.runtime.watchChildSessions("p", "s");
  await h.advance(40);
  assert.equal(h.state.sessions.length, 1);

  h.replies["session.list"] = [child, { ...child, id: "unrelated", parentSessionId: "other" }];
  await h.advance(2040);
  assert.deepEqual(h.state.sessions.map(session => session.id), ["s", "child"]);
  assert.equal(h.state.sessions[1].status, "running");

  h.replies["session.list"] = [{ ...child, status: "completed", updatedAt: "2026-11-03T00:00:01Z" }];
  await h.advance(2040);
  assert.equal(h.state.sessions[1].status, "completed");

  h.replies["session.list"] = [{ ...child, id: "after-close" }];
  await h.advance(2000);
  close();
  await h.advance(5000);
  assert.deepEqual(h.state.sessions.map(session => session.id), ["s", "child"]);
  assert.equal(h.calls.length, 4);
  assert.ok(h.calls.every(call => call.method === "session.list" && call.params.projectId === "p"));
});

test("independent project/agent writes overlap but session/send await every prerequisite", async () => {
  const h = createHarness();
  const start = h.now();
  const sent = h.runtime.sendWorkbenchMessage("s", "Hello");
  await h.advance(400);
  await sent;
  assert.equal(h.calls.find((call) => call.method === "session.send").at - start, 80);
  assert.equal(h.calls.find((call) => call.method === "event.wait").at - start, 240);
  assert.deepEqual(h.calls.slice(0, 4).map((call) => [call.method, call.at - start]), [
    ["project.upsert", 0], ["agent.upsert", 0], ["session.upsert", 40], ["session.send", 80]
  ]);
});

test("team prerequisites are de-duplicated and validated before any writes", async () => {
  const h = createHarness({ agentCount: 4 });
  h.session.target.teamId = "t";
  const start = h.now();
  const syncing = h.runtime.syncProjectAndAgents(h.session);
  await h.advance(40);
  await syncing;
  assert.equal(h.calls.length, 5);
  assert.ok(h.calls.every((call) => call.at === start));
  const invalid = createHarness({ agentCount: 4 });
  invalid.session.target.teamId = "t";
  invalid.instances[3].executable = "";
  await assert.rejects(invalid.runtime.syncProjectAndAgents(invalid.session), /CLI executable/);
  assert.equal(invalid.calls.length, 0);
});

test("failed prerequisite never starts a model turn", async () => {
  const h = createHarness({ failMethod: "agent.upsert" });
  const sent = assert.rejects(h.runtime.sendWorkbenchMessage("s", "Hello"), /simulated IPC failure/);
  await h.advance(400); await sent;
  assert.ok(!h.calls.some((call) => call.method === "session.send"));
  assert.ok(h.state.events.s.some((row) => row.data.kind === "error"));
});

test("first-token priority retains queue events and cancellation clears pending renders", async () => {
  const h = createHarness();
  h.runtime.standaloneHydrated.add("s");
  h.runtime.mergeStandaloneEvents("s", [delta(1, "", { type: "session.follow_up_queued", payload: { messageId: "q", text: "Next" } }), delta(2)]);
  assert.equal(h.state.queuedFollowUps.s[0].messageId, "q");
  h.runtime.mergeStandaloneEvents("s", [delta(3, "", { type: "session.follow_up_cancelled", payload: { messageId: "q" } })]);
  assert.equal(h.state.queuedFollowUps.s.length, 0);
  h.runtime.clearSessionRuntime("s");
  const count = h.renders.length;
  await h.advance(500);
  assert.equal(h.renders.length, count);
});

test("first-output detection is scoped to the active run, excludes approval/cancellation waits", () => {
  const { runtime } = createHarness();
  const running = { id: "r", status: "running" };
  assert.equal(runtime.isAwaitingFirstOutput(running, [delta(1, "old", { runId: "old-run" })]), true);
  assert.equal(runtime.isAwaitingFirstOutput(running, [delta(2)]), false);
  assert.equal(runtime.isAwaitingFirstOutput({ id: "next", status: "starting" }, [delta(2)]), true);
  for (const status of ["waiting_input", "waiting_approval", "cancelling", "completed", "failed", "cancelled"]) {
    assert.equal(runtime.isAwaitingFirstOutput({ id: "r", status }, []), false);
  }
});

test("visible first-output wait stays at 500ms; later idle backoff and termination survive", async () => {
  const h = createHarness();
  const ticks = [];
  let status = "running";
  h.runtime.setTestProjectHydrator(async () => { ticks.push(h.now()); return { id: "pr", status, mainSessionId: "s" }; });
  h.runtime.projectRunAwaitingOutput.set("pr", true);
  h.runtime.schedulePoll("pr");
  await h.advance(6250);
  assert.equal(ticks.length, 13);
  assert.ok(ticks.slice(1).every((at, i) => at - ticks[i] === 500));
  h.runtime.projectRunAwaitingOutput.set("pr", false);
  await h.advance(6000);
  assert.ok(ticks.some((at, i) => i > 0 && at - ticks[i - 1] === 2000));
  status = "completed";
  await h.advance(2000);
  const terminalCount = ticks.length;
  await h.advance(10000);
  assert.equal(ticks.length, terminalCount);
});

test("terminal project keeps polling for its queued follow-up, then stops after withdrawal", async () => {
  const h = createHarness();
  h.session.projectRunId = "pr";
  h.state.queuedFollowUps.s.push({ messageId: "q", text: "Next" });
  let ticks = 0;
  h.runtime.setTestProjectHydrator(async () => { ticks++; return { id: "pr", status: "completed", mainSessionId: "s" }; });
  h.runtime.schedulePoll("pr");
  await h.advance(1000);
  assert.equal(ticks, 2);
  h.state.queuedFollowUps.s = [];
  await h.advance(500);
  const count = ticks;
  await h.advance(10000);
  assert.equal(ticks, count);
});


test("missing baseline remains explicit instead of becoming a false empty diff", () => {
  const h = createHarness();
  const source = { id: "d", kind: "diff", name: "changes", content: JSON.stringify({ files: [], comparisonUnavailable: true }), metadata: { comparisonUnavailable: true } };
  const [artifact] = h.runtime.toUiArtifact(source);
  assert.equal(artifact.comparisonUnavailable, true);
  assert.equal(artifact.content, "");
  const [normal] = h.runtime.toUiArtifact({ ...source, metadata: {} });
  assert.equal(normal.comparisonUnavailable, undefined);
  assert.equal(h.runtime.sameArtifacts([artifact], [normal]), false);
  const [other] = h.runtime.toUiArtifact({ ...source, kind: "test_report" });
  assert.equal(other.comparisonUnavailable, undefined);
});


test("missing session/bridge reject; accepted turn survives hydrate failure without resending", async () => {
  const missing = createHarness();
  await assert.rejects(missing.runtime.sendWorkbenchMessage("missing", "Hello"), /missing/);
  const offline = createHarness({ bridgeAvailable: false });
  await assert.rejects(offline.runtime.sendWorkbenchMessage("s", "Hello"), /unavailable/);
  const h = createHarness({ failMethod: "session.history" });
  const history = delta(1, "Already streamed");
  h.replies["event.replay"] = { events: [history], lastSequence: 1 };
  const sent = h.runtime.sendWorkbenchMessage("s", "Hello");
  await h.advance(220); await sent;
  h.setFailure(undefined);
  h.replies["event.replay"] = { events: [], lastSequence: 1 };
  await h.advance(1000);
  assert.equal(h.calls.filter((call) => call.method === "session.send").length, 1);
  assert.ok(h.calls.some((call) => call.method === "event.wait"));
  assert.equal(h.runtime.standaloneSequences.get("s"), 1);
});

test("configuration reset sends null, commits only on success, and queues subsequent edits", async () => {
  const h = createHarness();
  h.session.permissionMode = "bypassPermissions";
  const reset = h.runtime.configureWorkbenchSession("s", { permissionMode: undefined });
  const model = h.runtime.configureWorkbenchSession("s", { model: "next-model" });
  await h.advance(39);
  assert.equal(h.session.permissionMode, "bypassPermissions");
  await h.advance(100); await reset; await model;
  assert.equal(h.calls[0].params.permissionMode, null);
  assert.equal(h.calls[1].params.permissionMode, null);
  assert.equal(h.session.permissionMode, undefined);
  assert.equal(h.session.model, "next-model");
  const failed = createHarness({ failMethod: "session.upsert" });
  failed.session.permissionMode = "default";
  const saved = assert.rejects(failed.runtime.configureWorkbenchSession("s", { permissionMode: "bypassPermissions" }), /simulated/);
  await failed.advance(100); await saved;
  assert.equal(failed.session.permissionMode, "default");
  assert.ok(failed.state.events.s.some((row) => row.data.kind === "error" && row.data.code === "SESSION_CONFIG_FAILED"));
});
