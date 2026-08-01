import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterRegistry,
  ApprovalService,
  AuditService,
  CommandPolicyService,
  CoreDaemon,
  CredentialService,
  Database,
  DiagnosticsService,
  EnvironmentPolicyService,
  EventService,
  EventSubscriptionService,
  MetricsService,
  OrchestrationService,
  PathPolicy,
  ProcessRuntime,
  RedactionService,
  RunService
} from "../dist/index.js";

function temporaryDirectory(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function project(id = "project") {
  return { id, name: id, rootPath: process.cwd(), repositoryType: "none", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default" };
}

function session(overrides = {}) {
  const now = new Date().toISOString();
  return { id: "session", projectId: "project", memberId: "main", title: "Session", status: "running", unreadCount: 0, createdAt: now, updatedAt: now, ...overrides };
}

test("B-042 applies safe, approval and blocked command rules", () => {
  const database = new Database(":memory:");
  const policies = new CommandPolicyService(database);
  const now = new Date().toISOString();
  policies.save({
    id: "strict",
    name: "Strict",
    defaultCommandAction: "approval",
    environmentAllowlist: ["PATH"],
    allowedPaths: [],
    commandRules: [
      { id: "safe-node", action: "safe", executable: "node" },
      { id: "block-remove", action: "blocked", executable: "rm" }
    ],
    updatedAt: now
  });
  assert.equal(policies.evaluate({ policyId: "strict", command: process.execPath, source: "system" }).action, "safe");
  assert.equal(policies.evaluate({ policyId: "strict", command: "unknown-tool", source: "system" }).action, "approval");
  assert.equal(policies.evaluate({ policyId: "strict", command: "rm", args: ["-rf", "target"], source: "system" }).action, "blocked");
  assert.equal(policies.evaluate({ command: "git", args: ["push", "--force"], source: "system" }).action, "blocked");
  database.close();
});

test("B-043 rejects symlink or junction traversal outside the workspace", (t) => {
  const root = temporaryDirectory(t, "agenthub-path-root-");
  const outside = temporaryDirectory(t, "agenthub-path-outside-");
  const link = join(root, "escape");
  try {
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`Creating a symlink/junction is unavailable: ${error}`);
    return;
  }
  const violations = new PathPolicy().validate(root, ["escape/secret.txt"], ["**"]);
  assert.deepEqual(violations, ["escape/secret.txt"]);
});

test("B-044 does not inherit unapproved host environment variables", async () => {
  const previous = process.env.AGENTHUB_TEST_HOST_SECRET;
  process.env.AGENTHUB_TEST_HOST_SECRET = "must-not-leak";
  try {
    const environment = new EnvironmentPolicyService().build(undefined);
    assert.equal(environment.AGENTHUB_TEST_HOST_SECRET, undefined);
    const handle = new ProcessRuntime().start({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.AGENTHUB_TEST_HOST_SECRET || 'absent')"],
      env: environment,
      timeoutMs: 5_000
    });
    let output = "";
    for await (const event of handle.events) if (event.kind === "stdout") output += event.text;
    assert.equal(output, "absent");
  } finally {
    if (previous === undefined) delete process.env.AGENTHUB_TEST_HOST_SECRET;
    else process.env.AGENTHUB_TEST_HOST_SECRET = previous;
  }
});

test("B-045 encrypts credentials and redacts events, audit records and diagnostics", async (t) => {
  const dataDir = temporaryDirectory(t, "agenthub-secrets-");
  const databasePath = join(dataDir, "agenthub.sqlite");
  const database = new Database(databasePath);
  const now = new Date().toISOString();
  database.projects.save(project(), now);
  database.agents.save({ id: "agent", providerId: "kimi-code", displayName: "Kimi", executable: "kimi", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now }, now);
  const credentials = new CredentialService(database, dataDir, new AdapterRegistry());
  const secret = "plain-kimi-secret-12345";
  credentials.set("agent", { apiKey: secret });
  assert.equal(credentials.environment("agent", "kimi-code").KIMI_API_KEY, secret);
  assert.doesNotMatch(JSON.stringify(database.credentials.get("agent")), new RegExp(secret));

  const redaction = new RedactionService(() => credentials.secretValues());
  assert.deepEqual(
    redaction.value({ inputTokens: 120, outputTokens: 45, apiToken: secret }),
    { inputTokens: 120, outputTokens: 45, apiToken: "[REDACTED]" }
  );
  const events = new EventService(database, redaction);
  const currentSession = session();
  database.sessions.save(currentSession);
  events.appendForSession(currentSession, {}, "agent.message", { messageId: "message", text: `provider said ${secret}` });
  assert.equal(events.replay({ sessionId: currentSession.id })[0].payload.text, "provider said [REDACTED]");

  const audit = new AuditService(database, redaction);
  audit.record({ actorType: "user", actorId: "tester", action: "secret.test", resourceType: "test", outcome: "success", details: { apiKey: secret, message: secret } });
  assert.doesNotMatch(JSON.stringify(audit.list()), new RegExp(secret));
  const metrics = new MetricsService(database);
  const result = new DiagnosticsService(database, audit, metrics, redaction, dataDir).export();
  assert.doesNotMatch(readFileSync(result.path, "utf8"), new RegExp(secret));
  database.close();
});

