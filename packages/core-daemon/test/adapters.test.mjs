import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AdapterRegistry,
  AgentService,
  AGENTHUB_CODEX_API_KEY_ENV,
  AGENTHUB_CODEX_PROVIDER_ID,
  buildCodexAppServerArgs,
  buildCodexCustomModelCatalog,
  buildCodexDynamicTools,
  CODEX_IMAGE_GENERATION_TOOL_NAME,
  buildCodexProviderConfigArgs,
  startChatCompatProxy,
  startCodexChatCompletions,
  buildCodexResumeArgs,
  buildCodexStartArgs,
  codexPermissionConfig,
  buildClaudeResumeArgs,
  buildClaudeStartArgs,
  buildKimiResumeArgs,
  buildKimiStartArgs,
  claudeRuntimeMcpArgs,
  createClaudeParseState,
  discoverClaudeModels,
  discoverCodexModels,
  discoverOpenAiCompatibleModels,
  providerEnvironmentPassthrough,
  listClaudeModels,
  mergeInstanceModelConfig,
  parseOpenAiCompatibleModelList,
  parseClaudeJsonEvent,
  CODEX_APP_SERVER_INITIALIZE_PARAMS,
  Database,
  EnvironmentPolicyService,
  buildCodexTurnInput,
  negotiateRunMode,
  parseCodexJsonEvent,
  parseCodexAppServerNotification,
  parseCodexApiModelList,
  parseCodexModelList,
  parseKimiDefaultModel,
  parseKimiModelList,
  parseKimiJsonEvent,
  parseKimiAcpUpdate,
  createKimiSubagentWireParseState,
  KimiSubagentWireWatcher,
  parseKimiSubagentWireLine,
  KimiAcpTurnSegments,
  parseKimiWireContextUsed,
  startCodexAppServer,
  executeCodexImageGeneration,
  executeOfficialWebSearch,
  RUNTIME_TOOL_NAMES,
  CredentialService,
  startKimiRuntimeMcpBridge,
  resolvePermissionMode,
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
  for (const providerId of ["codex", "claude-code", "kimi-code"]) {
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

test("Codex permission mode maps to approval policy and sandbox flags", () => {
  const withMode = (permissionMode) => ({ ...instance, baseArgs: [], providerOptions: { permissionMode } });
  assert.deepEqual(buildCodexStartArgs(withMode("ask"), "hello").slice(0, 6), [
    "exec", "--json", "--ask-for-approval", "on-request", "--sandbox", "workspace-write"
  ]);
  assert.deepEqual(buildCodexStartArgs(withMode("auto"), "hello").slice(0, 6), [
    "exec", "--json", "--ask-for-approval", "on-failure", "--sandbox", "workspace-write"
  ]);
  assert.deepEqual(buildCodexStartArgs(withMode("full-access"), "hello").slice(0, 6), [
    "exec", "--json", "--ask-for-approval", "never", "--sandbox", "danger-full-access"
  ]);
  const customBase = { ...withMode("ask"), baseArgs: ["exec", "--json"] };
  assert.ok(!buildCodexStartArgs(customBase, "hello").includes("--ask-for-approval"));
});

test("empty session permission mode falls back to the instance setting", () => {
  const configured = { ...instance, baseArgs: [], providerOptions: { permissionMode: "ask" } };
  const request = { instance: configured, prompt: "hello", cwd: process.cwd(), permissionMode: "" };
  assert.equal(resolvePermissionMode(configured, request), "ask");
  assert.deepEqual(codexPermissionConfig(configured, request), { approvalPolicy: "on-request", sandbox: "workspace-write" });
  assert.deepEqual(buildCodexStartArgs(configured, "hello", request).slice(0, 6), [
    "exec", "--json", "--ask-for-approval", "on-request", "--sandbox", "workspace-write"
  ]);

  // A real session override still wins over the instance default.
  const explicit = { ...request, permissionMode: "full-access" };
  assert.equal(resolvePermissionMode(configured, explicit), "full-access");
  assert.deepEqual(codexPermissionConfig(configured, explicit), { approvalPolicy: "never", sandbox: "danger-full-access" });
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
    "--config", 'model_providers.agenthub_proxy.name="Nautilo custom endpoint"',
    "--config", 'model_providers.agenthub_proxy.base_url="https://proxy.example.test/v1"',
    "--config", 'model_providers.agenthub_proxy.wire_api="responses"',
    "--config", 'model_providers.agenthub_proxy.env_key="OPENAI_API_KEY"'
  ]);
  assert.doesNotMatch(JSON.stringify(providerArgs), new RegExp(secret));

  const chatProviderArgs = buildCodexProviderConfigArgs({
    ...configured,
    providerOptions: { ...configured.providerOptions, wireApi: "chat" }
  }, environment);
  assert.ok(chatProviderArgs.includes('model_providers.agenthub_proxy.wire_api="chat"'));

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
  assert.ok(appServerArgs.includes("--enable"));
  assert.ok(appServerArgs.includes("image_generation"));
  assert.ok(appServerArgs.includes('web_search="live"'));

  const customCatalog = buildCodexCustomModelCatalog({
    ...configured,
    models: [{ id: "gpt-5.6-luna", displayName: "Luna", reasoningEfforts: ["medium"], contextWindow: 128000 }]
  }, "gpt-5.6-luna");
  assert.equal(customCatalog.models.length, 1);
  assert.equal(customCatalog.models[0].slug, "gpt-5.6-luna");
  assert.equal(customCatalog.models[0].supports_search_tool, true);
  assert.equal(customCatalog.models[0].web_search_tool_type, "text");
  assert.equal(customCatalog.models[0].default_verbosity, "low");
  assert.equal(customCatalog.models[0].apply_patch_tool_type, "freeform");
  assert.equal(customCatalog.models[0].default_reasoning_level, "medium");

  const noSearchCatalog = buildCodexCustomModelCatalog({
    ...configured,
    providerOptions: { ...configured.providerOptions, webSearch: false },
    models: [{ id: "gpt-5.6-luna" }]
  }, "gpt-5.6-luna");
  assert.equal(noSearchCatalog.models[0].supports_search_tool, false);
  assert.equal(noSearchCatalog.models[0].web_search_tool_type, "text");
  assert.equal(noSearchCatalog.models[0].supports_search_tool, false);

  const appServerArgsWithCatalog = buildCodexAppServerArgs(configured, environment, undefined, "C:\\Temp\\agenthub-codex-model.json");
  assert.ok(appServerArgsWithCatalog.includes('model_catalog_json="C:\\\\Temp\\\\agenthub-codex-model.json"'));

  const chatAppServerArgs = buildCodexAppServerArgs({
    ...configured,
    providerOptions: { ...configured.providerOptions, wireApi: "chat", webSearch: false }
  }, environment);
  assert.ok(chatAppServerArgs.includes('model_providers.agenthub_proxy.wire_api="responses"'));
  assert.equal(chatAppServerArgs.includes('web_search="live"'), false);

  const defaultEndpointArgs = buildCodexAppServerArgs({ ...configured, providerOptions: undefined }, environment);
  assert.ok(defaultEndpointArgs.includes('web_search="live"'));

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
    find: () => undefined,
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

test("instance model config overrides and extends the discovered catalog", () => {
  const base = {
    providerId: "codex",
    models: [
      { id: "gpt-a", displayName: "GPT A", isDefault: true, capabilities: [], reasoningEfforts: ["low", "high"], serviceTiers: [], contextWindow: 1000 },
      { id: "gpt-b", displayName: "GPT B", isDefault: false, capabilities: [], reasoningEfforts: [], serviceTiers: [] }
    ],
    defaultModel: "gpt-a",
    source: "provider_cli",
    fetchedAt: now
  };
  const merged = mergeInstanceModelConfig(base, [
    { id: "gpt-a", reasoningEfforts: ["medium", "high", "xhigh"], contextWindow: 2000 },
    { id: "custom-model", displayName: "Custom", reasoningEfforts: ["low"] }
  ]);
  assert.deepEqual(merged.models.map((model) => model.id), ["gpt-a", "gpt-b", "custom-model"]);
  assert.deepEqual(merged.models[0].reasoningEfforts, ["medium", "high", "xhigh"]);
  assert.equal(merged.models[0].contextWindow, 2000);
  assert.equal(merged.models[0].displayName, "GPT A");
  assert.equal(merged.models[2].displayName, "Custom");
  assert.equal(mergeInstanceModelConfig(base, []), base);
});

test("registry applies instance model config to every discovered catalog", async () => {
  const registry = new AdapterRegistry([{
    providerId: "codex",
    listModels: async () => ({
      providerId: "codex",
      models: [{ id: "gpt-a", displayName: "gpt-a", isDefault: false, capabilities: [], reasoningEfforts: [], serviceTiers: [] }],
      source: "provider_cli",
      fetchedAt: now
    })
  }]);
  const catalog = await registry.listModels({ ...instance, baseArgs: [], models: [{ id: "gpt-a", reasoningEfforts: ["high", "low"] }] });
  assert.deepEqual(catalog.models[0].reasoningEfforts, ["high", "low"]);
});

test("generic OpenAI-compatible model list parses data and models payloads", () => {
  const fromData = parseOpenAiCompatibleModelList({ data: [{ id: "m1", display_name: "Model One" }] });
  assert.equal(fromData.source, "provider_api");
  assert.equal(fromData.models[0].displayName, "Model One");
  assert.deepEqual(fromData.models[0].reasoningEfforts, ["low", "medium", "high"]);
  const fromModels = parseOpenAiCompatibleModelList({ models: [{ id: "m2", name: "Model Two" }] });
  assert.equal(fromModels.models[0].displayName, "Model Two");
  assert.equal(parseOpenAiCompatibleModelList({}).models.length, 0);
});

test("quick fetch with a base URL prefers the generic endpoint and applies instance config", async (t) => {
  const database = new Database(":memory:");
  const configured = {
    ...instance,
    id: "deepseek",
    executable: "codex",
    baseArgs: [],
    providerOptions: { baseUrl: "https://api.deepseek.com" },
    models: [{ id: "deepseek-chat", reasoningEfforts: ["fast", "slow"] }]
  };
  database.agents.save(configured, configured.updatedAt);
  t.mock.method(globalThis, "fetch", async () => new Response(
    JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  ));
  try {
    const service = new AgentService(database, new AdapterRegistry(), undefined, new EnvironmentPolicyService());
    const catalog = await service.listModels("codex", undefined, "deepseek", { baseUrl: "https://api.deepseek.com", apiKey: "sk-x" });
    assert.equal(catalog.providerId, "codex");
    assert.equal(catalog.source, "provider_api");
    assert.deepEqual(catalog.models.map((model) => model.id), ["deepseek-chat", "deepseek-reasoner"]);
    assert.deepEqual(catalog.models[0].reasoningEfforts, ["fast", "slow"]);
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

test("Codex app-server maps Nautilo runtime tools to dynamic function tools", () => {
  assert.deepEqual(buildCodexDynamicTools([{
    name: "agenthub_delegate",
    description: "Dispatch one child task",
    inputSchema: { type: "object", required: ["memberId", "task"] }
  }]), [{
    type: "function",
    name: "agenthub_delegate",
    description: "Dispatch one child task",
    inputSchema: { type: "object", required: ["memberId", "task"] }
  }]);
  assert.throws(() => buildCodexDynamicTools([{
    name: "agenthub.delegate",
    description: "Invalid dotted name",
    inputSchema: { type: "object" }
  }]), /Invalid Codex dynamic tool name: agenthub\.delegate/);
});

test("Codex Chat Completions compatibility mode streams an assistant message", async (t) => {
  let received;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-test", choices: [{ delta: { content: "Hi" } }] })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const configured = {
    ...instance,
    baseArgs: [],
    models: [{ id: "deepseek-v4-flash-free", reasoningEfforts: [] }],
    providerOptions: { wireApi: "chat", baseUrl: `http://127.0.0.1:${address.port}/v1` }
  };
  const run = startCodexChatCompletions({
    instance: configured,
    prompt: "hi",
    cwd: process.cwd(),
    model: "deepseek-v4-flash-free",
    env: { OPENAI_API_KEY: "test-secret" }
  });
  const events = [];
  for await (const event of run.events) events.push(event);
  assert.equal(received.model, "deepseek-v4-flash-free");
  assert.deepEqual(received.messages, [{ role: "user", content: "hi" }]);
  assert.ok(events.some((event) => event.kind === "message" && event.phase === "delta" && event.text === "Hi"));
  assert.ok(events.some((event) => event.kind === "message" && event.phase === "completed" && event.text === "Hi"));
  assert.equal(events.at(-1)?.kind, "exit");
});

test("Codex Responses compatibility proxy translates input and streams Responses events", async (t) => {
  let received;
  const remote = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-proxy", choices: [{ delta: { reasoning_content: "think first " } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-proxy", choices: [{ delta: { reasoning_content: "then answer. ", content: "Hi" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-proxy", choices: [], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12, completion_tokens_details: { reasoning_tokens: 3 } } })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  t.after(() => remote.close());
  const address = remote.address();
  const proxy = await startChatCompatProxy({
    remoteBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    environment: { OPENAI_API_KEY: "proxy-secret" }
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash-free",
      input: [{ type: "text", text: "hi" }],
      tools: [{ type: "web_search_preview" }],
      reasoning: { effort: "high" },
      max_output_tokens: 128,
      text: { format: { type: "json_object" } },
      stream: true
    })
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(received.messages, [{ role: "user", content: "hi" }]);
  assert.equal(received.stream, true);
  assert.equal(received.reasoning_effort, "high");
  assert.equal(received.max_tokens, 128);
  assert.deepEqual(received.response_format, { type: "json_object" });
  assert.equal("web_search_options" in received, false);
  assert.match(body, /response\.reasoning_summary_text\.delta/);
  assert.match(body, /response\.output_text\.delta/);
  assert.match(body, /"input_tokens":7/);
  assert.match(body, /"reasoning_tokens":3/);
  assert.match(body, /response\.completed/);
});

test("Codex Responses compatibility proxy translates Chat tool calls", async (t) => {
  let received;
  const remote = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-test", type: "function", function: { name: "lookup", arguments: "" } }] } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ q: "hi" }) } }] } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  t.after(() => remote.close());
  const address = remote.address();
  const proxy = await startChatCompatProxy({ remoteBaseUrl: `http://127.0.0.1:${address.port}/v1` });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash-free",
      input: [{ type: "text", text: "hi" }],
      tools: [{ type: "function", name: "lookup", description: "Look up data", parameters: { type: "object" } }],
      stream: true
    })
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(received.tools[0].function.name, "lookup");
  assert.match(body, /response\.output_item\.added/);
  assert.match(body, /response\.function_call_arguments\.delta/);
  assert.match(body, /response\.function_call_arguments\.done/);
  assert.match(body, /"type":"function_call"/);
  assert.match(body, /"arguments":"\{\\"q\\":\\"hi\\"\}"/);
});

test("Codex Responses compatibility proxy does not mark an empty upstream response completed", async (t) => {
  const remote = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "only thinking" } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  t.after(() => remote.close());
  const address = remote.address();
  const proxy = await startChatCompatProxy({ remoteBaseUrl: `http://127.0.0.1:${address.port}/v1` });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-flash-free", input: "hi", stream: true })
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /response\.failed/);
  assert.match(body, /empty_upstream_response/);
  assert.doesNotMatch(body, /response\.completed/);
});

test("Codex Responses compatibility proxy preserves reasoning for tool results", async (t) => {
  let received;
  const remote = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "DONE" } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  t.after(() => remote.close());
  const address = remote.address();
  const proxy = await startChatCompatProxy({ remoteBaseUrl: `http://127.0.0.1:${address.port}/v1` });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash-free",
      input: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "think before using the tool" }] },
        { type: "function_call", call_id: "call-roundtrip", name: "lookup", arguments: "{\"q\":\"hi\"}" },
        { type: "function_call_output", call_id: "call-roundtrip", output: "tool result" }
      ],
      stream: true
    })
  });
  assert.equal(response.status, 200);
  await response.text();
  const assistant = received.messages.find((message) => message.role === "assistant");
  const tool = received.messages.find((message) => message.role === "tool");
  assert.equal(assistant.reasoning_content, "think before using the tool");
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].function.name, "lookup");
  assert.equal(tool.tool_call_id, "call-roundtrip");
  assert.equal(tool.content, "tool result");
});

