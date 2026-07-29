import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourceUrl = new URL("../src/renderer/src/lib/subagent-activities.ts", import.meta.url);

async function loadModule() {
  const source = await readFile(sourceUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(transpiled)}`);
}

let seq = 0;
function runtimeEvent(type, payload) {
  seq += 1;
  return {
    schemaVersion: 1,
    eventId: `ev-${seq}`,
    sequence: seq,
    projectId: "proj-1",
    runId: "run-1",
    sessionId: "sess-1",
    type,
    timestamp: "2026-07-28T00:00:00.000Z",
    payload
  };
}

test("sub-agent events are bucketed by dispatch id and merged per call", async () => {
  const { collectSubagentActivities, subagentDispatchIdOf } = await loadModule();
  const events = [
    runtimeEvent("tool.started", { callId: "toolu-1", toolName: "Agent", inputSummary: "调研" }),
    runtimeEvent("agent.message", { messageId: "m-1", text: "主 agent 说话" }),
    runtimeEvent("agent.thinking_delta", { messageId: "t-1", text: "思考中", subagentDispatchId: "toolu-1" }),
    runtimeEvent("agent.message", { messageId: "m-2", text: "子 agent 报告", subagentDispatchId: "toolu-1" }),
    runtimeEvent("tool.started", { callId: "toolu-9", toolName: "Read", inputSummary: "/a.ts", subagentDispatchId: "toolu-1" }),
    runtimeEvent("tool.finished", { callId: "toolu-9", toolName: "Read", success: true, outputSummary: "文件内容", subagentDispatchId: "toolu-1" }),
    runtimeEvent("agent.message", { messageId: "m-3", text: "另一个子 agent", subagentDispatchId: "toolu-2" })
  ];

  assert.equal(subagentDispatchIdOf(events[1]), undefined);
  assert.equal(subagentDispatchIdOf(events[2]), "toolu-1");

  const buckets = collectSubagentActivities(events);
  assert.equal(buckets.size, 2);
  const activities = buckets.get("toolu-1");
  assert.equal(activities.length, 3);
  assert.deepEqual(activities.map((item) => item.kind), ["reasoning", "message", "tool_activity"]);
  const tool = activities[2];
  assert.equal(tool.status, "done");
  assert.equal(tool.output, "文件内容");
  assert.equal(buckets.get("toolu-2").length, 1);
});

test("message deltas accumulate into one streaming message", async () => {
  const { collectSubagentActivities } = await loadModule();
  const events = [
    runtimeEvent("agent.message_delta", { messageId: "m-1", text: "你好", subagentDispatchId: "d-1" }),
    runtimeEvent("agent.message_delta", { messageId: "m-1", text: "，世界", subagentDispatchId: "d-1" })
  ];
  const bucket = collectSubagentActivities(events).get("d-1");
  assert.equal(bucket.length, 1);
  assert.equal(bucket[0].text, "你好，世界");
  assert.equal(bucket[0].streaming, true);
});
