import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AdapterRegistry, PluginService } from "../dist/index.js";

const pluginSource = join(import.meta.dirname, "..", "..", "provider-plugin-pi");
const pluginDist = join(pluginSource, "dist", "index.js");

function tempDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const FAKE_PI = `const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("0.83.0"); process.exit(0); }
if (args.includes("--help")) { console.log("pi - AI coding assistant\\n--mode <mode> text, json, or rpc"); process.exit(0); }
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const resumedAt = args.indexOf("--session");
const sessionId = resumedAt >= 0 ? args[resumedAt + 1] : "pi-session-new";
const injected = process.env.AGENTHUB_PI_PROVIDER_CONFIG ? JSON.parse(process.env.AGENTHUB_PI_PROVIDER_CONFIG) : undefined;
let activeModel = { provider: "openai", id: "gpt-test", name: "GPT Test", contextWindow: 123456 };
let thinkingLevel = "high";
let buffer = "";
function finishPrompt() {
  send({ type: "message_start", message: { role: "assistant", content: [] } });
  send({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "checking" } });
  send({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "Hello " } });
  send({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "from Pi" } });
  send({ type: "message_end", message: {
    role: "assistant",
    content: [{ type: "thinking", thinking: "checking" }, { type: "text", text: "Hello from Pi" }],
    usage: { input: 10, output: 4, cacheRead: 3, cacheWrite: 0, reasoning: 1, totalTokens: 17 }
  } });
  send({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "edit", args: { path: "a.ts", oldText: "a", newText: "b" } });
  send({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "edit", result: { content: [{ type: "text", text: "done" }] }, isError: false });
  send({ type: "agent_end", messages: [], willRetry: false });
  send({ type: "agent_settled" });
}
function handle(value) {
  if (value.type === "get_state") return send({ id: value.id, type: "response", command: "get_state", success: true, data: {
    sessionId,
    thinkingLevel,
    model: activeModel
  } });
  if (value.type === "get_available_models") return send({ id: value.id, type: "response", command: "get_available_models", success: true, data: { models: [
    { provider: "openai", id: "gpt-test", name: "GPT Test", api: "openai-responses", reasoning: true, input: ["text", "image"], contextWindow: 123456, thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: null } },
    { provider: "anthropic", id: "claude-test", name: "Claude Test", api: "anthropic-messages", reasoning: false, input: ["text"], contextWindow: 100000 },
    ...(injected?.models ?? []).map((model) => ({ ...model, provider: "agenthub", api: injected.api }))
  ] } });
  if (value.type === "set_model") {
    activeModel = { provider: value.provider, id: value.modelId, name: value.modelId, contextWindow: 123456 };
    return send({ id: value.id, type: "response", command: "set_model", success: true, data: activeModel });
  }
  if (value.type === "set_thinking_level") {
    thinkingLevel = value.level;
    return send({ id: value.id, type: "response", command: "set_thinking_level", success: true });
  }
  if (value.type === "compact") {
    if (process.env.FAKE_PI_COMPACT_RESULT === "too-small") {
      return send({ id: value.id, type: "response", command: "compact", success: false, error: "Nothing to compact (session too small)" });
    }
    return send({ id: value.id, type: "response", command: "compact", success: true, data: { summary: "summary" } });
  }
  if (value.type === "prompt") {
    send({ id: value.id, type: "response", command: "prompt", success: true });
    if (value.message === "ask") return send({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Continue?", message: "Proceed with the task" });
    if (value.message === "empty-error") {
      send({ type: "message_start", message: { role: "assistant", content: [] } });
      send({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "error", reason: "error" } });
      send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", usage: { input: 0, output: 0, totalTokens: 0 } } });
      return send({ type: "agent_settled" });
    }
    return finishPrompt();
  }
  if (value.type === "extension_ui_response" && value.id === "ui-1") return finishPrompt();
  if (value.type === "abort") return send({ id: value.id, type: "response", command: "abort", success: true });
  if (value.type === "steer") return send({ id: value.id, type: "response", command: "steer", success: true });
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop();
  for (const line of lines) if (line.trim()) handle(JSON.parse(line));
});
`;