test("official web search runtime tool uses the selected official instance", async (t) => {
  const database = new Database(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "agenthub-search-"));
  const credentials = new CredentialService(database, dataDir, new AdapterRegistry());
  const official = {
    ...instance,
    id: "official-search",
    providerId: "codex",
    providerOptions: { baseUrl: "https://api.openai.com/v1", wireApi: "responses" }
  };
  const current = {
    ...instance,
    providerOptions: {
      wireApi: "chat",
      webSearchMode: "official",
      webSearchInstanceId: official.id,
      webSearchModel: "gpt-5.6-luna",
      webSearchReasoningEffort: "high"
    }
  };
  database.agents.save(official, now);
  credentials.set(official.id, { apiKey: "official-secret" });
  const previousFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "Search result", annotations: [{ type: "url_citation", url: "https://example.com", title: "Example" }] }] }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    database.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const result = await executeOfficialWebSearch({
    providerId: "codex",
    name: RUNTIME_TOOL_NAMES.officialWebSearch,
    arguments: { query: "today's news", search_context_size: "low" }
  }, current, database, credentials);
  assert.equal(result.success, true);
  assert.match(result.content, /Search result/);
  assert.match(result.content, /\[Example\]\(https:\/\/example\.com\)/);
  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.options.headers.authorization, "Bearer official-secret");
  const body = JSON.parse(captured.options.body);
  assert.equal(body.model, "gpt-5.6-luna");
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.deepEqual(body.tools, [{ type: "web_search", search_context_size: "low" }]);
});

