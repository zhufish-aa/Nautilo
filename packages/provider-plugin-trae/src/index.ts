/**
 * Nautilo provider plugin for Trae.
 *
 * Two Trae CLIs exist and this adapter drives both:
 *
 * - Official TRAE CLI (`traecli`, enterprise edition): ACP-native, driven over
 *   ndjson JSON-RPC (`traecli acp serve`) with streaming updates, tool calls,
 *   usage reports, permission bridging and session/load resume.
 * - Open-source trae-agent (`trae-cli`): headless execution, isolated API
 *   configuration and structured replies/usage read from its trajectory.
 *
 * The binary is probed per run: `instance.baseArgs` always precede the
 * plugin's own arguments, so wrappers such as `uv run trae-cli` work and the
 * host tests can inject fixture scripts. The SDK is imported type-only: the
 * compiled plugin is fully self-contained.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform, homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import conversationBridge from "../resources/sitecustomize.py";
import type {
  AdapterDetectionResult,
  AdapterEvent,
  AdapterFileDiff,
  AdapterResumeRequest,
  AdapterRun,
  AdapterStartRequest,
  AgentCliAdapter,
  ProcessEvent,
  ProcessHandle,
  ProviderDescriptor,
  ProviderPluginFactory
} from "@agenthub/provider-sdk";

// Keep in sync with agenthub-plugin.json (the descriptor is duplicated there
// so the host can render the catalog entry without loading plugin code).
const descriptor: ProviderDescriptor = {
  providerId: "trae",
  name: "Trae",
  vendor: "ByteDance",
  capabilities: ["headless_structured", "tool_streaming"],
  defaultExecutable: "trae-cli",
  nativeApiProtocol: "responses",
  connectionProtocolDiscovery: true,
  observeApiOutput: true,
  envPassthrough: ["TRAE_CONFIG_FILE"],
  credentialEnv: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "DOUBAO_API_KEY"]
};

type TraeMode = "acp" | "cli";

interface TraeBinary {
  mode: TraeMode;
  version: string;
  help: string;
}

function modernCli(binary: TraeBinary): boolean { return /^\s*exec\s/m.test(binary.help); }

function prepareOpenSourceConnection<T extends AdapterStartRequest>(request: T): T {
  if (!request.instance.providerOptions?.runtimeConnectionId) return request;
  const root = request.env?.NAUTILO_CONNECTION_DIRECTORY;
  if (!root) throw new Error("API connection directory is missing");
  const session = request.localSessionId ?? "default";
  if (!/^[A-Za-z0-9_-]+$/.test(session)) throw new Error("Invalid local session identity");
  const directory = join(root, "trae-agent", session);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const configFile = join(directory, "trae_config.yaml");
  const baseUrl = String(request.instance.providerOptions.baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");
  const config = buildOpenSourceConfiguration(request, baseUrl);
  writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { ...request, env: { ...request.env, TRAE_CONFIG_FILE: configFile, NAUTILO_TRAE_MCP_COUNT: String(Object.keys(asRecord(config.mcp_servers)).length),
    NAUTILO_TRAE_TRAJECTORY: join(directory, "trajectory.json"),
    ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: request.env?.NAUTILO_CONNECTION_API_KEY } };
}

export function buildOpenSourceConfiguration(request: AdapterStartRequest, baseUrl: string): Record<string, unknown> {
  const explicit = request.env?.TRAE_CONFIG_FILE;
  const source = explicit ? (isAbsolute(explicit) ? explicit : join(request.cwd, explicit))
    : ["trae_config.yaml", "trae_config.yml", "trae_config.json"].map(name => join(request.cwd, name)).find(existsSync);
  const parsed: unknown = source ? parseYaml(readFileSync(source, "utf8")) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Native Trae configuration must be an object");
  const config = parsed as Record<string, unknown>;
  const agent = { enable_lakeview: true, max_steps: 200,
    tools: ["bash", "str_replace_based_edit_tool", "sequentialthinking", "task_done"],
    ...asRecord(asRecord(config.agents).trae_agent) };
  const nativeModel = asRecord(asRecord(config.models)[String(asRecord(agent).model ?? "")]);
  for (const section of ["agents", "model_providers", "models", ...(agent.enable_lakeview !== false ? ["lakeview"] : [])]) {
    const value = config[section];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
      throw new Error(`Native Trae ${section} must be an object`);
    }
  }
  config.agents = { ...asRecord(config.agents), trae_agent: { ...agent, model: "selected" } };
  config.model_providers = { ...asRecord(config.model_providers), nautilo: { provider: "anthropic", api_key: "", base_url: baseUrl } };
  config.models = { ...asRecord(config.models), selected: { max_tokens: 16384, temperature: 0.5, top_p: 1, top_k: 0,
    parallel_tool_calls: true, max_retries: 1, ...nativeModel, model_provider: "nautilo", model: request.model } };
  if (agent.enable_lakeview !== false) config.lakeview = { ...asRecord(config.lakeview), model: "selected" };
  for (const server of request.mcpServers ?? []) {
    const servers = asRecord(config.mcp_servers);
    const entry = { ...asRecord(servers[server.name]) };
    for (const key of ["command", "args", "env", "cwd", "url", "http_url", "headers"]) delete entry[key];
    servers[server.name] = { ...entry, ...(server.transport === "http"
      ? { http_url: server.url, headers: server.headers }
      : { command: server.command, args: server.args, env: server.env }) };
    config.mcp_servers = servers;
    const allowed = config.allow_mcp_servers === undefined ? [] : config.allow_mcp_servers;
    if (!Array.isArray(allowed)) throw new Error("Native Trae allow_mcp_servers must be an array");
    config.allow_mcp_servers = [...new Set([...allowed, server.name])];
  }
  return config;
}

function prepareConnection<T extends AdapterStartRequest>(request: T, modern: boolean): T {
  const options = request.instance.providerOptions;
  if (!options?.runtimeConnectionId) return request;
  if (!request.env?.NAUTILO_CONNECTION_DIRECTORY) throw new Error("API connection directory is missing");
  const session = request.localSessionId ?? "default";
  if (!/^[A-Za-z0-9_-]+$/.test(session)) throw new Error("Invalid local session identity");
  const home = join(request.env.NAUTILO_CONNECTION_DIRECTORY, "trae", session);
  const directory = join(home, ".trae");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let instance = request.instance;
  if (modern) {
    writeFileSync(join(directory, "traecli.toml"), `model = ${JSON.stringify(request.model ?? "")}\nmodel_provider = "nautilo"\n${request.reasoningEffort ? `model_reasoning_effort = ${JSON.stringify(request.reasoningEffort)}\n` : ""}\n[model_providers.nautilo]\nname = "Nautilo"\nbase_url = ${JSON.stringify(options.baseUrl)}\nenv_key = "NAUTILO_CONNECTION_API_KEY"\nwire_api = "responses"\n`);
  } else {
    const models = (instance.models ?? []).filter(model => model.enabled !== false).map(model => ({
      name: `nautilo/${model.id}`, context_window: model.contextWindow ?? 128_000,
      claude: { model: model.id, base_url: options.baseUrl, api_key: "${NAUTILO_CONNECTION_API_KEY}", max_tokens: 16_384 },
    }));
    const alias = `nautilo/${request.model}`;
    const text = JSON.stringify({ model: { name: alias }, models, disable_model_failover: true, failover_models: [] });
    writeFileSync(join(directory, "traecli.yaml"), text);
    writeFileSync(join(directory, "trae_cli.yaml"), text);
    const roaming = join(home, "AppData", "Roaming", "trae_cli");
    mkdirSync(roaming, { recursive: true, mode: 0o700 });
    writeFileSync(join(roaming, "trae_cli.yaml"), text);
    instance = { ...instance, baseArgs: [...instance.baseArgs, "-c", `model.name=${alias}`, "-c", "disable_model_failover=true"] };
    request = { ...request, model: alias };
  }
  return { ...request, instance, env: { ...request.env, HOME: home, USERPROFILE: home, TRAE_HOME: directory, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CONFIG_HOME: join(home, ".config") } };
}

class TraePluginAdapter implements AgentCliAdapter {
  readonly providerId = "trae";
  readonly descriptor = descriptor;
  readonly supportsStructuredOutput = true;
  readonly supportsResume = true;
  readonly capabilities = {
    structuredOutput: true,
    textOutput: true,
    interactiveStdin: false,
    nativeResume: true,
    pty: false
  };

  async detect(instance: { executable: string; baseArgs?: string[] }): Promise<AdapterDetectionResult> {
    const executable = instance.executable || descriptor.defaultExecutable || "traecli";
    try {
      const probed = await probeTraeBinary(executable, instance.baseArgs ?? []);
      if (!probed) {
        return {
          installed: false,
          executable,
          error: "未识别为 Trae CLI：请安装官方 TRAE CLI（traecli，企业版）或开源 trae-agent（trae-cli），或在实例设置中指定可执行文件路径"
        };
      }
      return {
        installed: true,
        compatible: true,
        executable,
        version: probed.version,
        help: probed.help.slice(0, 16_384),
        error: undefined
      };
    } catch (error) {
      return { installed: false, executable, error: error instanceof Error ? error.message : String(error) };
    }
  }

  start(request: AdapterStartRequest): AdapterRun {
    return this.run(request, false);
  }

  resume(request: AdapterResumeRequest): AdapterRun {
    return this.run(request, true);
  }

  async connectionProtocol(request: AdapterStartRequest): Promise<"responses" | "anthropic"> {
    const binary = await probeTraeBinary(request.instance.executable || descriptor.defaultExecutable!, request.instance.baseArgs);
    if (!binary) throw new Error("未找到可用的 Trae CLI");
    return modernCli(binary) ? "responses" : "anthropic";
  }

  private run(request: AdapterStartRequest | AdapterResumeRequest, resume: boolean): AdapterRun {
    let handle: PluginProcessHandle | undefined;
    let rpc: PluginJsonRpcClient | undefined;
    let sessionId = resume ? (request as AdapterResumeRequest).providerSessionId : undefined;
    let finished = false;
    let cancelled = false;

    const events = async function* (): AsyncGenerator<AdapterEvent> {
      try {
        const binary = await probeTraeBinary(request.instance.executable || descriptor.defaultExecutable || "traecli", request.instance.baseArgs);
        if (cancelled) return;
        if (!binary) throw new Error("未找到可用的 Trae CLI（traecli 或 trae-cli）");
        request = binary.mode === "cli" ? prepareOpenSourceConnection(request) : prepareConnection(request, modernCli(binary));
        if (binary.mode === "cli") {
          request = prepareOpenSourceRuntime(request, resume ? (request as AdapterResumeRequest).providerSessionId : undefined);
          yield { kind: "status", phase: "turn_started" };
          yield* plainRun(request, (value) => { handle = value; });
          finished = true;
          return;
        }
        yield* acpRun(request, resume, {
          setHandle: (value) => { handle = value; },
          setRpc: (value) => { rpc = value; },
          getSessionId: () => sessionId,
          setSessionId: (value) => { sessionId = value; },
          setFinished: () => { finished = true; }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield { kind: "error", error: new Error(request.instance.providerOptions?.runtimeConnectionId && /keyring/.test(message)
          ? "当前安装的 Trae CLI 在执行自定义 API 前仍要求原生登录，但没有找到其登录凭据。请完成此 CLI 的登录，或为 Trae 插件指定支持直接 API 的 trae-agent 可执行文件。"
          : message) };
        if (!finished) await handle?.cancel().catch(() => undefined);
      }
    };

    const deferred = deferredProcess(() => handle);
    return {
      process: deferred,
      events: { [Symbol.asyncIterator]: events },
      cancel: async () => {
        cancelled = true;
        if (rpc && sessionId) rpc.notify("session/cancel", { sessionId });
        await handle?.cancel();
      },
      write: (input) => handle?.write(input)
    };
  }
}

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null ? value as RecordValue : {};

export function prepareOpenSourceRuntime<T extends AdapterStartRequest>(request: T, resume?: string): T {
  const id = request.localSessionId;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid Trae session identity");
  const session = `nautilo-trae:${id}`;
  if (resume && resume !== session) throw new Error("Trae session belongs to a different execution mode");
  const root = request.env?.NAUTILO_CONNECTION_DIRECTORY ?? process.env.AGENTHUB_DATA_DIR ?? join(homedir(), ".nautilo");
  const directory = join(root,"trae-agent",id);
  const bridge = join(directory,"bridge");
  mkdirSync(bridge,{recursive:true,mode:0o700});
  const script = join(bridge,"sitecustomize.py");
  if (!existsSync(script) || readFileSync(script,"utf8") !== conversationBridge) writeFileSync(script,conversationBridge,{mode:0o600});
  const images = (request.localImagePaths ?? []).map(path => isAbsolute(path) ? path : join(request.cwd,path));
  traeImagePrompt(request); // Validate attachments before starting the CLI.
  return {...request,env:{...request.env,
    PYTHONPATH:[bridge,request.env?.PYTHONPATH].filter(Boolean).join(delimiter),
    PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8",NAUTILO_TRAE_BRIDGE:"1",
    NAUTILO_TRAE_STATE:join(directory,"conversation.json"),NAUTILO_TRAE_SESSION_ID:session,
    NAUTILO_TRAE_RESUME:resume ? "1" : "0", NAUTILO_TRAE_IMAGES:JSON.stringify(images),
    NAUTILO_TRAE_TRAJECTORY:join(directory,"trajectory.json"),
    ...(request.reasoningEffort ? {NAUTILO_TRAE_EFFORT:request.reasoningEffort} : {})
  }};
}

/**
 * Probes one Trae CLI binary: `--version` must succeed and `--help` decides
 * the transport. `acp` in the help means the official ACP-native CLI;
 * otherwise a `run` subcommand means the open-source trae-agent.
 * (Named-exported for host-side tests.)
 */
