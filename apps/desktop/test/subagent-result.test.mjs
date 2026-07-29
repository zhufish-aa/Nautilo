import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourceUrl = new URL("../src/renderer/src/lib/subagent-result.ts", import.meta.url);

async function loadModule() {
  const source = await readFile(sourceUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(transpiled)}`);
}

test("result: splits answer body, agentId line and usage trailer", async () => {
  const { parseSubagentResult } = await loadModule();
  const output = "1+1 = 2。当前工作目录: C:/proj\nagentId: ab2253796189bb0a (use SendMessage with to: 'ab2253796189bb0a' to continue this agent)\n<usage>total_tokens: 23084\ntool_uses: 0\nduration_ms: 7777</usage>";
  const view = parseSubagentResult(output);
  assert.equal(view.body, "1+1 = 2。当前工作目录: C:/proj");
  assert.equal(view.agentId, "ab2253796189bb0a");
  assert.deepEqual(view.usage, { totalTokens: 23084, toolUses: 0, durationMs: 7777 });
});

test("result: plain output without metadata passes through untouched", async () => {
  const { parseSubagentResult } = await loadModule();
  const view = parseSubagentResult("就是**这样**。");
  assert.equal(view.body, "就是**这样**。");
  assert.equal(view.agentId, undefined);
  assert.equal(view.usage, undefined);
});

test("result: usage-only output keeps the original text as body", async () => {
  const { parseSubagentResult } = await loadModule();
  const output = "<usage>total_tokens: 10</usage>";
  const view = parseSubagentResult(output);
  assert.equal(view.body, output.trim());
  assert.deepEqual(view.usage, { totalTokens: 10, toolUses: undefined, durationMs: undefined });
});

test("input: extracts prompt and remaining scalar fields", async () => {
  const { parseSubagentInput } = await loadModule();
  const view = parseSubagentInput(JSON.stringify({
    description: "测试子agent功能",
    prompt: "回答 1+1",
    subagent_type: "explore",
    run_in_background: false,
    extra: { nested: true }
  }));
  assert.equal(view.prompt, "回答 1+1");
  assert.deepEqual(view.fields, [["run_in_background", "false"], ["extra", '{"nested":true}']]);
});

test("input: non-JSON input falls back to raw", async () => {
  const { parseSubagentInput } = await loadModule();
  const view = parseSubagentInput("not json at all");
  assert.equal(view.raw, "not json at all");
  assert.equal(view.prompt, undefined);
});

test("result: opencode <task><task_result> wrapper is stripped", async () => {
  const { parseSubagentResult } = await loadModule();
  const output = '<task id="ses_056c06e40ffe" state="completed">\n<task_result>\n## 报告\n\n正文内容\n</task_result>\n</task>';
  const view = parseSubagentResult(output);
  assert.equal(view.body, "## 报告\n\n正文内容");
  assert.equal(view.agentId, undefined);
  assert.equal(view.usage, undefined);
});

test("formatDurationMs compacts durations", async () => {
  const { formatDurationMs } = await loadModule();
  assert.equal(formatDurationMs(7777), "7.8s");
  assert.equal(formatDurationMs(420), "420ms");
  assert.equal(formatDurationMs(65000), "1m 5s");
  assert.equal(formatDurationMs(120000), "2m");
});