test("Codex app-server exposes an executable image bridge and persists its result", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agenthub-image-"));
  const previousFetch = globalThis.fetch;
  let captured;
  const imageBytes = Buffer.from("fake-png");
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ data: [{ b64_json: imageBytes.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const dynamic = buildCodexDynamicTools(undefined, true);
    assert.equal(dynamic?.[0]?.name, CODEX_IMAGE_GENERATION_TOOL_NAME);
    const result = await executeCodexImageGeneration({
      instance: { ...instance, providerOptions: { baseUrl: "https://pixel.example/v1" } },
      prompt: "generate",
      cwd: workspace,
      env: { OPENAI_API_KEY: "secret" }
    }, { prompt: "A simple blue square", filename: "blue-square" });
    assert.equal(captured.url, "https://pixel.example/v1/images/generations");
    assert.equal(JSON.parse(captured.options.body).prompt, "A simple blue square");
    assert.equal(JSON.parse(captured.options.body).output_format, "png");
    assert.deepEqual(readFileSync(result.path), imageBytes);
    assert.match(result.path, /output[\\/]imagegen[\\/]blue-square\.png$/);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Kimi runtime tools are injected through a run-scoped MCP endpoint", async (t) => {
  const calls = [];
  const bridge = await startKimiRuntimeMcpBridge([{
    name: "agenthub_delegate",
    description: "Dispatch one child task",
    inputSchema: { type: "object", properties: { memberId: { type: "string" }, task: { type: "string" } } }
  }], async (call) => {
    calls.push(call);
    return { success: true, content: JSON.stringify({ accepted: true, taskId: "task-1" }) };
  });
  t.after(() => bridge.close());
  const client = new Client({ name: "agenthub-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(bridge.url));
  await client.connect(transport);
  t.after(() => client.close());

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["delegate"]);
  const result = await client.callTool({ name: "delegate", arguments: { memberId: "child", task: "Check API" } });
  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "agenthub_delegate");
  assert.deepEqual(calls[0].arguments, { memberId: "child", task: "Check API" });
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
  const state = { messageId: "message-1", thinkingId: "thinking-1", toolNames: new Map(), toolCalls: new Map() };
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
  const duplicate = parseKimiAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", rawOutput: { hits: 2 } }, state);
  assert.deepEqual(duplicate, []);
  const usage = parseKimiAcpUpdate({ sessionUpdate: "usage_update", used: 4096, size: 262144 }, state)[0];
  assert.equal(usage.contextUsed, 4096);
  assert.equal(usage.contextWindow, 262144);
  const commands = parseKimiAcpUpdate({ sessionUpdate: "available_commands_update", availableCommands: [
    { name: "compact", description: "Compact context", input: { hint: "instruction" } }
  ] }, state)[0];
  assert.equal(commands.kind, "commands");
  assert.deepEqual(commands.commands[0], { name: "compact", description: "Compact context", inputHint: "instruction" });
  assert.deepEqual(parseKimiAcpUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" } }, state), []);

  const delayedAgent = parseKimiAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "agent-1", title: "Agent", status: "in_progress" }, state);
  const agentWithPrompt = parseKimiAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "agent-1", status: "in_progress", rawInput: { prompt: "inspect child" } }, state);
  assert.equal(delayedAgent.length, 1);
  assert.equal(agentWithPrompt.length, 1);
  assert.equal(agentWithPrompt[0].input.prompt, "inspect child");
});

