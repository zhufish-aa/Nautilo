import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourceUrl = new URL("../src/renderer/src/lib/session-tree.ts", import.meta.url);

async function loadSessionTree() {
  const source = await readFile(sourceUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(transpiled)}`);
}

function session(id, updatedAt, parentSessionId, projectId = "project-1") {
  return {
    id,
    projectId,
    target: { type: "agent", instanceId: id },
    title: id,
    status: "idle",
    parentSessionId,
    unreadCount: 0,
    createdAt: updatedAt,
    updatedAt
  };
}

test("children remain directly below their parent instead of joining the global time order", async () => {
  const { flattenSessionForest } = await loadSessionTree();
  const entries = flattenSessionForest([
    session("parent", "2026-07-20T01:00:00.000Z"),
    session("other", "2026-07-20T03:00:00.000Z"),
    session("child", "2026-07-20T04:00:00.000Z", "parent")
  ]);

  assert.deepEqual(entries.map(({ session: item }) => item.id), ["parent", "child", "other"]);
  assert.deepEqual(entries.map(({ depth }) => depth), [0, 1, 0]);
});

test("multi-level descendants are flattened depth-first", async () => {
  const { flattenSessionForest } = await loadSessionTree();
  const entries = flattenSessionForest([
    session("parent", "2026-07-20T03:00:00.000Z"),
    session("child", "2026-07-20T02:00:00.000Z", "parent"),
    session("grandchild", "2026-07-20T01:00:00.000Z", "child")
  ]);

  assert.deepEqual(entries.map(({ session: item, depth }) => [item.id, depth]), [
    ["parent", 0],
    ["child", 1],
    ["grandchild", 2]
  ]);
});

test("recent activity in a child lifts the complete parent tree", async () => {
  const { flattenSessionForest } = await loadSessionTree();
  const entries = flattenSessionForest([
    session("parent", "2026-07-20T01:00:00.000Z"),
    session("child", "2026-07-20T10:00:00.000Z", "parent"),
    session("other", "2026-07-20T09:00:00.000Z")
  ]);

  assert.deepEqual(entries.map(({ session: item }) => item.id), ["parent", "child", "other"]);
});

test("orphaned, self-parented, cyclic, and cross-project sessions remain visible as roots", async () => {
  const { flattenSessionForest } = await loadSessionTree();
  const entries = flattenSessionForest([
    session("orphan", "2026-07-20T06:00:00.000Z", "missing"),
    session("self", "2026-07-20T05:00:00.000Z", "self"),
    session("cycle-a", "2026-07-20T04:00:00.000Z", "cycle-b"),
    session("cycle-b", "2026-07-20T03:00:00.000Z", "cycle-a"),
    session("other-project-parent", "2026-07-20T02:00:00.000Z", undefined, "project-2"),
    session("cross-project-child", "2026-07-20T01:00:00.000Z", "other-project-parent")
  ]);

  assert.deepEqual(new Set(entries.map(({ session: item }) => item.id)), new Set([
    "orphan",
    "self",
    "cycle-a",
    "cycle-b",
    "other-project-parent",
    "cross-project-child"
  ]));
  assert.ok(entries.every(({ depth }) => depth === 0));
});
