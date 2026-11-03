import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(
  new URL("../src/renderer/src/stores/provider-tools.ts", import.meta.url),
  "utf8",
);
let calls = [];
let outcome = [];
let rejectImport = false;
globalThis.__capabilityTestRequest = async (method, payload) => {
  calls.push({ method, payload });
  if (method === "capability.importMany") {
    if (rejectImport) throw new Error("Import unavailable");
    return { results: outcome };
  }
  if (method === "capability.list")
    return [{ id: "daemon-resolved", name: "renamed-on-server" }];
  if (method === "capability.parseImport")
    return { candidates: [], errors: [] };
  throw new Error("Unexpected method");
};
const compiled = ts
  .transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  })
  .outputText.replace(
    'from "zustand"',
    `from ${JSON.stringify(import.meta.resolve("zustand"))}`,
  )
  .replace(
    'import { requestCore } from "../lib/bridge";',
    "const requestCore = (...args) => globalThis.__capabilityTestRequest(...args);",
  );
const { useProviderToolsStore: store } = await import(
  `data:text/javascript;charset=utf-8,${encodeURIComponent(compiled)}`
);
test.beforeEach(() => {
  calls = [];
  outcome = [];
  rejectImport = false;
  store.setState({ tools: [], loaded: false });
});
for (const policy of ["skip", "overwrite", "rename"])
  test(`importMany forwards ${policy} to Core and reloads daemon-resolved records`, async () => {
    const items = [{ kind: "mcp", name: "fixture", enabled: false }];
    outcome = [
      {
        name: "fixture",
        status:
          policy === "skip"
            ? "skipped"
            : policy === "overwrite"
              ? "updated"
              : "created",
      },
    ];
    assert.deepEqual(await store.getState().importMany(items, policy), outcome);
    assert.deepEqual(calls[0], {
      method: "capability.importMany",
      payload: { items, onConflict: policy },
    });
    assert.equal(calls[1].method, "capability.list");
    assert.equal(store.getState().tools[0].id, "daemon-resolved");
    assert.equal(
      calls.some(({ method }) => /start|spawn|launch/.test(method)),
      false,
    );
  });
test("partial failures preserve each outcome and still refresh successful imports", async () => {
  outcome = [
    { name: "one", status: "created", capabilityId: "a" },
    { name: "two", status: "failed", error: "Validation failed" },
    { name: "three", status: "skipped" },
  ];
  assert.deepEqual(await store.getState().importMany([], "skip"), outcome);
  assert.equal(store.getState().loaded, true);
});
test("rejected import propagates error without pretending success or starting processes", async () => {
  rejectImport = true;
  await assert.rejects(
    store.getState().importMany([], "rename"),
    /Import unavailable/,
  );
  assert.equal(calls.length, 1);
  assert.equal(store.getState().loaded, false);
});
test("JSON parsing delegates original source to Core rather than renderer parsing", async () => {
  const input = {
    source: "mcpJson",
    text: '{"mcpServers":{}}',
    fileName: "mcp.json",
  };
  await store.getState().parseImport(input);
  assert.deepEqual(calls, [
    { method: "capability.parseImport", payload: input },
  ]);
});