test("Kimi ACP coalesces cumulative tool input and preserves a late file path on completion", () => {
  const state = { messageId: "message-1", thinkingId: "thinking-1", toolNames: new Map(), toolCalls: new Map() };
  const first = parseKimiAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "write-1", title: "Write", status: "in_progress", rawInput: { content: "a" } }, state);
  const identified = parseKimiAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "write-1", status: "in_progress", rawInput: { content: "a".repeat(5_000), path: "src/example.ts" } }, state);
  const incremental = parseKimiAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "write-1", status: "in_progress", rawInput: { content: "a".repeat(10_000) } }, state);
  const completed = parseKimiAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "write-1", status: "completed", rawOutput: "written" }, state);
  assert.equal(first.length, 1);
  assert.equal(first[0].phase, "started");
  assert.equal(identified.length, 1);
  assert.equal(identified[0].phase, "started");
  assert.equal(identified[0].input.path, "src/example.ts");
  assert.deepEqual(incremental, []);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].phase, "completed");
  assert.equal(completed[0].input.path, "src/example.ts");
  assert.equal(completed[0].input.content.length, 10_000);
  assert.equal(Object.keys(completed[0].input)[0], "path");
});

test("Kimi ACP normalizes Edit old/new strings into a file diff", () => {
  const state = { messageId: "message-1", thinkingId: "thinking-1", toolNames: new Map(), toolCalls: new Map() };
  const started = parseKimiAcpUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "edit-1",
    title: "Edit",
    status: "in_progress",
    rawInput: { path: "src/example.ts", old_string: "const oldValue = 1;", new_string: "const newValue = 2;" }
  }, state)[0];
  const completed = parseKimiAcpUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "edit-1",
    title: "Editing src/example.ts",
    status: "completed",
    rawOutput: "Replaced 1 occurrence"
  }, state)[0];
  assert.deepEqual(started.fileDiff, {
    operation: "edit",
    path: "src/example.ts",
    before: "const oldValue = 1;",
    after: "const newValue = 2;"
  });
  assert.equal(completed.name, "Edit");
  assert.deepEqual(completed.fileDiff, started.fileDiff);
});

test("Kimi ACP normalizes Write content into an added-file diff", () => {
  const state = { messageId: "message-1", thinkingId: "thinking-1", toolNames: new Map(), toolCalls: new Map() };
  const started = parseKimiAcpUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "write-1",
    title: "Write",
    status: "in_progress",
    rawInput: { path: "src/new-file.ts", content: "export const value = 1;\n" }
  }, state)[0];
  assert.deepEqual(started.fileDiff, {
    operation: "write",
    path: "src/new-file.ts",
    before: "",
    after: "export const value = 1;\n"
  });
});

test("Kimi ACP reasoning is split before tools and before the final answer", () => {
  const state = { messageId: "kimi-message-1", thinkingId: "kimi-thinking-1", toolNames: new Map(), toolCalls: new Map() };
  const segments = new KimiAcpTurnSegments(state);

  const firstThought = parseKimiAcpUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "inspect project" } }, state);
  firstThought.forEach((event) => segments.append(event));
  const tool = parseKimiAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "read-1", title: "Read", status: "in_progress" }, state);
  const firstBoundary = segments.flushBefore(tool);
  assert.equal(firstBoundary[0].kind, "thinking");
  assert.equal(firstBoundary[0].messageId, "kimi-thinking-1");
  assert.equal(state.thinkingId, "kimi-thinking-2");

  const secondThought = parseKimiAcpUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "implement fix" } }, state);
  assert.equal(secondThought[0].messageId, "kimi-thinking-2");
  secondThought.forEach((event) => segments.append(event));
  const answer = parseKimiAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }, state);
  const secondBoundary = segments.flushBefore(answer);
  assert.equal(secondBoundary[0].messageId, "kimi-thinking-2");
  assert.equal(secondBoundary[0].text, "implement fix");
});

test("Kimi subagent wire parser exposes public progress and tools without private thoughts", () => {
  const state = createKimiSubagentWireParseState("agent-0");
  const thought = parseKimiSubagentWireLine(JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "content.part", part: { type: "think", think: "private reasoning" } }
  }), state, "dispatch-1");
  assert.deepEqual(thought, []);

  const message = parseKimiSubagentWireLine(JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "content.part", part: { type: "text", text: "Inspecting the adapter." } }
  }), state, "dispatch-1")[0];
  assert.equal(message.kind, "message");
  assert.equal(message.subagentDispatchId, "dispatch-1");

  const started = parseKimiSubagentWireLine(JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "tool.call", toolCallId: "read-1", name: "Read", args: { path: "src/a.ts" } }
  }), state, "dispatch-1")[0];
  const completed = parseKimiSubagentWireLine(JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "tool.result", toolCallId: "read-1", result: { isError: false, output: "ok" } }
  }), state, "dispatch-1")[0];
  assert.deepEqual(
    { name: started.name, phase: started.phase, input: started.input, dispatch: started.subagentDispatchId },
    { name: "Read", phase: "started", input: { path: "src/a.ts" }, dispatch: "dispatch-1" }
  );
  assert.deepEqual(
    { name: completed.name, phase: completed.phase, output: completed.output, success: completed.success },
    { name: "Read", phase: "completed", output: "ok", success: true }
  );
});

