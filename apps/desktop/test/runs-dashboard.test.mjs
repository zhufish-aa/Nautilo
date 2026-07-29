import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourceUrl = new URL("../src/renderer/src/lib/runs-dashboard.ts", import.meta.url);

async function loadDashboard() {
  const source = await readFile(sourceUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(transpiled)}`);
}

function session(id, overrides = {}) {
  return { id, title: id, unreadCount: 0, updatedAt: `2026-07-29T00:00:0${id}Z`, ...overrides };
}

test("groupSessionsForDashboard buckets waiting > running > unread", async () => {
  const { groupSessionsForDashboard } = await loadDashboard();
  const groups = groupSessionsForDashboard({
    sessions: [
      session("1"),
      session("2"),
      session("3"),
      session("4", { unreadCount: 3 }),
      session("5", { unreadCount: 2 })
    ],
    foreground: { "2": { status: "running" }, "3": { status: "waiting_approval" }, "5": { status: "running" } },
    running: {},
    pending: { "3": 1, "5": 2 }
  });
  // Pending wins over active and unread; active wins over unread.
  // (Recency order: synthetic updatedAt rises with the session id.)
  assert.deepEqual(groups.waiting.map((item) => item.id), ["5", "3"]);
  assert.deepEqual(groups.running.map((item) => item.id), ["2"]);
  assert.deepEqual(groups.unread.map((item) => item.id), ["4"]);
});

test("groupSessionsForDashboard sorts by recency and ignores idle read sessions", async () => {
  const { groupSessionsForDashboard } = await loadDashboard();
  const groups = groupSessionsForDashboard({
    sessions: [
      session("1", { unreadCount: 1, lastMessageAt: "2026-07-28T10:00:00Z" }),
      session("2", { unreadCount: 1, lastMessageAt: "2026-07-29T10:00:00Z" }),
      session("3")
    ],
    foreground: {},
    running: {},
    pending: {}
  });
  assert.deepEqual(groups.unread.map((item) => item.id), ["2", "1"]);
  assert.equal(groups.waiting.length, 0);
  assert.equal(groups.running.length, 0);
});
