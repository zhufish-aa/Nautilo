import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const sourceUrl = new URL("../src/renderer/src/lib/tool-display.ts", import.meta.url);
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");

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

const toolDisplay = build({ entryPoints: [fileURLToPath(sourceUrl)], bundle: true, format: "esm", write: false })
  .then(({ outputFiles }) => import(`data:text/javascript;charset=utf-8,${encodeURIComponent(outputFiles[0].text)}`));
const loadToolDisplay = () => toolDisplay;

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

test("tool cluster summaries count unique files, actual command calls, and failures", async () => {
  const { formatToolClusterSummary: summary } = await loadToolDisplay();
  const tool = (toolName, input, status = "done") => ({ kind: "tool_activity", toolName, input: JSON.stringify(input), status });
  const read = tool("Read", { path: "stream.ts" });
  const edit = tool("Edit", { path: "stream.ts" });
  const create = tool("create_file", { path: "new-file.ts" });
  const command = { kind: "command", status: "failed", command: "pnpm test" };
  assert.equal(summary([edit, read, read, create]).label, "读取 1 个文件 · 编辑 1 个文件 · 创建 1 个文件");
  assert.equal(summary([command, { ...command, status: "running" }]).label, "正在运行命令 · 2");
  assert.equal(summary([command, { ...command, status: "running" }]).failed, 1);
  assert.equal(summary([command, create, edit, read, tool("web_search", {})]).label, "读取 1 个文件 · 编辑 1 个文件 · 等 3 项操作");
  assert.equal(summary([tool("mcp__nautilo_0__browser_run", {}), tool("browser_eval", {})]).label, "操作了 2 次浏览器");
});

test("tool clusters use MCP server identity and keep isolated calls as single steps", async () => {
  const { formatToolClusterSummary: summary, toolActivityLabel } = await loadToolDisplay();
  const call = (toolName, status = "done", input) => ({ kind: "tool_activity", toolName, status, input });
  const browser = call("Playwright/browser_snapshot");
  const github = call("mcp__GitHub__list_issues");
  assert.equal(summary([browser]).standalone, true);
  assert.equal(summary([browser, browser]).label, "调用了 Playwright · 2 次");
  assert.equal(summary([browser, browser, github]).label, "调用了 Playwright (2) · GitHub (1)");
  assert.equal(summary([browser, github, call("mcp__Notes__list")]).label, "调用了 3 个 MCP 服务 · 3 次");
  assert.equal(summary([browser, call("Playwright/click", "running")]).label, "正在调用 Playwright · click (2)");
  assert.equal(summary([call("web_search")]).standalone, true);
  assert.equal(summary([call("lookup"), call("lookup")]).label, "调用了 2 次 lookup");
  assert.equal(summary([call("lookup"), call("translate")]).label, "调用了 2 次工具");
  assert.equal(toolActivityLabel(browser.toolName, "done", undefined, "zh-CN"), "调用了 Playwright · browser_snapshot");
  assert.equal(toolActivityLabel("web_search", "done", '{"query":"Nautilo"}', "zh-CN"), "搜索网页 · Nautilo");
  assert.equal(toolActivityLabel("web_search", "done", "Nautilo", "zh-CN"), "搜索网页 · Nautilo");
  assert.equal(toolActivityLabel("mcp", "done", '{"serverName":"GitHub","toolName":"list_issues","arguments":{}}', "zh-CN"), "调用了 GitHub · list_issues");
});
