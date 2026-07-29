import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourceUrl = new URL("../src/renderer/src/lib/tool-timeline-groups.ts", import.meta.url);

async function loadGrouping() {
  const source = await readFile(sourceUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(transpiled)}`);
}

function event(id, data) {
  return {
    id,
    sessionId: "session-1",
    sequence: Number(id.replace(/\D/g, "")) || 0,
    timestamp: "2026-07-24T00:00:00.000Z",
    data
  };
}

test("streaming reasoning keeps the grouped activity and flow effect running", async () => {
  const { groupToolTimeline } = await loadGrouping();
  const grouped = groupToolTimeline([
    event("event-1", { kind: "tool_activity", toolName: "Read", status: "done" }),
    event("event-2", { kind: "reasoning", text: "Still thinking", streaming: true })
  ]);

  assert.equal(grouped[0].data.kind, "tool_group");
  assert.equal(grouped[0].data.running, true);
});

test("completed reasoning does not leave the grouped flow effect running", async () => {
  const { groupToolTimeline } = await loadGrouping();
  const grouped = groupToolTimeline([
    event("event-1", { kind: "tool_activity", toolName: "Read", status: "done" }),
    event("event-2", { kind: "reasoning", text: "Finished thinking", streaming: false })
  ]);

  assert.equal(grouped[0].data.kind, "tool_group");
  assert.equal(grouped[0].data.running, false);
});

test("a running verification also keeps the grouped activity running", async () => {
  const { groupToolTimeline } = await loadGrouping();
  const grouped = groupToolTimeline([
    event("event-1", { kind: "reasoning", text: "Run checks", streaming: false }),
    event("event-2", { kind: "verification", command: "pnpm test", status: "running", log: "" })
  ]);

  assert.equal(grouped[0].data.kind, "tool_group");
  assert.equal(grouped[0].data.running, true);
});

test("a sub-agent dispatch stays out of the collapsed group and splits the burst", async () => {
  const { groupToolTimeline } = await loadGrouping();
  const grouped = groupToolTimeline([
    event("event-1", { kind: "tool_activity", toolName: "Read", status: "done" }),
    event("event-2", { kind: "tool_activity", toolName: "Grep", status: "done" }),
    event("event-3", { kind: "tool_activity", toolName: "Task", status: "running", subagent: { agentType: "Explore", task: "调研登录模块" } }),
    event("event-4", { kind: "tool_activity", toolName: "Read", status: "done" }),
    event("event-5", { kind: "tool_activity", toolName: "Edit", status: "done" })
  ]);

  assert.equal(grouped.length, 3);
  assert.equal(grouped[0].data.kind, "tool_group");
  assert.equal(grouped[0].data.stepCount, 2);
  assert.equal(grouped[1].data.kind, "tool_activity");
  assert.equal(grouped[1].data.subagent.agentType, "Explore");
  assert.equal(grouped[2].data.kind, "tool_group");
  assert.equal(grouped[2].data.stepCount, 2);
});

test("a lone sub-agent dispatch renders as a single row", async () => {
  const { groupToolTimeline } = await loadGrouping();
  const grouped = groupToolTimeline([
    event("event-1", { kind: "tool_activity", toolName: "Task", status: "done", subagent: { task: "查一下报错" } })
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].data.kind, "tool_activity");
});
