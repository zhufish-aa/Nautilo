import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourceUrl = new URL("../src/renderer/src/lib/subagent-activities.ts", import.meta.url);

async function loadModule() {
  const dependency = ts.transpileModule(await readFile(new URL('../src/renderer/src/lib/process-display.ts', import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const dependencyUrl = `data:text/javascript,${encodeURIComponent(dependency)}`;
  const source = (await readFile(sourceUrl, "utf8")).replace('"./process-display"', JSON.stringify(dependencyUrl));
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(transpiled)}`);
}

let seq = 0;

test("native tool and command progress update one row without finishing it", async () => {
  const { collectSubagentActivities } = await loadModule();
  const events = [
    runtimeEvent("tool.started",{callId:"t",toolName:"read",subagentDispatchId:"d"}),
    runtimeEvent("tool.updated",{callId:"t",toolName:"read",outputSummary:"loading",subagentDispatchId:"d"}),
    runtimeEvent("command.started",{callId:"c",command:"fixture",cwd:"/",subagentDispatchId:"d"}),
    runtimeEvent("command.updated",{callId:"c",command:"fixture",outputSummary:"one line",subagentDispatchId:"d"})
  ];
  let bucket=collectSubagentActivities(events).get("d");
  assert.equal(bucket.length,2);
  assert.deepEqual(bucket.map(row=>row.status),["running","running"]);
  assert.deepEqual(bucket.map(row=>row.output),["loading","one line"]);
  events.push(runtimeEvent("tool.finished",{callId:"t",toolName:"read",success:true,outputSummary:"complete",subagentDispatchId:"d"}));
  events.push(runtimeEvent("tool.updated",{callId:"t",toolName:"read",outputSummary:"stale progress",subagentDispatchId:"d"}));
  bucket=collectSubagentActivities(events).get("d");
  assert.equal(bucket[0].status,"done");
  assert.equal(bucket[0].output,"complete");
});
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

test('native sub-agents retain PTC dispatch patches through updates and final completion', async () => {
  const {collectSubagentActivities} = await loadModule();
  const base = {callId:'code',toolName:'run_code',subagentDispatchId:'child'};
  const events = [runtimeEvent('tool.started',{...base,inputSummary:'{"description":"Inspect files","code":"fixture"}'}),
    runtimeEvent('tool.updated',{...base,codeExecution:{partial:true,calls:[{callId:'read',name:'read',input:{path:'main.ts'},status:'running'}]}}),
    runtimeEvent('tool.updated',{...base,codeExecution:{partial:true,calls:[{callId:'shell',name:'pwsh',status:'done'}]}}),
    runtimeEvent('tool.updated',{...base,codeExecution:{partial:true,calls:[{callId:'read',name:'read',status:'done',output:'contents'}]}}),
    runtimeEvent('tool.finished',{...base,success:true,codeExecution:{partial:true,calls:[]}})];
  const rows = collectSubagentActivities(events).get('child');
  assert.equal(rows.length,1);
  assert.equal(rows[0].status,'done');
  assert.equal(rows[0].input,events[0].payload.inputSummary);
  assert.deepEqual(rows[0].codeExecution.calls.map(call=>[call.callId,call.status]),[['read','done'],['shell','done']]);
});

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

test("cumulative daemon message updates replace one streaming message", async () => {
  const { collectSubagentActivities } = await loadModule();
  const events = [
    runtimeEvent("agent.message_delta", { messageId: "m-1", text: "你好", subagentDispatchId: "d-1" }),
    runtimeEvent("agent.message_delta", { messageId: "m-1", text: "你好，世界", subagentDispatchId: "d-1" })
  ];
  const bucket = collectSubagentActivities(events).get("d-1");
  assert.equal(bucket.length, 1);
  assert.equal(bucket[0].text, "你好，世界");
  assert.equal(bucket[0].streaming, true);
});


test("replayed cumulative updates never duplicate message content", async () => {
  const { collectSubagentActivities } = await loadModule();
  const update = runtimeEvent("agent.message_delta", { messageId: "m-1", text: "你好，世界", subagentDispatchId: "d-1" });
  const bucket = collectSubagentActivities([update, update]).get("d-1");
  assert.equal(bucket.length, 1);
  assert.equal(bucket[0].text, "你好，世界");
});