test("Codex credentials support app-server custom providers and exec fallback", (t) => {
  const dataDir = temporaryDirectory(t, "agenthub-codex-credentials-");
  const database = new Database(":memory:");
  const credentials = new CredentialService(database, dataDir, new AdapterRegistry());
  const secret = "codex-custom-provider-secret";
  credentials.set("codex-agent", { apiKey: secret });

  assert.deepEqual(credentials.environment("codex-agent", "codex"), {
    OPENAI_API_KEY: secret,
    CODEX_API_KEY: secret
  });
  database.close();
});

test("B-046 enforces once, run, task, project and global approval scopes", () => {
  const database = new Database(":memory:");
  const approvals = new ApprovalService(database);
  const create = (operation, context) => approvals.request({ category: "command", operation, summary: operation, requestedBy: "tester", ...context });

  const once = create("once", {});
  approvals.resolve(once.id, "approved", "once");
  assert.equal(approvals.authorize("once", {}), true);
  assert.equal(approvals.authorize("once", {}), false);

  const run = create("run", { projectRunId: "run-1" });
  approvals.resolve(run.id, "approved", "run");
  assert.equal(approvals.authorize("run", { projectRunId: "run-1" }), true);
  assert.equal(approvals.authorize("run", { projectRunId: "run-2" }), false);

  const task = create("task", { taskId: "task-1" });
  approvals.resolve(task.id, "approved", "task");
  assert.equal(approvals.authorize("task", { taskId: "task-1" }), true);
  assert.equal(approvals.authorize("task", { taskId: "task-2" }), false);

  const scopedProject = create("project", { projectId: "project-1" });
  approvals.resolve(scopedProject.id, "approved", "project");
  assert.equal(approvals.authorize("project", { projectId: "project-1" }), true);
  assert.equal(approvals.authorize("project", { projectId: "project-2" }), false);

  const global = create("global", {});
  approvals.resolve(global.id, "approved", "global");
  assert.equal(approvals.authorize("global", { projectId: "any", projectRunId: "any", taskId: "any" }), true);
  database.close();
});

test("B-047 marks interrupted persisted work as recoverable after daemon restart", async (t) => {
  const dataDir = temporaryDirectory(t, "agenthub-restart-");
  const databasePath = join(dataDir, "agenthub.sqlite");
  const database = new Database(databasePath);
  const now = new Date().toISOString();
  database.projects.save(project(), now);
  database.agents.save({ id: "agent", providerId: "custom", displayName: "Agent", executable: "agent", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now }, now);
  database.teams.save({ id: "team", name: "Team", mainMemberId: "main", delegationPolicy: "autonomous", members: [{ id: "main", displayName: "Main", agentInstanceId: "agent", roleId: "role", strengths: {}, allowedTaskTypes: [], maxConcurrentTasks: 1, enabled: true }], createdAt: now, updatedAt: now }, now);
  database.projectRuns.save({ id: "project-run", projectId: "project", teamId: "team", goal: "Resume me", mainMemberId: "main", mainSessionId: "session", status: "executing", createdAt: now, updatedAt: now });
  database.sessions.save(session({ projectRunId: "project-run", providerSessionId: "provider-session" }));
  database.tasks.save({ id: "task", projectRunId: "project-run", title: "Task", objective: "Work", taskType: "code", assignedMemberId: "main", dependencies: [], allowedPaths: [], acceptanceCriteria: [], status: "running", attempt: 1, priority: 0, createdAt: now, updatedAt: now });
  database.runs.save({ id: "agent-run", projectRunId: "project-run", taskId: "task", sessionId: "session", agentInstanceId: "agent", memberId: "main", mode: "headless_text", status: "running", startedAt: now });
  // Simulate a run that died mid-turn: started, with a dangling tool step,
  // but no terminal event in the log.
  const appendEvent = (eventId, type, payload, sequence) => database.events.append({
    schemaVersion: 1, eventId, sequence, projectId: "project", runId: "agent-run", projectRunId: "project-run", taskId: "task", sessionId: "session", type, timestamp: now, payload
  });
  appendEvent("ev-run-started", "run.started", { runId: "agent-run" }, 1);
  appendEvent("ev-tool-started", "tool.started", { toolName: "Edit", inputSummary: "edit file" }, 2);
  database.close();

  const daemon = new CoreDaemon({ dataDir, databasePath, enableGitWorkflows: false });
  assert.equal(daemon.database.runs.get("agent-run")?.status, "crashed");
  assert.equal(daemon.database.sessions.get("session")?.status, "waiting_input");
  assert.equal(daemon.database.tasks.get("task")?.status, "waiting_user");
  assert.equal(daemon.database.projectRuns.get("project-run")?.status, "paused");
  assert.equal(daemon.recovery.list()[0]?.canResumeProviderSession, true);
  // The dead run gets the terminal event it never emitted, so replayed
  // timelines can settle dangling "running" steps.
  const terminalEvents = daemon.database.events.replay({ sessionId: "session" })
    .filter((event) => (event.type === "run.completed" || event.type === "run.failed") && event.runId === "agent-run");
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].type, "run.failed");
  assert.equal(terminalEvents[0].payload.code, "DAEMON_RESTARTED");
  // Re-running recovery must not append a duplicate terminal event.
  daemon.recovery.recoverInterrupted();
  const afterSecondPass = daemon.database.events.replay({ sessionId: "session" })
    .filter((event) => (event.type === "run.completed" || event.type === "run.failed") && event.runId === "agent-run");
  assert.equal(afterSecondPass.length, 1);
  await daemon.stop();
});

