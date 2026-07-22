import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterRegistry,
  Database,
  EventService,
  GitRepositoryService,
  GitWorkflowService,
  OrchestrationService,
  RunService,
  VerificationEngine
} from "../dist/index.js";

function git(cwd, ...args) {
  return execFileSync("git", ["--no-pager", "-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function createFixture(t, verificationTemplates = []) {
  const root = mkdtempSync(join(tmpdir(), "agenthub-git-workflow-"));
  const repositoryPath = join(root, "repository");
  const worktreeRoot = join(root, "worktrees");
  mkdirSync(join(repositoryPath, "src"), { recursive: true });
  git(root, "init", "-b", "main", repositoryPath);
  writeFileSync(join(repositoryPath, "src", "shared.txt"), "base\n", "utf8");
  git(repositoryPath, "add", ".");
  git(repositoryPath, "-c", "user.name=AgentHub Test", "-c", "user.email=test@agenthub.local", "commit", "-m", "initial");

  const database = new Database(":memory:");
  const now = new Date().toISOString();
  const project = {
    id: "project",
    name: "Project",
    rootPath: repositoryPath,
    repositoryType: "git",
    defaultBranch: "main",
    frontendPaths: [],
    backendPaths: ["src/**"],
    ignoredPaths: [],
    policyId: "default",
    verificationTemplates
  };
  database.projects.save(project, now);
  const events = new EventService(database);
  const workflow = new GitWorkflowService(database, events, worktreeRoot);
  const projectRun = {
    id: "run-1",
    projectId: project.id,
    goal: "Implement isolated change",
    mainMemberId: "main",
    mainSessionId: "session-main",
    status: "executing",
    createdAt: now,
    updatedAt: now
  };
  const mainSession = {
    id: "session-main",
    projectId: project.id,
    memberId: "main",
    projectRunId: projectRun.id,
    title: "Main",
    status: "running",
    unreadCount: 0,
    createdAt: now,
    updatedAt: now
  };
  const taskSession = {
    ...mainSession,
    id: "session-task",
    memberId: "worker",
    parentSessionId: mainSession.id,
    taskId: "task-1",
    title: "Task"
  };
  database.sessions.save(mainSession);
  database.sessions.save(taskSession);

  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repositoryPath, database, events, workflow, project, projectRun, mainSession, taskSession };
}

function plannedTask(now = new Date().toISOString(), overrides = {}) {
  return {
    id: "task-1",
    projectRunId: "run-1",
    title: "Change source",
    objective: "Update source safely",
    taskType: "code",
    assignedMemberId: "worker",
    dependencies: [],
    allowedPaths: ["src/**"],
    acceptanceCriteria: [],
    status: "running",
    attempt: 1,
    priority: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("B-032 detects branch, default branch, HEAD and dirty paths", async (t) => {
  const fixture = createFixture(t);
  const repositories = new GitRepositoryService();
  const clean = await repositories.inspect(fixture.repositoryPath);
  assert.equal(clean.branch, "main");
  assert.equal(clean.defaultBranch, "main");
  assert.match(clean.headCommit, /^[0-9a-f]{40}$/);
  assert.deepEqual(clean.dirtyPaths, []);

  writeFileSync(join(fixture.repositoryPath, "src", "dirty.txt"), "dirty\n", "utf8");
  const dirty = await repositories.inspect(fixture.repositoryPath);
  assert.deepEqual(dirty.dirtyPaths, ["src/dirty.txt"]);
});

test("Git is optional: an unborn repository runs in the project directory without creating a commit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agenthub-git-optional-"));
  const repositoryPath = join(root, "repository");
  const worktreeRoot = join(root, "worktrees");
  mkdirSync(repositoryPath, { recursive: true });
  git(root, "init", "-b", "main", repositoryPath);
  writeFileSync(join(repositoryPath, "uncommitted.txt"), "keep uncommitted\n", "utf8");

  const database = new Database(":memory:");
  const now = new Date().toISOString();
  const project = { id: "unborn-project", name: "Unborn", rootPath: repositoryPath, repositoryType: "git", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default", verificationTemplates: [] };
  const projectRun = { id: "unborn-run", projectId: project.id, goal: "Handle a non-Git-dependent task", mainMemberId: "main", mainSessionId: "unborn-session", status: "executing", createdAt: now, updatedAt: now };
  const session = { id: "unborn-session", projectId: project.id, memberId: "main", projectRunId: projectRun.id, title: "Main", status: "running", unreadCount: 0, createdAt: now, updatedAt: now };
  database.projects.save(project, now);
  database.sessions.save(session);
  const workflow = new GitWorkflowService(database, new EventService(database), worktreeRoot);

  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  const repository = await new GitRepositoryService().inspect(repositoryPath);
  assert.equal(repository.headCommit, undefined);
  const run = await workflow.initializeRun(projectRun);
  assert.equal(run.workspacePath, repositoryPath);
  assert.equal(run.branchName, undefined);
  assert.equal(run.baseCommit, undefined);

  const task = await workflow.initializeTask(run, plannedTask(now, { projectRunId: run.id }));
  assert.equal(task.workspacePath, repositoryPath);
  assert.equal(task.branchName, undefined);
  const finalized = await workflow.finalizeRun(run, session);
  assert.equal(finalized.needsMergeApproval, false);
  assert.equal(finalized.projectRun.resultCommit, undefined);
  assert.equal(git(repositoryPath, "status", "--porcelain=v1"), "?? uncommitted.txt");
  assert.throws(() => git(repositoryPath, "rev-parse", "HEAD"));
});

test("B-033 through B-040 isolate worktrees, collect diff, verify, and merge tasks in order", async (t) => {
  const verification = {
    id: "node-check",
    name: "Node check",
    command: process.execPath,
    args: ["-e", "process.stdout.write('verified')"],
    timeoutMs: 10_000,
    required: true,
    scopes: ["task", "run", "merge"]
  };
  const fixture = createFixture(t, [verification]);
  const run = await fixture.workflow.initializeRun(fixture.projectRun);
  const task = await fixture.workflow.initializeTask(run, plannedTask(undefined, {
    acceptanceCriteria: [{ id: "criterion-1", description: "Node command succeeds", commandTemplateId: verification.id, required: true }]
  }));

  assert.notEqual(run.workspacePath, fixture.repositoryPath);
  assert.notEqual(task.workspacePath, run.workspacePath);
  assert.match(run.branchName, /^agenthub\/run\//);
  assert.match(task.branchName, /^agenthub\/task\//);
  writeFileSync(join(task.workspacePath, "src", "worker.txt"), "worker result\n", "utf8");

  const finalized = await fixture.workflow.finalizeTask(run, task, fixture.taskSession, fixture.mainSession);
  assert.equal(finalized.ok, true);
  assert.equal(finalized.files.length, 1);
  assert.equal(finalized.files[0].path, "src/worker.txt");
  assert.equal(finalized.files[0].changeType, "added");
  assert.equal(finalized.files[0].additions, 1);
  assert.match(finalized.files[0].diff, /worker result/);
  assert.equal(readFileSync(join(run.workspacePath, "src", "worker.txt"), "utf8").replaceAll("\r\n", "\n"), "worker result\n");
  assert.equal(finalized.verificationResults.every((result) => result.passed), true);

  const secondSession = { ...fixture.taskSession, id: "session-task-2", taskId: "task-2", title: "Task 2" };
  fixture.database.sessions.save(secondSession);
  const secondTask = await fixture.workflow.initializeTask(run, plannedTask(undefined, {
    id: "task-2",
    title: "Second queued change",
    acceptanceCriteria: [{ id: "criterion-2", description: "Node command succeeds", commandTemplateId: verification.id, required: true }]
  }));
  assert.equal(secondTask.baseCommit, git(run.workspacePath, "rev-parse", "HEAD"));
  writeFileSync(join(secondTask.workspacePath, "src", "second.txt"), "second result\n", "utf8");
  const secondFinalized = await fixture.workflow.finalizeTask(run, secondTask, secondSession, fixture.mainSession);
  assert.equal(secondFinalized.ok, true);
  assert.equal(readFileSync(join(run.workspacePath, "src", "second.txt"), "utf8").replaceAll("\r\n", "\n"), "second result\n");

  const artifacts = fixture.database.artifacts.list({ projectRunId: run.id });
  const diff = artifacts.find((artifact) => artifact.kind === "diff");
  const commitDiff = artifacts.find((artifact) => artifact.kind === "commit");
  assert.ok(diff);
  assert.ok(commitDiff);
  assert.equal(JSON.parse(diff.content).files[0].path, "src/worker.txt");
  assert.match(commitDiff.content, /worker result/);
  assert.equal(fixture.database.verifications.list(run.id).length, 4);
  const eventTypes = fixture.events.replay({ projectRunId: run.id }).map((event) => event.type);
  assert.ok(eventTypes.includes("git.diff_collected"));
  assert.ok(eventTypes.includes("git.merge_started"));
  assert.ok(eventTypes.includes("git.merge_finished"));
  assert.ok(eventTypes.includes("verification.finished"));

  const finalizedRun = await fixture.workflow.finalizeRun(run, fixture.mainSession);
  assert.equal(finalizedRun.needsMergeApproval, true);
  assert.throws(() => readFileSync(join(fixture.repositoryPath, "src", "worker.txt"), "utf8"));
  const merged = await fixture.workflow.mergeFinal(finalizedRun.projectRun, fixture.mainSession);
  assert.equal(merged.conflicts, undefined);
  assert.equal(readFileSync(join(fixture.repositoryPath, "src", "worker.txt"), "utf8").replaceAll("\r\n", "\n"), "worker result\n");
});

test("B-035 blocks task changes outside allowedPaths without merging them", async (t) => {
  const fixture = createFixture(t);
  const run = await fixture.workflow.initializeRun(fixture.projectRun);
  const task = await fixture.workflow.initializeTask(run, plannedTask(undefined, { allowedPaths: ["web/**"] }));
  writeFileSync(join(task.workspacePath, "src", "blocked.txt"), "blocked\n", "utf8");

  const finalized = await fixture.workflow.finalizeTask(run, task, fixture.taskSession, fixture.mainSession);
  assert.equal(finalized.ok, false);
  assert.equal(finalized.reason, "path");
  assert.deepEqual(finalized.task.pathViolations, ["src/blocked.txt"]);
  assert.throws(() => readFileSync(join(run.workspacePath, "src", "blocked.txt"), "utf8"));
});

test("B-038 aborts conflicts and preserves the target worktree content", async (t) => {
  const fixture = createFixture(t);
  const run = await fixture.workflow.initializeRun(fixture.projectRun);
  const task = await fixture.workflow.initializeTask(run, plannedTask());

  writeFileSync(join(run.workspacePath, "src", "shared.txt"), "main run\n", "utf8");
  git(run.workspacePath, "add", ".");
  git(run.workspacePath, "-c", "user.name=AgentHub Test", "-c", "user.email=test@agenthub.local", "commit", "-m", "main change");
  writeFileSync(join(task.workspacePath, "src", "shared.txt"), "task run\n", "utf8");

  const finalized = await fixture.workflow.finalizeTask(run, task, fixture.taskSession, fixture.mainSession);
  assert.equal(finalized.ok, false);
  assert.equal(finalized.reason, "conflict");
  assert.deepEqual(finalized.task.conflicts.map((conflict) => conflict.path), ["src/shared.txt"]);
  assert.equal(readFileSync(join(run.workspacePath, "src", "shared.txt"), "utf8").replaceAll("\r\n", "\n"), "main run\n");
  assert.equal(git(run.workspacePath, "status", "--porcelain=v1"), "");
});

test("B-039 executes only registered templates and rejects unknown template IDs", async (t) => {
  const fixture = createFixture(t, [{
    id: "registered",
    name: "Registered",
    command: process.execPath,
    args: ["-e", "process.stdout.write('registered-only')"],
    timeoutMs: 10_000,
    required: true,
    scopes: ["task"]
  }]);
  const engine = new VerificationEngine(fixture.database);
  const results = await engine.run(fixture.project, fixture.repositoryPath, {
    projectRunId: fixture.projectRun.id,
    sessionId: fixture.mainSession.id,
    scope: "task",
    templateIds: ["registered"]
  });
  assert.equal(results[0].passed, true);
  assert.equal(fixture.database.artifacts.get(results[0].outputArtifactId).content, "registered-only");
  await assert.rejects(
    engine.run(fixture.project, fixture.repositoryPath, {
      projectRunId: fixture.projectRun.id,
      sessionId: fixture.mainSession.id,
      scope: "task",
      templateIds: ["not-registered"]
    }),
    (error) => error.descriptor?.code === "IPC_INVALID_REQUEST"
  );
});

test("B-040 required verification failure prevents task completion and merge", async (t) => {
  const fixture = createFixture(t, [{
    id: "must-pass",
    name: "Must pass",
    command: process.execPath,
    args: ["-e", "process.exit(7)"],
    timeoutMs: 10_000,
    required: true,
    scopes: ["task"]
  }]);
  const run = await fixture.workflow.initializeRun(fixture.projectRun);
  const task = await fixture.workflow.initializeTask(run, plannedTask(undefined, {
    acceptanceCriteria: [{ id: "criterion", description: "Must pass", commandTemplateId: "must-pass", required: true }]
  }));
  writeFileSync(join(task.workspacePath, "src", "unverified.txt"), "not accepted\n", "utf8");

  const finalized = await fixture.workflow.finalizeTask(run, task, fixture.taskSession, fixture.mainSession);
  assert.equal(finalized.ok, false);
  assert.equal(finalized.reason, "verification");
  assert.equal(finalized.verificationResults[0].exitCode, 7);
  assert.throws(() => readFileSync(join(run.workspacePath, "src", "unverified.txt"), "utf8"));
});

test("B-041 final merge refuses a dirty user worktree and preserves user files", async (t) => {
  const fixture = createFixture(t);
  const run = await fixture.workflow.initializeRun(fixture.projectRun);
  const task = await fixture.workflow.initializeTask(run, plannedTask());
  writeFileSync(join(task.workspacePath, "src", "approved.txt"), "ready\n", "utf8");
  const taskResult = await fixture.workflow.finalizeTask(run, task, fixture.taskSession, fixture.mainSession);
  assert.equal(taskResult.ok, true);
  const finalizedRun = await fixture.workflow.finalizeRun(run, fixture.mainSession);
  writeFileSync(join(fixture.repositoryPath, "user-notes.txt"), "keep me\n", "utf8");

  const blocked = await fixture.workflow.mergeFinal(finalizedRun.projectRun, fixture.mainSession);
  assert.ok(blocked.conflicts?.some((conflict) => conflict.path.includes("user-notes.txt")));
  assert.equal(readFileSync(join(fixture.repositoryPath, "user-notes.txt"), "utf8"), "keep me\n");
  assert.throws(() => readFileSync(join(fixture.repositoryPath, "src", "approved.txt"), "utf8"));
});

test("B-033 and B-041 direct orchestration waits for explicit merge approval", async (t) => {
  const fixture = createFixture(t);
  const now = new Date().toISOString();
  fixture.database.agents.save({
    id: "agent-main",
    providerId: "fake-git",
    displayName: "Main",
    executable: "fake",
    baseArgs: [],
    capabilities: [],
    enabled: true,
    status: "available",
    createdAt: now,
    updatedAt: now
  }, now);
  fixture.database.teams.save({
    id: "team",
    name: "Team",
    mainMemberId: "main",
    delegationPolicy: "autonomous",
    members: [{ id: "main", displayName: "Main", agentInstanceId: "agent-main", roleId: "main-role", strengths: {}, allowedTaskTypes: [], maxConcurrentTasks: 1, enabled: true }],
    createdAt: now,
    updatedAt: now
  }, now);

  const adapter = {
    providerId: "fake-git",
    supportsStructuredOutput: true,
    supportsResume: false,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: false, pty: false },
    detect: async () => ({ installed: true, executable: "fake" }),
    start(request) {
      async function* events() {
        if (request.prompt.includes("[AGENTHUB_PLANNER_DECISION]")) {
          yield { kind: "message", text: JSON.stringify({ mode: "direct", rationale: "Main can do it" }) };
        } else if (request.prompt.includes("[AGENTHUB_DIRECT_EXECUTION]")) {
          writeFileSync(join(request.cwd, "src", "direct.txt"), "direct result\n", "utf8");
          yield { kind: "message", text: "Direct implementation completed" };
        } else {
          yield { kind: "message", text: "Final result" };
        }
        yield { kind: "exit", exitCode: 0 };
      }
      return { process: {}, events: events(), cancel: async () => {}, write: () => {} };
    }
  };
  const registry = new AdapterRegistry([adapter]);
  const runs = new RunService(fixture.database, registry, fixture.events);
  const orchestration = new OrchestrationService(fixture.database, runs, fixture.events, fixture.workflow);
  const started = orchestration.start({ projectId: fixture.project.id, teamId: "team", goal: "Create direct file" });
  await orchestration.wait(started.projectRun.id);

  const mergeReady = fixture.database.projectRuns.get(started.projectRun.id);
  assert.equal(mergeReady.status, "merge_ready");
  assert.ok(mergeReady.mergeApprovalId);
  assert.throws(() => readFileSync(join(fixture.repositoryPath, "src", "direct.txt"), "utf8"));
  const approval = fixture.events.replay({ projectRunId: started.projectRun.id }).find((event) => event.type === "approval.requested" && event.payload.category === "merge");
  assert.ok(approval);

  const completed = await orchestration.resolveMerge(started.projectRun.id, true);
  assert.equal(completed.status, "completed");
  assert.equal(readFileSync(join(fixture.repositoryPath, "src", "direct.txt"), "utf8").replaceAll("\r\n", "\n"), "direct result\n");
});