test("Kimi subagent wire watcher correlates parallel child agents by prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "nautilo-kimi-wire-"));
  const sessionId = "session-test";
  const agentsDir = join(root, "sessions", "workspace", sessionId, "agents");
  try {
    mkdirSync(join(agentsDir, "main"), { recursive: true });
    writeFileSync(join(agentsDir, "main", "wire.jsonl"), "");
    const watcher = new KimiSubagentWireWatcher(sessionId, root);
    await watcher.initialize();
    watcher.track("dispatch-alpha", { prompt: "inspect alpha" });
    watcher.track("dispatch-beta", { prompt: "inspect beta" });

    const writeChild = (agentId, prompt, toolCallId) => {
      const directory = join(agentsDir, agentId);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "wire.jsonl"), [
        JSON.stringify({ type: "metadata", protocol_version: "1" }),
        JSON.stringify({ type: "turn.prompt", input: [{ type: "text", text: `subagent wrapper\n${prompt}\ncontext` }] }),
        JSON.stringify({ type: "context.append_loop_event", event: { type: "content.part", part: { type: "think", think: "hidden" } } }),
        JSON.stringify({ type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: `working on ${prompt}` } } }),
        JSON.stringify({ type: "context.append_loop_event", event: { type: "tool.call", toolCallId, name: "Read", args: { path: `${agentId}.ts` } } })
      ].join("\n") + "\n");
    };
    // Reverse the creation order: exact prompt matching must prevent cross-talk.
    writeChild("agent-0", "inspect beta", "read-beta");
    writeChild("agent-1", "inspect alpha", "read-alpha");

    const first = await watcher.poll();
    assert.equal(first.length, 4);
    assert.deepEqual(new Set(first.map((event) => event.subagentDispatchId)), new Set(["dispatch-alpha", "dispatch-beta"]));
    assert.equal(first.find((event) => event.kind === "tool" && event.callId === "read-alpha")?.subagentDispatchId, "dispatch-alpha");
    assert.equal(first.find((event) => event.kind === "tool" && event.callId === "read-beta")?.subagentDispatchId, "dispatch-beta");
    assert.equal(first.some((event) => event.kind === "message" && event.text.includes("hidden")), false);

    appendFileSync(join(agentsDir, "agent-1", "wire.jsonl"), JSON.stringify({
      type: "context.append_loop_event",
      event: { type: "tool.result", toolCallId: "read-alpha", result: { isError: false, output: "alpha done" } }
    }) + "\n");
    const second = await watcher.poll();
    assert.equal(second.length, 1);
    assert.equal(second[0].subagentDispatchId, "dispatch-alpha");
    assert.equal(second[0].kind, "tool");
    assert.equal(second[0].phase, "completed");
    assert.equal(second[0].output, "alpha done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Kimi subagent wire watcher resumes an existing child without replaying history", async () => {
  const root = mkdtempSync(join(tmpdir(), "nautilo-kimi-resume-wire-"));
  const sessionId = "session-resume";
  const childDir = join(root, "sessions", "workspace", sessionId, "agents", "agent-0");
  const wire = join(childDir, "wire.jsonl");
  try {
    mkdirSync(childDir, { recursive: true });
    writeFileSync(wire, JSON.stringify({
      type: "context.append_loop_event",
      event: { type: "content.part", part: { type: "text", text: "old history" } }
    }) + "\n");
    const watcher = new KimiSubagentWireWatcher(sessionId, root);
    await watcher.initialize();
    watcher.track("dispatch-resume", { resume: "agent-0", prompt: "continue" });
    appendFileSync(wire, JSON.stringify({
      type: "context.append_loop_event",
      event: { type: "tool.call", toolCallId: "new-read", name: "Read", args: { path: "new.ts" } }
    }) + "\n");

    const events = await watcher.poll();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "tool");
    assert.equal(events[0].callId, "new-read");
    assert.equal(events[0].subagentDispatchId, "dispatch-resume");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("Codex API model list is normalized with provider_api source", () => {
  const catalog = parseCodexApiModelList({ object: "list", data: [
    { id: "deepseek-chat", object: "model", owned_by: "deepseek" },
    { id: "deepseek-reasoner", object: "model", owned_by: "deepseek" },
    { object: "model" }
  ] });
  assert.equal(catalog.providerId, "codex");
  assert.equal(catalog.source, "provider_api");
  assert.deepEqual(catalog.models.map((model) => model.id), ["deepseek-chat", "deepseek-reasoner"]);
  assert.deepEqual(catalog.models[0].reasoningEfforts, ["minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(catalog.models[0].defaultReasoningEffort, undefined);
  assert.equal(catalog.defaultModel, undefined);
});

test("Codex model discovery prefers the instance-configured API endpoint", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  const configured = {
    ...instance,
    baseArgs: [],
    executable: "definitely-missing-codex-binary",
    providerOptions: { baseUrl: "https://api.deepseek.com/" }
  };
  const catalog = await discoverCodexModels(configured, { env: { OPENAI_API_KEY: "sk-test", PATH: process.env.PATH } });
  assert.equal(catalog.source, "provider_api");
  assert.deepEqual(catalog.models.map((model) => model.id), ["deepseek-chat"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.deepseek.com/models");
  assert.equal(requests[0].init.headers.authorization, "Bearer sk-test");
});

test("Codex model discovery falls back to the local CLI when the API fails", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "agenthub-codex-models-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("connection refused");
  });
  writeFileSync(join(workspace, "app-server"), readFileSync(fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url)), "utf8"));
  const previousCwd = process.cwd();
  process.chdir(workspace);
  try {
    const configured = { ...instance, baseArgs: [], providerOptions: { baseUrl: "https://api.deepseek.com/" } };
    const catalog = await discoverCodexModels(configured, { env: { PATH: process.env.PATH, OPENAI_API_KEY: "sk-test" } });
    assert.equal(catalog.source, "provider_cli");
    assert.equal(catalog.defaultModel, "gpt-fake-codex");
    assert.deepEqual(catalog.models[0].reasoningEfforts, ["low", "medium"]);
    assert.match(catalog.warning ?? "", /API 请求失败/);
  } finally {
    process.chdir(previousCwd);
  }
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

test("Claude commands match headless stream-json, resume, and effort surface", () => {
  const configured = { ...instance, baseArgs: [], providerOptions: { permissionMode: "plan" } };
  const request = { instance: configured, prompt: "hello", cwd: process.cwd(), model: "sonnet", reasoningEffort: "max" };
  assert.deepEqual(buildClaudeStartArgs(configured, "hello", request), [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "sonnet", "--effort", "max", "--permission-mode", "plan", "hello"
  ]);
  assert.deepEqual(buildClaudeResumeArgs(configured, "session-1", "continue", { ...request, prompt: "continue", providerSessionId: "session-1" }), [
    "-p", "--resume", "session-1", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "sonnet", "--effort", "max", "--permission-mode", "plan", "continue"
  ]);
  // The catalog's "default" entry must not leak into the CLI as a --model value.
  const defaultModel = buildClaudeStartArgs(configured, "hello", { ...request, model: "default" });
  assert.ok(!defaultModel.includes("--model"));
  // Clearing the session override must not hide the instance's plan mode.
  const inherited = buildClaudeStartArgs(configured, "hello", { ...request, permissionMode: "" });
  assert.deepEqual(inherited.slice(-3), ["--permission-mode", "plan", "hello"]);
  // A non-empty session value still overrides the instance setting.
  const overridden = buildClaudeStartArgs(configured, "hello", { ...request, permissionMode: "default" });
  assert.deepEqual(overridden.slice(-3), ["--permission-mode", "default", "hello"]);
  // Custom baseArgs own the whole CLI surface.
  const custom = { ...configured, baseArgs: ["-p", "--output-format", "stream-json"] };
  assert.deepEqual(buildClaudeStartArgs(custom, "hello", request), ["-p", "--output-format", "stream-json", "hello"]);
  assert.deepEqual(buildClaudeResumeArgs(custom, "session-1", "continue", request), ["-p", "--output-format", "stream-json", "--resume", "session-1", "continue"]);
  // Unknown permission modes are ignored rather than passed through.
  const weird = { ...instance, baseArgs: [], providerOptions: { permissionMode: "not-a-mode" } };
  assert.ok(!buildClaudeStartArgs(weird, "hello").includes("--permission-mode"));
});

test("Claude commands forward deliberate env overrides via --settings to beat settings.json", () => {
  const configured = { ...instance, baseArgs: [] };
  const request = {
    instance: configured,
    prompt: "hello",
    cwd: process.cwd(),
    env: { ANTHROPIC_BASE_URL: "https://relay.example.com", ANTHROPIC_API_KEY: "sk-test", PATH: "C:\\Windows" }
  };
  const args = buildClaudeStartArgs(configured, "hello", request);
  const flagIndex = args.indexOf("--settings");
  assert.ok(flagIndex > 0 && flagIndex < args.indexOf("hello"));
  assert.deepEqual(JSON.parse(args[flagIndex + 1]), {
    env: { ANTHROPIC_BASE_URL: "https://relay.example.com", ANTHROPIC_API_KEY: "sk-test" }
  });
  // Resume path gets the same treatment; no overrides means no flag.
  assert.ok(buildClaudeResumeArgs(configured, "s1", "go", { ...request, providerSessionId: "s1" }).includes("--settings"));
  assert.ok(!buildClaudeStartArgs(configured, "hello", { ...request, env: { PATH: "C:\\Windows" } }).includes("--settings"));
  assert.ok(!buildClaudeStartArgs(configured, "hello").includes("--settings"));
});

test("Claude runtime tools are injected as a headless MCP config", () => {
  const args = claudeRuntimeMcpArgs("http://127.0.0.1:4321/mcp/token");
  assert.equal(args[0], "--mcp-config");
  const config = JSON.parse(args[1]);
  assert.deepEqual(config, { mcpServers: { agenthub: { type: "http", url: "http://127.0.0.1:4321/mcp/token" } } });
  assert.deepEqual(args.slice(2), ["--allowedTools", "mcp__agenthub"]);
});

test("Claude stream-json parser exposes session, commands, messages, tools, and usage", () => {
  const state = createClaudeParseState();
  const init = parseClaudeJsonEvent({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-4-8", slash_commands: ["/compact", "cost"] }, state);
  assert.deepEqual(init[0], { kind: "session", providerSessionId: "sess-1", raw: { type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-4-8", slash_commands: ["/compact", "cost"] } });
  assert.deepEqual(init[1].commands, [{ name: "compact", description: "compact" }, { name: "cost", description: "cost" }]);

  const assistant = parseClaudeJsonEvent({ type: "assistant", message: { id: "msg-1", content: [
    { type: "thinking", thinking: "inspect first" },
    { type: "text", text: "I will edit the file." },
    { type: "tool_use", id: "toolu-1", name: "Edit", input: { file_path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" } }
  ], usage: { input_tokens: 12, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500, output_tokens: 7 } } }, state);
  assert.deepEqual(assistant.map((event) => event.kind), ["thinking", "message", "tool", "usage"]);
  assert.equal(assistant[1].messageId, "msg-1");
  assert.equal(assistant[1].phase, "completed");
  assert.deepEqual(assistant[2].fileDiff, { operation: "edit", path: "src/a.ts", before: "const a = 1;", after: "const a = 2;" });
  // Per-request usage reports the real context footprint of that single call.
  const requestUsage = assistant[3];
  assert.equal(requestUsage.inputTokens, 12);
  assert.equal(requestUsage.cachedInputTokens, 9500);
  assert.equal(requestUsage.outputTokens, 7);
  assert.equal(requestUsage.contextUsed, 9512);

  // Sub-agent requests carry their own context and must not move the indicator.
  const subUsage = parseClaudeJsonEvent({ type: "assistant", parent_tool_use_id: "toolu-task-9", message: { id: "msg-sub", content: [
    { type: "text", text: "sub" }
  ], usage: { input_tokens: 999, cache_read_input_tokens: 99000 } } }, state);
  assert.ok(!subUsage.some((event) => event.kind === "usage"));

  const completed = parseClaudeJsonEvent({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "toolu-1", content: [{ type: "text", text: "edited" }], is_error: false }
  ] } }, state)[0];
  assert.equal(completed.kind, "tool");
  assert.equal(completed.phase, "completed");
  assert.equal(completed.name, "Edit");
  assert.equal(completed.output, "edited");
  assert.equal(completed.success, true);

  const result = parseClaudeJsonEvent({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "sess-1",
    usage: { input_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 42 },
    modelUsage: { "claude-opus-4-8": { contextWindow: 200000 } } }, state);
  const usage = result.find((event) => event.kind === "usage");
  // result.usage totals stay cumulative (throughput), but contextUsed keeps the
  // latest single-request footprint instead of the session-wide cache sum.
  assert.equal(usage.inputTokens, 5);
  assert.equal(usage.cachedInputTokens, 1000);
  assert.equal(usage.outputTokens, 42);
  assert.equal(usage.contextUsed, 9512);
  assert.equal(usage.contextWindow, 200000);
  assert.ok(result.some((event) => event.kind === "status" && event.phase === "turn_completed"));
  assert.equal(state.toolNames.size, 0);

  const failed = parseClaudeJsonEvent({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", session_id: "sess-1" }, state);
  assert.ok(failed.some((event) => event.kind === "status" && event.phase === "turn_failed"));
  assert.ok(failed.some((event) => event.kind === "error" && event.error.message === "boom"));

  // Write and MultiEdit inputs also normalize into file diffs.
  const write = parseClaudeJsonEvent({ type: "assistant", message: { id: "msg-2", content: [
    { type: "tool_use", id: "toolu-2", name: "Write", input: { file_path: "src/new.ts", content: "export {};\n" } },
    { type: "tool_use", id: "toolu-3", name: "MultiEdit", input: { file_path: "src/a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] } }
  ] } }, state);
  assert.deepEqual(write[0].fileDiff, { operation: "write", path: "src/new.ts", before: "", after: "export {};\n" });
  assert.deepEqual(write[1].fileDiff, { operation: "edit", path: "src/a.ts", before: "a\nc", after: "b\nd" });
});

test("Claude stream_event partial messages emit text/thinking deltas", () => {
  const state = createClaudeParseState();

  // message_start + content_block_start establish message id and block types.
  assert.deepEqual(parseClaudeJsonEvent({ type: "stream_event", event: { type: "message_start", message: { id: "msg-s1" } } }, state), []);
  assert.deepEqual(parseClaudeJsonEvent({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } }, state), []);
  assert.deepEqual(parseClaudeJsonEvent({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } }, state), []);

  const think = parseClaudeJsonEvent({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } } }, state);
  assert.equal(think.length, 1);
  assert.equal(think[0].kind, "thinking");
  assert.equal(think[0].phase, "delta");
  assert.equal(think[0].messageId, "msg-s1-thinking");
  assert.equal(think[0].text, "plan");

  const delta1 = parseClaudeJsonEvent({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello " } } }, state);
  const delta2 = parseClaudeJsonEvent({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "world" } } }, state);
  assert.deepEqual(delta1.map((event) => [event.kind, event.phase, event.messageId, event.text]), [["message", "delta", "msg-s1", "Hello "]]);
  assert.deepEqual(delta2.map((event) => [event.kind, event.phase, event.messageId, event.text]), [["message", "delta", "msg-s1", "world"]]);

  // Whitespace-only deltas (paragraph breaks) are preserved.
  const newline = parseClaudeJsonEvent({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "\n\n" } } }, state);
  assert.equal(newline.length, 1);
  assert.equal(newline[0].text, "\n\n");

  // Sub-agent deltas carry the dispatch id so the UI can nest the activity.
  const sub = parseClaudeJsonEvent({ type: "stream_event", parent_tool_use_id: "toolu-task-1", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "sub" } } }, state);
  assert.equal(sub[0].subagentDispatchId, "toolu-task-1");

  // Tool input deltas and signature deltas stay silent — tools finalize via
  // the complete assistant event.
  assert.deepEqual(parseClaudeJsonEvent({ type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } } }, state), []);
  assert.deepEqual(parseClaudeJsonEvent({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } } }, state), []);

  // The complete assistant event still finalizes the message for persistence.
  const assistant = parseClaudeJsonEvent({ type: "assistant", message: { id: "msg-s1", content: [{ type: "text", text: "Hello world" }] } }, state);
  assert.deepEqual(assistant.map((event) => [event.kind, event.phase, event.text]), [["message", "completed", "Hello world"]]);

  // A result resets streaming state for the next turn.
  parseClaudeJsonEvent({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "sess-1" }, state);
  assert.equal(state.streamMessageId, undefined);
  assert.equal(state.streamBlocks.size, 0);
});

