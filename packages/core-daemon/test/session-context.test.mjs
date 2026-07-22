import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDaemon, buildSessionTurnContext } from "../dist/index.js";

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

function orchestrationAdapterRun(providerSessionId, prompt) {
  async function* events() {
    yield { kind: "session", providerSessionId };
    yield {
      kind: "message",
      text: prompt.includes("[AGENTHUB_PLANNER_DECISION]")
        ? JSON.stringify({ mode: "direct" })
        : "turn completed"
    };
    yield { kind: "exit", exitCode: 0 };
  }
  return { process: {}, events: events(), cancel: async () => {}, write: () => {} };
}

test("renderer session upsert preserves the native provider thread and the next turn resumes it", async () => {
  let starts = 0;
  let resumes = 0;
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  daemon.adapters.register({
    providerId: "context-test",
    supportsStructuredOutput: true,
    supportsResume: true,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: true, pty: false },
    detect: async () => ({ installed: true, executable: "context-test" }),
    start: () => {
      starts += 1;
      return adapterRun("native-thread-1");
    },
    resume: (request) => {
      resumes += 1;
      assert.equal(request.providerSessionId, "native-thread-1");
      return adapterRun(request.providerSessionId);
    }
  });

  const project = { id: "project-1", name: "Project", rootPath: process.cwd(), repositoryType: "git", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default" };
  const agent = { id: "agent-1", providerId: "context-test", displayName: "Context test", executable: "context-test", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now };
  const session = { id: "session-1", projectId: project.id, memberId: agent.id, agentInstanceId: agent.id, title: "Session", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
  daemon.database.projects.save(project, now);
  daemon.database.agents.save(agent, now);
  daemon.database.sessions.save(session);

  const first = await daemon.sessions.send({ sessionId: session.id, text: "first turn" });
  await waitForRun(daemon.database, first.runId);
  assert.equal(daemon.database.sessions.get(session.id)?.providerSessionId, "native-thread-1");

  const staleRendererCopy = { ...session, model: "updated-model", updatedAt: new Date().toISOString() };
  const upsert = await daemon.gateway.dispatch({ method: "session.upsert", input: staleRendererCopy });
  assert.equal(upsert.ok, true);
  assert.equal(upsert.data.providerSessionId, "native-thread-1");

  const second = await daemon.sessions.send({ sessionId: session.id, text: "follow-up turn" });
  await waitForRun(daemon.database, second.runId);
  assert.equal(starts, 1);
  assert.equal(resumes, 1);
  await daemon.stop();
});

test("message attachments persist, reach the provider, and survive user-message editing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agenthub-attachment-"));
  const imagePath = join(directory, "reference.png");
  await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const requests = [];
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  daemon.adapters.register({
    providerId: "attachment-test",
    supportsStructuredOutput: true,
    supportsResume: true,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: true, pty: false, localImages: true },
    detect: async () => ({ installed: true, executable: "attachment-test" }),
    start: (request) => { requests.push(request); return adapterRun("attachment-thread"); },
    resume: (request) => { requests.push(request); return adapterRun(request.providerSessionId); }
  });
  const project = { id: "attachment-project", name: "Project", rootPath: directory, repositoryType: "none", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default" };
  const agent = { id: "attachment-agent", providerId: "attachment-test", displayName: "Attachment test", executable: "attachment-test", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now };
  const session = { id: "attachment-session", projectId: project.id, memberId: agent.id, agentInstanceId: agent.id, title: "Session", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
  daemon.database.projects.save(project, now);
  daemon.database.agents.save(agent, now);
  daemon.database.sessions.save(session);

  const first = await daemon.sessions.send({ sessionId: session.id, text: "inspect this", attachments: [{ path: imagePath, name: "reference.png", kind: "image", mimeType: "image/png" }] });
  await waitForRun(daemon.database, first.runId);
  const original = daemon.database.sessions.messages(session.id).find((message) => message.sender === "user");
  assert.equal(original.attachmentIds.length, 1);
  assert.deepEqual(requests[0].localImagePaths, [imagePath]);
  assert.match(requests[0].prompt, /agenthub_user_attachments/);

  const second = await daemon.sessions.send({ sessionId: session.id, text: "inspect this more carefully", editMessageId: original.id });
  await waitForRun(daemon.database, second.runId);
  const userMessages = daemon.database.sessions.messages(session.id).filter((message) => message.sender === "user");
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0].text, "inspect this more carefully");
  assert.ok(userMessages[0].editedAt);
  assert.match(requests[1].prompt, /corrected instruction/);

  await daemon.stop();
  await rm(directory, { recursive: true, force: true });
});