const FAKE_MCP = `let buffer = "";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
function handle(value) {
  if (value.method === "initialize") return send({ jsonrpc: "2.0", id: value.id, result: {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "fake-mcp", version: "1.0.0" }
  } });
  if (value.method === "tools/list") return send({ jsonrpc: "2.0", id: value.id, result: { tools: [{
    name: "echo",
    description: "Echo text through MCP",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
  }] } });
  if (value.method === "tools/call") return send({ jsonrpc: "2.0", id: value.id, result: {
    content: [{ type: "text", text: "mcp:" + String(value.params?.arguments?.text || "") }],
    isError: false
  } });
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || "";
  for (const line of lines) if (line.trim()) handle(JSON.parse(line));
});
`;

test("the Pi plugin installs and registers its provider", async (t) => {
  if (!existsSync(pluginDist)) { t.skip("provider-plugin-pi is not built"); return; }
  const dataDir = tempDir(t, "agenthub-pi-plugin-");
  const adapters = new AdapterRegistry();
  const service = new PluginService(dataDir, adapters);
  await service.ready;

  const record = await service.installLocal(pluginSource);
  assert.equal(record.status, "loaded", record.error);
  const adapter = adapters.get("pi");
  assert.equal(adapter.constructor.name, "PiPluginAdapter");
  assert.equal(adapter.descriptor.defaultExecutable, "pi");
  assert.deepEqual(adapter.descriptor.nativeCommands, [{
    name: "compact",
    description: "压缩当前 Pi 会话上下文，可附加保留内容说明",
    inputHint: "可选的压缩说明",
    providerCommand: "compact"
  }]);

  await service.uninstall("pi");
  assert.ok(!adapters.has("pi"));
});

test("the Pi plugin discovers models and streams RPC turns with native resume", async (t) => {
  if (!existsSync(pluginDist)) { t.skip("provider-plugin-pi is not built"); return; }
  const factory = (await import(pathToFileURL(pluginDist).href)).default;
  const adapter = factory({ sdkVersion: "1" });
  const bin = tempDir(t, "agenthub-fake-pi-");
  const fakePi = join(bin, "fake-pi.mjs");
  writeFileSync(fakePi, FAKE_PI, "utf8");
  const instance = { providerId: "pi", executable: process.execPath, baseArgs: [fakePi], providerOptions: {} };

  const detection = await adapter.detect(instance);
  assert.equal(detection.installed, true, detection.error);
  assert.equal(detection.compatible, true);

  const catalog = await adapter.listModels(instance, { env: {} });
  assert.equal(catalog.defaultModel, "openai/gpt-test");
  assert.equal(catalog.models.length, 2);
  assert.deepEqual(catalog.models[0].capabilities, ["tool_use", "reasoning", "vision"]);
  assert.deepEqual(catalog.models[0].reasoningEfforts, ["off", "low", "medium", "high"]);
  assert.equal(catalog.models[0].contextWindow, 123456);
  assert.equal(catalog.models[0].defaultReasoningEffort, "high");

  const events = [];
  for await (const event of adapter.start({
    instance,
    prompt: "hello",
    cwd: bin,
    env: {},
    model: "openai/gpt-test",
    reasoningEffort: "high"
  }).events) events.push(event);

  assert.deepEqual(events.find((event) => event.kind === "commands")?.commands, [{
    name: "compact",
    description: "压缩当前 Pi 会话上下文，可附加保留内容说明",
    inputHint: "可选的压缩说明",
    providerCommand: "compact"
  }]);
  assert.equal(events.find((event) => event.kind === "session")?.providerSessionId, "pi-session-new");
  assert.deepEqual(events.filter((event) => event.kind === "message" && event.phase === "delta").map((event) => event.text), ["Hello ", "from Pi"]);
  assert.equal(events.find((event) => event.kind === "thinking" && event.phase === "delta")?.text, "checking");
  assert.deepEqual(events.find((event) => event.kind === "usage"), {
    kind: "usage",
    inputTokens: 10,
    cachedInputTokens: 3,
    outputTokens: 4,
    reasoningOutputTokens: 1,
    contextUsed: 17,
    raw: events.find((event) => event.kind === "usage").raw
  });
  const tool = events.find((event) => event.kind === "tool" && event.phase === "completed");
  assert.deepEqual(tool.fileDiff, { operation: "edit", path: "a.ts", before: "a", after: "b" });
  assert.equal(tool.success, true);
  assert.ok(events.some((event) => event.kind === "status" && event.phase === "turn_completed"));
  assert.equal(events.at(-1).kind, "exit");
  assert.equal(events.at(-1).exitCode, 0);

  const resumed = [];
  for await (const event of adapter.resume({
    instance,
    prompt: "again",
    providerSessionId: "pi-existing-session",
    cwd: bin,
    env: {}
  }).events) resumed.push(event);
  assert.equal(resumed.find((event) => event.kind === "session")?.providerSessionId, "pi-existing-session");
  assert.deepEqual(resumed.filter((event) => event.kind === "message" && event.phase === "delta").map((event) => event.text), ["Hello ", "from Pi"]);
});