test("Claude model catalog falls back to CLI aliases and exposes effort levels", async () => {
  const fallback = await discoverClaudeModels({});
  assert.equal(fallback.providerId, "claude-code");
  assert.equal(fallback.models[0].id, "default");
  assert.ok(fallback.models.some((model) => model.id === "opus"));
  assert.ok(fallback.models[0].isDefault);
  assert.deepEqual(listClaudeModels().models[1].reasoningEfforts, ["low", "medium", "high", "max"]);
});

test("Claude model discovery explains why it fell back", async () => {
  const noCredential = await discoverClaudeModels({});
  assert.match(noCredential.warning ?? "", /ANTHROPIC_API_KEY/);

  const badBaseUrl = await discoverClaudeModels({ ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "not-a-url" });
  assert.match(badBaseUrl.warning ?? "", /ANTHROPIC_BASE_URL/);
  assert.match(badBaseUrl.warning ?? "", /not-a-url/);
});

test("Claude model discovery reports HTTP failures and parses live model lists", async (t) => {
  const { createServer } = await import("node:http");
  let mode = "fail";
  const server = createServer((req, res) => {
    if (mode === "fail") {
      res.writeHead(401).end("unauthorized");
      return;
    }
    assert.equal(req.headers["x-api-key"], "test-key");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      data: [
        { id: "claude-opus-9", display_name: "Claude Opus 9", created_at: "2026-01-01T00:00:00Z", type: "model" },
        { id: "claude-sonnet-9", display_name: "Claude Sonnet 9", created_at: "2025-06-01T00:00:00Z", type: "model" }
      ],
      has_more: false
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const failed = await discoverClaudeModels({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: baseUrl });
  assert.match(failed.warning ?? "", /HTTP 401/);
  assert.match(failed.warning ?? "", new RegExp(baseUrl.replace(/[.:/]/g, "\\$&")));
  assert.equal(failed.models[0].id, "default");

  mode = "ok";
  const discovered = await discoverClaudeModels({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: baseUrl });
  assert.equal(discovered.warning, undefined);
  assert.equal(discovered.models[0].id, "default");
  // Sorted newest-first after the fallback entry.
  assert.deepEqual(discovered.models.slice(1).map((model) => model.id), ["claude-opus-9", "claude-sonnet-9"]);
});

test("Anthropic-protocol shims fall back to the OpenAI-compatible catalog at the host root", async (t) => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    if (req.url === "/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }]
      }));
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const shimBaseUrl = `http://127.0.0.1:${server.address().port}/anthropic`;

  const generic = await discoverOpenAiCompatibleModels(shimBaseUrl, "test-key");
  assert.deepEqual(generic.models.map((model) => model.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);

  const claude = await discoverClaudeModels({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: shimBaseUrl });
  assert.equal(claude.source, "provider_api");
  assert.equal(claude.models[0].id, "default");
  const flash = claude.models.find((model) => model.id === "deepseek-v4-flash");
  assert.ok(flash);
  assert.deepEqual(flash.reasoningEfforts, ["low", "medium", "high", "max"]);
});

