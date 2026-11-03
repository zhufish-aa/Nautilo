import test from "node:test";
import assert from "node:assert/strict";
import fsPromises, { access, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginService } from "../dist/runtime/plugins/plugin-service.js";
import { readWorkspaceArtifact } from "../dist/application/artifact-read.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nautilo-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function database(rootPath) {
  return { projects: { get: () => ({ rootPath }) } };
}

function read(rootPath, path) {
  return readWorkspaceArtifact(database(rootPath), { projectId: "test", path });
}

const invalid = (error) => error?.descriptor?.code === "IPC_INVALID_REQUEST";
const invalidPlugin = (error) => error?.descriptor?.code === "PLUGIN_INVALID";

async function linkOrSkip(t, target, path, type) {
  try { await symlink(target, path, type); return true; }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.skip("Creating symlinks requires Windows Developer Mode or suitable privileges");
      return false;
    }
    throw error;
  }
}

test("plugin uninstall rejects traversal and malformed IDs without deleting siblings", async (t) => {
  const root = await fixture(t);
  const dataDir = join(root, "data");
  const service = new PluginService(dataDir, { find() {}, unregister() {}, register() {} });
  await service.ready;
  const marker = join(root, "outside", "keep.txt");
  await mkdir(join(root, "outside"));
  await writeFile(marker, "keep");
  for (const id of ["", ".", "..", "../../outside", "..\\..\\outside", "/tmp/outside", "C:\\outside", undefined, "valid/../outside"]) {
    await assert.rejects(() => service.uninstall(id), invalidPlugin);
    await access(marker);
  }
  const target = join(dataDir, "plugins", "valid-provider-2");
  await mkdir(target);
  await writeFile(join(target, "plugin.txt"), "fixture");
  assert.deepEqual(await service.uninstall("valid-provider-2"), { removed: true });
  await assert.rejects(() => access(target));
  assert.deepEqual(await service.uninstall("valid-provider-2"), { removed: true });
  await access(marker);
});

test("plugin uninstall rejects linked plugin roots and preserves nested link targets", async (t) => {
  const root = await fixture(t);
  const dataDir = join(root, "data");
  const service = new PluginService(dataDir, { find() {}, unregister() {}, register() {} });
  await service.ready;
  const outside = join(root, "outside");
  await mkdir(outside);
  const marker = join(outside, "keep.txt");
  await writeFile(marker, "keep");
  if (!await linkOrSkip(t, outside, join(dataDir, "plugins", "linked"), "junction")) return;
  await assert.rejects(() => service.uninstall("linked"), invalidPlugin);
  await access(marker);
  const target = join(dataDir, "plugins", "valid");
  await mkdir(target);
  if (!await linkOrSkip(t, outside, join(target, "nested"), "junction")) return;
  assert.deepEqual(await service.uninstall("valid"), { removed: true });
  await access(marker);
});

test("artifact reads reject nested traversal and allow legitimate relative and absolute files", async (t) => {
  const root = await fixture(t);
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "sub"), { recursive: true });
  await writeFile(join(root, "outside.txt"), "outside");
  for (const name of ["report.md", "..report.txt"]) {
    await writeFile(join(workspace, name), "inside");
    for (const path of [name, join(workspace, name), `sub/../${name}`]) {
      const result = await read(workspace, path);
      assert.equal(Buffer.from(result.base64, "base64").toString(), "inside");
      assert.equal(result.size, 6);
    }
  }
  for (const path of ["../outside.txt", "sub/../../outside.txt", join(root, "outside.txt"), "."]) {
    await assert.rejects(() => read(workspace, path), invalid);
  }
  await assert.rejects(() => read(workspace, "missing.txt"), (error) => error?.descriptor?.code === "IPC_NOT_FOUND");
});

test("artifact reads reject symlink escapes but retain links to files inside the workspace", async (t) => {
  const root = await fixture(t);
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(workspace, "report.txt"), "inside");
  await writeFile(join(outside, "secret.txt"), "synthetic outside data");
  if (!await linkOrSkip(t, outside, join(workspace, "escape"), "junction")) return;
  await assert.rejects(() => read(workspace, "escape/secret.txt"), invalid);
  if (!await linkOrSkip(t, join(workspace, "report.txt"), join(workspace, "inside.txt"), "file")) return;
  const result = await read(workspace, "inside.txt");
  assert.equal(Buffer.from(result.base64, "base64").toString(), "inside");
  const alias = join(root, "workspace-alias");
  if (!await linkOrSkip(t, workspace, alias, "junction")) return;
  for (const path of ["report.txt", join(alias, "report.txt"), join(workspace, "report.txt")]) {
    const linkedRoot = await read(alias, path);
    assert.equal(Buffer.from(linkedRoot.base64, "base64").toString(), "inside");
  }
});