test("B-048 resumes the current main session or creates a replacement main session", async () => {
  const database = new Database(":memory:");
  const now = new Date().toISOString();
  database.projects.save(project(), now);
  for (const id of ["main-agent", "replacement-agent"]) {
    database.agents.save({ id, providerId: "fake", displayName: id, executable: "fake", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now }, now);
  }
  const team = { id: "team", name: "Team", mainMemberId: "main", delegationPolicy: "direct_only", members: [
    { id: "main", displayName: "Main", agentInstanceId: "main-agent", roleId: "main-role", strengths: {}, allowedTaskTypes: [], maxConcurrentTasks: 1, enabled: true },
    { id: "replacement", displayName: "Replacement", agentInstanceId: "replacement-agent", roleId: "replacement-role", strengths: {}, allowedTaskTypes: [], maxConcurrentTasks: 1, enabled: true }
  ], createdAt: now, updatedAt: now };
  database.teams.save(team, now);
  const original = session({ projectRunId: "project-run", providerSessionId: "provider-session" });
  database.sessions.save(original);
  database.projectRuns.save({ id: "project-run", projectId: "project", teamId: team.id, goal: "Recover", mainMemberId: "main", mainSessionId: original.id, status: "paused", createdAt: now, updatedAt: now });

  const adapter = {
    providerId: "fake",
    supportsStructuredOutput: true,
    supportsResume: true,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: true, pty: false },
    detect: async () => ({ installed: true, executable: "fake" }),
    start: (request) => fakeRun(request.prompt),
    resume: (request) => fakeRun(request.prompt)
  };
  const events = new EventService(database);
  const orchestration = new OrchestrationService(database, new RunService(database, new AdapterRegistry([adapter]), events), events);

  const resumed = orchestration.recover("project-run", "main", "resume");
  assert.equal(resumed.mainSessionId, original.id);
  await orchestration.wait("project-run");

  const completed = database.projectRuns.get("project-run");
  database.projectRuns.save({ ...completed, status: "failed", updatedAt: new Date().toISOString() });
  const replaced = orchestration.recover("project-run", "replacement", "replace");
  assert.equal(replaced.mainMemberId, "replacement");
  assert.notEqual(replaced.mainSessionId, original.id);
  assert.equal(database.sessions.get(replaced.mainSessionId)?.parentSessionId, original.id);
  assert.deepEqual(replaced.previousMainMemberIds, ["main", "main"]);
  await orchestration.wait("project-run");
  database.close();
});

test("B-049 replays and immediately delivers newly appended sequenced events", async () => {
  const database = new Database(":memory:");
  const events = new EventService(database);
  const subscriptions = new EventSubscriptionService(events);
  const currentSession = session();
  database.sessions.save(currentSession);
  const subscription = subscriptions.subscribe({ sessionId: currentSession.id });
  events.appendForSession(currentSession, {}, "agent.message", { messageId: "one", text: "one" });
  const first = subscriptions.replay(subscription.subscriptionId, 0);
  events.appendForSession(currentSession, {}, "agent.message", { messageId: "two", text: "two" });
  const missed = subscriptions.replay(subscription.subscriptionId, first.lastSequence);
  assert.deepEqual(missed.events.map((event) => event.payload.text), ["two"]);
  assert.equal(missed.lastSequence, 2);
  const waiting = subscriptions.wait(subscription.subscriptionId, missed.lastSequence, 1_000);
  queueMicrotask(() => events.appendForSession(currentSession, {}, "agent.message_delta", { messageId: "three", text: "thr" }));
  const streamed = await waiting;
  assert.equal(streamed.events[0]?.type, "agent.message_delta");
  assert.equal(streamed.events[0]?.payload.text, "thr");
  assert.equal(streamed.lastSequence, 3);
  assert.throws(
    () => subscriptions.replay(JSON.stringify({ sessionId: currentSession.id }), 0),
    (error) => error?.descriptor?.code === "IPC_NOT_FOUND"
  );
  database.close();
});

