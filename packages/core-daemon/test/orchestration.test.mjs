import test from "node:test";
import assert from "node:assert/strict";
import {
  AdapterRegistry,
  CoreDaemon,
  Database,
  EventService,
  OrchestrationService,
  RunService,
  SessionService
} from "../dist/index.js";

const now = new Date().toISOString();

function plannedTask(id, assignedMemberId, dependencies = []) {
  return {
    id,
    title: `Task ${id}`,
    objective: `Complete ${id}`,
    taskType: "code",
    assignedMemberId,
    dependencies,
    allowedPaths: [],
    acceptanceCriteria: [],
    contextNeeds: [],
    assignmentReason: "configured member"
  };
}

function adapterRun(response, agentId) {
  async function* events() {
    yield { kind: "session", providerSessionId: `${agentId}-session` };
    if (response.waitFor) await response.waitFor;
    if (response.text) yield { kind: "message", text: response.text };
    yield { kind: "exit", exitCode: response.exitCode ?? 0 };
  }
  return { process: {}, events: events(), cancel: async () => {}, write: () => {} };
}

function setup({ policy = "autonomous", responder, disabledChild = false, disabledOther = false }) {
  const prompts = [];
  const counts = new Map();
  const adapter = {
    providerId: "fake",
    supportsStructuredOutput: true,
    supportsResume: true,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: true, pty: false },
    detect: async () => ({ installed: true, executable: "fake" }),
    start: (request) => respond(request, "start"),
    resume: (request) => respond(request, "resume")
  };
  function respond(request, transport) {
    prompts.push({
      agentId: request.instance.id,
      prompt: request.prompt,
      transport,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      serviceTier: request.serviceTier
    });
    const key = `${request.instance.id}:${request.prompt.match(/\[AGENTHUB_[A-Z_]+\]/)?.[0] ?? "unknown"}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return adapterRun(responder(request, count, prompts), request.instance.id);
  }

  const database = new Database(":memory:");
  database.projects.save({ id: "project", name: "Project", rootPath: process.cwd(), repositoryType: "git", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default" }, now);
  for (const id of ["agent-main", "agent-child", "agent-other"]) {
    const disabled = (id === "agent-child" && disabledChild) || (id === "agent-other" && disabledOther);
    database.agents.save({ id, providerId: "fake", displayName: id, executable: "fake", baseArgs: [], capabilities: [], enabled: !disabled, status: disabled ? "disabled" : "available", createdAt: now, updatedAt: now }, now);
  }
  const members = [
    { id: "main", displayName: "User Main", agentInstanceId: "agent-main", roleId: "role-main", strengths: {}, allowedTaskTypes: [], maxConcurrentTasks: 1, enabled: true },
    { id: "child", displayName: "User Child", agentInstanceId: "agent-child", model: "child-model", reasoningEffort: "high", serviceTier: "priority", roleId: "role-child", strengths: {}, allowedTaskTypes: ["code"], maxConcurrentTasks: 1, enabled: !disabledChild },
    { id: "other", displayName: "User Other", agentInstanceId: "agent-other", roleId: "role-other", strengths: {}, allowedTaskTypes: ["code"], maxConcurrentTasks: 1, enabled: !disabledOther }
  ];
  const team = { id: "team", name: "User Team", mainMemberId: "main", delegationPolicy: policy, members, createdAt: now, updatedAt: now };
  database.teams.save(team, now);
  const registry = new AdapterRegistry([adapter]);
  const events = new EventService(database);
  const runs = new RunService(database, registry, events);
  const orchestration = new OrchestrationService(database, runs, events);
  return { database, orchestration, prompts, team, runs };
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function waitForRun(database, runId) {
  await waitUntil(
    () => ["completed", "failed", "timed_out", "cancelled", "crashed"].includes(database.runs.get(runId)?.status),
    `run ${runId} did not finish`
  );
  return database.runs.get(runId);
}

test("direct lets the main Agent finish without creating child tasks", async () => {
  const fixture = setup({
    responder: ({ prompt }) => prompt.includes("[AGENTHUB_PLANNER_DECISION]")
      ? { text: JSON.stringify({ mode: "direct", rationale: "I can handle this" }) }
      : { text: "Direct work finished" }
  });
  const started = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "Do it" });
  await fixture.orchestration.wait(started.projectRun.id);
  assert.equal(fixture.database.projectRuns.get(started.projectRun.id)?.status, "completed");
  assert.equal(fixture.database.tasks.list(started.projectRun.id).length, 0);
  assert.deepEqual(fixture.prompts.map((entry) => entry.prompt.match(/\[AGENTHUB_[A-Z_]+\]/)?.[0]), ["[AGENTHUB_PLANNER_DECISION]", "[AGENTHUB_DIRECT_EXECUTION]"]);
  fixture.database.close();
});

test("delegate creates a child session and returns the child result to the main session", async () => {
  const fixture = setup({
    responder: ({ prompt }) => {
      if (prompt.includes("[AGENTHUB_PLANNER_DECISION]")) return { text: JSON.stringify({ mode: "delegate", rationale: "Use configured child", task: plannedTask("t1", "child") }) };
      if (prompt.includes("[AGENTHUB_DELEGATED_TASK]")) return { text: "Child implementation result" };
      return { text: "Final synthesis" };
    }
  });
  const started = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "Delegate one part" });
  await fixture.orchestration.wait(started.projectRun.id);
  const task = fixture.database.tasks.get("t1");
  assert.equal(task?.status, "completed");
  const childSession = fixture.database.sessions.list("project", "child").find((session) => session.projectRunId === started.projectRun.id);
  assert.equal(childSession?.parentSessionId, started.mainSession.id);
  assert.equal(childSession?.model, "child-model");
  assert.equal(childSession?.reasoningEffort, "high");
  assert.equal(childSession?.serviceTier, "priority");
  const childRequest = fixture.prompts.find((entry) => entry.agentId === "agent-child" && entry.prompt.includes("[AGENTHUB_DELEGATED_TASK]"));
  assert.equal(childRequest?.model, "child-model");
  assert.equal(childRequest?.reasoningEffort, "high");
  assert.equal(childRequest?.serviceTier, "priority");
  const mainMessages = fixture.database.sessions.messages(started.mainSession.id);
  assert.ok(mainMessages.some((message) => message.kind === "result" && message.fromMemberId === "child" && message.text.includes("Child implementation")));
  assert.ok(fixture.database.events.replay({ sessionId: started.mainSession.id }).some((event) => event.type === "handoff.created" && event.payload.toMemberId === "child"));
  assert.deepEqual(fixture.prompts.map((entry) => entry.prompt.match(/\[AGENTHUB_[A-Z_]+\]/)?.[0]), ["[AGENTHUB_PLANNER_DECISION]", "[AGENTHUB_DELEGATED_TASK]", "[AGENTHUB_DELEGATION_ACCEPTED]", "[AGENTHUB_FINAL_SYNTHESIS]"]);
  assert.match(fixture.prompts.at(-1).prompt, /Child implementation result/);
  fixture.database.close();
});

test("the parent Agent continues immediately after a child run is accepted", async () => {
  let releaseChild;
  const childGate = new Promise((resolve) => { releaseChild = resolve; });
  let childStarted;
  const childStartedPromise = new Promise((resolve) => { childStarted = resolve; });
  const fixture = setup({
    responder: ({ prompt }) => {
      if (prompt.includes("[AGENTHUB_PLANNER_DECISION]")) {
        return { text: JSON.stringify({ mode: "delegate", memberId: "child", task: "Long child task" }) };
      }
      if (prompt.includes("[AGENTHUB_DELEGATED_TASK]")) {
        childStarted();
        return { text: "child finished", waitFor: childGate };
      }
      if (prompt.includes("[AGENTHUB_DELEGATION_ACCEPTED]")) return { text: "Child accepted; I can keep working." };
      if (prompt === "main follow-up while child works") return { text: "Main follow-up answered before the child finished." };
      return { text: "final synthesis" };
    }
  });
  const sessions = new SessionService(fixture.database, fixture.runs);
  const started = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "Use a background child" });
  await childStartedPromise;
  await waitUntil(
    () => fixture.prompts.some((entry) => entry.prompt.includes("[AGENTHUB_DELEGATION_ACCEPTED]")),
    "parent did not receive a dispatch receipt"
  );
  await waitUntil(
    () => fixture.database.sessions.messages(started.mainSession.id).some((message) => message.text.includes("Child accepted")),
    "parent did not continue after dispatch"
  );
  assert.equal(fixture.database.tasks.list(started.projectRun.id)[0]?.status, "running");
  assert.equal(fixture.database.sessions.get(started.mainSession.id)?.status, "completed");

  const followUp = await sessions.send({ sessionId: started.mainSession.id, text: "main follow-up while child works" });
  assert.equal((await waitForRun(fixture.database, followUp.runId))?.status, "completed");
  assert.equal(fixture.database.tasks.list(started.projectRun.id)[0]?.status, "running");
  assert.ok(fixture.database.sessions.messages(started.mainSession.id).some((message) => message.text.includes("answered before the child finished")));

  releaseChild();
  await fixture.orchestration.wait(started.projectRun.id);
  assert.equal(fixture.database.projectRuns.get(started.projectRun.id)?.status, "completed");
  fixture.database.close();
});

test("the main Agent can choose to continue an existing child session", async () => {
  let plannerCalls = 0;
  let childSessionId;
  const fixture = setup({
    responder: ({ prompt }) => {
      if (prompt.includes("[AGENTHUB_PLANNER_DECISION]")) {
        plannerCalls += 1;
        return plannerCalls === 1
          ? { text: JSON.stringify({ mode: "delegate", memberId: "child", task: "First child task" }) }
          : { text: JSON.stringify({ mode: "delegate", memberId: "child", task: "Follow up in context", continueSessionId: childSessionId }) };
      }
      if (prompt.includes("[AGENTHUB_DELEGATED_TASK]")) return { text: plannerCalls === 1 ? "first result" : "follow-up result" };
      return { text: "final" };
    }
  });

  const first = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "First request" });
  await fixture.orchestration.wait(first.projectRun.id);
  childSessionId = fixture.database.sessions.list("project", "child").find((session) => session.projectRunId === first.projectRun.id)?.id;
  assert.ok(childSessionId);

  const second = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "Follow-up request", sessionId: first.mainSession.id });
  await fixture.orchestration.wait(second.projectRun.id);
  const childSessions = fixture.database.sessions.list("project", "child");
  assert.equal(childSessions.length, 1);
  assert.equal(childSessions[0].id, childSessionId);
  assert.equal(childSessions[0].projectRunId, second.projectRun.id);
  assert.match(fixture.prompts.find((entry) => entry.prompt.includes("Follow-up request") && entry.prompt.includes("[AGENTHUB_PLANNER_DECISION]"))?.prompt ?? "", new RegExp(childSessionId));
  const childRuns = fixture.prompts.filter((entry) => entry.agentId === "agent-child" && entry.prompt.includes("[AGENTHUB_DELEGATED_TASK]"));
  assert.deepEqual(childRuns.map((entry) => entry.transport), ["start", "resume"]);
  fixture.database.close();
});

test("a new main session cannot discover or continue another main session's child", async () => {
  let oldChildSessionId;
  const fixture = setup({
    responder: ({ prompt }) => {
      if (prompt.includes("[AGENTHUB_PLANNER_DECISION]")) {
        if (prompt.includes("First main request")) {
          return { text: JSON.stringify({ mode: "delegate", memberId: "child", task: "First child task" }) };
        }
        return {
          text: JSON.stringify({
            mode: "delegate",
            memberId: "child",
            task: "Illegally continue an unrelated child",
            continueSessionId: oldChildSessionId
          })
        };
      }
      if (prompt.includes("[AGENTHUB_DELEGATED_TASK]")) return { text: "child result" };
      return { text: "main continuation" };
    }
  });

  const first = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "First main request" });
  await fixture.orchestration.wait(first.projectRun.id);
  const oldChild = fixture.database.sessions.list("project", "child")
    .find((session) => session.parentSessionId === first.mainSession.id);
  assert.ok(oldChild);
  oldChildSessionId = oldChild.id;

  const second = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "Independent new main request" });
  assert.notEqual(second.mainSession.id, first.mainSession.id);
  await fixture.orchestration.wait(second.projectRun.id);

  const secondPlanningPrompt = fixture.prompts.findLast(
    (entry) => entry.prompt.includes("[AGENTHUB_PLANNER_DECISION]") && entry.prompt.includes("Independent new main request")
  )?.prompt ?? "";
  assert.doesNotMatch(secondPlanningPrompt, new RegExp(oldChildSessionId));
  assert.equal(fixture.database.projectRuns.get(second.projectRun.id)?.status, "failed");
  assert.equal(fixture.database.sessions.get(oldChildSessionId)?.parentSessionId, first.mainSession.id);
  assert.ok(
    fixture.database.sessions.messages(second.mainSession.id)
      .some((message) => message.text.includes("PLAN_SCHEMA_INVALID"))
  );
  fixture.database.close();
});

test("a new orchestration turn receives persisted chat and delegated artifacts", async () => {
  const fixture = setup({
    responder: ({ prompt }) => prompt.includes("[AGENTHUB_PLANNER_DECISION]")
      ? { text: JSON.stringify({ mode: "direct" }) }
      : { text: "Generated the requested kitten image at outputs/latest-kitten.png" }
  });
  const first = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "Generate a kitten image" });
  await fixture.orchestration.wait(first.projectRun.id);
  fixture.database.artifacts.save({
    id: "image-1",
    kind: "image",
    name: "latest-kitten.png",
    contentHash: "hash",
    path: "outputs/latest-kitten.png",
    projectRunId: first.projectRun.id,
    sessionId: "delegated-child-session"
  });

  const second = fixture.orchestration.start({
    projectId: "project",
    teamId: "team",
    sessionId: first.mainSession.id,
    goal: "你觉得这张图片怎么样？"
  });
  await fixture.orchestration.wait(second.projectRun.id);
  const planningPrompt = fixture.prompts.findLast((entry) => entry.prompt.includes("[AGENTHUB_PLANNER_DECISION]"))?.prompt ?? "";
  assert.match(planningPrompt, /agenthub_conversation_continuity/);
  assert.match(planningPrompt, /latest-kitten\.png/);
  assert.doesNotMatch(planningPrompt, /Generated the requested kitten image/);
  fixture.database.close();
});

test("compact delegate decisions are expanded into internal tasks", async () => {
  const fixture = setup({
    responder: ({ prompt }) => {
      if (prompt.includes("[AGENTHUB_PLANNER_DECISION]")) {
        return { text: JSON.stringify({ mode: "delegate", memberId: "child", task: "Generate the requested image", reason: "The configured child is the image specialist" }) };
      }
      if (prompt.includes("[AGENTHUB_DELEGATED_TASK]")) return { text: "image generated" };
      if (prompt.includes("[AGENTHUB_CHILD_RESULT]")) return { text: "ack" };
      return { text: "final" };
    }
  });
  const started = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "Generate an image" });
  await fixture.orchestration.wait(started.projectRun.id);
  const task = fixture.database.tasks.get("task-1");
  assert.equal(task?.assignedMemberId, "child");
  assert.equal(task?.objective, "Generate the requested image");
  assert.equal(task?.taskType, "code");
  assert.equal(task?.status, "completed");
  fixture.database.close();
});

test("legacy planner output with string acceptance criteria is safely normalized", async () => {
  const fixture = setup({
    disabledOther: true,
    responder: ({ prompt }) => {
      if (prompt.includes("[AGENTHUB_PLANNER_DECISION]")) {
        return { text: JSON.stringify({
          mode: "delegate",
          rationale: "Use the only enabled specialist",
          task: {
            id: "image-task",
            title: "Generate image",
            objective: "Generate a kitten drinking water",
            taskType: "code",
            assignedMemberId: "chil",
            dependencies: [],
            allowedPaths: ["outputs/"],
            acceptanceCriteria: ["A clear image is generated"],
            contextNeeds: [],
            assignmentReason: "Image specialist"
          }
        }) };
      }
      if (prompt.includes("[AGENTHUB_DELEGATED_TASK]")) return { text: "image generated" };
      if (prompt.includes("[AGENTHUB_CHILD_RESULT]")) return { text: "ack" };
      return { text: "final" };
    }
  });
  const started = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "Generate an image" });
  await fixture.orchestration.wait(started.projectRun.id);
  const task = fixture.database.tasks.get("image-task");
  assert.equal(task?.assignedMemberId, "child");
  assert.deepEqual(task?.acceptanceCriteria, [{ id: "image-task-criterion-1", description: "A clear image is generated", required: true }]);
  assert.equal(task?.status, "completed");
  fixture.database.close();
});

test("plan validates and executes an acyclic dependency graph in order", async () => {
  const fixture = setup({
    responder: ({ prompt }) => {
      if (prompt.includes("[AGENTHUB_PLANNER_DECISION]")) return { text: JSON.stringify({ mode: "plan", rationale: "Two dependent tasks", tasks: [plannedTask("first", "child"), plannedTask("second", "other", ["first"])] }) };
      if (prompt.includes("[AGENTHUB_DELEGATED_TASK]")) return { text: prompt.includes('"id": "first"') ? "first done" : "second done" };
      if (prompt.includes("[AGENTHUB_CHILD_RESULT]")) return { text: "ack" };
      return { text: "final" };
    }
  });
  const started = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "Use a DAG" });
  await fixture.orchestration.wait(started.projectRun.id);
  assert.deepEqual(fixture.database.tasks.list(started.projectRun.id).map((task) => [task.id, task.status]), [["first", "completed"], ["second", "completed"]]);
  const delegatedPrompts = fixture.prompts.filter((entry) => entry.prompt.includes("[AGENTHUB_DELEGATED_TASK]"));
  assert.ok(delegatedPrompts[0].prompt.includes('"id": "first"'));
  assert.ok(delegatedPrompts[1].prompt.includes('"id": "second"'));
  fixture.database.close();
});

test("ask_before_delegate waits for approval before starting a child", async () => {
  const fixture = setup({
    policy: "ask_before_delegate",
    responder: ({ prompt }) => {
      if (prompt.includes("[AGENTHUB_PLANNER_DECISION]")) return { text: JSON.stringify({ mode: "delegate", rationale: "Ask first", task: plannedTask("approval-task", "child") }) };
      if (prompt.includes("[AGENTHUB_DELEGATED_TASK]")) return { text: "approved work" };
      if (prompt.includes("[AGENTHUB_CHILD_RESULT]")) return { text: "ack" };
      return { text: "final" };
    }
  });
  const started = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "Approval required" });
  await fixture.orchestration.wait(started.projectRun.id);
  assert.equal(fixture.database.projectRuns.get(started.projectRun.id)?.status, "waiting_user");
  assert.equal(fixture.database.tasks.get("approval-task")?.status, "waiting_approval");
  assert.equal(fixture.prompts.filter((entry) => entry.prompt.includes("[AGENTHUB_DELEGATED_TASK]")).length, 0);
  fixture.orchestration.resolveDelegation(started.projectRun.id, true);
  await fixture.orchestration.wait(started.projectRun.id);
  assert.equal(fixture.database.projectRuns.get(started.projectRun.id)?.status, "completed");
  fixture.database.close();
});

test("direct_only and enabled-member routing reject unauthorized decisions", async () => {
  for (const options of [{ policy: "direct_only", disabledChild: false }, { policy: "autonomous", disabledChild: true }]) {
    const fixture = setup({
      ...options,
      responder: ({ prompt }) => prompt.includes("[AGENTHUB_PLANNER_DECISION]")
        ? { text: JSON.stringify({ mode: "delegate", rationale: "invalid", task: plannedTask("invalid", "child") }) }
        : { text: "unused" }
    });
    const started = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "Invalid route" });
    await fixture.orchestration.wait(started.projectRun.id);
    assert.equal(fixture.database.projectRuns.get(started.projectRun.id)?.status, "failed");
    assert.equal(fixture.database.tasks.list(started.projectRun.id).length, 0);
    fixture.database.close();
  }
});

test("failed child can be retried by the main Agent", async () => {
  let attempts = 0;
  const fixture = setup({
    responder: ({ prompt }) => {
      if (prompt.includes("[AGENTHUB_PLANNER_DECISION]")) return { text: JSON.stringify({ mode: "delegate", rationale: "delegate", task: plannedTask("retry-task", "child") }) };
      if (prompt.includes("[AGENTHUB_DELEGATED_TASK]")) return ++attempts === 1 ? { text: "first failure", exitCode: 1 } : { text: "retry passed" };
      if (prompt.includes("[AGENTHUB_RECOVERY_DECISION]")) return { text: JSON.stringify({ action: "retry", taskId: "retry-task", rationale: "transient failure" }) };
      if (prompt.includes("[AGENTHUB_CHILD_RESULT]")) return { text: "ack" };
      return { text: "final" };
    }
  });
  const started = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "Retry failures" });
  await fixture.orchestration.wait(started.projectRun.id);
  assert.equal(fixture.database.tasks.get("retry-task")?.attempt, 2);
  assert.equal(fixture.database.tasks.get("retry-task")?.status, "completed");
  assert.ok(fixture.database.events.replay({ sessionId: started.mainSession.id }).some((event) => event.type === "recovery.decision" && event.payload.action === "retry"));
  fixture.database.close();
});

test("failed child can be taken over or skipped by the main Agent", async (context) => {
  await context.test("take_over", async () => {
    const fixture = setup({
      responder: ({ prompt }) => {
        if (prompt.includes("[AGENTHUB_PLANNER_DECISION]")) return { text: JSON.stringify({ mode: "delegate", rationale: "delegate", task: plannedTask("takeover-task", "child") }) };
        if (prompt.includes("[AGENTHUB_DELEGATED_TASK]")) return { text: "failed", exitCode: 1 };
        if (prompt.includes("[AGENTHUB_RECOVERY_DECISION]")) return { text: JSON.stringify({ action: "take_over", taskId: "takeover-task", rationale: "main can finish" }) };
        if (prompt.includes("[AGENTHUB_TAKE_OVER]")) return { text: "main completed it" };
        return { text: "final" };
      }
    });
    const started = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "Take over" });
    await fixture.orchestration.wait(started.projectRun.id);
    assert.equal(fixture.database.tasks.get("takeover-task")?.status, "completed");
    assert.equal(fixture.database.tasks.get("takeover-task")?.completedByMemberId, started.projectRun.mainMemberId);
    fixture.database.close();
  });

  await context.test("continue", async () => {
    const fixture = setup({
      responder: ({ prompt }) => {
        if (prompt.includes("[AGENTHUB_PLANNER_DECISION]")) return { text: JSON.stringify({ mode: "plan", rationale: "continue independent work", tasks: [plannedTask("failed", "child"), plannedTask("dependent", "other", ["failed"]), plannedTask("independent", "other")] }) };
        if (prompt.includes("[AGENTHUB_DELEGATED_TASK]")) return prompt.includes('"id": "failed"') ? { text: "failed", exitCode: 1 } : { text: "independent done" };
        if (prompt.includes("[AGENTHUB_RECOVERY_DECISION]")) return { text: JSON.stringify({ action: "continue", taskId: "failed", rationale: "skip nonessential task" }) };
        if (prompt.includes("[AGENTHUB_CHILD_RESULT]")) return { text: "ack" };
        return { text: "final" };
      }
    });
    const started = fixture.orchestration.start({ projectId: "project", teamId: "team", goal: "Continue independent work" });
    await fixture.orchestration.wait(started.projectRun.id);
    assert.equal(fixture.database.tasks.get("failed")?.status, "failed");
    assert.equal(fixture.database.tasks.get("dependent")?.status, "cancelled");
    assert.equal(fixture.database.tasks.get("independent")?.status, "completed");
    assert.deepEqual(fixture.database.projectRuns.get(started.projectRun.id)?.acceptedTaskFailures, ["failed"]);
    assert.equal(fixture.database.projectRuns.get(started.projectRun.id)?.status, "completed");
    fixture.database.close();
  });
});

test("desktop-facing IPC persists configuration and drives a real orchestration run", async () => {
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  const adapter = {
    providerId: "fake-ipc",
    supportsStructuredOutput: true,
    supportsResume: false,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: false, pty: false },
    detect: async () => ({ installed: true, executable: "fake" }),
    start: (request) => adapterRun({ text: request.prompt.includes("[AGENTHUB_PLANNER_DECISION]") ? JSON.stringify({ mode: "direct", rationale: "IPC direct" }) : "IPC execution complete" }, request.instance.id)
  };
  daemon.adapters.register(adapter);
  const project = { id: "ipc-project", name: "IPC", rootPath: process.cwd(), repositoryType: "git", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default" };
  const agent = { id: "ipc-agent", providerId: "fake-ipc", displayName: "IPC Agent", executable: "fake", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now };
  const team = { id: "ipc-team", name: "IPC Team", mainMemberId: "ipc-main", delegationPolicy: "autonomous", members: [{ id: "ipc-main", displayName: "IPC Main", agentInstanceId: agent.id, roleId: "ipc-role", strengths: {}, allowedTaskTypes: [], maxConcurrentTasks: 1, enabled: true }], createdAt: now, updatedAt: now };
  for (const [method, input] of [["project.upsert", project], ["agent.upsert", agent], ["team.upsert", team]]) {
    const response = await daemon.gateway.dispatch({ method, input });
    assert.equal(response.ok, true, `${method} should be registered`);
  }
  const [projects, agents, teams, inspection, detection] = await Promise.all([
    daemon.gateway.dispatch({ method: "project.list", input: undefined }),
    daemon.gateway.dispatch({ method: "agent.list", input: undefined }),
    daemon.gateway.dispatch({ method: "team.list", input: undefined }),
    daemon.gateway.dispatch({ method: "project.scan", input: { projectId: project.id } }),
    daemon.gateway.dispatch({ method: "provider.detect", input: { providerId: "fake-ipc", executable: "fake" } })
  ]);
  assert.equal(projects.ok && projects.data.length, 1);
  assert.equal(agents.ok && agents.data.length, 1);
  assert.equal(teams.ok && teams.data.length, 1);
  assert.equal(inspection.ok && inspection.data.inspection.git.isRepo, true);
  assert.equal(detection.ok && detection.data.installed, true);
  const started = await daemon.gateway.dispatch({ method: "orchestration.start", input: { projectId: project.id, teamId: team.id, goal: "Run through IPC" } });
  assert.equal(started.ok, true);
  await daemon.orchestration.wait(started.data.projectRun.id);
  const fetched = await daemon.gateway.dispatch({ method: "projectRun.get", input: { projectRunId: started.data.projectRun.id } });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.data.projectRun.status, "completed");
  await daemon.stop();
});
