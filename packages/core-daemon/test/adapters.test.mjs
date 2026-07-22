import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdapterRegistry,
  AgentService,
  AGENTHUB_CODEX_API_KEY_ENV,
  AGENTHUB_CODEX_PROVIDER_ID,
  buildCodexAppServerArgs,
  buildCodexProviderConfigArgs,
  buildCodexResumeArgs,
  buildCodexStartArgs,
  buildKimiResumeArgs,
  buildKimiStartArgs,
  CODEX_APP_SERVER_INITIALIZE_PARAMS,
  Database,
  EnvironmentPolicyService,
  buildCodexTurnInput,
  negotiateRunMode,
  parseCodexJsonEvent,
  parseCodexAppServerNotification,
  parseCodexModelList,
  parseKimiDefaultModel,
  parseKimiModelList,
  parseKimiJsonEvent,
  parseKimiAcpUpdate,
  parseKimiWireContextUsed,
  resumeStrategy
} from "../dist/index.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));
const now = new Date().toISOString();
const instance = { id: "fake", providerId: "codex", displayName: "Fake", executable: process.execPath, baseArgs: [fixture, "--json"], capabilities: [], enabled: true, status: "available", createdAt: now, updatedAt: now };

test("registry detects and normalizes a structured provider", async () => {
  const registry = new AdapterRegistry();
  const customInstance = { ...instance, providerId: "custom", providerOptions: { outputMode: "jsonl" } };
  const detection = await registry.detect(customInstance);
  assert.equal(detection.installed, true);
  assert.equal(detection.executable, process.execPath);
  assert.match(detection.help, /Usage: node/);
  const run = registry.start({ instance: customInstance, prompt: "hello", cwd: process.cwd(), timeoutMs: 5_000 });
  const events = [];
  for await (const event of run.events) events.push(event);
  assert.ok(events.some((event) => event.kind === "message" && event.text === "fixture ready"));
  assert.ok(events.some((event) => event.kind === "file" && event.path === "src/example.ts"));
  assert.equal(events.at(-1)?.kind, "exit");
});

test("all bundled provider adapters satisfy the structured run contract", async () => {
  const registry = new AdapterRegistry();
  for (const providerId of ["codex", "claude-code", "kimi-code", "opencode"]) {
    const configured = { ...instance, id: providerId, providerId };
    const run = registry.start({ instance: configured, prompt: "contract", cwd: process.cwd() });
    const events = [];
    for await (const event of run.events) events.push(event);
    assert.ok(events.some((event) => event.kind === "message"), `${providerId} should normalize JSONL`);
  }
});

test("native resume and custom JSONL configuration are explicit", async () => {
  const registry = new AdapterRegistry();
  const resumed = registry.resume({ instance, providerSessionId: "session-1", prompt: "continue", cwd: process.cwd() });
  const resumeEvents = [];
  for await (const event of resumed.events) resumeEvents.push(event);
  assert.ok(resumeEvents.some((event) => event.kind === "message"));

  const custom = { ...instance, providerId: "custom", providerOptions: { outputMode: "jsonl" } };
  const customRun = registry.start({ instance: custom, prompt: "custom", cwd: process.cwd() });
  const customEvents = [];
  for await (const event of customRun.events) customEvents.push(event);
  assert.ok(customEvents.some((event) => event.kind === "message"));
  assert.equal(registry.capabilities(custom).structuredOutput, true);
});

test("capability negotiation has deterministic downgrade", () => {
  const capabilities = { structuredOutput: false, textOutput: true, interactiveStdin: false, nativeResume: false, pty: false };
  assert.equal(negotiateRunMode(capabilities, ["headless_structured", "headless_text"]), "headless_text");
  assert.equal(resumeStrategy(capabilities), "prompt_reconstruction");
});

test("Codex commands match the official exec JSONL and resume surface", () => {
  const configured = { ...instance, baseArgs: [], profile: "work" };
  const request = { instance: configured, prompt: "hello", cwd: process.cwd(), model: "gpt-test", reasoningEffort: "max", serviceTier: "priority", outputSchemaPath: "result.schema.json" };
  assert.deepEqual(buildCodexStartArgs(configured, "hello", request), [
    "exec", "--json", "--model", "gpt-test", "--config", 'model_reasoning_effort="max"', "--config", 'service_tier="priority"', "--profile", "work", "--output-schema", "result.schema.json", "hello"
  ]);
  assert.deepEqual(buildCodexResumeArgs(configured, "thread-1", "continue", { ...request, prompt: "continue", providerSessionId: "thread-1" }), [
    "exec", "resume", "--json", "--model", "gpt-test", "--config", 'model_reasoning_effort="max"', "--config", 'service_tier="priority"', "thread-1", "continue"
  ]);
});

