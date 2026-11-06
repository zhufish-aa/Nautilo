import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { projectFixture, settle } from "./helpers/project-poll-harness.mjs";

test("real bootstrap hydrates each live project once and keeps project inspection lazy", async () => {
  const h = projectFixture(1);
  h.replies["projectRun.list"] = [h.projectRun];
  const hydrations = [], notifications = [];
  const store = (name) => ({ getState: () => ({ hydrate: async (...args) => { hydrations.push([name, ...args]); }, load: async () => {} }) });
  const modules = {
    "./bridge": { getBridge: () => ({}) },
    "./orchestration-runtime": h.runtime,
    "./notifications": { startNotificationWatcher: () => notifications.push(true) },
    "../stores/projects": { useProjectsStore: store("projects") },
    "../stores/agents": { useAgentsStore: store("agents") },
    "../stores/providers": { useProvidersStore: store("providers") },
    "../stores/provider-tools": { useProviderToolsStore: store("tools") },
    "../stores/teams": { useTeamsStore: store("teams") },
    "../stores/connections": { useConnectionsStore: store("connections") }
  };
  const source = readFileSync(new URL("../src/renderer/src/lib/core-bootstrap.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (name) => modules[name] });
  await settle(h, () => exports.initializeCoreState());
  assert.equal(h.calls.filter((c) => c.method === "projectRun.get").length, 1);
  assert.equal(h.calls.filter((c) => c.method === "projectRun.list").length, 2, "resume reads a fresh index");
  assert.deepEqual(hydrations.find(([name]) => name === "projects"), ["projects", false]);
  assert.equal(notifications.length, 1);
  assert.deepEqual(hydrations.find(([name]) => name === "connections"), ["connections"]);
  await settle(h, () => exports.initializeCoreState());
  assert.equal(h.calls.filter((c) => c.method === "projectRun.get").length, 1, "bootstrap is idempotent");
});