export async function probeTraeBinary(executable: string, baseArgs: string[] = [], env?: Record<string, string | undefined>): Promise<TraeBinary | undefined> {
  const version = await capture(executable, [...baseArgs, "--version"], env);
  if (version.exitCode !== 0) return undefined;
  const help = await capture(executable, [...baseArgs, "--help"], env);
  if (help.exitCode !== 0) return undefined;
  const mode: TraeMode | undefined = /\bacp\b/i.test(help.text)
    ? "acp"
    : /^\s*run(\s|,|$)/m.test(help.text) ? "cli" : undefined;
  if (!mode) return undefined;
  return { mode, version: version.text.trim(), help: help.text };
}

/* ------------------------------------------------------------------------ */
/* ACP transport (official traecli)                                         */
/* ------------------------------------------------------------------------ */

interface AcpRunHooks {
  setHandle(handle: PluginProcessHandle): void;
  setRpc(client: PluginJsonRpcClient): void;
  getSessionId(): string | undefined;
  setSessionId(value: string): void;
  setFinished(): void;
}

async function* acpRun(
  request: AdapterStartRequest | AdapterResumeRequest,
  resume: boolean,
  hooks: AcpRunHooks
): AsyncGenerator<AdapterEvent> {
  const env = { ...(request.env ?? {}), PYTHONUNBUFFERED: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } as Record<string, string>;
  // The ACP subcommand shape is `traecli acp serve`; fall back to bare `acp`
  // when the binary exits before answering initialize.
  let handle = spawnAcp(request, env, ["acp", "serve"]);
  let rpc = new PluginJsonRpcClient(handle);
  try {
    await rpc.request("initialize", acpInitializeParams());
  } catch {
    await handle.cancel().catch(() => undefined);
    handle = spawnAcp(request, env, ["acp"]);
    rpc = new PluginJsonRpcClient(handle);
    await rpc.request("initialize", acpInitializeParams());
  }
  hooks.setHandle(handle);
  hooks.setRpc(rpc);

  const initializeResponse = asRecord(rpc.lastInitializeResult);
  const agentCapabilities = asRecord(initializeResponse.agentCapabilities);
  if (resume && agentCapabilities.loadSession === false) {
    throw new Error("当前 TRAE CLI 不支持 session/load，无法恢复会话");
  }

  const mcpServers = acpMcpServers(request);
  const state: TraeAcpParseState = { messageId: "trae-message-1", thinkingId: "trae-thinking-1", toolNames: new Map(), toolCalls: new Map() };
  let messageStreamed = false;
  let thinkingStreamed = false;

  const sessionRequest = rpc.requestWithId(resume ? "session/load" : "session/new", resume
    ? { sessionId: (request as AdapterResumeRequest).providerSessionId, cwd: request.cwd, mcpServers }
    : { cwd: request.cwd, mcpServers });
  // ACP session/load reconstructs the loaded conversation by replaying its
  // historical session/update notifications before the load response. A new
  // CLI process is created for every resumed turn, so those notifications are
  // queued on this fresh RPC client. If they reach the prompt loop below, the
  // host concatenates every old assistant chunk into the new answer. Consume
  // the replay through the exact load-response boundary before prompting.
  const sessionResponseValue = resume
    ? (await Promise.all([
        sessionRequest.promise,
        drainAcpSessionLoadReplay(rpc, sessionRequest.id, request)
      ]))[0]
    : await sessionRequest.promise;
  const sessionResponse = asRecord(sessionResponseValue);
  const sessionId = String(sessionResponse.sessionId ?? (resume ? (request as AdapterResumeRequest).providerSessionId : ""));
  if (!sessionId) throw new Error("TRAE CLI ACP did not return a session id");
  hooks.setSessionId(sessionId);
  yield { kind: "session", providerSessionId: sessionId };
  // Resume spawns a fresh CLI process whose options reset to defaults, so
  // model / effort are re-applied from configOptions every time.
  await applyAcpConfig(rpc, sessionId, sessionResponse, request);
  yield { kind: "status", phase: "turn_started" };
  const prompt = rpc.requestWithId("session/prompt", { sessionId, prompt: traeImagePrompt(request) });
  void prompt.promise.catch(() => undefined);

  for await (const event of rpc) {
    if (event.kind === "notification" && event.method === "session/update") {
      const update = asRecord(event.params).update;
      for (const item of parseTraeAcpUpdate(update, state)) {
        if (item.kind === "message") messageStreamed = true;
        if (item.kind === "thinking") thinkingStreamed = true;
        yield item;
      }
    } else if (event.kind === "request" && event.method === "session/request_permission") {
      await answerAcpPermission(rpc, event.id, event.params, request);
    } else if (event.kind === "request") {
      rpc.respondError(event.id, -32601, `Nautilo does not support ACP request ${event.method}`);
    } else if (event.kind === "response" && event.id === prompt.id) {
      // The daemon coalesces delta buffers when a completed event carries no text.
      if (messageStreamed) yield { kind: "message", phase: "completed", messageId: state.messageId, text: "" };
      if (thinkingStreamed) yield { kind: "thinking", phase: "completed", messageId: state.thinkingId, text: "" };
      yield { kind: "status", phase: event.error ? "turn_failed" : "turn_completed" };
      hooks.setFinished();
      await handle.cancel();
      yield event.error
        ? { kind: "error", error: new Error(JSON.stringify(event.error)) }
        : { kind: "exit", exitCode: 0 };
      return;
    } else if (event.kind === "transport") {
      const mapped = transportEvent(event.event);
      if (mapped) yield mapped;
    }
  }
}

