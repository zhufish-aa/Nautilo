import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry, Database, EventService, RunService } from "../dist/index.js";

const now = new Date().toISOString();

async function waitForRun(database, runId) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const run = database.runs.get(runId);
    if (run && ["completed", "failed", "timed_out", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} did not finish`);
}

function adapterRun(providerSessionId) {
  async function* events() {
    yield { kind: "session", providerSessionId };
    yield { kind: "message", text: "ok" };
    yield { kind: "exit", exitCode: 0 };
  }
  return { process: {}, events: events(), cancel: async () => {}, write: () => {} };
}

test("RunService starts a new provider session and resumes subsequent messages", async () => {
  let starts = 0;
  let resumes = 0;
  const requests = [];
  const adapter = {
    providerId: "fake",
    supportsStructuredOutput: true,
    supportsResume: true,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: true, pty: false },
    detect: async () => ({ installed: true, executable: "fake" }),
    start: (request) => { starts += 1; requests.push(request); return adapterRun("provider-session-1"); },
    resume: (request) => {
      resumes += 1;
      requests.push(request);
      assert.equal(request.providerSessionId, "provider-session-1");
      return adapterRun(request.providerSessionId);
    }
  };
  const database = new Database(":memory:");
  const registry = new AdapterRegistry([adapter]);
  const service = new RunService(database, registry, new EventService(database));
  const project = { id: "p1", name: "Project", rootPath: process.cwd(), repositoryType: "git", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default" };
  const session = { id: "s1", projectId: "p1", memberId: "a1", model: "session-model", reasoningEffort: "max", serviceTier: "priority", title: "Session", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
  const agent = { id: "a1", providerId: "fake", displayName: "Fake", executable: "fake", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now };
  database.projects.save(project, now);
  database.sessions.save(session);

  const firstRunId = await service.start(session, agent, "first");
  await waitForRun(database, firstRunId);
  const persistedSession = database.sessions.get(session.id);
  assert.equal(persistedSession?.providerSessionId, "provider-session-1");

  const secondRunId = await service.start(persistedSession, agent, "second");
  await waitForRun(database, secondRunId);
  assert.equal(starts, 1);
  assert.equal(resumes, 1);
  assert.deepEqual(requests.map(({ model, reasoningEffort, serviceTier }) => ({ model, reasoningEffort, serviceTier })), [
    { model: "session-model", reasoningEffort: "max", serviceTier: "priority" },
    { model: "session-model", reasoningEffort: "max", serviceTier: "priority" }
  ]);
  database.close();
});

test("RunService serializes turns in one session without blocking another session", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const starts = [];
  const adapter = {
    providerId: "fake",
    supportsStructuredOutput: true,
    supportsResume: false,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: false, pty: false },
    detect: async () => ({ installed: true, executable: "fake" }),
    start: (request) => {
      starts.push(request.prompt);
      async function* events() {
        if (request.prompt === "main-first") await firstGate;
        yield { kind: "message", text: request.prompt };
        yield { kind: "exit", exitCode: 0 };
      }
      return { process: {}, events: events(), cancel: async () => {}, write: () => {} };
    }
  };
  const database = new Database(":memory:");
  const service = new RunService(database, new AdapterRegistry([adapter]), new EventService(database));
  const project = { id: "p1", name: "Project", rootPath: process.cwd(), repositoryType: "none", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default" };
  const main = { id: "main", projectId: "p1", memberId: "a1", title: "Main", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
  const child = { ...main, id: "child", title: "Child" };
  const agent = { id: "a1", providerId: "fake", displayName: "Fake", executable: "fake", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now };
  database.projects.save(project, now);
  database.sessions.save(main);
  database.sessions.save(child);

  const first = await service.launch(main, agent, "main-first");
  const queuedMain = service.launch(main, agent, "main-second");
  const parallelChild = await service.launch(child, agent, "child-first");
  await parallelChild.completion;
  assert.deepEqual(starts, ["main-first", "child-first"]);

  releaseFirst();
  await first.completion;
  const second = await queuedMain;
  await second.completion;
  assert.deepEqual(starts, ["main-first", "child-first", "main-second"]);
  database.close();
});
