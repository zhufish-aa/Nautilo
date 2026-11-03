import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, delta } from "./helpers/orchestration-runtime-harness.mjs";

import { projectFixture, settle } from "./helpers/project-poll-harness.mjs";

test("startup indexes use at most four projects per batch and retain original session order", async () => {
  const h = createHarness();
  h.projectState.projects = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}` }));
  h.replies["session.list"] = ({ projectId }) => [{ ...h.session, id: `s-${projectId}`, projectId }];
  h.replies["projectRun.list"] = [];
  h.replies["run.list"] = [];
  const start = h.now();
  await settle(h, () => h.runtime.hydrateWorkbenchSessions());
  assert.equal(h.now() - start, 240);
  assert.equal(h.calls.length, 41);
  const byTime = new Map();
  for (const call of h.calls.filter((c) => c.method === "session.list")) byTime.set(call.at, (byTime.get(call.at) ?? 0) + 1);
  assert.ok([...byTime.values()].every((count) => count <= 4));
  assert.deepEqual(Array.from(h.state.sessions, (s) => s.id), h.projectState.projects.map((p) => `s-${p.id}`));
});

test("21-session idle project poll fetches one live history, not all 20 completed histories", async () => {
  const h = projectFixture();
  h.runtime.registerProjectSessionView("s", "pr");
  await h.hydrate();
  const before = h.calls.length, renders = h.renders.length;
  const start = h.now();
  await h.hydrate();
  const tick = h.calls.slice(before);
  assert.equal(tick.filter((c) => c.method === "session.get").length, 1);
  assert.equal(tick.length, 28); // six run indexes, 21 replay reads, one live history
  assert.equal(h.now() - start, 920); // same serial replay schedule, no extra live RTT
  assert.equal(h.renders.length, renders);
  assert.equal(h.state.foreground.s.status, "running");
  assert.equal(h.state.sessions.find((s) => s.id === "s").permissionMode, "default");
});

test("hidden project reads metadata without histories; first display still restores messages", async () => {
  const h = projectFixture(2);
  await h.hydrate();
  assert.equal(h.calls.filter((c) => c.method === "session.get").length, 0);
  h.runtime.registerProjectSessionView("s", "pr");
  await h.hydrate();
  assert.equal(h.calls.filter((c) => c.method === "session.get").length, 2);
  assert.ok(h.state.events.child1.some((e) => e.data.kind === "message" && e.data.text === "History"));
});

test("new events invalidate idle history even when updatedAt collides, including rewind and queue cancellation", async () => {
  const h = projectFixture(2);
  h.runtime.registerProjectSessionView("s", "pr");
  await h.hydrate();
  for (const [index, type] of ["agent.message", "session.checkpoint_reverted", "session.follow_up_cancelled", "run.started"].entries()) {
    h.messages.set("child1", [{ id: "changed", sessionId: "child1", sender: "user", text: `Changed ${index}`, createdAt: h.sessions[1].createdAt }]);
    h.feeds.get("child1").push(delta(index + 1, "", { type, sessionId: "child1", runId: "r-child1", payload: { messageId: "q", text: "changed", checkpointId: "checkpoint" } }));
    const count = h.calls.length;
    await h.hydrate();
    assert.equal(h.calls.slice(count).filter((c) => c.method === "session.get" && c.params.sessionId === "child1").length, 1);
    assert.ok(h.state.events.child1.some((e) => e.data.kind === "message" && e.data.text === `Changed ${index}`));
  }
});

test("revision/missing timestamp/manual refresh invalidate histories, while follow-up run state advances", async () => {
  const h = projectFixture(2);
  h.runtime.registerProjectSessionView("s", "pr");
  await h.hydrate();
  h.sessions[1].updatedAt = "2026-11-03T00:01:00Z";
  h.sessions[1].permissionMode = "plan";
  await h.hydrate();
  assert.equal(h.state.sessions.find((s) => s.id === "child1").permissionMode, "plan");
  delete h.sessions[1].updatedAt;
  const before = h.calls.length;
  await h.hydrate(); await h.hydrate();
  assert.equal(h.calls.slice(before).filter((c) => c.method === "session.get" && c.params.sessionId === "child1").length, 2);
  h.sessions[1].updatedAt = h.sessions[0].updatedAt;
  h.runs.unshift({ id: "next", sessionId: "child1", status: "running" });
  await h.hydrate();
  assert.equal(h.state.activeAgentRunIds.child1, "next");
  const beforeRefresh = h.calls.length;
  await settle(h, () => h.runtime.ensureProjectRunHydrated("pr"));
  assert.equal(h.calls.slice(beforeRefresh).filter((c) => c.method === "session.get").length, 2);
});

test("manual session hydration retains live project hydration by default; startup can defer it", async () => {
  const manual = projectFixture(1);
  manual.replies["projectRun.list"] = [manual.projectRun];
  await settle(manual, () => manual.runtime.hydrateWorkbenchSessions());
  assert.equal(manual.calls.filter((c) => c.method === "projectRun.get").length, 1);
  const startup = projectFixture(1);
  startup.replies["projectRun.list"] = [startup.projectRun];
  await settle(startup, () => startup.runtime.hydrateWorkbenchSessions({ hydrateActiveProjectRuns: false }));
  assert.equal(startup.calls.filter((c) => c.method === "projectRun.get").length, 0);
  await settle(startup, () => startup.runtime.resumeWorkbenchRuns());
  assert.equal(startup.calls.filter((c) => c.method === "projectRun.get").length, 1);
});

test("resume uses fresh bounded indexes, preserves hydrate order, and isolates failed projects", async () => {
  const h = createHarness();
  h.projectState.projects = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}` }));
  h.replies["run.list"] = [];
  h.replies["projectRun.list"] = ({ projectId }) => projectId === "p3"
    ? Promise.reject(new Error("project unavailable"))
    : [{ id: `run-${projectId}`, status: "running" }];
  const hydrated = [];
  h.runtime.setTestProjectHydrator(async (id) => { hydrated.push(id); return { id, status: "completed" }; });
  const start = h.now();
  await settle(h, () => h.runtime.resumeWorkbenchRuns());
  assert.equal(h.now() - start, 160);
  assert.deepEqual(hydrated, ["run-p0", "run-p1", "run-p2", "run-p4", "run-p5", "run-p6", "run-p7", "run-p8"]);
  const indexes = h.calls.filter((c) => c.method === "projectRun.list");
  assert.deepEqual(indexes.map((c) => c.at - start), [40, 40, 40, 40, 80, 80, 80, 80, 120]);
  h.replies["projectRun.list"] = ({ projectId }) => projectId === "p0" ? [{ id: "new-run", status: "running" }] : [];
  await settle(h, () => h.runtime.resumeWorkbenchRuns());
  assert.equal(hydrated.at(-1), "new-run", "resume must not reuse the earlier run index");
});