/**
 * Consumes ACP's session/load reconstruction stream through its response.
 * Requests still need answers so a server that asks the client for permission
 * while loading cannot deadlock. Notifications are deliberately discarded:
 * they describe already-persisted history, not activity from the next turn.
 */
async function drainAcpSessionLoadReplay(
  rpc: PluginJsonRpcClient,
  responseId: string | number,
  request: AdapterStartRequest | AdapterResumeRequest
): Promise<void> {
  for await (const event of rpc) {
    if (event.kind === "response" && event.id === responseId) return;
    if (event.kind === "request" && event.method === "session/request_permission") {
      await answerAcpPermission(rpc, event.id, event.params, request);
    } else if (event.kind === "request") {
      rpc.respondError(event.id, -32601, `Nautilo does not support ACP request ${event.method}`);
    }
  }
  throw new Error("TRAE CLI ACP closed before session/load completed");
}

function acpInitializeParams(): RecordValue {
  return {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo: { name: "Nautilo", version: "0.1.0" }
  };
}

function spawnAcp(request: AdapterStartRequest | AdapterResumeRequest, env: Record<string, string>, acpArgs: string[]): PluginProcessHandle {
  const executable = request.instance.executable || descriptor.defaultExecutable || "traecli";
  const args = [...request.instance.baseArgs, ...acpArgs];
  const resolved = resolveSpawnCommand(executable, args, env);
  const child = spawn(resolved.command, resolved.args, {
    cwd: request.cwd,
    env,
    windowsHide: true,
    windowsVerbatimArguments: resolved.verbatim ?? false
  });
  return new PluginProcessHandle(child, {
    timeoutMs: request.timeoutMs,
    idleTimeoutMs: request.idleTimeoutMs,
    // ACP can stream cumulative tool inputs, making transport bytes grow
    // quadratically for file writes; no plain-text 20 MB default here.
    maxOutputBytes: request.maxOutputBytes ?? 256 * 1024 * 1024
  });
}

