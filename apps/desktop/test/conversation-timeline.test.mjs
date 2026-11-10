import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/renderer/src/lib/conversation-timeline.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { conversationTimeline, conversationRows } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(compiled)}`);
const policySource = await readFile(new URL("../src/renderer/src/lib/orchestration-timeline-policy.ts", import.meta.url), "utf8");
const policyCompiled = ts.transpileModule(policySource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { compactOrchestrationTimeline } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(policyCompiled)}`);
const event = (id, data) => ({ id, sessionId: "s", timestamp: "2026-11-03T00:00:00Z", sequence: 0, data });
const message = (id, text) => event(id, { kind: "message", sender: "agent", text });
const tool = (id) => event(id, { kind: "tool_activity", toolName: "Read", status: "done" });
const group = (id, items) => event(id, { kind: "tool_group", items, callCount: items.length, stepCount: items.length, running: false });

test("late background updates remain with their original turn while new replies keep their own rows",()=>{
  const user=(id)=>event(id,{kind:"message",sender:"user",text:id});
  const first={...tool("original-child"),runId:"r1"};
  const second={...message("new-reply","new answer"),runId:"r2"};
  const late={...message("late-child","background result"),runId:"r1",background:true};
  const rows=conversationRows([user("u1"),first,user("u2"),second,late],false);
  assert.equal(rows.length,4);
  assert.deepEqual(rows[1].turn.events.map(event=>event.id),["original-child","late-child"]);
  assert.deepEqual(rows[3].turn.events.map(event=>event.id),["new-reply"]);
  assert.equal(rows[3].turn.result.id,"new-reply");
});

test("turn elapsed time uses its foreground lifecycle and ignores late background work", () => {
  const timed = (id, time, data, runId, background = false) => ({...event(id, data), timestamp:`2026-11-06T00:${time}Z`, runId, background});
  const user = timed('u1', '00:00', {kind:'message', sender:'user', text:'one'});
  const start = timed('start', '00:01', {kind:'activity', phase:'starting'}, 'r1');
  const answer = timed('a1', '01:10', {kind:'message', sender:'agent', text:'answer'}, 'r1');
  const done = timed('done', '01:13', {kind:'activity', phase:'completed'}, 'r1');
  const nextUser = timed('u2', '02:00', {kind:'message', sender:'user', text:'two'});
  const late = timed('late', '05:00', {kind:'message', sender:'agent', text:'background', streaming:true}, 'r1', true);
  const rows = conversationRows([user, start, answer, done, nextUser, late], true);
  assert.equal(rows[1].turn.completed, true);
  assert.equal(rows[1].turn.durationMs, 72_000);
  assert.equal(rows[1].turn.id, 'turn-u1');
  const generating = conversationRows([user, start, {...answer, data:{...answer.data, streaming:true}}], true)[1].turn;
  assert.equal(generating.durationMs, undefined);
});

test("historical duration uses known timestamps without inventing missing or negative time", () => {
  const user = {...event('user', {kind:'message', sender:'user', text:'hi'}), timestamp:'2026-11-06T00:00:00Z'};
  const answer = {...message('answer','hello'), timestamp:'2026-11-06T00:00:03Z'};
  assert.equal(conversationRows([user, answer], false)[1].turn.durationMs, 3_000);
  assert.equal(conversationRows([{...user, timestamp:'missing'}, answer], false)[1].turn.durationMs, undefined);
  assert.equal(conversationRows([user, {...answer, timestamp:'2026-11-05T23:59:00Z'}], false)[1].turn.durationMs, undefined);
});

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
  ]), [failed, waiting]);
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


test("in-progress commentary and tools stay visible until a final result completes", () => {
  const user = event("user", { kind: "message", sender: "user", text: "Read the file" });
  const commentary = { ...message("comment", "Reading now"), runId: "r" };
  const command = { ...tool("read"), runId: "r" };
  const final = { ...message("answer", "Final answer"), runId: "r" };
  const live = { ...final, data: { ...final.data, streaming: true } };
  const running = conversationRows([user, commentary, command, live], true)[1].turn;
  assert.equal(running.completed, false);
  assert.equal(running.result, live, "the streamed reply and final reply use the same visible slot");
  assert.deepEqual(running.events.map(item => item.id), ["comment", "read", "answer"]);
  const completed = { ...event("done", { kind: "activity", phase: "completed" }), runId: "r" };
  const done = conversationRows([user, commentary, command, final, completed], true)[1].turn;
  assert.equal(done.completed, true);
  assert.equal(done.result, final);
  assert.equal(done.id, running.id);
  assert.deepEqual(done.events.map(item => item.id), ["comment", "read", "answer"]);
  assert.equal(conversationRows([user, commentary, command, live, completed], true)[1].turn.completed, false);
});