test("the Pi plugin bridges extension confirmation and builds safe permission arguments", async (t) => {
  if (!existsSync(pluginDist)) { t.skip("provider-plugin-pi is not built"); return; }
  const module = await import(pathToFileURL(pluginDist).href);
  const adapter = module.default({ sdkVersion: "1" });
  const bin = tempDir(t, "agenthub-fake-pi-ui-");
  const fakePi = join(bin, "fake-pi.mjs");
  writeFileSync(fakePi, FAKE_PI, "utf8");
  const instance = { providerId: "pi", executable: process.execPath, baseArgs: [fakePi], providerOptions: {} };
  const interactions = [];
  const events = [];
  for await (const event of adapter.start({
    instance,
    prompt: "ask",
    cwd: bin,
    env: {},
    requestInteraction: async (input) => {
      interactions.push(input);
      return { outcome: "selected", optionId: "confirm" };
    }
  }).events) events.push(event);
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].kind, "approval");
  assert.ok(events.some((event) => event.kind === "message" && event.text === "Hello "));

  const baseRequest = { instance, prompt: "x", cwd: bin, env: {} };
  assert.ok(module.piRunArgs({ ...baseRequest, permissionMode: "read-only" }, false).includes("read,grep,find,ls"));
  assert.ok(module.piRunArgs({ ...baseRequest, permissionMode: "isolated" }, false).includes("--no-approve"));
  assert.deepEqual(module.piRunArgs({ ...baseRequest, providerSessionId: "s-1" }, true).slice(-2), ["--session", "s-1"]);
});

test("the Pi plugin completes compact RPC responses without waiting for agent_settled", async (t) => {
  if (!existsSync(pluginDist)) { t.skip("provider-plugin-pi is not built"); return; }
  const factory = (await import(pathToFileURL(pluginDist).href)).default;
  const adapter = factory({ sdkVersion: "1" });
  const bin = tempDir(t, "agenthub-fake-pi-compact-");
  const fakePi = join(bin, "fake-pi.mjs");
  writeFileSync(fakePi, FAKE_PI, "utf8");
  const instance = { providerId: "pi", executable: process.execPath, baseArgs: [fakePi], providerOptions: {} };

  const completed = [];
  for await (const event of adapter.resume({
    instance,
    prompt: "/compact preserve decisions",
    providerCommand: "compact",
    providerSessionId: "pi-existing-session",
    cwd: bin,
    env: {}
  }).events) completed.push(event);
  assert.equal(completed.find((event) => event.kind === "message")?.text, "Pi 会话压缩完成。");
  assert.ok(completed.some((event) => event.kind === "status" && event.phase === "turn_completed"));
  assert.equal(completed.at(-1)?.kind, "exit");
  assert.equal(completed.at(-1)?.exitCode, 0);

  const noOp = [];
  for await (const event of adapter.resume({
    instance,
    prompt: "/compact",
    providerCommand: "compact",
    providerSessionId: "pi-existing-session",
    cwd: bin,
    env: { FAKE_PI_COMPACT_RESULT: "too-small" }
  }).events) noOp.push(event);
  assert.equal(noOp.find((event) => event.kind === "message")?.text, "当前 Pi 会话没有可压缩的旧内容，无需压缩。");
  assert.ok(noOp.some((event) => event.kind === "status" && event.phase === "turn_completed"));
  assert.ok(!noOp.some((event) => event.kind === "error"));
  assert.equal(noOp.at(-1)?.exitCode, 0);
});

