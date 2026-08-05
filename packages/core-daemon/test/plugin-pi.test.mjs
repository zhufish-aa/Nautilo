import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    thinkingLevel: "high",
    model: { provider: "openai", id: "gpt-test", name: "GPT Test", contextWindow: 123456 }
  } });
  if (value.type === "get_available_models") return send({ id: value.id, type: "response", command: "get_available_models", success: true, data: { models: [
    { provider: "openai", id: "gpt-test", name: "GPT Test", api: "openai-responses", reasoning: true, input: ["text", "image"], contextWindow: 123456, thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: null } },
    { provider: "anthropic", id: "claude-test", name: "Claude Test", api: "anthropic-messages", reasoning: false, input: ["text"], contextWindow: 100000 },
    ...(injected?.models ?? []).map((model) => ({ ...model, provider: "agenthub", api: injected.api }))
  ] } });
  if (value.type === "set_model") return send({ id: value.id, type: "response", command: "set_model", success: true, data: { provider: value.provider, id: value.modelId } });
  if (value.type === "set_thinking_level") return send({ id: value.id, type: "response", command: "set_thinking_level", success: true });
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

  const events = [];
  for await (const event of adapter.start({
    instance,
    prompt: "hello",
    cwd: bin,
    env: {},
    model: "openai/gpt-test",
    reasoningEffort: "high"
  }).events) events.push(event);

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
    extension.default({
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
