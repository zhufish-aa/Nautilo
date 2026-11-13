import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const source = ts.transpileModule(readFileSync(new URL("../src/renderer/src/stores/harness-modes.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const instance = { id: "harness-deepseek", providerId: "deepseek", executable: "dsh" };
const catalog = { modes: [{ id: "standard" }, { id: "custom-workflow", name: "My workflow" }], defaultMode: "standard" };

function harness(requestCore, saved = new Map()) {
  const exports = {};
  let time = 0;
  vm.runInNewContext(source, {
    exports,
    Date: class extends Date { static now() { return time; } },
    localStorage: {
      getItem: key => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
      removeItem: key => saved.delete(key)
    },
    require: name => {
      if (name === "zustand") return { create };
      if (name === "zustand/middleware") return { createJSONStorage, persist };
      if (name === "../lib/bridge") return { requestCore };
      throw Error(`Unexpected dependency: ${name}`);
    }
  });
  return { store: exports.useHarnessModesStore, key: exports.harnessModeKey, saved, advance: ms => { time += ms; } };
}

test("mode discovery shares its first request and cached reads never restart loading", async () => {
  let calls = 0, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const { store, key, advance } = harness(async (method, input) => {
    calls++;
    assert.equal(method, "provider.modes");
    assert.equal(input.agentInstanceId, instance.id);
    return gate;
  });
  const first = store.getState().loadModes(instance);
  assert.equal(first, store.getState().loadModes(instance));
  assert.equal(store.getState().loading[key(instance)], true);
  finish(catalog);
  await first;
  advance(24 * 60 * 60 * 1000);
  const updates = [];
  const unsubscribe = store.subscribe(state => updates.push(state.loading[key(instance)]));
  await store.getState().loadModes(instance);
  await store.getState().loadModes(instance);
  unsubscribe();
  assert.equal(calls, 1);
  assert.deepEqual(updates, []);
  assert.equal(store.getState().catalogs[key(instance)], catalog);
});

test("saved native modes are immediately available after recreating the store", async () => {
  const original = harness(async () => catalog);
  await original.store.getState().loadModes(instance);
  let calls = 0;
  const restored = harness(async () => { calls++; throw Error("Should not discover again"); }, original.saved);
  assert.equal(restored.store.getState().catalogs[restored.key(instance)].modes[1].id, "custom-workflow");
  await restored.store.getState().loadModes(instance);
  assert.equal(calls, 0);
  assert.equal(restored.store.getState().loading[restored.key(instance)], undefined);
});

test("manual refresh shares requests, retains the roster on failure, and permits an explicit retry", async () => {
  let calls = 0, fail = false;
  const { store, key } = harness(async () => { calls++; if (fail) throw Error("Offline"); return catalog; });
  await store.getState().loadModes(instance);
  fail = true;
  const refresh = store.getState().loadModes(instance, true);
  assert.equal(refresh, store.getState().loadModes(instance, true));
  assert.equal(store.getState().catalogs[key(instance)], catalog);
  await refresh;
  assert.equal(store.getState().errors[key(instance)], true);
  assert.equal(store.getState().loading[key(instance)], false);
  await store.getState().loadModes(instance);
  assert.equal(calls, 2);
  fail = false;
  await store.getState().loadModes(instance, true);
  assert.equal(calls, 3);
  assert.equal(store.getState().errors[key(instance)], false);
});

test("changing the native executable loads its own catalog without reusing another installation", async () => {
  let calls = 0;
  const { store, key } = harness(async () => { calls++; return catalog; });
  const other = { ...instance, executable: "D:\\harness\\dsh.exe" };
  await store.getState().loadModes(instance);
  await store.getState().loadModes(other);
  assert.equal(calls, 2);
  assert.notEqual(key(instance), key(other));
});
