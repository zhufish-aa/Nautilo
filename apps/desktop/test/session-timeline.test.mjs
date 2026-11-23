import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/renderer/src/lib/session-timeline.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { openTimeline, applyTimelineChanges, timelineEntries } = await import(`data:text/javascript,${encodeURIComponent(outputText)}`);

const block = (seq, kind, runId, text, sealed = true) => ({
  seq, blockId: `b${seq}`, runId, kind, content: { text }, sealed, status: null, result: null
});
const turn = (runId, status, finalBlockId = null) => ({ runId, status, finalBlockId, durationMs: status === "running" ? null : 3400 });
const page = (revision, operations, change = null) => ({ reset: false, revision, changes: [{ operations, turn: change }] });
const created = (...blocks) => blocks.map(block => ({ type: "block_created", block }));
const seal = (blockId) => ({ type: "block_updated", blockId, sealed: true });
const delta = (blockId, text) => ({ type: "block_delta", blockId, text });
const shape = (timeline) => timelineEntries(timeline).map(entry => entry.block
  ? entry.block.seq : [entry.turn.status, entry.process.map(block => block.seq)]);

test("a visible workflow card splits the rows but does not repeat the turn disclosure", () => {
  const plan = { ...block(3, "notice", null, ""), content: { type: "workflow.plan", payload: { plan: { id: "plan" } } } };
  const timeline = openTimeline({ revision: 1, blocks: [
    block(1, "user_prompt", "r1", "First"), block(2, "thinking", "r1", "Before plan"),
    plan, block(4, "tool_call", "r1", "After plan"), block(5, "assistant_text", "r1", "Final"),
    block(6, "user_prompt", "r2", "Second"), block(7, "assistant_text", "r2", "Other reply")
  ], turns: [turn("r1", "completed", "b5"), turn("r2", "completed", "b7")] });
  const entries = timelineEntries(timeline);
  assert.deepEqual(entries.map(entry => entry.block?.seq ?? [entry.disclosureKey, entry.process.map(row => row.seq)]),
    [1, ["b2", [2]], 3, ["b2", [4]], 5, 6, ["b7", []], 7]);
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
  assert.deepEqual(shape(live), [1, ["running", [2, 3, 4, 5, 6, 7]]]);
  const done = turn("r1", "completed", "b7");
  live = applyTimelineChanges(live, page(3, [], done));
  assert.deepEqual(shape(live), [1, ["completed", [2, 3, 4, 5, 6]], 7]);
  const next = turn("r2", "running");
  live = applyTimelineChanges(live, page(4, created(...blocks.slice(7)), next));
  const reopened = openTimeline({ revision: 4, blocks, turns: [done, next] });
  assert.deepEqual(live, reopened);
  assert.deepEqual(shape(live), [1, ["completed", [2, 3, 4, 5, 6]], 7, 8, 9, ["running", [10]]]);
});

test("approval remains in place without grouping past it", () => {
  const blocks = [block(1, "thinking", "r", "Before"), block(2, "interaction", "r", "Question"), block(3, "tool_call", "r", "After")];
  const live = openTimeline({ revision: 1, blocks, turns: [turn("r", "completed")] });
  const resolved = applyTimelineChanges(live, page(2, [{ type: "block_updated", blockId: "b2", status: "resolved", result: { text: "Yes" } }]));
  assert.deepEqual(shape(resolved), [["completed", [1]], 2, ["completed", [3]]]);
  assert.equal(resolved.blocks[1].result.text, "Yes");
});

test("direct replies keep their completion row, and a turn with a process does not get a duplicate", () => {
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
  assert.deepEqual(shape(reopened), [1, ["completed", []], 2, 3, ["completed", [4]], 5, 6]);
  assert.equal(timelineEntries(reopened)[1].turn.durationMs, 3400);
});
