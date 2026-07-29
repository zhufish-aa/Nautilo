import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourceUrl = new URL("../src/renderer/src/lib/line-diff.ts", import.meta.url);

async function loadDiff() {
  const source = await readFile(sourceUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(transpiled)}`);
}

test("aligns unchanged lines around an edited line", async () => {
  const { diffLines } = await loadDiff();
  const rows = diffLines("a\nb\nc", "a\nB\nc");
  assert.deepEqual(rows.map((row) => row.type), ["same", "removed", "added", "same"]);
  assert.equal(rows[0].text, "a");
  assert.equal(rows[3].text, "c");
});

test("marks the differing middle of paired lines", async () => {
  const { diffLines } = await loadDiff();
  const rows = diffLines("const x = 1;", "const x = 2;");
  const removed = rows.find((row) => row.type === "removed");
  const added = rows.find((row) => row.type === "added");
  assert.deepEqual(removed.segments, [
    { text: "const x = ", changed: false },
    { text: "1", changed: true },
    { text: ";", changed: false }
  ]);
  assert.deepEqual(added.segments, [
    { text: "const x = ", changed: false },
    { text: "2", changed: true },
    { text: ";", changed: false }
  ]);
});

test("write operation renders every line as added", async () => {
  const { diffLines } = await loadDiff();
  const rows = diffLines("", "one\ntwo");
  assert.deepEqual(rows.map((row) => row.type), ["added", "added"]);
});

test("empty after renders every line as removed", async () => {
  const { diffLines } = await loadDiff();
  const rows = diffLines("one\ntwo", "");
  assert.deepEqual(rows.map((row) => row.type), ["removed", "removed"]);
});

test("multi-line replacement pairs only the shared prefix", async () => {
  const { diffLines } = await loadDiff();
  const rows = diffLines("x1\nx2\nx3", "y1\ny2");
  assert.deepEqual(rows.map((row) => row.type), ["removed", "removed", "removed", "added", "added"]);
  const firstRemoved = rows[0];
  const thirdRemoved = rows[2];
  assert.ok(firstRemoved.segments.some((segment) => segment.changed));
  assert.ok(thirdRemoved.segments.every((segment) => !segment.changed));
});
