import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDaemon } from "../dist/index.js";
import { readWorkspaceArtifact } from "../dist/application/artifact-read.js";

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

test("work mode injects deliverable guidance on the first turn", async () => {
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  const workspace = mkdtempSync(join(tmpdir(), "agenthub-work-"));
  const project = { id: "project-work", name: "Workspace", rootPath: workspace, repositoryType: "none", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default" };
  const agent = { id: "agent-work", providerId: "work-test", displayName: "Work test", executable: "work-test", baseArgs: [], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now };
  const session = { id: "session-work", projectId: project.id, memberId: agent.id, agentInstanceId: agent.id, title: "Doc", status: "idle", mode: "work", unreadCount: 0, createdAt: now, updatedAt: now };
  daemon.database.projects.save(project, now);
  daemon.database.agents.save(agent, now);
  daemon.database.sessions.save(session);
  const prompts = [];
  daemon.adapters.register({
    providerId: "work-test",
    supportsStructuredOutput: true,
    supportsResume: false,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: false, pty: false },
    detect: async () => ({ installed: true, executable: "work-test" }),
    start: (request) => {
      prompts.push(request.prompt);
      async function* events() { yield { kind: "session", providerSessionId: "thread-work" }; yield { kind: "exit", exitCode: 0 }; }
      return { process: {}, events: events(), cancel: async () => {}, write: () => {} };
    }
  });

  await daemon.sessions.send({ sessionId: session.id, text: "make a quarterly report" });
  await waitFor(() => prompts.length === 1);
  assert.match(prompts[0], /<agenthub_work_mode>/);
  assert.ok(prompts[0].includes(workspace));
  assert.match(prompts[0], /make a quarterly report/);
  await waitFor(() => daemon.database.runs.list().every((run) => ["completed", "failed", "timed_out", "crashed", "cancelled"].includes(run.status)));
  await daemon.stop();
});

test("artifact.read serves files inside the workspace and rejects escapes", async () => {
  const daemon = new CoreDaemon({ databasePath: ":memory:", enableGitWorkflows: false });
  const workspace = mkdtempSync(join(tmpdir(), "agenthub-artifact-"));
  writeFileSync(join(workspace, "report.md"), "# Hello");
  const project = { id: "project-artifact", name: "Workspace", rootPath: workspace, repositoryType: "none", frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: "default" };
  daemon.database.projects.save(project, now);

  const byRelative = await readWorkspaceArtifact(daemon.database, { projectId: project.id, path: "report.md" });
  assert.equal(Buffer.from(byRelative.base64, "base64").toString("utf8"), "# Hello");
  assert.equal(byRelative.mimeType, "text/markdown");

  const byAbsolute = await readWorkspaceArtifact(daemon.database, { projectId: project.id, path: join(workspace, "report.md") });
  assert.equal(byAbsolute.size, 7);

  await assert.rejects(
    () => readWorkspaceArtifact(daemon.database, { projectId: project.id, path: "../outside.txt" }),
    (error) => error?.descriptor?.code === "IPC_INVALID_REQUEST"
  );
  await assert.rejects(
    () => readWorkspaceArtifact(daemon.database, { projectId: project.id, path: join(tmpdir(), "somewhere-else.txt") }),
    (error) => error?.descriptor?.code === "IPC_INVALID_REQUEST"
  );
  await assert.rejects(
    () => readWorkspaceArtifact(daemon.database, { projectId: project.id, path: "missing.md" }),
    (error) => error?.descriptor?.code === "IPC_NOT_FOUND"
  );
  await daemon.stop();
});