test("new user messages do not hide the previous final answer or collapse an unfinished run", () => {
  const user = event("u1", { kind: "message", sender: "user", text: "One" });
  const answer = { ...message("a1", "Answer one"), runId: "r1" };
  const nextUser = event("u2", { kind: "message", sender: "user", text: "Two" });
  const nextAnswer = { ...message("a2", "Answer two"), runId: "r2" };
  assert.equal(conversationRows([user, answer, nextUser, nextAnswer], true)[1].turn.completed, false);
  const done = { ...event("done", { kind: "activity", phase: "completed" }), runId: "r1" };
  const rows = conversationRows([user, answer, done, nextUser, nextAnswer], true);
  assert.equal(rows[1].turn.result, answer);
  assert.equal(rows[3].turn.completed, false);
  assert.deepEqual(rows.filter(row => row.kind === "event").map(row => row.event.id), ["u1", "u2"]);
});

const task = (id, taskId, status = "running") => event(id, {
  kind: "task_update", taskId, title: "Inspect the current directory", memberName: "Explorer", status, sessionId: `child-${taskId}`
});
const delegate = (id, receipt, extra = {}) => event(id, {
  kind: "tool_activity", toolName: "agenthub_delegate", status: "done",
  input: '{"memberId":"explorer","task":"Inspect the current directory"}',
  output: JSON.stringify(receipt), ...extra
});

test("dispatch receipts from Codex and MCP merge into one task without losing details", () => {
  const receipt = { accepted: true, tasks: [{ taskId: "t1" }] };
  const outputs = [
    receipt,
    { success: true, content: JSON.stringify(receipt) },
    { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(receipt) }] },
    { result: { content: [{ type: "text", text: JSON.stringify(receipt) }], isError: false } },
    { structuredContent: receipt }
  ];
  for (const output of outputs) {
    const call = delegate("call", output, { toolName: "mcp__nautilo__agenthub_delegate" });
    const dispatched = task("task-row", "t1");
    const reply = message("reply", "Delegated.");
    const rows = conversationTimeline([group("g", [call]), reply, dispatched]);
    assert.deepEqual(rows.map(row => row.id), ["reply", "task-row"]);
    assert.equal(rows[0], reply);
    assert.equal(rows[1].data.sessionId, "child-t1");
    assert.deepEqual(rows[1].data.dispatchCall, { toolName: call.data.toolName, input: call.data.input, output: call.data.output });
    assert.equal(dispatched.data.dispatchCall, undefined, "source history is untouched");
    assert.equal(conversationTimeline([call, reply, dispatched])[1], rows[1], "unchanged task cards retain identity");
  }
});

test("a task keeps its row ID and child link when a receipt arrives and status updates", () => {
  const dispatched = task("task-row", "t1");
  const starting = delegate("call", {}, { status: "running", output: undefined });
  assert.deepEqual(conversationTimeline([starting, dispatched]), [starting, dispatched]);
  const finished = delegate("call", { accepted: true, tasks: [{ taskId: "t1" }] });
  const running = conversationTimeline([finished, dispatched]);
  const completed = { ...dispatched, data: { ...dispatched.data, status: "completed" } };
  const done = conversationTimeline([finished, completed]);
  assert.equal(running.length, 1);
  assert.equal(done.length, 1);
  assert.equal(done[0].id, running[0].id);
  assert.equal(done[0].data.status, "completed");
  assert.equal(done[0].data.sessionId, running[0].data.sessionId);
});

