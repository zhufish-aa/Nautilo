import test from "node:test";
import assert from "node:assert/strict";
import { subagentMeta } from "../dist/runtime/subagent-detection.js";

test("Claude Task tool is recognized as a sub-agent dispatch", () => {
  const meta = subagentMeta("Task", {
    description: "调研登录模块",
    prompt: "请阅读 src/auth 并总结登录流程",
    subagent_type: "Explore"
  });
  assert.deepEqual(meta, { agentType: "Explore", task: "调研登录模块" });
});

test("Kimi Agent tool and opencode task tool are recognized case-insensitively", () => {
  assert.deepEqual(subagentMeta("Agent", { prompt: "查一下这个报错" }), { agentType: undefined, task: "查一下这个报错" });
  assert.deepEqual(subagentMeta("task", { description: "写一个脚本" }), { agentType: undefined, task: "写一个脚本" });
  assert.deepEqual(subagentMeta("spawn_agent", { description: "并行验证", subagent_type: "worker" }), { agentType: "worker", task: "并行验证" });
});

test("falls back to a truncated prompt when no description exists", () => {
  const prompt = "x".repeat(500);
  const meta = subagentMeta("Task", { prompt });
  assert.equal(meta?.task?.length, 201);
  assert.ok(meta?.task?.endsWith("…"));
});

test("background dispatches are flagged (kimi run_in_background, opencode background)", () => {
  assert.deepEqual(subagentMeta("Agent", { prompt: "后台跑着", run_in_background: true }),
    { agentType: undefined, task: "后台跑着", background: true });
  assert.deepEqual(subagentMeta("task", { description: "后台任务", background: true }),
    { agentType: undefined, task: "后台任务", background: true });
  // foreground dispatches stay unflagged
  assert.deepEqual(subagentMeta("task", { description: "前台", background: false }),
    { agentType: undefined, task: "前台" });
});

test("unrelated or malformed tool calls are not dispatches", () => {
  assert.equal(subagentMeta("TaskCreate", { description: "待办" }), undefined);
  assert.equal(subagentMeta("Bash", { command: "ls", description: "列目录" }), undefined);
  assert.equal(subagentMeta("Task", {}), undefined);
  assert.equal(subagentMeta("Task", "not-an-object"), undefined);
  assert.equal(subagentMeta("Task", undefined), undefined);
});
