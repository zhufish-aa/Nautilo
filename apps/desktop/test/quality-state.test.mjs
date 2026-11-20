import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import ts from "typescript";

function moduleAt(path) {
  const source = readFileSync(new URL(`../src/renderer/src/${path}`, import.meta.url), "utf8");
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports });
  return exports;
}
const { TimelinePositions, resolveReadingAnchor } = moduleAt("lib/timeline-position.ts");
const { EditorModelCache } = moduleAt("lib/editor-model-cache.ts");
const { lifecycleWithDelegates } = moduleAt("lib/session-lifecycle.ts");
const model = (size = 10) => ({ disposed: false, getValueLength() { return size; }, dispose() { this.disposed = true; } });

test("a retried child stays visible after the main turn ends without reopening successful siblings", () => {
  const complete = { status: "completed" };
  const retrying = [{ status: "completed" }, { status: "queued" }];
  assert.equal(lifecycleWithDelegates(complete, retrying).status, "running");
  assert.equal(lifecycleWithDelegates(complete, retrying).reason, "delegating");
  assert.equal(lifecycleWithDelegates(complete, [{ status: "completed" }, { status: "failed" }]), complete);
  const waiting = { status: "waiting_approval" };
  assert.equal(lifecycleWithDelegates(waiting, retrying), waiting);
});

test("folding activities and prepending history retain the nearest surviving reading row", () => {
  const previous = ["question", "turn", "tool-1", "tool-2", "final"];
  assert.equal(resolveReadingAnchor("tool-2", ["older", ...previous], previous), 4);
  assert.equal(resolveReadingAnchor("tool-2", ["older", "question", "turn", "final"], previous), 2);
  assert.equal(resolveReadingAnchor("final", ["question", "turn", "final"], previous), 2);
  assert.equal(resolveReadingAnchor("missing", previous, previous), -1);
});

test("reading memory preserves offsets and manual follow state while bounding inactive sessions", () => {
  const positions = new TimelinePositions(2);
  positions.set("a", { top: 240, rowKey: "stable-event", offset: -7, follow: false });
  positions.set("b", { top: 20, follow: true });
  assert.equal(positions.get("a").offset, -7);
  positions.set("c", { top: 10, follow: false });
  assert.equal(positions.get("b"), undefined);
  assert.equal(positions.get("a").follow, false);
  positions.set("a", { top: Number.NaN, follow: true });
  assert.equal(positions.get("a").top, 240);
});

test("500 file switches release detached Monaco models but keep the edited file and its reading position", () => {
  const cache = new EditorModelCache(), all = [];
  for (let i = 0; i < 500; i++) {
    const models = { modified: model(), original: model(), view: { top: i * 10 } };
    all.push(models); cache.set(`file-${i}`, models);
  }
  assert.equal(all.filter(item => !item.modified.disposed).length, 20);
  assert.equal(all.filter(item => !item.original.disposed).length, 20);
  assert.equal(cache.get("file-0"), undefined);
  assert.equal(cache.get("file-499").view.top, 4990);
  cache.get("file-480");
  cache.set("new-file", { modified: model() });
  assert.ok(cache.get("file-480"));
  assert.equal(cache.get("file-481"), undefined);
  cache.clear();
  assert.ok(all.every(item => item.modified.disposed && item.original.disposed));
});

test("an oversized active buffer stays available while the byte budget evicts detached buffers", () => {
  const cache = new EditorModelCache(), detached = model(6 * 1024 * 1024), active = model(9 * 1024 * 1024);
  cache.set("old", { modified: detached });
  cache.set("editing", { modified: active });
  assert.ok(detached.disposed);
  assert.equal(active.disposed, false);
  assert.equal(cache.get("editing").modified, active);
  cache.clear();
});