test("failed, incomplete, unrelated and native calls stay visible", () => {
  const receipt = { accepted: true, tasks: [{ taskId: "t1" }] };
  const dispatched = task("task-row", "t1");
  const calls = [
    delegate("failed", receipt, { status: "failed" }),
    delegate("rejected", { accepted: false, tasks: receipt.tasks }),
    delegate("error", { isError: true, content: JSON.stringify(receipt) }),
    delegate("unsuccessful", { success: false, contentItems: [{ text: JSON.stringify(receipt) }] }),
    delegate("incomplete", {}, { output: '{"tasks":[' }),
    delegate("unmatched", { accepted: true, tasks: [{ taskId: "missing" }] }),
    delegate("other-tool", receipt, { toolName: "read_file" }),
    delegate("native", receipt, { subagent: { task: "Inspect the current directory" } }),
    { ...delegate("other-session", receipt), sessionId: "another-session" }
  ];
  assert.deepEqual(conversationTimeline([...calls, dispatched]), [...calls, dispatched]);
});

test("multi-task receipts only merge when every delegated task is represented", () => {
  const call = delegate("call", { accepted: true, tasks: [{ taskId: "t1" }, { taskId: "t2" }] });
  const first = task("row1", "t1");
  const second = task("row2", "t2");
  assert.deepEqual(conversationTimeline([call, first]), [call, first]);
  const rows = conversationTimeline([call, first, second]);
  assert.deepEqual(rows.map(row => row.id), ["row1", "row2"], "identical titles do not collapse distinct tasks");
  assert.ok(rows.every(row => row.data.dispatchCall?.output === call.data.output));
});

test("approval receipts keep the approval and waiting task visible", () => {
  const approval = event("approval", { kind: "approval", approval: { status: "pending" } });
  const dispatched = task("task-row", "t1", "waiting_approval");
  const call = delegate("call", { accepted: false, approvalRequired: true, tasks: [{ taskId: "t1" }] });
  const rows = conversationTimeline([call, approval, dispatched]);
  assert.deepEqual(rows.map(row => row.id), ["approval", "task-row"]);
  assert.equal(rows[0], approval);
  assert.equal(rows[1].data.status, "waiting_approval");
});

const legacyTask = (id, taskId) => {
  const row = task(id, taskId);
  return { ...row, data: { ...row.data, memberId: "explorer", objective: "Inspect the current directory" } };
};

test("legacy Codex calls without results merge at the initial task position through completion", () => {
  const before = message("before", "I will delegate");
  const created = { ...legacyTask("task-row", "t1"), sequence: 35 };
  const call = { ...delegate("call", undefined), sequence: 36 };
  const checking = message("checking", "I will check the result");
  const command = tool("command");
  const done = { ...created, id: "task-completed", sequence: 84, timestamp: "2026-11-03T00:01:30Z", data: { ...created.data, status: "completed" } };
  const inputs = [before, created, call, checking, command];
  const first = conversationTimeline(compactOrchestrationTimeline(inputs));
  const final = conversationTimeline(compactOrchestrationTimeline([...inputs, done]));
  assert.deepEqual(final.map(row => row.id), ["before", "task-row", "checking", "command"]);
  assert.deepEqual(final.map(row => row.id), first.map(row => row.id));
  assert.equal(final[1].sequence, 35);
  assert.equal(final[1].timestamp, created.timestamp);
  assert.equal(final[1].data.status, "completed");
  assert.equal(final[1].data.sessionId, "child-t1");
  assert.equal(final[1].data.dispatchCall.input, call.data.input);
  assert.equal(created.data.status, "running", "source events remain immutable");
});

test("legacy fallback does not match across turns, members, objectives or ambiguous repeats", () => {
  const call = delegate("call", undefined);
  const dispatched = legacyTask("task-row", "t1");
  const nextUser = event("user2", { kind: "message", sender: "user", text: "Again" });
  const variants = [
    [call, nextUser, dispatched],
    [call, { ...dispatched, data: { ...dispatched.data, memberId: "other" } }],
    [call, { ...dispatched, data: { ...dispatched.data, objective: "A different task" } }],
    [call, dispatched, legacyTask("task-row2", "t2")],
    [call, delegate("call2", undefined), dispatched],
    [delegate("failed", undefined, { status: "failed" }), dispatched],
    [delegate("incomplete", undefined, { input: '{"memberId":' }), dispatched],
    [delegate("partial-result", undefined, { output: '{"tasks":[' }), dispatched]
  ];
  for (const input of variants) assert.deepEqual(conversationTimeline(input), input);
});
