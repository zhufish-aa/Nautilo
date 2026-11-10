import test from "node:test";
import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await fsPromises.readFile(new URL("../src/main/artifact-protocol.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function load(overrides = {}) {
  const module = { exports: {} };
  const imports = { electron: {}, "node:fs/promises": fsPromises, ...overrides };
  new Function("require", "module", "exports", compiled)(
    (name) => Object.hasOwn(imports, name) ? imports[name] : require(name), module, module.exports
  );
  return module.exports;
}

async function fixture(t) {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "nautilo-protocol-"));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await fsPromises.mkdir(join(root, "workspace"));
  await fsPromises.mkdir(join(root, "outside"));
  return root;
}

async function link(t, target, path, type = "junction") {
  try { await fsPromises.symlink(target, path, type); return true; }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.skip("Symlink creation requires Windows Developer Mode or suitable privileges");
      return false;
    }
    throw error;
  }
}

test("artifact protocol serves registered files and rejects traversal and outside links", async (t) => {
  const root = await fixture(t);
  const workspace = join(root, "workspace");
  await fsPromises.writeFile(join(workspace, "..report.png"), "image fixture");
  await fsPromises.writeFile(join(root, "outside", "secret.png"), "synthetic private bytes");
  const { readArtifactResponse } = load();
  const allowed = await readArtifactResponse(join(workspace, "..report.png"), [workspace]);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("Content-Type"), "image/png");
  assert.equal(await allowed.text(), "image fixture");
  for (const path of [join(root, "outside", "secret.png"), `${workspace}/sub/../../outside/secret.png`]) {
    const denied = await readArtifactResponse(path, [workspace]);
    assert.equal(denied.status, 403);
    assert.equal(await denied.text(), "Forbidden");
  }
  if (!await link(t, join(root, "outside"), join(workspace, "escape"))) return;
  assert.equal((await readArtifactResponse(join(workspace, "escape", "secret.png"), [workspace])).status, 403);
  if (!await link(t, workspace, join(root, "alias"))) return;
  const inside = await readArtifactResponse(join(root, "alias", "..report.png"), [workspace]);
  assert.equal(await inside.text(), "image fixture");
});

test("artifact protocol checks descriptor identity before returning bytes", async (t) => {
  const root = await fixture(t);
  const workspace = join(root, "workspace");
  await fsPromises.writeFile(join(workspace, "image.png"), "inside");
  const outside = join(root, "outside", "secret.png");
  await fsPromises.writeFile(outside, "synthetic outside data");
  const { readArtifactResponse } = load({ "node:fs/promises": { ...fsPromises, open: () => fsPromises.open(outside, "r") } });
  const denied = await readArtifactResponse(join(workspace, "image.png"), [workspace]);
  assert.equal(denied.status, 403);
  assert.doesNotMatch(await denied.text(), /synthetic outside data/);
});

test("artifact protocol streams the validated descriptor after the path changes", async (t) => {
  const root = await fixture(t);
  const workspace = join(root, "workspace");
  const path = join(workspace, "image.png");
  await fsPromises.writeFile(path, "validated content");
  const { readArtifactResponse } = load();
  const response = await readArtifactResponse(path, [workspace]);
  assert.equal(response.status, 200);
  await fsPromises.rename(path, join(workspace, "previous.png"));
  await fsPromises.writeFile(path, "replacement content");
  assert.equal(await response.text(), "validated content");
});

test("artifact protocol handles empty and missing files without leaking a handle", async (t) => {
  const root = await fixture(t);
  const workspace = join(root, "workspace");
  const path = join(workspace, "empty.png");
  await fsPromises.writeFile(path, "");
  const { readArtifactResponse } = load();
  const empty = await readArtifactResponse(path, [workspace]);
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), "");
  assert.equal((await readArtifactResponse(join(workspace, "missing.png"), [workspace])).status, 404);
});
