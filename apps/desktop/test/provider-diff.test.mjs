import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, helperModules } from "./helpers/orchestration-runtime-harness.mjs";
const { parseProviderDiff } = helperModules["./provider-diff"];
const { collectChangedFiles } = helperModules["./changed-files"];
const plain = (value) => JSON.parse(JSON.stringify(value));
const patch = (path, text = "new") => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${text}\n`;
const file = (path, diff = patch(path)) => ({ path, diff, changeType: "modified", additions: 1, deletions: 1 });
const row = (id, runId, data, sessionId = "s") => ({ id, runId, sessionId, timestamp: "2026-11-03T00:00:00Z", sequence: +id || 0, data });
const native = (id, run, paths, session = "s") => row(id, run, { kind: "file_change", source: "provider", replace: true, files: paths.map((path) => file(path)) }, session);
const item = (id, run, path, session = "s") => row(id, run, { kind: "file_change", files: [file(path)] }, session);
const paths = (events) => Array.from(collectChangedFiles(events), (file) => file.path);
const runtime = (seq, type, payload, runId = "r", sessionId = "s") => ({ eventId: `e${seq}`, sequence: seq, schemaVersion: 1, projectId: "p", sessionId, runId, type, timestamp: `2026-11-03T00:00:${String(seq).padStart(2, "0")}Z`, payload });
const nativeEvent = (seq, diff, runId = "r") => runtime(seq, "run.diff_updated", { diff, source: "provider", providerThreadId: "thread", providerTurnId: "turn" }, runId);

test("provider parser preserves patches, counts hunks, handles add/delete/rename/binary and quoted UTF8 paths", () => {
  assert.deepEqual(plain(parseProviderDiff(patch("folder/a file.ts"))), [file("folder/a file.ts")]);
  const added = "diff --git a/new b/new\nnew file mode 100644\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+hello\n";
  const deleted = "diff --git a/old b/old\ndeleted file mode 100644\n--- a/old\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n";
  const rename = "diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n";
  const binary = "diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n";
  assert.deepEqual(Array.from(parseProviderDiff(added + deleted + rename + binary), (f) => [f.path, f.changeType, f.additions, f.deletions]), [["new", "added", 1, 0], ["old", "deleted", 0, 1], ["b", "modified", 0, 0], ["image.png", "modified", 0, 0]]);
  const quoted = 'diff --git "a/\\344\\275\\240.txt" "b/\\344\\275\\240.txt"\n--- "a/\\344\\275\\240.txt"\n+++ "b/\\344\\275\\240.txt"\n@@ -1 +1 @@\n-x\n+y\n';
  assert.equal(parseProviderDiff(quoted)[0].path, "你.txt");
  assert.equal(parseProviderDiff("").length, 0);
  assert.equal(parseProviderDiff("unrecognized raw content").length, 0);
});

test("latest native snapshot replaces its run including empty, suppresses late item/tool patches", () => {
  const events = [item("1", "r", "old"), native("2", "r", ["a", "b"]), native("3", "r", ["a"]), item("4", "r", "late"), row("5", "r", { kind: "tool_activity", toolName: "Write", fileDiff: { path: "tool", before: "", after: "x" } })];
  assert.deepEqual(paths(events), ["a"]);
  assert.deepEqual(paths([...events, native("6", "r", [])]), []);
});

test("native withdrawal preserves other runs and sessions, including same-path fallback and nested groups", () => {
  const other = item("1", "other", "same");
  const foreign = item("2", "r", "foreign", "other-session");
  const grouped = row("3", "r", { kind: "tool_group", items: [native("4", "r", ["same", "withdrawn"]), native("5", "r", [])] });
  assert.deepEqual(paths([other, foreign, grouped]), ["same", "foreign"]);
});

test("runtime replays native snapshots once, carries scope, suppresses legacy patch rows and keeps raw artifact", () => {
  const h = createHarness();
  const events = [runtime(1, "file.changed", { path: "old", changeType: "modified", diff: patch("old") }), nativeEvent(2, patch("a") + patch("b")), nativeEvent(3, patch("a")), runtime(4, "file.changed", { path: "late", changeType: "modified", diff: patch("late") })];
  const timeline = h.runtime.buildStandaloneTimeline([], events, []);
  assert.deepEqual(paths(timeline), ["a"]);
  const empty = h.runtime.buildStandaloneTimeline([], [...events, nativeEvent(5, "")], []);
  assert.deepEqual(paths(empty), []);
  const artifact = { id: "native-diff:r", kind: "diff", name: "r.native.diff.json", metadata: { source: "provider", runId: "r" }, content: JSON.stringify({ files: [], diff: patch("a"), source: "provider" }) };
  const ui = h.runtime.toUiArtifact(artifact)[0];
  assert.equal(ui.content, patch("a"));
  assert.equal(ui.diffSource, "provider");
  assert.equal(h.runtime.toUiArtifact({ ...artifact, content: JSON.stringify({ files: [], diff: "" }) })[0].content, "");
  const warning = h.runtime.toUiArtifact({ ...artifact, metadata: { comparisonUnavailable: true, source: "filesystem" } })[0];
  assert.equal(warning.comparisonUnavailable, true);
  assert.equal(warning.diffSource, "filesystem");
});

test("native cache is bounded per run/session and latest snapshot replaces, never concatenates", () => {
  const h = createHarness();
  let events = [];
  for (let i = 1; i < 100; i++) events = h.runtime.mergeEventCache(events, [nativeEvent(i, patch("a", String(i)))]);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.diff, patch("a", "99"));
  assert.equal(events[0].eventId, "e1");
  events = h.runtime.mergeEventCache(events, [nativeEvent(100, ""), nativeEvent(101, patch("other"), "other")]);
  assert.equal(events.length, 2);
  assert.equal(events[0].payload.diff, "");
  assert.deepEqual(paths(h.runtime.buildStandaloneTimeline([], events, [])), ["other"]);
});

test("filesystem artifact from another run cannot overwrite an item diff on the same path", () => {
  const h = createHarness();
  const artifact = { id: "fs", kind: "diff", sessionId: "s", metadata: { runId: "other", source: "filesystem" }, content: JSON.stringify({ files: [file("a", "wrong run")] }) };
  const events = [runtime(1, "file.changed", { path: "a", changeType: "modified", diff: "this run" })];
  assert.equal(collectChangedFiles(h.runtime.buildStandaloneTimeline([], events, [artifact]))[0].diff, "this run");
});

test("incomplete per-file comparisons stay unknown despite tool fallback and promote artifact warning", () => {
  const h = createHarness();
  const unavailable = { ...file("a"), diff: undefined, comparisonUnavailable: true, reason: "baseline_excluded" };
  const events = [row("1", "r", { kind: "file_change", files: [unavailable] }), row("2", "r", { kind: "tool_activity", toolName: "Write", fileDiff: { path: "a", before: "", after: "x" } })];
  const collected = collectChangedFiles(events)[0];
  assert.equal(collected.kind, "patch");
  assert.equal(collected.comparisonUnavailable, true);
  assert.equal(collected.diff, undefined);
  assert.equal(h.runtime.toUiArtifact({ id: "fs", kind: "diff", content: JSON.stringify({ files: [unavailable] }) })[0].comparisonUnavailable, true);
});

test("late lower-sequence native snapshot cannot resurrect cleared files", () => {
  const h = createHarness();
  const events = h.runtime.mergeEventCache([nativeEvent(5, "")], [nativeEvent(3, patch("old"))]);
  assert.equal(events[0].payload.diff, "");
});

test("native diff update bursts avoid metadata refresh; terminal events still refresh raw artifacts", () => {
  const h = createHarness();
  assert.equal(h.runtime.needsStandalonePersistenceSync([nativeEvent(1, patch("a")), runtime(2, "artifact.created", { kind: "diff", artifactId: "native-diff:r" })]), false);
  assert.equal(h.runtime.needsStandalonePersistenceSync([runtime(3, "run.completed", {})]), true);
  assert.equal(h.runtime.needsStandalonePersistenceSync([runtime(4, "artifact.created", { kind: "image", artifactId: "image" })]), true);
});
