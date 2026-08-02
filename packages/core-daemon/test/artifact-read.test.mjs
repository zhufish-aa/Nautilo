import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../dist/index.js";
import { readWorkspaceArtifact } from "../dist/application/artifact-read.js";

const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

function createFixture() {
  const tempRoot = mkdtempSync(join(tmpdir(), "agenthub-artifact-read-"));
  const workspace = join(tempRoot, "workspace");
  mkdirSync(workspace);
  const database = new Database(join(tempRoot, "test.sqlite"));
  const project = {
    id: "project-artifact-read",
    name: "Artifact read test",
    rootPath: workspace,
    repositoryType: "none",
    frontendPaths: [],
    backendPaths: [],
    ignoredPaths: [],
    policyId: "default"
  };
  database.projects.save(project, new Date().toISOString());
  return { database, project, tempRoot, workspace };
}

function closeFixture(fixture) {
  fixture.database.close();
  rmSync(fixture.tempRoot, { recursive: true, force: true });
}

test("artifact.read identifies PDF and old/new Office formats case-insensitively", async () => {
  const fixture = createFixture();
  try {
    const formats = [
      ["REPORT.DOC", "application/msword"],
      ["REPORT.DOCX", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["REPORT.XLS", "application/vnd.ms-excel"],
      ["REPORT.XLSX", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["REPORT.PPT", "application/vnd.ms-powerpoint"],
      ["REPORT.PPTX", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["REPORT.PDF", "application/pdf"],
      ["REPORT.PY", "text/plain"]
    ];

    for (const [fileName, expectedMime] of formats) {
      writeFileSync(join(fixture.workspace, fileName), "preview fixture");
      const artifact = await readWorkspaceArtifact(fixture.database, {
        projectId: fixture.project.id,
        path: fileName
      });
      assert.equal(artifact.mimeType, expectedMime, fileName);
    }
  } finally {
    closeFixture(fixture);
  }
});

test("artifact.read falls back to octet-stream for unknown extensions", async () => {
  const fixture = createFixture();
  try {
    writeFileSync(join(fixture.workspace, "REPORT.BIN"), "preview fixture");
    const artifact = await readWorkspaceArtifact(fixture.database, {
      projectId: fixture.project.id,
      path: "REPORT.BIN"
    });
    assert.equal(artifact.mimeType, "application/octet-stream");
  } finally {
    closeFixture(fixture);
  }
});

test("artifact.read rejects paths outside the project workspace", async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      () => readWorkspaceArtifact(fixture.database, { projectId: fixture.project.id, path: "../outside.txt" }),
      (error) => error?.descriptor?.code === "IPC_INVALID_REQUEST"
    );
  } finally {
    closeFixture(fixture);
  }
});

test("artifact.read rejects files larger than the 20MB preview limit", async () => {
  const fixture = createFixture();
  try {
    const oversizedPath = join(fixture.workspace, "oversized.bin");
    writeFileSync(oversizedPath, "");
    truncateSync(oversizedPath, MAX_PREVIEW_BYTES + 1);
    await assert.rejects(
      () => readWorkspaceArtifact(fixture.database, { projectId: fixture.project.id, path: "oversized.bin" }),
      (error) => error?.descriptor?.code === "IPC_INVALID_REQUEST"
        && error.descriptor.details?.reason?.includes("20MB")
    );
  } finally {
    closeFixture(fixture);
  }
});