test("the Pi plugin injects AgentHub third-party endpoint settings and qualifies switched models", async (t) => {
  if (!existsSync(pluginDist)) { t.skip("provider-plugin-pi is not built"); return; }
  const module = await import(pathToFileURL(pluginDist).href);
  const adapter = module.default({ sdkVersion: "1" });
  const bin = tempDir(t, "agenthub-fake-pi-custom-");
  const fakePi = join(bin, "fake-pi.mjs");
  writeFileSync(fakePi, FAKE_PI, "utf8");
  const instance = {
    providerId: "pi",
    displayName: "Company API",
    executable: process.execPath,
    baseArgs: [fakePi],
    providerOptions: { baseUrl: "http://intranet.example/v1/", apiType: "openai-completions" },
    models: [{ id: "deepseek-v4", displayName: "DeepSeek V4", reasoningEfforts: ["off", "high"], contextWindow: 200000 }]
  };

  const catalog = await adapter.listModels(instance, { env: { AGENTHUB_PI_API_KEY: "secret" } });
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].id, "deepseek-v4");
  assert.equal(catalog.models[0].contextWindow, 200000);
  assert.equal(catalog.defaultModel, "deepseek-v4");
  assert.equal(catalog.models[0].defaultReasoningEffort, "off");

  const activeCatalog = module.parsePiModels({ data: { models: [
    { provider: "agenthub", id: "deepseek-v4-pro", reasoning: true, thinkingLevelMap: { low: "low", high: "high", max: "max" } },
    { provider: "agenthub", id: "deepseek-v4-flash-free", reasoning: true, thinkingLevelMap: { low: "low", high: "high", max: "max" } }
  ] } }, { data: {
    model: { provider: "agenthub", id: "deepseek-v4-flash-free" },
    thinkingLevel: "max"
  } }, "agenthub");
  assert.equal(activeCatalog.defaultModel, "deepseek-v4-flash-free");
  assert.equal(activeCatalog.models.find((model) => model.id === "deepseek-v4-flash-free")?.defaultReasoningEffort, "max");

  const args = module.piRunArgs({ instance, prompt: "x", cwd: bin, model: "deepseek-v4" }, false);
  assert.ok(args.includes("--extension"));
  assert.deepEqual(args.slice(-2), ["--model", "agenthub/deepseek-v4"]);

  const events = [];
  for await (const event of adapter.start({
    instance,
    prompt: "custom",
    cwd: bin,
    env: { AGENTHUB_PI_API_KEY: "secret" },
    model: "deepseek-v4",
    reasoningEffort: "high"
  }).events) events.push(event);
  assert.ok(events.some((event) => event.kind === "message" && event.text === "Hello "));
  assert.ok(events.some((event) => event.kind === "status" && event.phase === "turn_completed"));
});

test("the Pi plugin verifies model and thinking switches before prompting", async () => {
  if (!existsSync(pluginDist)) return;
  const module = await import(pathToFileURL(pluginDist).href);
  assert.doesNotThrow(() => module.assertPiSelection({
    data: { model: { provider: "agenthub", id: "deepseek-v4-pro" }, thinkingLevel: "max" }
  }, "agenthub/deepseek-v4-pro", "max"));
  assert.throws(() => module.assertPiSelection({
    data: { model: { provider: "agenthub", id: "deepseek-v4-flash-free" }, thinkingLevel: "high" }
  }, "agenthub/deepseek-v4-pro", "max"), /model switch did not apply/);
  assert.throws(() => module.assertPiSelection({
    data: { model: { provider: "agenthub", id: "deepseek-v4-pro" }, thinkingLevel: "high" }
  }, "agenthub/deepseek-v4-pro", "max"), /thinking level did not apply/);
});

test("the Pi plugin materializes run-scoped skills and loads them with native --skill flags", async (t) => {
  if (!existsSync(pluginDist)) { t.skip("provider-plugin-pi is not built"); return; }
  const module = await import(pathToFileURL(pluginDist).href);
  const source = tempDir(t, "agenthub-pi-skill-source-");
  mkdirSync(join(source, "scripts"), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "source skill must not overwrite generated frontmatter", "utf8");
  writeFileSync(join(source, "scripts", "build.js"), "console.log('ok')", "utf8");
  const bundle = module.materializePiSkills([{
    id: "skill-ppt",
    name: "Office Presentations",
    description: "Create verified PowerPoint decks",
    instructions: "Use scripts/build.js and verify the result.",
    resourceDir: source
  }]);
  t.after(bundle.cleanup);

  assert.equal(bundle.paths.length, 1);
  const generated = readFileSync(join(bundle.paths[0], "SKILL.md"), "utf8");
  assert.match(generated, /name: office-presentations/);
  assert.match(generated, /Use scripts\/build\.js/);
  assert.match(generated, /agenthub:runtime-skill:skill-ppt/);
  assert.equal(readFileSync(join(bundle.paths[0], "scripts", "build.js"), "utf8"), "console.log('ok')");

  const instance = { providerId: "pi", executable: "pi", baseArgs: [], providerOptions: {} };
  const args = module.piRunArgs({ instance, prompt: "x", cwd: source }, false, bundle.paths);
  const skillFlag = args.indexOf("--skill");
  assert.ok(skillFlag > 0);
  assert.equal(args[skillFlag + 1], bundle.paths[0]);
  bundle.cleanup();
  assert.equal(existsSync(bundle.paths[0]), false);
});

