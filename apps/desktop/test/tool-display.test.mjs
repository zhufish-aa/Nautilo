import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourceUrl = new URL("../src/renderer/src/lib/tool-display.ts", import.meta.url);

test("shared event icons recognize native names across harnesses", async () => {
  const { toolActivityKind } = await loadToolDisplay();
  for (const [name, input, expected] of [
    ["exec_command", { command: "pwd" }, "command"], ["Bash", { command: "ls" }, "command"],
    ["Shell", {}, "command"], ["functions.run_command", {}, "command"], ["pwsh", {}, "command"],
    ["ReadFile", { path: "src/index.ts" }, "read"], ["read", { file_path: "src/index.ts" }, "read"],
    ["WriteFile", {}, "write"], ["write", {}, "write"], ["StrReplaceFile", {}, "edit"], ["apply_patch", {}, "edit"],
    ["mcp_firecrawl_firecrawl_map", {}, "mcp"], ["mcp__github__get_profile", {}, "mcp"],
    ["Read", { file_path: "C:/skills/github/SKILL.md" }, "skill"], ["skill", {}, "skill"],
    ["exec_command", { command: "Get-Content 'C:/skills/github/SKILL.md'" }, "skill"],
    ["run_code", {}, "code"], ["read_image", {}, "image"], ["Grep", {}, "search"], ["web_fetch", {}, "web"],
    ["ask_user_question", {}, "question"], ["AskUserQuestion", {}, "question"], ["request_user_input", {}, "question"],
  ]) assert.equal(toolActivityKind(name, JSON.stringify(input)), expected, name);
});

test("PTC details decode code and recover older truncated inputs", async () => {
  const { codeExecutionInput } = await loadToolDisplay();
  const code = 'const value = "hello";\nconsole.log(value);';
  assert.deepEqual(codeExecutionInput(JSON.stringify({ description: "Read files", code })), { description: "Read files", code, truncated: false });
  const partial = codeExecutionInput('{"description":"Read files","code":"line one\\nline two');
  assert.equal(partial.code, 'line one\nline two');
  assert.equal(partial.description, 'Read files');
  assert.equal(partial.truncated, true);
});

async function loadToolDisplay() {
  const source = await readFile(sourceUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(transpiled)}`);
}

test("Kimi file tools show their target path in the activity label", async () => {
  const { toolActivityLabel } = await loadToolDisplay();
  assert.equal(toolActivityLabel("Read", "running", "{\"path\":\"src/types.ts\"}", "zh-CN"), "正在读取 src/types.ts");
  assert.equal(toolActivityLabel("Edit", "done", "{\"file_path\":\"src/provider.ts\"}", "zh-CN"), "已编辑 src/provider.ts");
  assert.equal(toolActivityLabel("Write", "failed", "{\"filePath\":\"src/output.ts\"}", "en-US"), "Failed to write src/output.ts");
});

test("Kimi search tools show the query and optional search path", async () => {
  const { toolActivityLabel } = await loadToolDisplay();
  assert.equal(
    toolActivityLabel("Grep", "running", "{\"pattern\":\"permissionPolicyId\",\"path\":\"apps/desktop/src\"}", "zh-CN"),
    "正在搜索 permissionPolicyId · apps/desktop/src"
  );
  assert.equal(toolActivityLabel("Glob", "done", "{\"pattern\":\"**/*.tsx\",\"path\":\"src\"}", "en-US"), "Found **/*.tsx · src");
});

test("Kimi Edit input is converted into a renderable file diff", async () => {
  const { toolInputFileDiff } = await loadToolDisplay();
  assert.deepEqual(
    toolInputFileDiff("Editing src/example.ts", JSON.stringify({
      path: "src/example.ts",
      old_string: "const oldValue = 1;",
      new_string: "const newValue = 2;"
    })),
    {
      operation: "edit",
      path: "src/example.ts",
      before: "const oldValue = 1;",
      after: "const newValue = 2;"
    }
  );
  assert.equal(toolInputFileDiff("Read", "{\"path\":\"src/example.ts\"}"), undefined);
});

test("Kimi Write input is converted into an added-file diff", async () => {
  const { toolInputFileDiff } = await loadToolDisplay();
  assert.deepEqual(
    toolInputFileDiff("Writing src/new-file.ts", JSON.stringify({
      path: "src/new-file.ts",
      content: "export const value = 1;\n"
    })),
    {
      operation: "write",
      path: "src/new-file.ts",
      before: "",
      after: "export const value = 1;\n"
    }
  );
});

test("truncated historical Kimi Write input still exposes a partial added-file diff", async () => {
  const { toolActivityLabel, toolInputFileDiff } = await loadToolDisplay();
  const truncated = `{\"path\":\"src/new-file.ts\",\"content\":\"first line\\nsecond`;
  assert.equal(toolActivityLabel("Write", "done", truncated, "zh-CN"), "已写入 src/new-file.ts");
  assert.deepEqual(toolInputFileDiff("Write", truncated), {
    operation: "write",
    path: "src/new-file.ts",
    before: "",
    after: "first line\nsecond",
    truncated: true
  });
});