test("successive orchestrated chat turns keep one native provider session", async () => {
  let starts = 0;
  const resumedSessionIds = [];
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  daemon.adapters.register({
    providerId: "orchestration-context-test",
    supportsStructuredOutput: true,
    supportsResume: true,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: true, pty: false },
    detect: async () => ({ installed: true, executable: "orchestration-context-test" }),
    start: (request) => {
      starts += 1;
      return orchestrationAdapterRun("native-main-thread", request.prompt);
    },
    resume: (request) => {
      resumedSessionIds.push(request.providerSessionId);
      return orchestrationAdapterRun(request.providerSessionId, request.prompt);
    }
  });

  const project = { id: "orchestration-project", name: "Project", rootPath: process.cwd(), repositoryType: "git", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default" };
  const agent = { id: "orchestration-agent", providerId: "orchestration-context-test", displayName: "Context test", executable: "orchestration-context-test", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now };
  const member = { id: "orchestration-main", displayName: "Main", agentInstanceId: agent.id, roleId: "main", strengths: {}, allowedTaskTypes: [], maxConcurrentTasks: 1, enabled: true };
  const team = { id: "orchestration-team", name: "Team", mainMemberId: member.id, delegationPolicy: "autonomous", members: [member], createdAt: now, updatedAt: now };
  const staleRendererSession = { id: "orchestration-session", projectId: project.id, memberId: agent.id, teamId: team.id, agentInstanceId: agent.id, title: "Chat", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
  daemon.database.projects.save(project, now);
  daemon.database.agents.save(agent, now);
  daemon.database.teams.save(team, now);
  daemon.database.sessions.save(staleRendererSession);

  let sessionId = staleRendererSession.id;
  for (const [index, goal] of ["first request", "follow-up request", "what did I ask first?"].entries()) {
    const beforeUpsert = daemon.database.sessions.get(sessionId);
    if (index > 0) {
      assert.equal(beforeUpsert?.providerSessionId, "native-main-thread");
      assert.equal(beforeUpsert?.projectId, staleRendererSession.projectId);
      assert.equal(beforeUpsert?.agentInstanceId, staleRendererSession.agentInstanceId);
    }
    const upsert = await daemon.gateway.dispatch({
      method: "session.upsert",
      input: { ...staleRendererSession, updatedAt: new Date().toISOString() }
    });
    assert.equal(upsert.ok, true);
    if (index > 0) assert.equal(upsert.data.providerSessionId, "native-main-thread");
    const started = daemon.orchestration.start({ projectId: project.id, teamId: team.id, agentInstanceId: agent.id, sessionId, goal });
    if (index > 0) assert.equal(started.mainSession.providerSessionId, "native-main-thread");
    await daemon.orchestration.wait(started.projectRun.id);
    assert.equal(daemon.database.projectRuns.get(started.projectRun.id)?.status, "completed");
    assert.equal(daemon.database.sessions.get(started.mainSession.id)?.providerSessionId, "native-main-thread");
    sessionId = started.mainSession.id;
  }

  assert.equal(starts, 1);
  assert.deepEqual(resumedSessionIds, Array(5).fill("native-main-thread"));
  assert.equal(daemon.database.sessions.get(sessionId)?.providerSessionId, "native-main-thread");
  await daemon.stop();
});

test("lost provider context is reconstructed from persisted chat and attaches the latest referenced image", () => {
  const imagePath = new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1");
  const context = buildSessionTurnContext({
    currentText: "你觉得这个图片怎么样？",
    recoverProviderContext: true,
    messages: [
      { id: "m1", sessionId: "s1", sender: "user", text: "帮我生成一只小猫和科比打篮球", createdAt: now },
      { id: "m2", sessionId: "s1", sender: "agent", text: "图片已经生成。", createdAt: now }
    ],
    artifacts: [{ id: "a1", kind: "image", name: "generated.png", contentHash: "hash", path: imagePath, sessionId: "s1" }]
  });
  assert.match(context.prompt, /小猫和科比打篮球/);
  assert.match(context.prompt, /generated\.png/);
  assert.equal(context.localImagePaths[0], imagePath);
  assert.equal(context.recovered, true);
});