test("Codex custom API base URL is applied as an invocation-scoped model provider", () => {
  const secret = "must-not-appear-in-process-arguments";
  const configured = {
    ...instance,
    baseArgs: [],
    providerOptions: { baseUrl: "https://proxy.example.test/v1/" }
  };
  const environment = { [AGENTHUB_CODEX_API_KEY_ENV]: secret };
  const providerArgs = buildCodexProviderConfigArgs(configured, environment);

  assert.equal(AGENTHUB_CODEX_PROVIDER_ID, "agenthub_proxy");
  assert.deepEqual(providerArgs, [
    "--config", 'model_provider="agenthub_proxy"',
    "--config", 'model_providers.agenthub_proxy.name="AgentHub custom endpoint"',
    "--config", 'model_providers.agenthub_proxy.base_url="https://proxy.example.test/v1"',
    "--config", 'model_providers.agenthub_proxy.wire_api="responses"',
    "--config", 'model_providers.agenthub_proxy.env_key="OPENAI_API_KEY"'
  ]);
  assert.doesNotMatch(JSON.stringify(providerArgs), new RegExp(secret));

  const startArgs = buildCodexStartArgs(configured, "hello", {
    instance: configured,
    prompt: "hello",
    cwd: process.cwd(),
    env: environment
  });
  const resumeArgs = buildCodexResumeArgs(configured, "thread-1", "continue", {
    instance: configured,
    prompt: "continue",
    cwd: process.cwd(),
    env: environment,
    providerSessionId: "thread-1"
  });
  const appServerArgs = buildCodexAppServerArgs(configured, environment);
  for (const args of [startArgs, resumeArgs, appServerArgs]) {
    assert.ok(args.includes('model_provider="agenthub_proxy"'));
    assert.ok(args.includes('model_providers.agenthub_proxy.base_url="https://proxy.example.test/v1"'));
    assert.ok(args.includes('model_providers.agenthub_proxy.env_key="OPENAI_API_KEY"'));
    assert.doesNotMatch(JSON.stringify(args), new RegExp(secret));
  }
  assert.deepEqual(appServerArgs.slice(0, 2), ["app-server", "--stdio"]);

  const profiledAppServerArgs = buildCodexAppServerArgs({ ...configured, profile: "work" }, environment);
  assert.deepEqual(profiledAppServerArgs.slice(0, 4), ["--profile", "work", "app-server", "--stdio"]);
});

test("Codex custom endpoint supports no-auth local providers and rejects unsafe URL schemes", () => {
  const local = {
    ...instance,
    providerOptions: { baseUrl: "http://127.0.0.1:11434/v1" }
  };
  const args = buildCodexProviderConfigArgs(local, {});
  assert.ok(args.includes('model_providers.agenthub_proxy.base_url="http://127.0.0.1:11434/v1"'));
  assert.equal(args.some((value) => value.includes(".env_key=")), false);

  const unsafe = { ...instance, providerOptions: { baseUrl: "file:///C:/secrets" } };
  assert.throws(
    () => buildCodexProviderConfigArgs(unsafe, {}),
    /Unsupported Codex API base URL protocol/
  );
});

test("model discovery uses the exact CLI instance and its sanitized credential environment", async () => {
  const database = new Database(":memory:");
  const selected = {
    ...instance,
    id: "pixel-codex",
    executable: "pixel-codex",
    providerOptions: { baseUrl: "https://proxy.example.test/v1" }
  };
  const other = { ...instance, id: "default-codex", executable: "codex" };
  database.agents.save(other, other.updatedAt);
  database.agents.save(selected, selected.updatedAt);
  let captured;
  const adapters = {
    listModels: async (configured, context) => {
      captured = { configured, context };
      return { providerId: "codex", models: [], source: "provider_cli", fetchedAt: new Date().toISOString() };
    }
  };
  const credentials = {
    environment: (agentInstanceId, providerId) => ({
      OPENAI_API_KEY: `${agentInstanceId}:${providerId}:secret`
    })
  };

  try {
    const service = new AgentService(database, adapters, credentials, new EnvironmentPolicyService());
    await service.listModels("codex", undefined, selected.id);
    assert.equal(captured.configured.id, selected.id);
    assert.equal(captured.configured.providerOptions.baseUrl, "https://proxy.example.test/v1");
    assert.equal(captured.context.env.OPENAI_API_KEY, "pixel-codex:codex:secret");
    assert.ok(captured.context.env.PATH);
  } finally {
    database.close();
  }
});

