import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../src/renderer/src/lib/sidebar-navigation.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { sessionLocation, searchSidebarSessions, visibleSidebarEntries, groupSidebarEntries, UNGROUPED_PROJECT } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(output)}`);

test("history routes use one workspace regardless of legacy mode and encode IDs", () => {
  assert.equal(sessionLocation({ id: "a&b", mode: "work" }), "/sessions?session=a%26b");
  assert.equal(sessionLocation({ id: "code/1" }), "/sessions?session=code%2F1");
});

test("search matches title and project, retains both modes, and never sorts store in place", () => {
  const sessions = [
    { id: "a", title: "Old task", projectId: "p", updatedAt: "2026-01-01", mode: "code" },
    { id: "b", title: "New notes", projectId: "p", updatedAt: "2026-01-03", mode: "work" },
    { id: "c", title: "Unrelated", projectId: "q", updatedAt: "2026-01-02" }
  ];
  assert.deepEqual(searchSidebarSessions(sessions, [{ id: "p", name: "Nautilo" }], "  NAUTILO ").map(s => s.id), ["b", "a"]);
  assert.deepEqual(searchSidebarSessions(sessions, [], "notes").map(s => s.id), ["b"]);
  assert.deepEqual(searchSidebarSessions(sessions, [], "").map(s => s.id), ["b", "c", "a"]);
  assert.deepEqual(sessions.map(s => s.id), ["a", "b", "c"]);
  assert.deepEqual(searchSidebarSessions(sessions, [], "missing"), []);
});

test("long histories are bounded but selected descendants retain their ancestry", () => {
  const entries = Array.from({ length: 1000 }, (_, index) => ({ session: { id: String(index) }, depth: 0 }));
  entries[999].depth = 2;
  entries[998].depth = 1;
  assert.equal(visibleSidebarEntries(entries, 60).length, 60);
  const visible = visibleSidebarEntries(entries, 60, "999");
  assert.equal(visible.length, 63);
  assert.deepEqual(visible.slice(-3).map(entry => entry.session.id), ["997", "998", "999"]);
  assert.equal(visibleSidebarEntries(entries, 60, "10").length, 60);
  assert.equal(entries.length, 1000);
});

test("projects contain their sessions once and preserve empty projects and orphans", () => {
  const entries = [
    { session: { id: "a", projectId: "p" }, depth: 0 },
    { session: { id: "b", projectId: "p" }, depth: 1 },
    { session: { id: "c", projectId: "removed" }, depth: 0 },
    { session: { id: "d", projectId: "" }, depth: 0 }
  ];
  const groups = groupSidebarEntries(entries, [{ id: "p", name: "Project" }, { id: "empty", name: "Empty" }]);
  assert.deepEqual(groups.map(([id, rows]) => [id, rows.map(entry => entry.session.id)]), [["p", ["a", "b"]], ["empty", []], [UNGROUPED_PROJECT, ["c", "d"]]]);
  assert.equal(groups.flatMap(([, rows]) => rows).length, entries.length);
});