function acpMcpServers(request: AdapterStartRequest | AdapterResumeRequest): Array<Record<string, unknown>> {
  const servers: Array<Record<string, unknown>> = [];
  for (const server of request.mcpServers ?? []) {
    if (server.transport === "http" && server.url) {
      servers.push({
        type: "http",
        name: server.name,
        url: server.url,
        headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value }))
      });
    } else if (server.transport === "stdio" && server.command) {
      servers.push({
        name: server.name,
        command: server.command,
        args: server.args ?? [],
        env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value }))
      });
    }
  }
  return servers;
}

function traeImagePrompt(request: AdapterStartRequest): RecordValue[] {
  return [{ type:"text", text:request.prompt }, ...(request.localImagePaths ?? []).map(path => {
    const mimeType = ({png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",gif:"image/gif",webp:"image/webp"} as Record<string,string>)[path.split(".").at(-1)?.toLowerCase() ?? ""];
    if (!mimeType) throw new Error(`Unsupported image attachment: ${path}`);
    const data = readFileSync(isAbsolute(path) ? path : join(request.cwd,path));
    if (!data.length) throw new Error(`Image attachment is empty: ${path}`);
    return {type:"image",mimeType,data:data.toString("base64")};
  })];
}

/** Applies session model / reasoning effort through ACP configOptions. */
async function applyAcpConfig(rpc: PluginJsonRpcClient, sessionId: string, response: RecordValue, request: AdapterStartRequest | AdapterResumeRequest): Promise<void> {
  let options = Array.isArray(response.configOptions) ? response.configOptions.map(asRecord) : [];
  const selections: Array<[string | undefined, string[]]> = [
    [request.model, ["model"]],
    [request.reasoningEffort, ["thinking", "reasoning", "effort"]]
  ];
  for (const [value, hints] of selections) {
    if (!value) continue;
    const option = options.find((item) => hints.some((hint) => `${String(item.id ?? "")} ${String(item.name ?? "")} ${String(item.label ?? "")}`.toLowerCase().includes(hint)));
    if (option?.id) {
      const result = asRecord(await rpc.request("session/set_config_option", { sessionId, configId: option.id, value }));
      if (Array.isArray(result.configOptions)) options = result.configOptions.map(asRecord);
      continue;
    }
    const isModel = hints[0] === "model";
    if (request.env?.[isModel ? "NAUTILO_BRIDGE_MODEL" : "NAUTILO_BRIDGE_EFFORT"] === value) continue;
    const models = asRecord(response.models);
    if (isModel && models.currentModelId === value) continue;
    if (isModel && Array.isArray(models.availableModels) && models.availableModels.some(item => asRecord(item).modelId === value)) {
      await rpc.request("session/set_model", { sessionId, modelId:value });
    } else throw new Error(`CLI did not advertise a way to apply ${isModel ? "model" : "reasoning effort"}=${value}`);
  }
}

async function answerAcpPermission(
  rpc: PluginJsonRpcClient,
  id: string | number,
  params: unknown,
  request: AdapterStartRequest | AdapterResumeRequest
): Promise<void> {
  const record = asRecord(params);
  const options = Array.isArray(record.options) ? record.options.map(asRecord) : [];
  if (request.requestInteraction) {
    const toolCall = asRecord(record.toolCall);
    try {
      const response = await request.requestInteraction({
        kind: "approval",
        title: String(toolCall.title ?? "Trae permission"),
        detail: toolCall.rawInput !== undefined ? JSON.stringify(toolCall.rawInput, null, 2) : undefined,
        options: options.map((option) => ({
          id: String(option.optionId ?? option.id ?? ""),
          label: String(option.name ?? option.label ?? option.optionId ?? "")
        })).filter((option) => option.id)
      });
      rpc.respond(id, response.outcome === "selected" && response.optionId
        ? { outcome: { outcome: "selected", optionId: response.optionId } }
        : { outcome: { outcome: "cancelled" } });
      return;
    } catch { /* fall through to cancel */ }
    rpc.respond(id, { outcome: { outcome: "cancelled" } });
    return;
  }
  const allowed = options.find((option) => !String(option.kind ?? "").includes("reject"));
  if (allowed?.optionId) rpc.respond(id, { outcome: { outcome: "selected", optionId: allowed.optionId } });
  else rpc.respond(id, { outcome: { outcome: "cancelled" } });
}

function transportEvent(event: ProcessEvent): AdapterEvent | undefined {
  if (event.kind === "stdout") return { kind: "raw", stream: "stdout", text: event.text };
  if (event.kind === "stderr") return { kind: "raw", stream: "stderr", text: event.text };
  return event;
}

/* ------------------------- ACP session/update parsing ------------------- */

const TOOL_INPUT_IDENTITY_KEYS = ["path", "file_path", "filePath", "target_path", "targetPath", "query", "pattern", "glob"] as const;

function printable(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (Array.isArray(value)) {
    const parts = value.map(printable).filter((part): part is string => Boolean(part));
    return parts.length ? parts.join("\n") : undefined;
  }
  const object = asRecord(value);
  if (typeof object.text === "string" && object.text.trim()) return object.text;
  if (object.content !== undefined) {
    const nested = printable(object.content);
    if (nested) return nested;
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function toolInput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const source = value as RecordValue;
  const prioritized: RecordValue = {};
  for (const key of TOOL_INPUT_IDENTITY_KEYS) {
    if (Object.hasOwn(source, key)) prioritized[key] = source[key];
  }
  for (const [key, entry] of Object.entries(source)) {
    if (!Object.hasOwn(prioritized, key)) prioritized[key] = entry;
  }
  return prioritized;
}

function mergeToolInput(previous: unknown, current: unknown): unknown {
  if (
    typeof previous !== "object" || previous === null || Array.isArray(previous)
    || typeof current !== "object" || current === null || Array.isArray(current)
  ) return current ?? previous;
  return toolInput({ ...previous as RecordValue, ...current as RecordValue });
}

function toolInputIdentity(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as RecordValue;
  const identity = TOOL_INPUT_IDENTITY_KEYS.flatMap((key) => {
    const entry = input[key];
    return typeof entry === "string" && entry.trim() ? [[key, entry.trim()] as const] : [];
  });
  return identity.length ? JSON.stringify(identity) : undefined;
}

function firstString(input: RecordValue, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function fileDiff(toolName: string, value: unknown): AdapterFileDiff | undefined {
  const normalized = toolName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const isEdit = normalized === "edit"
    || normalized.startsWith("edit_")
    || normalized.startsWith("editing_")
    || normalized.endsWith("_edit")
    || normalized.endsWith("_edit_file");
  const isWrite = normalized === "write"
    || normalized.startsWith("write_")
    || normalized.startsWith("writing_")
    || normalized.endsWith("_write")
    || normalized.endsWith("_write_file");
  if (!isEdit && !isWrite) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as RecordValue;
  const path = firstString(input, TOOL_INPUT_IDENTITY_KEYS);
  if (isWrite) {
    const content = firstString(input, ["content", "text", "data"]);
    return content === undefined ? undefined : { operation: "write", path, before: "", after: content };
  }
  const before = firstString(input, ["old_string", "oldString", "old_text", "oldText", "before"]);
  const after = firstString(input, ["new_string", "newString", "new_text", "newText", "after"]);
  if (before === undefined || after === undefined) return undefined;
  return { operation: "edit", path, before, after };
}

export interface TraeAcpParseState {
  messageId: string;
  thinkingId: string;
  toolNames: Map<string, string>;
  toolCalls: Map<string, {
    phase: "started" | "completed";
    input?: unknown;
    inputIdentity?: string;
    output?: string;
  }>;
}

/**
 * Parses one ACP `session/update` notification payload. Protocol-generic
 * (verified against the ACP schema); named-exported for host-side tests.
 */
export function parseTraeAcpUpdate(value: unknown, state: TraeAcpParseState): AdapterEvent[] {
  const update = asRecord(value);
  const stringValue = (entry: unknown): string | undefined => typeof entry === "string" ? entry : undefined;
  if (update.sessionUpdate === "available_commands_update") {
    const commands = Array.isArray(update.availableCommands) ? update.availableCommands.map(asRecord).flatMap((command) => {
      const name = stringValue(command.name);
      if (!name) return [];
      const input = asRecord(command.input);
      return [{
        name,
        description: stringValue(command.description) ?? name,
        inputHint: stringValue(input.hint)
      }];
    }) : [];
    return commands.length ? [{ kind: "commands", commands, raw: value }] : [];
  }
  if (update.sessionUpdate === "usage_update") {
    return [{
      kind: "usage",
      contextUsed: typeof update.used === "number" ? update.used : undefined,
      contextWindow: typeof update.size === "number" ? update.size : undefined,
      raw: value
    }];
  }
  if (update.sessionUpdate === "agent_message_chunk") {
    const content = asRecord(update.content);
    return content.type === "text" && typeof content.text === "string"
      ? [{ kind: "message", phase: "delta", messageId: state.messageId, text: content.text, raw: value }]
      : [];
  }
  if (update.sessionUpdate === "agent_thought_chunk") {
    const content = asRecord(update.content);
    return content.type === "text" && typeof content.text === "string" && content.text.length > 0
      ? [{ kind: "thinking", phase: "delta", messageId: state.thinkingId, text: content.text, raw: value }]
      : [];
  }
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return [];
  const callId = stringValue(update.toolCallId);
  const suppliedName = stringValue(update.title);
  if (callId && suppliedName && !state.toolNames.has(callId)) state.toolNames.set(callId, suppliedName);
  const name = (callId ? state.toolNames.get(callId) : undefined) ?? suppliedName ?? "tool";
  const status = stringValue(update.status);
  const completed = status === "completed" || status === "failed";
  const input = update.rawInput === undefined ? undefined : toolInput(update.rawInput);
  const output = printable(update.rawOutput) ?? printable(update.content);
  if (callId) {
    const previous = state.toolCalls.get(callId);
    const mergedInput = input === undefined ? previous?.input : mergeToolInput(previous?.input, input);
    const next = {
      phase: completed ? "completed" as const : "started" as const,
      input: mergedInput,
      inputIdentity: toolInputIdentity(mergedInput),
      output: output ?? previous?.output
    };
    state.toolCalls.set(callId, next);
    if (
      previous?.phase === "completed"
      || (!completed && previous?.phase === "started" && previous.inputIdentity === next.inputIdentity)
    ) return [];
    return [{
      kind: "tool",
      callId,
      name,
      phase: next.phase,
      input: next.input,
      output: next.output,
      success: status !== "failed",
      fileDiff: fileDiff(name, next.input),
      raw: value
    }];
  }
  return [{
    kind: "tool",
    callId,
    name,
    phase: completed ? "completed" : "started",
    input,
    output,
    success: status !== "failed",
    fileDiff: fileDiff(name, input),
    raw: value
  }];
}

/* ----------------------------- JSON-RPC client -------------------------- */

type PluginJsonRpcEvent =
  | { kind: "notification"; method: string; params?: unknown }
  | { kind: "request"; id: string | number; method: string; params?: unknown }
  | { kind: "response"; id: string | number; result?: unknown; error?: unknown }
  | { kind: "transport"; event: ProcessEvent };

function rpcError(value: unknown): Error {
  if (typeof value === "object" && value !== null && "message" in value) return new Error(String(value.message));
  return new Error(typeof value === "string" ? value : JSON.stringify(value));
}

/** Newline-delimited JSON-RPC over a spawned process (ACP transport). */
class PluginJsonRpcClient implements AsyncIterable<PluginJsonRpcEvent> {
  private readonly queue = new AsyncQueue<PluginJsonRpcEvent>();
  private readonly pending = new Map<string | number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 1;
  /** Result of the last successful initialize, for capability inspection. */
  lastInitializeResult: unknown;

  constructor(readonly process: ProcessHandle) {
    void this.pump();
  }

  request(method: string, params?: unknown): Promise<unknown> {
    return this.requestWithId(method, params).promise;
  }

  requestWithId(method: string, params?: unknown): { id: number; promise: Promise<unknown> } {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send({ jsonrpc: "2.0", id, method, params });
    if (method === "initialize") {
      void promise.then((result) => { this.lastInitializeResult = result; }).catch(() => undefined);
    }
    return { id, promise };
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  respond(id: string | number, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  [Symbol.asyncIterator](): AsyncIterator<PluginJsonRpcEvent> {
    return this.queue[Symbol.asyncIterator]();
  }

  private send(message: unknown): void {
    this.process.write(`${JSON.stringify(message)}\n`);
  }

  private async pump(): Promise<void> {
    let stdout = "";
    try {
      for await (const event of this.process.events) {
        if (event.kind !== "stdout") {
          this.queue.push({ kind: "transport", event });
          continue;
        }
        stdout += event.text;
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) this.acceptLine(line);
      }
      if (stdout.trim()) this.acceptLine(stdout);
    } finally {
      const error = new Error("JSON-RPC process closed before the request completed");
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.queue.close();
    }
  }

  private acceptLine(line: string): void {
    if (!line.trim()) return;
    let value: RecordValue;
    try {
      value = JSON.parse(line) as RecordValue;
    } catch {
      this.queue.push({ kind: "transport", event: { kind: "stdout", text: line } });
      return;
    }
    const id = value.id as string | number | undefined;
    if (id !== undefined && ("result" in value || "error" in value) && !("method" in value)) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        if (value.error !== undefined) pending.reject(rpcError(value.error));
        else pending.resolve(value.result);
      }
      this.queue.push({ kind: "response", id, result: value.result, error: value.error });
      return;
    }
    if (typeof value.method !== "string") return;
    if (id !== undefined) this.queue.push({ kind: "request", id, method: value.method, params: value.params });
    else this.queue.push({ kind: "notification", method: value.method, params: value.params });
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Plain-text transport (open-source trae-agent)                            */
/* ------------------------------------------------------------------------ */

/**
 * CLI args for one `trae-cli run`. `instance.baseArgs` always come first
 * (wrapper support such as `uv run trae-cli`). A `provider/model` session
 * model splits into --provider/--model; a bare name maps to --model only.
 * (Named-exported for host-side tests.)
 */
export function traeCliArgs(instance: { executable: string; baseArgs: string[] }, request: AdapterStartRequest): string[] {
  const args = [...instance.baseArgs, "run", request.prompt, "--working-dir", request.cwd];
  if (request.env?.NAUTILO_TRAE_TRAJECTORY) args.push("--trajectory-file",request.env.NAUTILO_TRAE_TRAJECTORY);
  if (request.instance.providerOptions?.runtimeConnectionId) {
    args.push("--provider", "nautilo", "--model", request.model ?? "", "--config-file", request.env?.TRAE_CONFIG_FILE ?? "");
    return args;
  }
  const model = request.model?.trim();
  if (model) {
    const slash = model.indexOf("/");
    if (slash > 0) args.push("--provider", model.slice(0, slash), "--model", model.slice(slash + 1));
    else args.push("--model", model);
  }
  return args;
}

async function* plainRun(request: AdapterStartRequest | AdapterResumeRequest, setHandle: (handle: PluginProcessHandle) => void): AsyncGenerator<AdapterEvent> {
  const env = { PYTHONUNBUFFERED: "1", ...(request.env ?? {}) } as Record<string, string>;
  const executable = request.instance.executable || descriptor.defaultExecutable || "traecli";
  const args = traeCliArgs(request.instance, request);
  const resolved = resolveSpawnCommand(executable, args, env);
  const child = spawn(resolved.command, resolved.args, {
    cwd: request.cwd,
    env,
    windowsHide: true,
    windowsVerbatimArguments: resolved.verbatim ?? false
  });
  const handle = new PluginProcessHandle(child, {
    timeoutMs: request.timeoutMs,
    idleTimeoutMs: request.idleTimeoutMs,
    maxOutputBytes: request.maxOutputBytes ?? 20 * 1024 * 1024
  });
  setHandle(handle);
  // trae-agent runs non-interactively here; close stdin so it never waits.
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  let pending = "";
  let bridgeReady = false;
  let streamedMessage = false;
  let streamedUsage = false;
  for await (const event of handle.events) {
    if (event.kind === "stdout") {
      pending += event.text;
      let index: number;
      while ((index=pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0,index).trimEnd();
        pending = pending.slice(index+1);
        if (line.startsWith("@nautilo-event:")) {
          const frame = JSON.parse(line.slice("@nautilo-event:".length));
          if (frame.kind === "nautilo_ready") {bridgeReady=true;continue;}
          streamedMessage ||= frame.kind === "message";
          streamedUsage ||= frame.kind === "usage";
          yield frame as AdapterEvent;
        } else { stdout += line + "\n"; yield {kind:"raw",stream:"stdout",text:line+"\n"}; }
      }
    } else if (event.kind === "stderr") {
      stderr += event.text;
      yield { kind: "raw", stream: "stderr", text: event.text };
    } else if (event.kind === "exit") {
      const text = cleanTraeCliText(stdout);
      if (event.exitCode === 0) {
        if (!bridgeReady) throw new Error("Trae did not load the conversation bridge; check the configured native Python environment");
        if (request.env?.NAUTILO_TRAE_TRAJECTORY) {
          const trajectory = JSON.parse(readFileSync(request.env.NAUTILO_TRAE_TRAJECTORY, "utf8"));
          if (trajectory.success !== true) throw new Error("Trae Agent did not complete the task; check the configured model and execution result");
          const interactions = (Array.isArray(trajectory.llm_interactions) ? trajectory.llm_interactions : []) as { response?: { content?: string; usage?: { input_tokens?: number; output_tokens?: number } } }[];
          const answer = trajectory.final_result || [...interactions].reverse().find(item => item.response?.content)?.response?.content;
          if (typeof answer !== "string" || !answer.trim()) throw new Error("Trae Agent returned no assistant response");
          if (!streamedMessage) yield { kind: "message", phase: "completed", text: answer };
          if (!streamedUsage) yield { kind: "usage", usageScope: "turn", inputTokensIncludesCache: false,
            inputTokens: interactions.reduce((sum, item) => sum + (item.response?.usage?.input_tokens ?? 0), 0),
            outputTokens: interactions.reduce((sum, item) => sum + (item.response?.usage?.output_tokens ?? 0), 0) };
        } else if (text) yield { kind: "message", phase: "completed", text };
        yield { kind: "status", phase: "turn_completed" };
      } else {
        const detail = cleanTraeCliText(stderr) || text || `trae-cli exited with ${event.exitCode ?? "unknown"}`;
        yield { kind: "status", phase: "turn_failed" };
        yield { kind: "error", error: new Error(detail.slice(-2_000)) };
      }
      yield event;
    } else {
      yield event;
    }
  }
}

/** Strips ANSI escapes and trailing panel chrome from trae-cli console output. */
export function cleanTraeCliText(value: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = value.replace(/\[[0-9;?]*[ -/]*[@-~]/g, "");
  return plain
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/* ------------------------------------------------------------------------ */
/* Shared process plumbing (kept in sync with the opencode plugin)          */
/* ------------------------------------------------------------------------ */

function deferredProcess(current: () => PluginProcessHandle | undefined): ProcessHandle {
  return {
    get pid() { return current()?.pid; },
    get child() {
      const handle = current();
      if (!handle) throw new Error("Trae CLI process has not started yet");
      return handle.child;
    },
    events: {
      async *[Symbol.asyncIterator]() {
        const handle = current();
        if (handle) yield* handle.events;
      }
    },
    write: (input) => current()?.write(input),
    cancel: async () => { await current()?.cancel(); },
    wait: () => current()?.wait() ?? Promise.resolve({ exitCode: null })
  };
}

/** Runs a short-lived command (detect probes) and captures its output. */
function capture(command: string, args: string[], env?: Record<string, string | undefined>): Promise<{ text: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let text = "";
    const resolved = resolveSpawnCommand(command, args, env);
    const child = spawn(resolved.command, resolved.args, {
      windowsHide: true,
      windowsVerbatimArguments: resolved.verbatim ?? false,
      env: env ? { ...process.env, ...env } as Record<string, string> : undefined
    });
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ text, exitCode: null });
    }, 8_000);
    child.stdout.on("data", (chunk) => { text += String(chunk); });
    child.stderr.on("data", (chunk) => { text += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ text, exitCode });
    });
  });
}