test("Codex JSONL parser exposes session, message, usage, and failures", () => {
  assert.deepEqual(parseCodexJsonEvent({ type: "thread.started", thread_id: "thread-1" })[0], {
    kind: "session", providerSessionId: "thread-1", raw: { type: "thread.started", thread_id: "thread-1" }
  });
  assert.equal(parseCodexJsonEvent({ type: "item.completed", item: { type: "agent_message", text: "done" } })[0]?.kind, "message");
  const completed = parseCodexJsonEvent({ type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 1 } });
  assert.equal(completed[0]?.kind, "usage");
  assert.equal(completed[1]?.kind, "status");
  assert.ok(parseCodexJsonEvent({ type: "turn.failed", error: { message: "bad model" } }).some((event) => event.kind === "error"));
});

test("Codex app-server parser preserves deltas, call ids, input, and output", () => {
  const delta = parseCodexAppServerNotification("item/agentMessage/delta", { itemId: "message-1", delta: "Hello " })[0];
  assert.deepEqual({ kind: delta.kind, phase: delta.phase, messageId: delta.messageId, text: delta.text }, {
    kind: "message", phase: "delta", messageId: "message-1", text: "Hello "
  });
  const started = parseCodexAppServerNotification("item/started", { item: { type: "mcpToolCall", id: "call-1", server: "browser", tool: "search", arguments: { q: "news" }, status: "inProgress" } })[0];
  const completed = parseCodexAppServerNotification("item/completed", { item: { type: "mcpToolCall", id: "call-1", server: "browser", tool: "search", arguments: { q: "news" }, result: { count: 3 }, status: "completed" } })[0];
  assert.equal(started.callId, "call-1");
  assert.deepEqual(started.input, { q: "news" });
  assert.equal(completed.callId, "call-1");
  assert.match(completed.output, /"count": 3/);
  const usage = parseCodexAppServerNotification("thread/tokenUsage/updated", { tokenUsage: {
    total: { totalTokens: 245000, inputTokens: 240000, outputTokens: 5000 },
    last: { totalTokens: 2450, inputTokens: 2000, outputTokens: 450 },
    modelContextWindow: 128000
  } })[0];
  assert.equal(usage.inputTokens, 240000);
  assert.equal(usage.contextUsed, 2450);
  assert.equal(usage.contextWindow, 128000);
  const image = parseCodexAppServerNotification("item/completed", { item: {
    type: "imageGeneration", id: "image-1", result: "aGVsbG8=", savedPath: "C:/tmp/generated.png", status: "completed"
  } });
  assert.ok(image.some((event) => event.kind === "artifact" && event.artifactType === "image"));
});

test("Codex app-server opts into native experimental provider capabilities", () => {
  assert.equal(CODEX_APP_SERVER_INITIALIZE_PARAMS.capabilities.experimentalApi, true);
});

test("Codex app-server sends generated image references as native local image input", () => {
  assert.deepEqual(buildCodexTurnInput("review this image", ["C:/images/generated.png"]), [
    { type: "text", text: "review this image" },
    { type: "localImage", path: "C:/images/generated.png", detail: "auto" }
  ]);
});

