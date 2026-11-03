import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/renderer/src/lib/conversation-timeline.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { conversationTimeline } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(compiled)}`);
const event = (id, data) => ({ id, sessionId: "s", timestamp: "2026-11-03T00:00:00Z", sequence: 0, data });
const message = (id, text) => event(id, { kind: "message", sender: "agent", text });
const tool = (id) => event(id, { kind: "tool_activity", toolName: "Read", status: "done" });
const group = (id, items) => event(id, { kind: "tool_group", items, callCount: items.length, stepCount: items.length, running: false });

test("messages and tools retain chronological order and original references", () => {
  const before = message("m1", "First, I will read the file.");
  const read = tool("t1");
  const reasoning = event("r1", { kind: "reasoning", text: "Thought", streaming: false });
  const after = message("m2", "Here is the change.");
  const rows = conversationTimeline([before, group("g1", [read, reasoning]), after]);
  assert.deepEqual(rows.map((row) => row.id), ["m1", "t1", "r1", "m2"]);
  assert.equal(rows[0], before);
  assert.equal(rows[1], read);
  assert.equal(rows[3], after);
});

test("nested groups preserve approvals, errors, handoffs and file rows", () => {
  const approval = event("a1", { kind: "approval", approval: { status: "pending" } });
  const error = event("e1", { kind: "error", message: "Failed" });
  const handoff = event("h1", { kind: "handoff" });
  const file = event("f1", { kind: "file_change", files: [] });
  assert.deepEqual(conversationTimeline([group("g", [approval, group("g2", [error, handoff]), file])]), [approval, error, handoff, file]);
});

test("only redundant usage/transient completion rows are suppressed", () => {
  const starting = event("start", { kind: "activity", phase: "starting" });
  const failed = event("failed", { kind: "run_status", run: { status: "failed" } });
  const waiting = event("waiting", { kind: "run_status", run: { status: "waiting_approval" } });
  assert.deepEqual(conversationTimeline([
    event("u", { kind: "usage" }), starting,
    event("done", { kind: "activity", phase: "completed" }),
    event("complete", { kind: "run_status", run: { status: "completed" } }), failed, waiting
  ]), [starting, failed, waiting]);
});

test("streaming patches change only their event identity, not historical rows", () => {
  const history = message("old", "Finished");
  const live = message("live", "Hello");
  const first = conversationTimeline([history, live]);
  const patched = { ...live, data: { ...live.data, text: "Hello there", streaming: true } };
  const second = conversationTimeline([history, patched]);
  assert.equal(second[0], first[0]);
  assert.equal(second[1].id, first[1].id);
  assert.notEqual(second[1], first[1]);
});
