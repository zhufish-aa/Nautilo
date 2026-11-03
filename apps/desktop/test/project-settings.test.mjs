import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const renderer = new URL("../src/renderer/src/", import.meta.url);
function load(relative, modules) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL(relative, renderer), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInNewContext(source, {
    exports,
    require: (name) => {
      if (!(name in modules)) throw new Error(`Unexpected import: ${name}`);
      return modules[name];
    }
  });
  return exports;
}
const mappers = load("lib/core-mappers.ts", {
  "./provider-catalog": { providerMeta: () => undefined }
});
const utils = load("lib/utils.ts", { clsx: require("clsx") });
const plain = (value) => JSON.parse(JSON.stringify(value));
const project = {
  id: "p",
  name: "Non-Git workspace",
  rootPath: "/test/workspace",
  repositoryType: "none",
  workspaceMode: "direct",
  defaultBranch: "trunk",
  frontendPaths: ["web"],
  backendPaths: ["api"],
  ignoredPaths: ["private", "large-data"],
  policyId: "custom-policy",
  verificationTemplates: []
};

function harness(request = async (_method, params) => params) {
  const calls = [];
  const { useProjectsStore: store } = load("stores/projects.ts", {
    zustand: require("zustand"),
    "../lib/bridge": {
      requestCore: (method, params) => {
        calls.push({ method, params });
        return request(method, params);
      }
    },
    "../lib/core-mappers": mappers,
    "../lib/utils": utils
  });
  store.setState({ projects: [mappers.toUiProject(project)] });
  return { store, calls };
}

test("legacy projects default to full comparison and retain all persisted settings", () => {
  const ui = mappers.toUiProject(project);
  assert.equal(ui.nonGitDiffMode, "full");
  assert.deepEqual(plain(mappers.toDomainProject(ui)), { ...project, nonGitDiffMode: "full" });
  delete ui.nonGitDiffMode;
  assert.equal(mappers.toDomainProject(ui).nonGitDiffMode, "full");
});

test("hydrated off survives a send-path domain round trip without any inspection", () => {
  const saved = { ...project, nonGitDiffMode: "off" };
  assert.deepEqual(plain(mappers.toDomainProject(mappers.toUiProject(saved))), saved);
});

test("comparison changes persist full/off without replacing unrelated project fields", async () => {
  const { store, calls } = harness();
  for (const nonGitDiffMode of ["off", "full"]) {
    await store.getState().setNonGitDiffMode("p", nonGitDiffMode);
    assert.deepEqual(plain(calls.at(-1)), {
      method: "project.upsert",
      params: { ...project, nonGitDiffMode }
    });
    assert.equal(store.getState().projects[0].nonGitDiffMode, nonGitDiffMode);
  }
});

test("pending and failed saves retain the last persisted selection and newer local metadata", async () => {
  let reject;
  const { store } = harness(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      })
  );
  const pending = store.getState().setNonGitDiffMode("p", "off");
  const rejected = assert.rejects(pending, /Save unavailable/);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.getState().projects[0].nonGitDiffMode, "full");
  store.getState().setActiveRun("p", { id: "new-run" });
  reject(new Error("Save unavailable"));
  await rejected;
  assert.equal(store.getState().projects[0].nonGitDiffMode, "full");
  assert.equal(store.getState().projects[0].activeRun.id, "new-run");
});

test("other settings retain off, ignored paths and custom policy", async () => {
  const { store, calls } = harness();
  await store.getState().setNonGitDiffMode("p", "off");
  await store.getState().setWorkspaceMode("p", "git_isolated");
  await store.getState().setVerificationTemplates("p", [{ id: "check", command: "test" }]);
  for (const { params } of calls.slice(1)) {
    assert.equal(params.nonGitDiffMode, "off");
    assert.equal(params.policyId, project.policyId);
    assert.deepEqual(plain(params.ignoredPaths), project.ignoredPaths);
  }
  assert.equal(calls.at(-1).params.workspaceMode, "git_isolated");
});

test("concurrent settings use the preceding saved result rather than stale full-project payloads", async () => {
  let release;
  const { store, calls } = harness((_method, params) => {
    if (params.nonGitDiffMode === "off" && params.workspaceMode === "direct") {
      return new Promise((resolve) => {
        release = () => resolve(params);
      });
    }
    return Promise.resolve(params);
  });
  const mode = store.getState().setNonGitDiffMode("p", "off");
  const workspace = store.getState().setWorkspaceMode("p", "git_isolated");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 1);
  release();
  await Promise.all([mode, workspace]);
  assert.equal(calls[1].params.nonGitDiffMode, "off");
  assert.equal(store.getState().projects[0].workspaceMode, "git_isolated");
});

