import assert from "node:assert/strict";
import { createHarness } from "./orchestration-runtime-harness.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
export async function settle(h, action) {
  let settled = false, error;
  const pending = action().then(() => { settled = true; }, (e) => { settled = true; error = e; });
  for (let i = 0; !settled && i < 5000; i++) await h.advance(10);
  assert.equal(settled, true, "runtime request should settle");
  await pending;
  if (error) throw error;
}
export function projectFixture(count = 21, source) {
  const h = createHarness({ source });
  const sessions = Array.from({ length: count }, (_, i) => ({ ...h.session, id: i ? `child${i}` : "s", projectRunId: "pr", parentSessionId: i ? "s" : undefined, memberId: "member", agentInstanceId: "a0", title: `Session ${i}`, status: i ? "completed" : "running", permissionMode: "default" }));
  const messages = new Map(sessions.map((s) => [s.id, [{ id: `m-${s.id}`, sessionId: s.id, sender: "user", text: "History", createdAt: s.createdAt }]]));
  const feeds = new Map(sessions.map((s) => [s.id, []]));
  const runs = sessions.map((s, i) => ({ id: i ? `r-${s.id}` : "r", sessionId: s.id, status: i ? "completed" : "running" }));
  const projectRun = { id: "pr", projectId: "p", teamId: "t", mainSessionId: "s", mainAgentInstanceId: "a0", mainMemberId: "member", status: "executing", goal: "Test", createdAt: sessions[0].createdAt, updatedAt: sessions[0].updatedAt };
  h.state.sessions = clone(sessions);
  for (const s of sessions) { h.state.events[s.id] = []; h.state.queuedFollowUps[s.id] = []; }
  Object.assign(h.replies, {
    "projectRun.get": () => ({ projectRun: clone(projectRun) }),
    "session.list": () => clone(sessions),
    "run.list": () => clone(runs),
    "task.list": [], "verification.list": [],
    "session.get": ({ sessionId }) => ({ session: clone(sessions.find((s) => s.id === sessionId)), messages: clone(messages.get(sessionId)) }),
    "event.subscribe": ({ sessionId }) => ({ subscriptionId: `sub-${sessionId}` }),
    "event.replay": ({ subscriptionId, afterSequence }) => { const events = feeds.get(subscriptionId.slice(4)) ?? []; return { events: clone(events.filter((e) => e.sequence > afterSequence)), lastSequence: events.at(-1)?.sequence ?? 0 }; }
  });
  return { ...h, sessions, messages, feeds, runs, projectRun, hydrate: () => settle(h, () => h.runtime.hydrateProjectRun("pr")) };
}