test("the Pi plugin reports an empty model error as failed instead of completed", async (t) => {
  if (!existsSync(pluginDist)) { t.skip("provider-plugin-pi is not built"); return; }
  const factory = (await import(pathToFileURL(pluginDist).href)).default;
  const adapter = factory({ sdkVersion: "1" });
  const bin = tempDir(t, "agenthub-fake-pi-error-");
  const fakePi = join(bin, "fake-pi.mjs");
  writeFileSync(fakePi, FAKE_PI, "utf8");
  const instance = { providerId: "pi", executable: process.execPath, baseArgs: [fakePi], providerOptions: {} };
  const events = [];
  for await (const event of adapter.start({ instance, prompt: "empty-error", cwd: bin, env: {} }).events) events.push(event);

  assert.ok(events.some((event) => event.kind === "error" && /model response stream failed|stopped with error/i.test(event.error.message)));
  assert.ok(events.some((event) => event.kind === "status" && event.phase === "turn_failed"));
  assert.ok(!events.some((event) => event.kind === "status" && event.phase === "turn_completed"));
  assert.equal(events.findLast((event) => event.kind === "exit")?.exitCode, 1);
});

test("the generated Windows compatibility extension replaces bash with native PowerShell", async (t) => {
  if (process.platform !== "win32") { t.skip("Windows-only compatibility extension"); return; }
  if (!existsSync(pluginDist)) { t.skip("provider-plugin-pi is not built"); return; }
  const module = await import(pathToFileURL(pluginDist).href);
  const bin = tempDir(t, "agenthub-pi-powershell-");
  const instance = { providerId: "pi", executable: "pi", baseArgs: [], providerOptions: {} };
  const args = module.piRunArgs({ instance, prompt: "x", cwd: bin }, false);
  const extensionPath = args[args.indexOf("--extension") + 1];
  const registered = [];
  const handlers = new Map();
  let active = ["read", "bash", "edit", "write"];
  const previous = process.env.AGENTHUB_PI_ENABLE_POWERSHELL;
  process.env.AGENTHUB_PI_ENABLE_POWERSHELL = "1";
  try {
    const extension = await import(`${pathToFileURL(extensionPath).href}?test=${Date.now()}`);
    await extension.default({
      registerProvider() {},
      registerTool(tool) { registered.push(tool); },
      on(name, handler) { handlers.set(name, handler); },
      getActiveTools() { return active; },
      setActiveTools(names) { active = names; }
    });
    await handlers.get("session_start")?.();
  } finally {
    if (previous === undefined) delete process.env.AGENTHUB_PI_ENABLE_POWERSHELL;
    else process.env.AGENTHUB_PI_ENABLE_POWERSHELL = previous;
  }

  assert.ok(active.includes("powershell"));
  assert.ok(!active.includes("bash"));
  const tool = registered.find((entry) => entry.name === "powershell");
  assert.ok(tool);
  const result = await tool.execute("test", { command: "Write-Output agenthub-pi-ok", timeoutMs: 10_000 }, undefined, undefined, { cwd: bin });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /agenthub-pi-ok/);
});

