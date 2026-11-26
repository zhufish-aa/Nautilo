import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/renderer/src/lib/session-timeline.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { openTimeline, applyTimelineChanges, timelineEntries } = await import(`data:text/javascript,${encodeURIComponent(outputText)}`);
const policy = await readFile(new URL("../src/renderer/src/lib/orchestration-timeline-policy.ts", import.meta.url), "utf8");
const { withoutDelegationReceipt } = await import(`data:text/javascript,${encodeURIComponent(ts.transpileModule(policy, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText)}`);

const block = (seq, kind, runId, text, sealed = true) => ({
  seq, blockId: `b${seq}`, runId, kind, content: { text }, sealed, status: null, result: null
});
const turn = (runId, status, finalBlockId = null) => ({ runId, status, finalBlockId, durationMs: status === "running" ? null : 3400 });
const page = (revision, operations, change = null) => ({ reset: false, revision, changes: [{ operations, turn: change }] });
const created = (...blocks) => blocks.map(block => ({ type: "block_created", block }));
const seal = (blockId) => ({ type: "block_updated", blockId, sealed: true });
const delta = (blockId, text) => ({ type: "block_delta", blockId, text });
const shape = (timeline, expanded = true) => timelineEntries(timeline)
  .filter(entry => expanded || !entry.process)
  .map(entry => entry.block
    ? entry.block.seq : entry.summary ? ["summary", entry.summary.runId] : [entry.turn.status, entry.process.map(block => block.seq)]);

test("the workflow plan and both parts of the process stay below a single disclosure", () => {
  const plan = { ...block(3, "notice", null, ""), content: { type: "workflow.plan", payload: { plan: { id: "r1" } } } };
  const timeline = openTimeline({ revision: 1, blocks: [
    block(1, "user_prompt", "r1", "First"), block(2, "thinking", "r1", "Before plan"),
    plan, block(4, "tool_call", "r1", "After plan"), block(5, "assistant_text", "r1", "Final"),
    block(6, "user_prompt", "r2", "Second"), block(7, "assistant_text", "r2", "Other reply")
  ], turns: [turn("r1", "completed", "b5"), turn("r2", "completed", "b7")] });
  assert.deepEqual(shape(timeline), [1, ["summary", "r1"], ["completed", [2]], 3, ["completed", [4]], 5, 6, 7]);
  assert.deepEqual(shape(timeline, false), [1, ["summary", "r1"], 3, 5, 6, 7]);
});

test("a plan that arrives before its tool record still comes after the turn summary", () => {
  const plan = { ...block(2, "notice", null, ""), content: { type: "workflow.plan", payload: { plan: { id: "r1" } } } };
  const blocks = [
    block(1, "user_prompt", "r1", "Prepare a plan"), plan,
    block(3, "tool_call", "r1", "Submit plan"), block(4, "assistant_text", "r1", "Plan ready")
  ];
  const live = openTimeline({ revision: 1, blocks, turns: [turn("r1", "running")] });
  assert.deepEqual(shape(live), [1, 2, ["running", [3]], 4]);
  const done = turn("r1", "completed", "b4");
  const approved = applyTimelineChanges(live, page(2, [{
    type: "block_updated", blockId: "b2", status: "approved"
  }], done));
  assert.deepEqual(shape(approved), [1, ["summary", "r1"], 2, ["completed", [3]], 4]);
  assert.deepEqual(shape(approved, false), [1, ["summary", "r1"], 2, 4]);
  assert.equal(approved.blocks[1].status, "approved");
});

test("a delegated task stays visible below a single process summary and updates in place", () => {
  const task = {
    ...block(3, "notice", "r1", ""), status: "queued",
    content: { type: "task.updated", payload: { taskId: "task", status: "queued" } }
  };
  const blocks = [
    block(1, "user_prompt", "r1", "Delegate"),
    block(2, "assistant_text", "r1", "Dispatching a teammate"),
    task,
    block(4, "tool_call", "r1", "Delegate"),
    block(5, "assistant_text", "r1", "Dispatched"),
  ];
  const live = openTimeline({ revision: 1, blocks, turns: [turn("r1", "running")] });
  assert.deepEqual(shape(live), [1, ["running", [2]], 3, ["running", [4]], 5]);
  const done = applyTimelineChanges(live, page(2, [], turn("r1", "completed", "b5")));
  const updated = applyTimelineChanges(done, page(3, [{
    type: "block_updated", blockId: "b3", status: "completed",
    result: { type: "task.updated", payload: { taskId: "task", status: "completed" } }
  }]));
  assert.deepEqual(shape(updated), [1, ["summary", "r1"], ["completed", [2]], 3, ["completed", [4]], 5]);
  assert.equal(updated.blocks[2].status, "completed");
  assert.equal(updated.blocks[2].blockId, task.blockId);
});

test("internal handoff records do not add rows to the parent conversation", () => {
  const timeline = openTimeline({ revision: 1, blocks: [
    block(1, "assistant_text", "r1", "Dispatched"),
    { ...block(2, "notice", null, ""), content: { type: "handoff.created", payload: { summary: "Internal" } } },
    block(3, "assistant_text", "r2", "The task finished."),
  ], turns: [turn("r1", "completed", "b1"), turn("r2", "completed", "b3")] });
  assert.deepEqual(shape(timeline), [1, 3]);
  assert.equal(timeline.blocks.length, 3);
});