test("a failed setting does not block the next queued save or clear the previous mode", async () => {
  const { store, calls } = harness(async (_method, params) => {
    if (params.nonGitDiffMode === "off") throw new Error("Unavailable");
    return params;
  });
  const rejected = assert.rejects(store.getState().setNonGitDiffMode("p", "off"), /Unavailable/);
  const workspace = store.getState().setWorkspaceMode("p", "git_isolated");
  await Promise.all([rejected, workspace]);
  assert.equal(calls[1].params.nonGitDiffMode, "full");
  assert.equal(store.getState().projects[0].workspaceMode, "git_isolated");
});

test("saving a removed project rejects rather than falsely reporting success", async () => {
  const { store, calls } = harness();
  store.setState({ projects: [] });
  await assert.rejects(store.getState().setNonGitDiffMode("p", "off"), /Project not found/);
  assert.equal(calls.length, 0);
});

test("scan and settings serialize so a slow full snapshot cannot overwrite a later off save", async () => {
  let releaseScan;
  const { store, calls } = harness(async (method, params) => {
    if (method === 'project.scan') return new Promise(resolve => {
      releaseScan = () => resolve({ project: { ...project, nonGitDiffMode: 'full' } });
    });
    return params;
  });
  const scan = store.getState().rescanProject('p');
  const save = store.getState().setNonGitDiffMode('p', 'off');
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls.map(c => c.method), ['project.scan']);
  releaseScan();
  await Promise.all([scan, save]);
  assert.equal(store.getState().projects[0].nonGitDiffMode, 'off');
  assert.deepEqual(calls.map(c => c.method), ['project.scan', 'project.upsert']);
});

test("hydrate does not replay a stale list over a newer saved setting", async () => {
  let releaseList;
  let persisted = { ...project, nonGitDiffMode: 'full' };
  const { store } = harness(async (method, params) => {
    if (method === 'project.list') return new Promise(resolve => { releaseList = () => resolve([{ ...project, nonGitDiffMode: 'full' }]); });
    if (method === 'project.upsert') { persisted = params; return params; }
    if (method === 'project.scan') return { project: persisted };
    throw Error(method);
  });
  const hydrate = store.getState().hydrate();
  await store.getState().setNonGitDiffMode('p', 'off');
  releaseList();
  await hydrate;
  assert.equal(store.getState().projects[0].nonGitDiffMode, 'off');
});

test("a failed scan releases the project queue so settings still save", async () => {
  const { store } = harness(async (method, params) => {
    if (method === 'project.scan') throw Error('scan failed');
    return params;
  });
  const scan = assert.rejects(store.getState().rescanProject('p'), /scan failed/);
  const save = store.getState().setNonGitDiffMode('p', 'off');
  await Promise.all([scan, save]);
  assert.equal(store.getState().projects[0].nonGitDiffMode, 'off');
  assert.equal(store.getState().projects[0].scanning, false);
});

test("startup metadata hydration avoids every historical project's scan", async () => {
  const { store, calls } = harness(async (method) => {
    if (method === 'project.list') return Array.from({ length: 100 }, (_, index) => ({ ...project, id: `project-${index}` }));
    throw Error(`Unexpected startup filesystem work: ${method}`);
  });
  store.setState({ projects: [] });
  await store.getState().hydrate(false);
  assert.equal(store.getState().projects.length, 100);
  assert.deepEqual(calls.map(c => c.method), ['project.list']);
  assert(store.getState().projects.every(p => !p.scan && p.nonGitDiffMode === 'full'));
});

test("metadata hydration drops externally removed rows without resurrecting a local deletion", async () => {
  let release;
  const { store } = harness(async (method) => {
    if (method === 'project.list') return new Promise(resolve => { release = resolve; });
    throw Error(method);
  });
  const pending = store.getState().hydrate(false);
  store.setState({ projects: [] });
  release([{ ...project }]);
  await pending;
  assert.equal(store.getState().projects.length, 0);
  store.setState({ projects: [mappers.toUiProject(project)] });
  const next = store.getState().hydrate(false);
  release([]);
  await next;
  assert.equal(store.getState().projects.length, 0);
});

test("metadata hydration adopts remote edits but preserves concurrently created projects", async () => {
  let release;
  const { store } = harness(async (method) => {
    if (method === 'project.list') return new Promise(resolve => { release = resolve; });
    throw Error(method);
  });
  const pending = store.getState().hydrate(false);
  store.setState(state => ({ projects: [mappers.toUiProject({ ...project, id: 'new', name: 'New' }), ...state.projects] }));
  release([{ ...project, name: 'Renamed remotely' }]);
  await pending;
  assert.equal(store.getState().projects.find(p => p.id === 'p').name, 'Renamed remotely');
  assert.equal(store.getState().projects.find(p => p.id === 'new').name, 'New');
});
