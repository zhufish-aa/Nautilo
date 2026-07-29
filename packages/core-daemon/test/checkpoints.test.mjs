import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterRegistry,
  CheckpointService,
  Database,
  EventService,
  RunService
} from "../dist/index.js";
import { captureWorkspaceSnapshot } from "../dist/runtime/run-workspace-snapshot.js";

const now = new Date().toISOString();

async function tempDir(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function seedSession(database, workspace) {
  const project = { id: "p1", name: "Project", rootPath: workspace, repositoryType: "folder", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default" };
  const session = { id: "s1", projectId: "p1", memberId: "a1", title: "Session", status: "idle", unreadCount: 0, createdAt: now, updatedAt: now };
  database.projects.save(project, now);
  database.sessions.save(session);
  return session;
}

test("checkpoint revert restores touched files and keeps user files", async (t) => {
  const workspace = await tempDir(t, "agenthub-checkpoint-ws-");
  const dataDir = await tempDir(t, "agenthub-checkpoint-data-");
  const database = new Database(":memory:");
  const session = seedSession(database, workspace);
  const events = new EventService(database);
  const checkpoints = new CheckpointService(database, dataDir, events);

  await writeFile(join(workspace, "a.txt"), "before", "utf8");
  const run = { id: "run-1", sessionId: session.id, agentInstanceId: "a1", mode: "headless_structured", status: "completed", startedAt: now };
  database.runs.save(run);
  const snapshot = await captureWorkspaceSnapshot(workspace);
  const row = await checkpoints.save(session, run, snapshot);
  checkpoints.recordTouched(run.id, workspace, ["a.txt", "b.txt", "../outside.txt"]);

  // The agent rewrote a.txt and created b.txt; the user created keep.txt.
  await writeFile(join(workspace, "a.txt"), "after", "utf8");
  await writeFile(join(workspace, "b.txt"), "agent made this", "utf8");
  await writeFile(join(workspace, "keep.txt"), "mine", "utf8");

  const preview = await checkpoints.preview(row.id);
  assert.deepEqual(preview.restored, ["a.txt"]);
  assert.deepEqual(preview.removed, ["b.txt"]);
  assert.equal(preview.warning, undefined);

  const summary = await checkpoints.revert(row.id);
  assert.deepEqual(summary.restored, ["a.txt"]);
  assert.deepEqual(summary.removed, ["b.txt"]);
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "before");
  assert.equal(existsSync(join(workspace, "b.txt")), false);
  assert.equal(await readFile(join(workspace, "keep.txt"), "utf8"), "mine");

  // The revert is marked on the session timeline.
  const reverted = database.events.replay({ sessionId: session.id }).filter((event) => event.type === "session.checkpoint_reverted");
  assert.equal(reverted.length, 1);
  assert.deepEqual(reverted[0].payload.restored, ["a.txt"]);
  database.close();
});

test("checkpoint keeps the newest 20 per session and deletes old snapshot files", async (t) => {
  const workspace = await tempDir(t, "agenthub-checkpoint-ws-");
  const dataDir = await tempDir(t, "agenthub-checkpoint-data-");
  const database = new Database(":memory:");
  const session = seedSession(database, workspace);
  const checkpoints = new CheckpointService(database, dataDir, new EventService(database));

  await writeFile(join(workspace, "a.txt"), "x", "utf8");
  const snapshot = await captureWorkspaceSnapshot(workspace);
  const run = { id: "run-1", sessionId: session.id, agentInstanceId: "a1", mode: "headless_structured", status: "completed", startedAt: now };
  database.runs.save(run);
  let oldest;
  for (let index = 0; index < 21; index += 1) {
    const row = await checkpoints.save(session, run, snapshot);
    oldest ??= row.id;
  }
  const rows = checkpoints.list(session.id);
  assert.equal(rows.length, 20);
  assert.ok(!rows.some((row) => row.id === oldest));
  assert.equal(existsSync(join(dataDir, "checkpoints", `${oldest}.json`)), false);
  database.close();
});

test("RunService captures a checkpoint at launch and records touched files at run end", async (t) => {
  const workspace = await tempDir(t, "agenthub-checkpoint-ws-");
  const dataDir = await tempDir(t, "agenthub-checkpoint-data-");
  await writeFile(join(workspace, "a.txt"), "before", "utf8");

  const adapter = {
    providerId: "fake",
    supportsStructuredOutput: true,
    supportsResume: false,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: false, pty: false },
    detect: async () => ({ installed: true, executable: "fake" }),
    start: () => {
      async function* events() {
        yield { kind: "file", path: "a.txt", changeType: "modified" };
        yield { kind: "message", text: "ok" };
        yield { kind: "exit", exitCode: 0 };
      }
      return { process: {}, events: events(), cancel: async () => {}, write: () => {} };
    }
  };
  const database = new Database(":memory:");
  const session = seedSession(database, workspace);
  const agent = { id: "a1", providerId: "fake", displayName: "Fake", executable: "fake", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now };
  const events = new EventService(database);
  const service = new RunService(database, new AdapterRegistry([adapter]), events);
  const checkpoints = new CheckpointService(database, dataDir, events);
  service.setCheckpointService(checkpoints);

  const handle = await service.launch(session, agent, "change a.txt");
  const runId = handle.runId;
  await handle.completion;

  const rows = checkpoints.list(session.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, runId);
  assert.deepEqual(database.checkpoints.touchedForRuns([runId]), ["a.txt"]);

  // End-to-end: the agent's edit is undone by reverting to the launch checkpoint.
  await writeFile(join(workspace, "a.txt"), "after", "utf8");
  await checkpoints.revert(rows[0].id);
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "before");
  database.close();
});