test("provider environment passthrough forwards Anthropic vars and instance baseUrl", () => {
  const registry = new AdapterRegistry();
  const claude = { ...instance, providerId: "claude-code" };
  const claudeDescriptor = registry.find("claude-code").descriptor;
  const shell = { ANTHROPIC_BASE_URL: "https://relay.example.com", ANTHROPIC_AUTH_TOKEN: "relay-token", UNRELATED: "x" };
  const passthrough = providerEnvironmentPassthrough(claude, shell, claudeDescriptor);
  assert.deepEqual(passthrough, { ANTHROPIC_BASE_URL: "https://relay.example.com", ANTHROPIC_AUTH_TOKEN: "relay-token" });

  const withOption = providerEnvironmentPassthrough({ ...claude, providerOptions: { baseUrl: "https://option.example.com" } }, shell, claudeDescriptor);
  assert.equal(withOption.ANTHROPIC_BASE_URL, "https://option.example.com");

  assert.deepEqual(providerEnvironmentPassthrough({ ...instance, providerId: "codex" }, shell, registry.find("codex").descriptor), {});

  const codexShell = { OPENAI_API_KEY: "sk-shell", OPENAI_BASE_URL: "https://relay.example.com/v1", UNRELATED: "x" };
  assert.deepEqual(providerEnvironmentPassthrough({ ...instance, providerId: "codex" }, codexShell, registry.find("codex").descriptor), {
    OPENAI_API_KEY: "sk-shell",
    OPENAI_BASE_URL: "https://relay.example.com/v1"
  });
  const codexWithOption = providerEnvironmentPassthrough(
    { ...instance, providerId: "codex", providerOptions: { baseUrl: "https://api.deepseek.com/" } },
    codexShell,
    registry.find("codex").descriptor
  );
  assert.equal(codexWithOption.OPENAI_BASE_URL, "https://api.deepseek.com/");
});