test("artifact reads reject files above the preview byte limit", async (t) => {
  const workspace = await fixture(t);
  const path = join(workspace, "large.txt");
  await writeFile(path, "");
  await truncate(path, 20 * 1024 * 1024 + 1);
  await assert.rejects(() => read(workspace, path), invalid);
});

test("artifact reads reject a replaced handle and bound files growing after stat", async (t) => {
  const root = await fixture(t);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const path = join(workspace, "report.txt");
  const outside = join(root, "outside.txt");
  await writeFile(path, "inside");
  await writeFile(outside, "synthetic outside data");
  const originalOpen = fsPromises.open;
  try {
    // Deterministic open/replacement race: the returned descriptor belongs
    // to a different file while the path still resolves inside the project.
    fsPromises.open = () => originalOpen(outside, "r");
    syncBuiltinESMExports();
    await assert.rejects(() => read(workspace, path), invalid);

    let bytesRead = 0;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      const originalStat = handle.stat.bind(handle);
      const originalRead = handle.read.bind(handle);
      handle.stat = async () => {
        const beforeGrowth = await originalStat();
        await truncate(path, 24 * 1024 * 1024);
        return beforeGrowth;
      };
      handle.read = async (...readArgs) => {
        const result = await originalRead(...readArgs);
        bytesRead += result.bytesRead;
        return result;
      };
      return handle;
    };
    syncBuiltinESMExports();
    await assert.rejects(() => read(workspace, path), invalid);
    assert.equal(bytesRead, 20 * 1024 * 1024 + 1);
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("plugin uninstall revalidates its target after asynchronous unload", async (t) => {
  const root = await fixture(t);
  const dataDir = join(root, "data");
  const service = new PluginService(dataDir, { find() {}, unregister() {}, register() {} });
  await service.ready;
  const outside = join(root, "outside");
  await mkdir(outside);
  const marker = join(outside, "keep.txt");
  await writeFile(marker, "keep");
  const target = join(dataDir, "plugins", "racing");
  await mkdir(target);
  const link = join(dataDir, "plugins", "next");
  if (!await linkOrSkip(t, outside, link, "junction")) return;
  // Simulates a directory replacement while the plugin process shuts down.
  service.unload = async () => {
    await rename(target, join(dataDir, "plugins", "previous"));
    await rename(link, target);
  };
  await assert.rejects(() => service.uninstall("racing"), invalidPlugin);
  await access(marker);
});

test("plugin enable and disable reject unsafe IDs and linked directories", async (t) => {
  const root = await fixture(t);
  const dataDir = join(root, "data");
  const service = new PluginService(dataDir, { find() {}, unregister() {}, register() {} });
  await service.ready;
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, ".disabled"), "keep");
  for (const enabled of [true, false]) {
    for (const id of ["", ".", "..", "../../outside", "..\\..\\outside", "/tmp/outside", "C:\\outside", undefined]) {
      await assert.rejects(() => service.setEnabled(id, enabled), invalidPlugin);
    }
  }
  if (!await linkOrSkip(t, outside, join(dataDir, "plugins", "linked"), "junction")) return;
  for (const enabled of [true, false]) {
    await assert.rejects(() => service.setEnabled("linked", enabled), invalidPlugin);
  }
  assert.equal(await fsPromises.readFile(join(outside, ".disabled"), "utf8"), "keep");
});

test("disabling a plugin never overwrites an existing disabled-marker link", async (t) => {
  const root = await fixture(t);
  const dataDir = join(root, "data");
  const service = new PluginService(dataDir, { find() {}, unregister() {}, register() {} });
  await service.ready;
  const dir = join(dataDir, "plugins", "valid");
  await mkdir(dir);
  await writeFile(join(dir, "agenthub-plugin.json"), JSON.stringify({
    id: "valid", apiVersion: 1, main: "missing.mjs",
    descriptor: { providerId: "valid", name: "Fixture", vendor: "Tests", capabilities: [] }
  }));
  const outside = join(root, "keep.txt");
  await writeFile(outside, "keep");
  if (!await linkOrSkip(t, outside, join(dir, ".disabled"), "file")) return;
  assert.equal((await service.setEnabled("valid", false)).status, "disabled");
  assert.equal(await fsPromises.readFile(outside, "utf8"), "keep");
  // Enabling only removes the link, never its target. The synthetic plugin
  // has no executable, so loading reports the expected error afterward.
  assert.equal((await service.setEnabled("valid", true)).status, "error");
  assert.equal(await fsPromises.readFile(outside, "utf8"), "keep");
  await assert.rejects(() => fsPromises.lstat(join(dir, ".disabled")));
});