test("B-050 audits IPC actions with outcomes and redacted inputs", async (t) => {
  const dataDir = temporaryDirectory(t, "agenthub-audit-");
  const daemon = new CoreDaemon({ dataDir, enableGitWorkflows: false });
  await daemon.gateway.dispatch({ method: "credential.set", input: { agentInstanceId: "agent", apiKey: "audit-secret-value" } });
  await daemon.gateway.dispatch({ method: "health.get", input: undefined });
  const records = daemon.audit.list({ limit: 10 });
  assert.ok(records.some((record) => record.action === "ipc.health.get" && record.outcome === "success"));
  assert.doesNotMatch(JSON.stringify(records), /audit-secret-value/);
  await daemon.stop();
});

test("B-051 computes persisted run, retry, conflict and verification metrics", () => {
  const database = new Database(":memory:");
  const now = new Date().toISOString();
  database.projects.save(project(), now);
  database.projectRuns.save({ id: "project-run", projectId: "project", goal: "Metrics", mainMemberId: "main", status: "completed", createdAt: now, updatedAt: now });
  const currentSession = session({ projectRunId: "project-run" });
  database.sessions.save(currentSession);
  database.runs.save({ id: "completed", projectRunId: "project-run", sessionId: currentSession.id, agentInstanceId: "agent", mode: "headless_text", status: "completed", startedAt: new Date(Date.now() - 1_000).toISOString(), endedAt: new Date().toISOString() });
  database.runs.save({ id: "failed", projectRunId: "project-run", sessionId: currentSession.id, agentInstanceId: "agent", mode: "headless_text", status: "failed", startedAt: new Date(Date.now() - 500).toISOString(), endedAt: new Date().toISOString() });
  database.tasks.save({ id: "task", projectRunId: "project-run", title: "Task", objective: "Retry", taskType: "code", dependencies: [], allowedPaths: [], acceptanceCriteria: [], status: "completed", attempt: 2, priority: 0, createdAt: now, updatedAt: now });
  database.verifications.save({ id: "verification", projectRunId: "project-run", commandTemplateId: "test", command: "test", args: [], cwd: process.cwd(), passed: true, required: true, exitCode: 0, durationMs: 10, createdAt: now });
  new EventService(database).appendForSession(currentSession, { projectRunId: "project-run" }, "git.conflict", { sourceBranch: "task", targetBranch: "main", paths: ["file"], taskId: "task" });
  const metrics = new MetricsService(database).snapshot("project");
  assert.deepEqual({ total: metrics.totalRuns, completed: metrics.completedRuns, failed: metrics.failedRuns, retried: metrics.retriedTasks, conflicts: metrics.conflicts, verification: metrics.verificationPassed }, { total: 2, completed: 1, failed: 1, retried: 1, conflicts: 1, verification: 1 });
  assert.ok(metrics.averageRunDurationMs >= 500);
  database.close();
});

test("B-052 exports a user-readable diagnostic bundle", (t) => {
  const dataDir = temporaryDirectory(t, "agenthub-diagnostics-");
  const database = new Database(join(dataDir, "agenthub.sqlite"));
  const redaction = new RedactionService();
  const audit = new AuditService(database, redaction);
  audit.record({ actorType: "system", actorId: "test", action: "diagnostic.ready", resourceType: "test", outcome: "success" });
  const exported = new DiagnosticsService(database, audit, new MetricsService(database), redaction, dataDir).export();
  const payload = JSON.parse(readFileSync(exported.path, "utf8"));
  assert.equal(payload.schemaVersion, 1);
  assert.ok(Array.isArray(payload.audit));
  assert.equal(exported.auditCount, 1);
  database.close();
});

function fakeRun(prompt) {
  async function* events() {
    yield { kind: "session", providerSessionId: "resumed-provider-session" };
    yield { kind: "message", text: prompt.includes("[AGENTHUB_PLANNER_DECISION]") ? JSON.stringify({ mode: "direct", rationale: "Recovered main handles it" }) : "Recovered work completed" };
    yield { kind: "exit", exitCode: 0 };
  }
  return { process: {}, events: events(), cancel: async () => {}, write: () => {} };
}
