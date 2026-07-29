import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourceUrl = new URL("../src/renderer/src/lib/notification-policy.ts", import.meta.url);

async function loadPolicy() {
  const source = await readFile(sourceUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(transpiled)}`);
}

test("terminalTransition only fires on active → terminal", async () => {
  const { terminalTransition } = await loadPolicy();
  assert.equal(terminalTransition({ status: "running" }, { status: "completed" }), "completed");
  assert.equal(terminalTransition({ status: "waiting_approval" }, { status: "failed" }), "failed");
  assert.equal(terminalTransition({ status: "running" }, { status: "cancelled" }), "cancelled");
  // Still active, cleared, or already terminal: no notification.
  assert.equal(terminalTransition({ status: "running" }, { status: "waiting_approval" }), undefined);
  assert.equal(terminalTransition({ status: "running" }, undefined), undefined);
  assert.equal(terminalTransition({ status: "completed" }, { status: "completed" }), undefined);
  assert.equal(terminalTransition(undefined, { status: "completed" }), undefined);
});

test("shouldNotify skips the session the user is watching", async () => {
  const { shouldNotify } = await loadPolicy();
  assert.equal(shouldNotify("s1", "s1", false), false);
  assert.equal(shouldNotify("s1", "s1", true), true);
  assert.equal(shouldNotify("s1", "s2", false), true);
  assert.equal(shouldNotify("s1", undefined, false), true);
});

test("pendingCountsBySession counts only pending interactions", async () => {
  const { pendingCountsBySession } = await loadPolicy();
  assert.deepEqual(pendingCountsBySession({
    s1: [{ status: "pending" }, { status: "resolved" }, { status: "pending" }],
    s2: [{ status: "cancelled" }],
    s3: []
  }), { s1: 2 });
});