test("Codex native images retain only a file reference when a saved image exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "agenthub-native-image-"));
  try {
    const imagePath = join(directory, "generated.png");
    writeFileSync(imagePath, Buffer.from("image-bytes"));
    const events = parseCodexAppServerNotification("item/completed", { item: {
      type: "imageGeneration",
      id: "image-reference",
      result: "aGVsbG8=",
      savedPath: imagePath,
      status: "completed"
    } });
    const artifact = events.find((event) => event.kind === "artifact");
    assert.equal(artifact.path, imagePath);
    assert.equal(artifact.data, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Kimi commands match prompt stream-json and session resume", () => {
  const configured = { ...instance, baseArgs: [] };
  const request = { instance: configured, model: "kimi-test", prompt: "hello", cwd: process.cwd() };
  assert.deepEqual(buildKimiStartArgs(configured, "hello", request), ["--model", "kimi-test", "--prompt", "hello", "--output-format", "stream-json"]);
  assert.deepEqual(buildKimiResumeArgs(configured, "session-1", "continue", { ...request, prompt: "continue", providerSessionId: "session-1" }), ["--model", "kimi-test", "--session", "session-1", "--prompt", "continue", "--output-format", "stream-json"]);
});

test("Kimi stream-json parser exposes messages, tools, and resume hints", () => {
  const tool = parseKimiJsonEvent({ role: "assistant", tool_calls: [{ id: "tool-1", type: "function", function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" } }] })[0];
  assert.equal(tool?.kind, "tool");
  assert.deepEqual(tool?.input, { command: "pwd" });
  assert.equal(parseKimiJsonEvent({ role: "assistant", content: "done" })[0]?.kind, "message");
  const session = parseKimiJsonEvent({ role: "meta", type: "session.resume_hint", session_id: "session-1" })[0];
  assert.equal(session?.kind, "session");
  assert.equal(session?.providerSessionId, "session-1");
});

test("Kimi ACP parser preserves streaming chunks and coalescible tool details", () => {
  const state = { messageId: "message-1", thinkingId: "thinking-1", toolNames: new Map() };
  const chunk = parseKimiAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } }, state)[0];
  assert.deepEqual({ kind: chunk.kind, phase: chunk.phase, messageId: chunk.messageId, text: chunk.text }, {
    kind: "message", phase: "delta", messageId: "message-1", text: "partial"
  });
  const started = parseKimiAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "web_search", status: "in_progress", rawInput: { q: "news" } }, state)[0];
  const completed = parseKimiAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", rawOutput: { hits: 2 } }, state)[0];
  assert.equal(started.name, "web_search");
  assert.equal(completed.name, "web_search");
  assert.equal(completed.callId, "tool-1");
  assert.match(completed.output, /"hits": 2/);
  const usage = parseKimiAcpUpdate({ sessionUpdate: "usage_update", used: 4096, size: 262144 }, state)[0];
  assert.equal(usage.contextUsed, 4096);
  assert.equal(usage.contextWindow, 262144);
  const commands = parseKimiAcpUpdate({ sessionUpdate: "available_commands_update", availableCommands: [
    { name: "compact", description: "Compact context", input: { hint: "instruction" } }
  ] }, state)[0];
  assert.equal(commands.kind, "commands");
  assert.deepEqual(commands.commands[0], { name: "compact", description: "Compact context", inputHint: "instruction" });
});

test("Kimi context usage falls back to the provider wire log when ACP omits usage_update", () => {
  const wire = [
    JSON.stringify({ type: "llm.request", maxTokens: 1_000_000 }),
    JSON.stringify({ type: "usage.record", usage: { inputOther: 2_000, inputCacheRead: 20_000, inputCacheCreation: 0, output: 500 } }),
    JSON.stringify({ type: "llm.request", maxTokens: 977_500 }),
    JSON.stringify({ type: "usage.record", usage: { inputOther: 500, inputCacheRead: 22_000, inputCacheCreation: 0, output: 250 } })
  ].join("\n");
  assert.equal(parseKimiWireContextUsed(wire, 1_000_000), 45_250);
});

test("Codex app-server model/list is normalized without hard-coded models", () => {
  const catalog = parseCodexModelList({ data: [
    {
      id: "model-1",
      model: "gpt-test-codex",
      displayName: "GPT Test Codex",
      description: "Test model",
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deep" }
      ],
      defaultReasoningEffort: "medium",
      serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }]
    }
  ], nextCursor: null });
  assert.equal(catalog.providerId, "codex");
  assert.equal(catalog.defaultModel, "gpt-test-codex");
  assert.deepEqual(catalog.models[0].reasoningEfforts, ["medium", "high"]);
  assert.equal(catalog.models[0].defaultReasoningEffort, "medium");
  assert.equal(catalog.models[0].serviceTiers[0].id, "priority");
});

test("Kimi configured aliases are normalized and preserve the full model alias", () => {
  const raw = JSON.stringify({
    providers: { "managed:kimi-code": { type: "kimi", apiKey: "must-not-leak" } },
    models: {
      "kimi-code/k3": {
        provider: "managed:kimi-code",
        model: "k3",
        maxContextSize: 1048576,
        capabilities: ["thinking", "tool_use"],
        displayName: "K3",
        supportEfforts: ["low", "high", "max"]
      }
    }
  });
  assert.equal(parseKimiDefaultModel("managed:kimi-code type=kimi models=1\n\nDefault model: kimi-code/k3\n"), "kimi-code/k3");
  const catalog = parseKimiModelList(raw, "kimi-code/k3");
  assert.equal(catalog.defaultModel, "kimi-code/k3");
  assert.equal(catalog.models[0].id, "kimi-code/k3");
  assert.equal(catalog.models[0].contextWindow, 1048576);
  assert.deepEqual(catalog.models[0].serviceTiers, []);
  assert.equal(JSON.stringify(catalog).includes("must-not-leak"), false);
});