test("the generated Pi extension injects AgentHub STDIO MCP tools", async (t) => {
  if (!existsSync(pluginDist)) { t.skip("provider-plugin-pi is not built"); return; }
  const module = await import(pathToFileURL(pluginDist).href);
  const bin = tempDir(t, "agenthub-pi-mcp-");
  const fakeMcp = join(bin, "fake-mcp.mjs");
  writeFileSync(fakeMcp, FAKE_MCP, "utf8");
  const instance = { providerId: "pi", executable: "pi", baseArgs: [], providerOptions: {} };
  const args = module.piRunArgs({ instance, prompt: "x", cwd: bin }, false);
  const extensionPath = args[args.indexOf("--extension") + 1];
  const registered = [];
  const handlers = new Map();
  let active = ["read", "bash", "edit", "write"];
  const previousMcp = process.env.AGENTHUB_PI_MCP_SERVERS;
  const previousPowershell = process.env.AGENTHUB_PI_ENABLE_POWERSHELL;
  process.env.AGENTHUB_PI_MCP_SERVERS = JSON.stringify([{
    name: "firecrawl",
    transport: "stdio",
    command: process.execPath,
    args: [fakeMcp],
    env: { FIRECRAWL_API_KEY: "test" }
  }]);
  delete process.env.AGENTHUB_PI_ENABLE_POWERSHELL;
  try {
    const extension = await import(`${pathToFileURL(extensionPath).href}?mcp-test=${Date.now()}`);
    await extension.default({
      registerProvider() {},
      registerTool(tool) { registered.push(tool); },
      on(name, handler) { handlers.set(name, handler); },
      getActiveTools() { return active; },
      setActiveTools(names) { active = names; }
    });
    await handlers.get("session_start")?.({}, { ui: { notify() {} } });
    const tool = registered.find((entry) => entry.name === "mcp_firecrawl_echo");
    assert.ok(tool, `registered tools: ${registered.map((entry) => entry.name).join(", ")}`);
    assert.ok(active.includes("mcp_firecrawl_echo"));
    const result = await tool.execute("mcp-call", { text: "hello" });
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, "mcp:hello");
    await handlers.get("session_shutdown")?.();
  } finally {
    if (previousMcp === undefined) delete process.env.AGENTHUB_PI_MCP_SERVERS;
    else process.env.AGENTHUB_PI_MCP_SERVERS = previousMcp;
    if (previousPowershell === undefined) delete process.env.AGENTHUB_PI_ENABLE_POWERSHELL;
    else process.env.AGENTHUB_PI_ENABLE_POWERSHELL = previousPowershell;
  }
});

test("the generated Pi extension injects AgentHub Streamable HTTP MCP tools", async (t) => {
  if (!existsSync(pluginDist)) { t.skip("provider-plugin-pi is not built"); return; }
  const module = await import(pathToFileURL(pluginDist).href);
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      const value = JSON.parse(body);
      if (!Object.hasOwn(value, "id")) {
        response.writeHead(202).end();
        return;
      }
      let result;
      if (value.method === "initialize") {
        result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "http-mcp", version: "1" } };
      } else if (value.method === "tools/list") {
        result = { tools: [{ name: "ping", description: "Ping over HTTP", inputSchema: { type: "object", properties: {} } }] };
      } else if (value.method === "tools/call") {
        result = { content: [{ type: "text", text: "http-pong" }] };
      }
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "test-session" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: value.id, result }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const instance = { providerId: "pi", executable: "pi", baseArgs: [], providerOptions: {} };
  const args = module.piRunArgs({ instance, prompt: "x", cwd: process.cwd() }, false);
  const extensionPath = args[args.indexOf("--extension") + 1];
  const registered = [];
  const handlers = new Map();
  let active = ["read"];
  const previousMcp = process.env.AGENTHUB_PI_MCP_SERVERS;
  process.env.AGENTHUB_PI_MCP_SERVERS = JSON.stringify([{
    name: "remote",
    transport: "http",
    url: `http://127.0.0.1:${address.port}/mcp`,
    headers: { "x-agenthub-test": "1" }
  }]);
  try {
    const extension = await import(`${pathToFileURL(extensionPath).href}?http-mcp-test=${Date.now()}`);
    await extension.default({
      registerProvider() {},
      registerTool(tool) { registered.push(tool); },
      on(name, handler) { handlers.set(name, handler); },
      getActiveTools() { return active; },
      setActiveTools(names) { active = names; }
    });
    await handlers.get("session_start")?.({}, { ui: { notify() {} } });
    const tool = registered.find((entry) => entry.name === "mcp_remote_ping");
    assert.ok(tool);
    assert.ok(active.includes(tool.name));
    const result = await tool.execute("http-call", {});
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, "http-pong");
    await handlers.get("session_shutdown")?.();
  } finally {
    if (previousMcp === undefined) delete process.env.AGENTHUB_PI_MCP_SERVERS;
    else process.env.AGENTHUB_PI_MCP_SERVERS = previousMcp;
  }
});
