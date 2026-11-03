import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../src/renderer/src/lib/timeline-row-keys.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { reconcileTimelineKeys } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(compiled)}`);
const rows = (...keys) => keys.map((key) => ({ key, render: () => "updated content" }));

test("new arrays and row renderers preserve the virtualizer's key callback for unchanged order", () => {
  const first = reconcileTimelineKeys(undefined, rows("one", "two"), "s");
  for (let i = 0; i < 120; i++) assert.equal(reconcileTimelineKeys(first, rows("one", "two"), "s"), first);
  assert.deepEqual([0, 1, 2].map(first.getItemKey), ["one", "two", "2"]);
});

test("reorder, insertion, deletion, same-count replacement, and session change invalidate measurements", () => {
  const first = reconcileTimelineKeys(undefined, rows("one", "two"), "s");
  for (const [next, session] of [[rows("two", "one"), "s"], [rows("one", "new", "two"), "s"], [rows("one"), "s"], [rows("one", "new"), "s"], [rows("one", "two"), "other"]]) {
    const updated = reconcileTimelineKeys(first, next, session);
    assert.notEqual(updated.getItemKey, first.getItemKey);
    assert.deepEqual(next.map((_, index) => updated.getItemKey(index)), next.map((row) => row.key));
    assert.equal(first.getItemKey(1), "two", "old callbacks retain their snapshot, not a mutable ref");
  }
});
