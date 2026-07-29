import test from "node:test";
import assert from "node:assert/strict";
import { CoreDaemon } from "../dist/index.js";

const now = new Date().toISOString();

function waitFor(condition, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("condition was not met"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function fixture() {
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  const project = { id: "project-follow-up", name: "Project", rootPath: process.cwd(), repositoryType: "none", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default" };
  const agent = { id: "agent-follow-up", providerId: "follow-up-test", displayName: "Follow-up test", executable: "follow-up-test", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now };
  const session = { id: "session-follow-up", projectId: project.id, memberId: agent.id, agentInstanceId: agent.id, title: "Session", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
  daemon.database.projects.save(project, now);
  daemon.database.agents.save(agent, now);
  daemon.database.sessions.save(session);
  return { daemon, agent, session };
}

test("steer sends guidance to the active provider turn without waiting for completion", async () => {
  const { daemon, session } = fixture();
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  const steers = [];
  daemon.adapters.register({
    providerId: "follow-up-test",
    supportsStructuredOutput: true,
    supportsResume: false,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: false, pty: false },
    detect: async () => ({ installed: true, executable: "follow-up-test" }),
    start: () => {
      async function* events() { yield { kind: "session", providerSessionId: "thread-1" }; await done; yield { kind: "exit", exitCode: 0 }; }
      return { process: {}, events: events(), steer: async (text) => { steers.push(text); }, cancel: async () => { release(); }, write: () => {} };
    }
  });

  await daemon.sessions.send({ sessionId: session.id, text: "start working" });
  const result = await daemon.sessions.followUp({ sessionId: session.id, text: "focus on tests first", mode: "steer" });
  assert.deepEqual(result, { accepted: true, mode: "steer" });
  assert.deepEqual(steers, ["focus on tests first"]);
  assert.equal(daemon.database.sessions.messages(session.id).at(-1)?.text, "focus on tests first");
  release();
  await waitFor(() => daemon.database.runs.list().every((run) => ["completed", "failed", "timed_out", "crashed", "cancelled"].includes(run.status)));
  await daemon.stop();
});

test("queue acknowledges immediately and starts a new turn after the active turn completes", async () => {
  const { daemon, session } = fixture();
  const releases = [];
  const prompts = [];
  daemon.adapters.register({
    providerId: "follow-up-test",
    supportsStructuredOutput: true,
    supportsResume: false,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: false, pty: false },
    detect: async () => ({ installed: true, executable: "follow-up-test" }),
    start: (request) => {
      prompts.push(request.prompt);
      let release;
      const done = new Promise((resolve) => { release = resolve; });
      releases.push(release);
      async function* events() { yield { kind: "session", providerSessionId: `thread-${prompts.length}` }; await done; yield { kind: "exit", exitCode: 0 }; }
      return { process: {}, events: events(), cancel: async () => { release(); }, write: () => {} };
    }
  });

  await daemon.sessions.send({ sessionId: session.id, text: "initial task" });
  const result = await Promise.race([
    daemon.sessions.followUp({ sessionId: session.id, text: "after that, summarize", mode: "queue" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("queue waited for the active run")), 100))
  ]);
  assert.deepEqual(result, { accepted: true, mode: "queue" });
  assert.equal(prompts.length, 1);
  releases[0]();
  await waitFor(() => prompts.length === 2);
  assert.match(prompts[1], /after that, summarize/);
  releases[1]();
  await waitFor(() => daemon.database.runs.list().every((run) => ["completed", "failed", "timed_out", "crashed", "cancelled"].includes(run.status)));
  await daemon.stop();
});

test("steer falls back to queue when the provider has no mid-turn channel", async () => {
  const { daemon, session } = fixture();
  const releases = [];
  const prompts = [];
  daemon.adapters.register({
    providerId: "follow-up-test",
    supportsStructuredOutput: true,
    supportsResume: false,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: false, pty: false },
    detect: async () => ({ installed: true, executable: "follow-up-test" }),
    start: (request) => {
      prompts.push(request.prompt);
      let release;
      const done = new Promise((resolve) => { release = resolve; });
      releases.push(release);
      async function* events() { yield { kind: "session", providerSessionId: `thread-${prompts.length}` }; await done; yield { kind: "exit", exitCode: 0 }; }
      return { process: {}, events: events(), cancel: async () => { release(); }, write: () => {} };
    }
  });

  await daemon.sessions.send({ sessionId: session.id, text: "initial task" });
  // No steer channel on this adapter: the follow-up must queue, not throw.
  const result = await daemon.sessions.followUp({ sessionId: session.id, text: "and then clean up", mode: "steer" });
  assert.deepEqual(result, { accepted: true, mode: "queue" });
  assert.equal(prompts.length, 1);
  releases[0]();
  await waitFor(() => prompts.length === 2);
  assert.match(prompts[1], /and then clean up/);
  releases[1]();
  await waitFor(() => daemon.database.runs.list().every((run) => ["completed", "failed", "timed_out", "crashed", "cancelled"].includes(run.status)));
  await daemon.stop();
});