test("only the trailing receipt for this conversation is removed from the reply", () => {
  const task = "11111111-1111-4111-8111-111111111111";
  const child = "22222222-2222-4222-8222-222222222222";
  const strip = text => withoutDelegationReceipt(text, (kind, id) => id === (kind === "task" ? task : child));
  const taskId = `任务 ID \`${task}\`。`;
  assert.equal(strip(`已派发。\n\n- **任务 ID** \`${task}\`\n- 子会话 ID \`${child}\``), "已派发。");
  assert.equal(strip(`报告已返回。\n\n${taskId}`), "报告已返回。");
  assert.equal(strip(`Done.\n\n- **Child session ID:** \`${child}\``), "Done.");
  for (const text of [
    taskId, `请记录${taskId}`, "说明\n\n任务 ID other-task",
    `示例\n\n\`\`\`text\n${taskId}`, `示例\n\n~~~text\n${taskId}\n~~~`,
  ]) assert.equal(strip(text), text);
});

test("streamed and reopened timelines preserve order, collapse interim text, and retain late edits", () => {
  const blocks = [
    block(1, "user_prompt", "r1", "First"),
    block(2, "thinking", "r1", "Thought"),
    block(3, "tool_call", "r1", "First edit"),
    block(4, "user_append", "r1", "Steer"),
    block(5, "thinking", "r1", "New thought"),
    block(6, "assistant_text", "r1", "Interim text"),
    block(7, "assistant_text", "r1", "Final"),
    block(8, "user_prompt", "r2", "Next"),
    block(9, "late_result", "r1", "Late edit"),
    block(10, "thinking", "r2", "Next thought", false),
  ];
  let live = openTimeline({ revision: 0, blocks: [], turns: [] });
  live = applyTimelineChanges(live, page(1, created(blocks[0], block(2, "thinking", "r1", "Th", false)), turn("r1", "running")));
  assert.deepEqual(shape(live), [1, ["running", [2]]]);
  live = applyTimelineChanges(live, page(2, [delta("b2", "ought"), seal("b2"), ...created(...blocks.slice(2, 7))]));
  assert.throws(() => applyTimelineChanges(live, page(3, [delta("b2", "replay")])), /closed block/);
  assert.throws(() => applyTimelineChanges(live, page(3, created(block(3, "tool_call", "r1", "late")))), /tail append/);
  assert.deepEqual(shape(live), [1, ["running", [2, 3]], ["running", [4, 5, 6]], 7]);
  const done = turn("r1", "completed", "b7");
  live = applyTimelineChanges(live, page(3, [], done));
  assert.deepEqual(shape(live), [1, ["summary", "r1"], ["completed", [2, 3]], ["completed", [4, 5, 6]], 7]);
  const next = turn("r2", "running");
  live = applyTimelineChanges(live, page(4, created(...blocks.slice(7)), next));
  const reopened = openTimeline({ revision: 4, blocks, turns: [done, next] });
  assert.deepEqual(live, reopened);
  assert.deepEqual(shape(live), [1, ["summary", "r1"], ["completed", [2, 3]], ["completed", [4, 5, 6]], 7, 8, 9, ["running", [10]]]);
});

test("approval remains in place without grouping past it", () => {
  const blocks = [block(1, "thinking", "r", "Before"), block(2, "interaction", "r", "Question"), block(3, "tool_call", "r", "After")];
  const live = openTimeline({ revision: 1, blocks, turns: [turn("r", "completed")] });
  const resolved = applyTimelineChanges(live, page(2, [{ type: "block_updated", blockId: "b2", status: "resolved", result: { text: "Yes" } }]));
  assert.deepEqual(shape(resolved), [["summary", "r"], ["completed", [1]], 2, ["completed", [3]]]);
  assert.equal(resolved.blocks[1].result.text, "Yes");
});

test("direct replies stay unwrapped and the process summary comes before the first step", () => {
  const blocks = [
    block(1, "user_prompt", "r1", "Hello"), block(2, "assistant_text", "r1", "Hello!"),
    block(3, "user_prompt", "r2", "Check"), block(4, "tool_call", "r2", "Listed files"),
    block(5, "interaction", "r2", "Confirm"), block(6, "assistant_text", "r2", "Done"),
  ];
  const summaries = [turn("r1", "completed", "b2"), turn("r2", "completed", "b6")];
  const live = applyTimelineChanges(openTimeline({ revision: 1, blocks, turns: [
    turn("r1", "running"), summaries[1],
  ] }), page(2, [], summaries[0]));
  const reopened = openTimeline({ revision: 2, blocks, turns: summaries });
  assert.deepEqual(timelineEntries(live), timelineEntries(reopened));
  assert.deepEqual(shape(reopened), [1, 2, 3, ["summary", "r2"], ["completed", [4]], 5, 6]);
  assert.equal(timelineEntries(reopened)[3].summary.durationMs, 3400);
});