test("Codex app-server compaction uses thread/compact/start instead of a chat turn", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "agenthub-codex-compact-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const logPath = join(workspace, "methods.log");
  // `node app-server` resolves the script from cwd; an extensionless CommonJS
  // file lets us pose as `codex app-server --stdio` without a real Codex install.
  const fixture = readFileSync(fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url)), "utf8");
  writeFileSync(join(workspace, "app-server"), fixture);
  const instance = {
    id: "codex-1",
    providerId: "codex",
    displayName: "Codex",
    executable: process.execPath,
    baseArgs: [],
    capabilities: [],
    enabled: true,
    status: "available",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const run = startCodexAppServer({
    instance,
    prompt: "/compact",
    cwd: workspace,
    providerSessionId: "thread-123",
    providerCommand: "compact",
    env: { ...process.env, CODEX_FAKE_LOG: logPath }
  }, true);

  const events = [];
  for await (const event of run.events) events.push(event);

  assert.ok(events.some((event) => event.kind === "session" && event.providerSessionId === "thread-123"));
  assert.ok(events.some((event) => event.kind === "message" && typeof event.text === "string" && event.text.includes("压缩")));
  assert.equal(events.find((event) => event.kind === "exit")?.exitCode, 0);
  const methods = readFileSync(logPath, "utf8").trim().split("\n");
  assert.ok(methods.includes("thread/resume"));
  assert.ok(methods.includes("thread/compact/start"));
  assert.ok(!methods.includes("turn/start"));
});

test("Codex app-server executes image_gen through the configured Images API", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "agenthub-codex-image-e2e-"));
  const fixture = readFileSync(fileURLToPath(new URL("./fixtures/fake-codex-image-app-server.mjs", import.meta.url)), "utf8");
  writeFileSync(join(workspace, "app-server"), fixture);
  const logPath = join(workspace, "rpc.ndjson");
  const imageBytes = Buffer.from("fake-e2e-png");
  const imageRequests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      imageRequests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ b64_json: imageBytes.toString("base64") }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(workspace, { recursive: true, force: true });
  });

  const instance = {
    id: "codex-image",
    providerId: "codex",
    displayName: "Codex",
    executable: process.execPath,
    baseArgs: [],
    providerOptions: { baseUrl },
    capabilities: [],
    enabled: true,
    status: "available",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const run = startCodexAppServer({
    instance,
    prompt: "make an image",
    cwd: workspace,
    env: { ...process.env, OPENAI_API_KEY: "test-image-key", CODEX_FAKE_LOG: logPath },
    timeoutMs: 10_000
  }, false);

  const events = [];
  for await (const event of run.events) events.push(event);

  const rpcMessages = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const threadStart = rpcMessages.find((message) => message.method === "thread/start");
  assert.equal(threadStart.params.dynamicTools[0].name, "image_gen");
  assert.equal(threadStart.params.dynamicTools[0].type, "function");
  assert.equal(rpcMessages.some((message) => message.id === "image-call-1" && message.method === undefined), true);
  assert.equal(imageRequests.length, 1);
  assert.deepEqual(imageRequests[0], {
    method: "POST",
    url: "/v1/images/generations",
    authorization: "Bearer test-image-key",
    body: {
      model: "gpt-image-2",
      prompt: "A small blue square",
      n: 1,
      size: "auto",
      quality: "medium",
      output_format: "png"
    }
  });
  const artifact = events.find((event) => event.kind === "artifact" && event.artifactType === "image");
  assert.ok(artifact);
  assert.deepEqual(readFileSync(artifact.path), imageBytes);
  assert.match(artifact.path, /output[\\/]imagegen[\\/]e2e-blue-square\.png$/);
  assert.equal(events.find((event) => event.kind === "exit")?.exitCode, 0);
});