/** SIGTERM does not kill a Windows process tree; taskkill /T does. */
function killTree(child: ChildProcessWithoutNullStreams): void {
  if (platform() === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

/**
 * Windows cannot spawn npm-style CLI shims (`traecli.cmd`) directly:
 * CreateProcess needs the real file, and .cmd/.bat must run through cmd.exe.
 * On win32 this resolves the command against PATH/PATHEXT and wraps script
 * shims in `cmd.exe /d /s /c`; elsewhere the invocation is unchanged.
 */
function resolveSpawnCommand(command: string, args: string[], env?: Record<string, string | undefined>): { command: string; args: string[]; verbatim?: boolean } {
  if (platform() !== "win32") return { command, args };
  const merged = { ...process.env, ...env };
  const envValue = (key: string): string | undefined => {
    for (const [name, value] of Object.entries(merged)) {
      if (name.toLowerCase() === key.toLowerCase()) return value as string | undefined;
    }
    return undefined;
  };
  const hasDirectory = /[\\/]/.test(command) || /^[a-zA-Z]:/.test(command);
  // Try executable extensions first: an extensionless file next to a .cmd
  // shim (npm's git-bash wrapper) exists but cannot be spawned on win32.
  const extensions = hasDirectory ? [""] : [...(envValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""];
  const directories = hasDirectory ? [""] : (envValue("PATH") ?? "").split(delimiter).filter(Boolean);
  let resolved: string | undefined;
  for (const dir of directories) {
    for (const extension of extensions) {
      const candidate = dir ? join(dir, command + extension) : command + extension;
      try {
        if (statSync(candidate).isFile()) { resolved = candidate; break; }
      } catch { /* keep searching */ }
    }
    if (resolved) break;
  }
  if (!resolved) return { command, args };
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args };
  const quote = (value: string): string => (value.length && !/[\s"&|<>^()%!]/.test(value) ? value : `"${value.replaceAll('"', '""')}"`);
  // cmd /s /c strips exactly one outer quote pair before running the line,
  // so the whole line is wrapped once; inside, the shim path and unsafe args
  // carry their own quotes. Callers must spawn with
  // windowsVerbatimArguments — Node's default escaping injects backslashes
  // that cmd does not understand.
  const line = `"${[quote(resolved), ...args.map(quote)].join(" ")}"`;
  return { command: "cmd.exe", args: ["/d", "/s", "/c", line], verbatim: true };
}

interface HandleLimits {
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes: number;
}

/** ProcessHandle over a spawned child, with overall/idle/output limits. */
class PluginProcessHandle implements ProcessHandle {
  readonly events: AsyncIterable<ProcessEvent>;
  private readonly queue: ProcessEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<ProcessEvent>) => void> = [];
  private closed = false;
  private outputBytes = 0;
  private readonly exitPromise: Promise<{ exitCode: number | null; signal?: string }>;
  private overallTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;

  constructor(readonly child: ChildProcessWithoutNullStreams, limits: HandleLimits) {
    this.events = { [Symbol.asyncIterator]: () => this.iterate() };
    const onOutput = (kind: "stdout" | "stderr", chunk: unknown): void => {
      const text = String(chunk);
      this.outputBytes += text.length;
      if (this.outputBytes > limits.maxOutputBytes) {
        this.timeout("max_output");
        return;
      }
      this.push({ kind, text });
      this.resetIdleTimer(limits.idleTimeoutMs);
    };
    child.stdout.on("data", (chunk) => onOutput("stdout", chunk));
    child.stderr.on("data", (chunk) => onOutput("stderr", chunk));
    child.on("error", (error) => this.push({ kind: "error", error }));
    this.exitPromise = new Promise((resolve) => {
      child.on("close", (exitCode, signal) => {
        this.push({ kind: "exit", exitCode, signal: signal ?? undefined });
        this.finish();
        resolve({ exitCode, signal: signal ?? undefined });
      });
    });
    if (limits.timeoutMs) {
      this.overallTimer = setTimeout(() => this.timeout("timeout"), limits.timeoutMs);
    }
    this.resetIdleTimer(limits.idleTimeoutMs);
  }

  get pid(): number | undefined { return this.child.pid; }
  write(input: string): void { this.child.stdin.write(input); }
  wait(): Promise<{ exitCode: number | null; signal?: string }> { return this.exitPromise; }

  async cancel(): Promise<void> {
    killTree(this.child);
    await this.exitPromise.catch(() => undefined);
  }

  private timeout(reason: "timeout" | "idle" | "max_output"): void {
    if (this.closed) return;
    this.push({ kind: "timeout", reason });
    killTree(this.child);
  }

  private resetIdleTimer(idleTimeoutMs?: number): void {
    if (!idleTimeoutMs || this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.timeout("idle"), idleTimeoutMs);
  }

  private push(event: ProcessEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  private finish(): void {
    this.closed = true;
    if (this.overallTimer) clearTimeout(this.overallTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  private async *iterate(): AsyncGenerator<ProcessEvent> {
    for (;;) {
      const event = this.queue.shift();
      if (event !== undefined) {
        yield event;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<ProcessEvent>>((resolve) => this.waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}

const factory: ProviderPluginFactory = () => new TraePluginAdapter();
export default factory;
