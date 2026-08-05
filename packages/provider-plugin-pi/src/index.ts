/**
 * AgentHub provider plugin for Pi.
 *
 * Pi is driven as a long-lived JSONL RPC child process for each AgentHub turn.
 * The adapter closes the process only after `agent_settled`, because Pi may
 * automatically retry or compact after the earlier `agent_end` event.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, extname, join } from "node:path";
import type {
  AdapterDetectionResult,
  AdapterDiscoveryContext,
  AdapterEvent,
  AdapterFileDiff,
  AdapterResumeRequest,
  AdapterRun,
  AdapterSkill,
  AdapterStartRequest,
  AgentCliAdapter,
  AgentInstance,
  ProcessEvent,
  ProcessHandle,
  ProviderDescriptor,
  ProviderModel,
  ProviderModelCatalog,
  ProviderPluginFactory
} from "@agenthub/provider-sdk";

/** Native Pi commands that AgentHub can expose before the first run. */
const NATIVE_COMMANDS = [
  {
    name: "compact",
    description: "压缩当前 Pi 会话上下文，可附加保留内容说明",
    inputHint: "可选的压缩说明",
    providerCommand: "compact" as const
  }
];

const descriptor: ProviderDescriptor = {
  providerId: "pi",
  name: "Pi",
  vendor: "Pi",
  capabilities: ["headless_structured", "native_resume", "tool_streaming"],
  defaultExecutable: "pi",
  credentialEnv: ["AGENTHUB_PI_API_KEY"],
  baseUrlEnv: "AGENTHUB_PI_BASE_URL",
  envPassthrough: [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY", "OPENROUTER_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY",
    "OPENCODE_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY", "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_SESSION_DIR"
  ],
  permissionModes: [
    {
      value: "standard",
      name: { "zh-CN": "标准", "en-US": "Standard" },
      description: { "zh-CN": "加载项目级 Pi 资源并沿用 Pi 的工具配置", "en-US": "Load project-local Pi resources and keep Pi's configured tools" }
    },
    {
      value: "read-only",
      name: { "zh-CN": "只读", "en-US": "Read only" },
      description: { "zh-CN": "仅启用 read、grep、find 和 ls", "en-US": "Only enable read, grep, find, and ls" }
    },
    {
      value: "isolated",
      name: { "zh-CN": "忽略项目扩展", "en-US": "Ignore project extensions" },
      description: { "zh-CN": "沿用 Pi 的工具配置，但不加载项目级 Pi 资源", "en-US": "Keep Pi's configured tools but ignore project-local Pi resources" }
    }
  ],
  apiTypes: [
    {
      value: "openai-completions",
      name: { "zh-CN": "OpenAI Chat Completions", "en-US": "OpenAI Chat Completions" },
      description: { "zh-CN": "适用于 /chat/completions 兼容接口", "en-US": "For /chat/completions-compatible endpoints" }
    },
    {
      value: "openai-responses",
      name: { "zh-CN": "OpenAI Responses", "en-US": "OpenAI Responses" },
      description: { "zh-CN": "适用于 OpenAI Responses 兼容接口", "en-US": "For OpenAI Responses-compatible endpoints" }
    },
    {
      value: "anthropic-messages",
      name: { "zh-CN": "Anthropic Messages", "en-US": "Anthropic Messages" },
      description: { "zh-CN": "适用于 Anthropic Messages 兼容接口", "en-US": "For Anthropic Messages-compatible endpoints" }
    },
    {
      value: "google-generative-ai",
      name: { "zh-CN": "Google Generative AI", "en-US": "Google Generative AI" },
      description: { "zh-CN": "适用于 Gemini/Google Generative AI 接口", "en-US": "For Gemini/Google Generative AI endpoints" }
    }
  ],
  nativeCommands: NATIVE_COMMANDS,
  contextWindowDiscovery: true
};

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null ? value as RecordValue : {};
const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length ? value : undefined;
const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

interface PiParseState {
  messageSequence: number;
  currentMessageId?: string;
  currentThinkingId?: string;
  streamedText: boolean;
  streamedThinking: boolean;
  lastAssistantStopReason?: string;
  modelError: boolean;
  toolArgs: Map<string, { name: string; args: RecordValue }>;
}

class PiPluginAdapter implements AgentCliAdapter {
  readonly providerId = "pi";
  readonly descriptor = descriptor;
  readonly supportsStructuredOutput = false;
  readonly supportsResume = true;
  readonly capabilities = {
    structuredOutput: false,
    textOutput: true,
    interactiveStdin: true,
    nativeResume: true,
    pty: false
  };

  async detect(instance: AgentInstance): Promise<AdapterDetectionResult> {
    const executable = instance.executable || descriptor.defaultExecutable || "pi";
    try {
      const version = await capture(executable, [...instance.baseArgs, "--version"]);
      if (version.exitCode !== 0) return { installed: false, executable, error: version.text.trim() || "Pi --version failed" };
      const help = await capture(executable, [...instance.baseArgs, "--help"]);
      const compatible = help.exitCode === 0 && /AI coding assistant/i.test(help.text) && /--mode\s+<mode>/i.test(help.text) && /\brpc\b/i.test(help.text);
      return {
        installed: true,
        compatible,
        executable,
        version: version.text.trim(),
        help: help.text.slice(0, 16_384),
        error: compatible ? undefined : "该 pi 可执行文件不是支持 JSONL RPC 的 Pi coding agent，或版本过旧"
      };
    } catch (error) {
      return { installed: false, executable, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listModels(instance: AgentInstance, context?: AdapterDiscoveryContext): Promise<ProviderModelCatalog> {
    const executable = instance.executable || descriptor.defaultExecutable || "pi";
    const env = { ...(context?.env ?? {}), PI_OFFLINE: "1" } as Record<string, string>;
    configurePiProviderEnvironment(instance, env);
    const args = [
      ...instance.baseArgs,
      "--mode", "rpc", "--no-session", "--no-approve", "--offline",
      ...(hasAgentHubEndpoint(instance) ? ["--extension", agentHubPiExtensionPath()] : [])
    ];
    const result = await rpcCapture(executable, args, env, [
      { id: "agenthub-state", type: "get_state" },
      { id: "agenthub-models", type: "get_available_models" }
    ]);
    const stateResponse = result.find((item) => item.type === "response" && item.id === "agenthub-state");
    const modelResponse = result.find((item) => item.type === "response" && item.id === "agenthub-models");
    if (!modelResponse || modelResponse.success === false) {
      throw new Error(stringValue(modelResponse?.error) ?? "Pi did not return get_available_models");
    }
    return parsePiModels(modelResponse, stateResponse, hasAgentHubEndpoint(instance) ? "agenthub" : undefined);
  }

  start(request: AdapterStartRequest): AdapterRun {
    return this.run(request, false);
  }

  resume(request: AdapterResumeRequest): AdapterRun {
    return this.run(request, true);
  }

  private run(request: AdapterStartRequest | AdapterResumeRequest, resume: boolean): AdapterRun {
    const executable = request.instance.executable || descriptor.defaultExecutable || "pi";
    const env = { ...process.env, ...(request.env ?? {}), PI_OFFLINE: "1" } as Record<string, string>;
    configurePiProviderEnvironment(request.instance, env);
    configurePiMcpEnvironment(request, env);
    if (platform() === "win32" && request.permissionMode !== "read-only") {
      env.AGENTHUB_PI_ENABLE_POWERSHELL = "1";
    }
    const skills = materializePiSkills(request.skills);
    const args = piRunArgs(request, resume, skills.paths);
    const resolved = resolveSpawnCommand(executable, args, env);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(resolved.command, resolved.args, {
        cwd: request.cwd,
        env,
        windowsHide: true,
        windowsVerbatimArguments: resolved.verbatim ?? false
      });
    } catch (error) {
      skills.cleanup();
      throw error;
    }
    const processHandle = new PluginProcessHandle(child, {
      timeoutMs: request.timeoutMs,
      idleTimeoutMs: request.idleTimeoutMs,
      // Pi's message_update frames contain the complete growing assistant
      // snapshot in addition to the delta. A cumulative byte cap therefore
      // counts the same reasoning text thousands of times and kills healthy
      // long turns. Only enforce a cap when the caller explicitly supplies one;
      // jsonLines() still bounds each individual RPC frame below.
      maxOutputBytes: request.maxOutputBytes
    });
    const state: PiParseState = {
      messageSequence: 0,
      streamedText: false,
      streamedThinking: false,
      modelError: false,
      toolArgs: new Map()
    };
    let settled = false;
    let terminalStatus = false;
    let stateReceived = false;
    let promptSent = false;
    const selectedModel = effectivePiModel(request.instance, request.model);

    const send = (value: RecordValue): void => processHandle.write(`${JSON.stringify(value)}\n`);
    const sendPrompt = (): void => {
      if (promptSent) return;
      promptSent = true;
      if (request.providerCommand === "compact") {
        const customInstructions = request.prompt.replace(/^\s*\/?compact\b/i, "").trim();
        send({
          id: "agenthub-prompt",
          type: "compact",
          ...(customInstructions ? { customInstructions } : {})
        });
      } else {
        send({
          id: "agenthub-prompt",
          type: "prompt",
          message: request.prompt,
          ...(request.localImagePaths?.length ? { images: imagePayloads(request.localImagePaths) } : {})
        });
      }
    };
    const sendVerificationOrPrompt = (): void => {
      if (selectedModel || request.reasoningEffort) send({ id: "agenthub-verify-state", type: "get_state" });
      else sendPrompt();
    };
    const sendThinkingOrVerify = (): void => {
      if (request.reasoningEffort) send({ id: "agenthub-set-thinking", type: "set_thinking_level", level: request.reasoningEffort });
      else sendVerificationOrPrompt();
    };
    send({ id: "agenthub-state", type: "get_state" });

    const events = async function* (): AsyncGenerator<AdapterEvent> {
      // Report this before the first turn event so Core can expose /compact
      // in the composer and the context-usage card for the active session.
      yield { kind: "commands", commands: NATIVE_COMMANDS };
      yield { kind: "status", phase: "turn_started" };
      if (request.runtimeTools?.length) {
        yield { kind: "raw", stream: "stderr", text: "Pi RPC does not natively accept AgentHub runtime tools; provider-native Pi tools remain available.\n" };
      }
      try {
        for await (const item of jsonLines(processHandle)) {
          if (item.kind === "process") {
            const processEvent = item.event;
            if (processEvent.kind === "stderr") {
              yield { kind: "raw", stream: "stderr", text: processEvent.text };
            } else if (processEvent.kind === "error") {
              yield { kind: "error", error: processEvent.error };
            } else if (processEvent.kind === "timeout") {
              yield processEvent;
            } else if (processEvent.kind === "exit") {
              const modelFailed = state.modelError || state.lastAssistantStopReason === "error" || state.lastAssistantStopReason === "aborted";
              if (!terminalStatus) {
                yield { kind: "status", phase: settled && processEvent.exitCode === 0 && !modelFailed ? "turn_completed" : "turn_failed" };
                terminalStatus = true;
              }
              // Pi RPC itself exits 0 after a failed model turn. Normalize that
              // process result so older AgentHub cores cannot overwrite the
              // already-reported provider failure as a completed run.
              yield modelFailed && processEvent.exitCode === 0
                ? { ...processEvent, exitCode: 1 }
                : processEvent;
            }
            continue;
          }

          const value = item.value;
          if (value.type === "response") {
            if (request.providerCommand === "compact" && value.id === "agenthub-prompt") {
              const error = stringValue(value.error);
              const nothingToCompact = value.success === false
                && /^(?:Nothing to compact(?: \(session too small\))?|Already compacted)$/i.test(error ?? "");
              if (value.success === false && !nothingToCompact) {
                throw new Error(error ?? `Pi RPC command ${String(value.command)} failed`);
              }
              yield {
                kind: "message",
                phase: "completed",
                messageId: "pi-compact",
                text: nothingToCompact
                  ? "当前 Pi 会话没有可压缩的旧内容，无需压缩。"
                  : "Pi 会话压缩完成。",
                raw: value
              };
              settled = true;
              if (!terminalStatus) {
                yield { kind: "status", phase: "turn_completed", raw: value };
                terminalStatus = true;
              }
              // Compact is an RPC command, not an agent turn, so Pi responds
              // directly and does not emit agent_settled. Close stdin after
              // the response or a successful compaction would wait forever.
              if (child.stdin.writable) child.stdin.end();
              continue;
            }
            if (value.success === false) throw new Error(stringValue(value.error) ?? `Pi RPC command ${String(value.command)} failed`);
            if (value.id === "agenthub-state") {
              stateReceived = true;
              const data = asRecord(value.data);
              const sessionId = stringValue(data.sessionId);
              if (!sessionId) throw new Error("Pi get_state response did not include sessionId");
              yield { kind: "session", providerSessionId: sessionId, raw: value };
              const slash = selectedModel?.indexOf("/") ?? -1;
              if (selectedModel && slash > 0) {
                send({ id: "agenthub-set-model", type: "set_model", provider: selectedModel.slice(0, slash), modelId: selectedModel.slice(slash + 1) });
              } else sendThinkingOrVerify();
            } else if (value.id === "agenthub-set-model") {
              sendThinkingOrVerify();
            } else if (value.id === "agenthub-set-thinking") {
              sendVerificationOrPrompt();
            } else if (value.id === "agenthub-verify-state") {
              assertPiSelection(value, selectedModel, request.reasoningEffort);
              sendPrompt();
            }
            continue;
          }

          if (value.type === "extension_ui_request") {
            yield* handleExtensionUi(request, value, send);
            continue;
          }

          if (value.type === "agent_settled") {
            settled = true;
            const failed = state.modelError || state.lastAssistantStopReason === "error" || state.lastAssistantStopReason === "aborted";
            if (!terminalStatus) {
              yield { kind: "status", phase: failed ? "turn_failed" : "turn_completed", raw: value };
              terminalStatus = true;
            }
            if (child.stdin.writable) child.stdin.end();
            continue;
          }

          for (const event of parsePiRpcEvent(value, state)) yield event;
        }
        if (!stateReceived && !terminalStatus) {
          yield { kind: "status", phase: "turn_failed" };
          terminalStatus = true;
        }
      } catch (error) {
        if (!terminalStatus) {
          yield { kind: "status", phase: "turn_failed" };
          terminalStatus = true;
        }
        yield { kind: "error", error: error instanceof Error ? error : new Error(String(error)) };
        await processHandle.cancel().catch(() => undefined);
      } finally {
        skills.cleanup();
      }
    };

    return {
      process: processHandle,
      events: { [Symbol.asyncIterator]: events },
      cancel: async () => {
        if (child.stdin.writable) send({ id: "agenthub-abort", type: "abort" });
        await processHandle.cancel();
        skills.cleanup();
      },
      steer: async (input) => {
        if (!child.stdin.writable) throw new Error("Pi RPC process is no longer running");
        send({ id: `agenthub-steer-${Date.now()}`, type: "steer", message: input });
      },
      write: (input) => processHandle.write(input)
    };
  }
}

export function piRunArgs(
  request: AdapterStartRequest | AdapterResumeRequest,
  resume: boolean,
  skillPaths: string[] = []
): string[] {
  const args = [...request.instance.baseArgs, "--mode", "rpc", "--offline"];
  const mode = request.permissionMode ?? "standard";
  if (mode === "isolated") args.push("--no-approve");
  else args.push("--approve");
  if (mode === "read-only") args.push("--tools", "read,grep,find,ls");
  // The extension also supplies Windows-native PowerShell compatibility and
  // normalizes malformed empty provider errors, so load it for every Pi run.
  args.push("--extension", agentHubPiExtensionPath());
  for (const path of skillPaths) args.push("--skill", path);
  if (resume) args.push("--session", (request as AdapterResumeRequest).providerSessionId);
  const selectedModel = effectivePiModel(request.instance, request.model);
  if (selectedModel) args.push("--model", selectedModel);
  if (request.reasoningEffort) args.push("--thinking", request.reasoningEffort);
  return args;
}

export function parsePiModels(modelResponse: RecordValue, stateResponse?: RecordValue, providerFilter?: string): ProviderModelCatalog {
  const data = asRecord(modelResponse.data);
  const rawModels = (Array.isArray(data.models) ? data.models : [])
    .filter((item) => !providerFilter || asRecord(item).provider === providerFilter);
  const stateData = asRecord(stateResponse?.data);
  const active = asRecord(stateData.model);
  const activeProvider = stringValue(active.provider);
  const activeId = stringValue(active.id);
  const activeThinkingLevel = stringValue(stateData.thinkingLevel);
  let defaultModel = activeProvider && activeId
    ? providerFilter === activeProvider ? activeId : `${activeProvider}/${activeId}`
    : undefined;
  const models: ProviderModel[] = rawModels.map((item) => {
    const model = asRecord(item);
    const provider = stringValue(model.provider) ?? "unknown";
    const modelId = stringValue(model.id) ?? "unknown";
    const id = providerFilter === provider ? modelId : `${provider}/${modelId}`;
    const input = Array.isArray(model.input) ? model.input.map(String) : [];
    const levelMap = asRecord(model.thinkingLevelMap);
    const mappedLevels = Object.entries(levelMap)
      .filter(([, value]) => value !== null && value !== false)
      .map(([level]) => level);
    const reasoning = model.reasoning === true;
    const reasoningEfforts = reasoning
      ? [...new Set(["off", ...(mappedLevels.length ? mappedLevels : ["low", "medium", "high"])])]
      : [];
    return {
      id,
      displayName: stringValue(model.name) ?? modelId,
      description: `${provider} · ${stringValue(model.api) ?? "Pi"}`,
      isDefault: id === defaultModel,
      contextWindow: numberValue(model.contextWindow),
      capabilities: ["tool_use", ...(reasoning ? ["reasoning"] : []), ...(input.includes("image") ? ["vision"] : [])],
      reasoningEfforts,
      defaultReasoningEffort: id === defaultModel && activeThinkingLevel && reasoningEfforts.includes(activeThinkingLevel)
        ? activeThinkingLevel
        : reasoningEfforts.includes("medium") ? "medium" : reasoningEfforts[0],
      serviceTiers: []
    };
  });
  if (providerFilter) {
    defaultModel = models.find((model) => model.isDefault)?.id ?? models[0]?.id;
    for (const model of models) model.isDefault = model.id === defaultModel;
  }
  return {
    providerId: "pi",
    models,
    defaultModel,
    source: "provider_cli",
    fetchedAt: new Date().toISOString()
  };
}

/** Fails closed when Pi accepted a switch command but did not apply it. */
export function assertPiSelection(
  stateResponse: RecordValue,
  expectedModel?: string,
  expectedThinkingLevel?: string
): void {
  const data = asRecord(stateResponse.data);
  const model = asRecord(data.model);
  const provider = stringValue(model.provider);
  const modelId = stringValue(model.id);
  if (expectedModel) {
    const slash = expectedModel.indexOf("/");
    const matches = slash > 0
      ? provider === expectedModel.slice(0, slash) && modelId === expectedModel.slice(slash + 1)
      : modelId === expectedModel;
    if (!matches) {
      const actual = provider && modelId ? `${provider}/${modelId}` : "none";
      throw new Error(`Pi model switch did not apply: expected ${expectedModel}, got ${actual}`);
    }
  }
  if (expectedThinkingLevel) {
    const actual = stringValue(data.thinkingLevel);
    if (actual !== expectedThinkingLevel) {
      throw new Error(`Pi thinking level did not apply: expected ${expectedThinkingLevel}, got ${actual ?? "none"}`);
    }
  }
}

const PI_SKILL_FILE_NAMES = new Set(["skill.md", "skills.md", "skill.markdown", "skills.markdown"]);

function piSkillSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "skill";
}

function renderPiSkill(skill: AdapterSkill, slug: string): string {
  const description = skill.description.replace(/\s+/g, " ").trim() || slug;
  return [
    "---",
    `name: ${slug}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    skill.instructions.trim(),
    "",
    `<!-- agenthub:runtime-skill:${skill.id} -->`,
    ""
  ].join("\n");
}

/** Materializes run-scoped Pi skills so the provider plugin owns Pi's native format. */
export function materializePiSkills(skills: AdapterSkill[] | undefined): { paths: string[]; cleanup: () => void } {
  if (!skills?.length) return { paths: [], cleanup: () => undefined };
  const root = mkdtempSync(join(tmpdir(), "agenthub-pi-skills-"));
  const paths: string[] = [];
  const used = new Set<string>();
  let cleaned = false;
  try {
    for (const skill of skills) {
      const base = piSkillSlug(skill.name);
      let slug = base;
      let suffix = 2;
      while (used.has(slug)) slug = `${base}-${suffix++}`;
      used.add(slug);
      const directory = join(root, slug);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), renderPiSkill(skill, slug), "utf8");
      const source = skill.resourceDir?.trim();
      if (source) {
        try {
          if (statSync(source).isDirectory()) {
            for (const entry of readdirSync(source, { withFileTypes: true })) {
              if (entry.isFile() && PI_SKILL_FILE_NAMES.has(entry.name.toLowerCase())) continue;
              cpSync(join(source, entry.name), join(directory, entry.name), { recursive: true });
            }
          }
        } catch { /* missing optional resources do not prevent the skill from loading */ }
      }
      paths.push(directory);
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    paths,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const PI_API_TYPES = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
const AGENTHUB_PI_EXTENSION = `import { spawn } from "node:child_process";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_TIMEOUT_MS = 30000;

function mcpError(value) {
  if (!value) return "Unknown MCP error";
  if (typeof value === "string") return value;
  if (value.message) return String(value.message);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function mcpToolName(serverName, toolName, used) {
  const clean = (value) => String(value || "tool").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
  const base = ("mcp_" + clean(serverName) + "_" + clean(toolName)).slice(0, 120);
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = base.slice(0, 116) + "_" + suffix++;
  used.add(name);
  return name;
}

function toolParameters(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  return { type: "object", properties: {}, ...schema };
}

function toolResult(result, serverName, toolName) {
  const rawContent = Array.isArray(result?.content) ? result.content : [];
  const content = rawContent.map((part) => {
    if (part?.type === "text") return { type: "text", text: String(part.text || "") };
    if (part?.type === "image" && part.data && part.mimeType) {
      return { type: "image", data: String(part.data), mimeType: String(part.mimeType) };
    }
    return { type: "text", text: JSON.stringify(part ?? null) };
  });
  if (!content.length && result?.structuredContent !== undefined) {
    content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
  }
  if (!content.length) content.push({ type: "text", text: "MCP tool completed with no content" });
  return {
    content,
    details: { server: serverName, tool: toolName, structuredContent: result?.structuredContent },
    isError: result?.isError === true
  };
}

class StdioMcpClient {
  constructor(config) {
    this.config = config;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = "";
  }

  async start() {
    if (!this.config.command) throw new Error("STDIO MCP server is missing command");
    const useShell = process.platform === "win32" && /\\.(cmd|bat)$/i.test(this.config.command);
    this.child = spawn(this.config.command, this.config.args || [], {
      cwd: this.config.cwd || undefined,
      env: { ...process.env, ...(this.config.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: useShell
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) process.stderr.write("[AgentHub MCP " + this.config.name + "] " + text + "\\n");
    });
    this.child.on("close", (code) => {
      const error = new Error("MCP server " + this.config.name + " exited with code " + String(code));
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agenthub-pi", version: "0.2.5" }
    });
    this.notify("notifications/initialized", {});
  }

  onData(chunk) {
    this.buffer += String(chunk);
    const lines = this.buffer.split(/\\r?\\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      entry.cleanup();
      if (message.error) entry.reject(new Error(mcpError(message.error)));
      else entry.resolve(message.result);
    }
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new Error("MCP server " + this.config.name + " is not connected");
    this.child.stdin.write(JSON.stringify(message) + "\\n");
  }

  request(method, params, signal) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      let abortHandler;
      const cleanup = () => {
        clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP request timed out: " + method));
      }, MCP_TIMEOUT_MS);
      timer.unref?.();
      if (signal) {
        abortHandler = () => {
          this.pending.delete(id);
          cleanup();
          this.notify("notifications/cancelled", { requestId: id, reason: "AgentHub tool call aborted" });
          reject(new Error("MCP request aborted: " + method));
        };
        if (signal.aborted) return abortHandler();
        signal.addEventListener("abort", abortHandler, { once: true });
      }
      this.pending.set(id, { resolve, reject, cleanup });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }

  notify(method, params) {
    try { this.write({ jsonrpc: "2.0", method, params }); } catch { /* process is closing */ }
  }

  async close() {
    try { this.child?.stdin?.end(); } catch { /* already closed */ }
    if (this.child?.exitCode === null) this.child.kill();
  }
}

class HttpMcpClient {
  constructor(config) {
    this.config = config;
    this.nextId = 0;
    this.sessionId = undefined;
  }

  async start() {
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agenthub-pi", version: "0.2.5" }
    });
    await this.notify("notifications/initialized", {});
  }

  async post(message, signal) {
    if (!this.config.url) throw new Error("HTTP MCP server is missing URL");
    const timeout = AbortSignal.timeout(MCP_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        ...(this.config.headers || {}),
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {})
      },
      body: JSON.stringify(message),
      signal: requestSignal
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    if (!response.ok) throw new Error("MCP HTTP " + response.status + ": " + (await response.text()).slice(0, 2000));
    if (response.status === 202 || response.status === 204) return undefined;
    const text = await response.text();
    if (!text.trim()) return undefined;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      const messages = [];
      for (const block of text.split(/\\r?\\n\\r?\\n/)) {
        const data = block.split(/\\r?\\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\\n");
        if (!data || data === "[DONE]") continue;
        try { messages.push(JSON.parse(data)); } catch { /* ignore non-JSON SSE data */ }
      }
      return messages.find((item) => item.id === message.id) || messages.at(-1);
    }
    return JSON.parse(text);
  }

  async request(method, params, signal) {
    const id = ++this.nextId;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
    if (response?.error) throw new Error(mcpError(response.error));
    return response?.result;
  }

  async notify(method, params) {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  async close() {
    if (!this.sessionId || !this.config.url) return;
    try {
      await fetch(this.config.url, {
        method: "DELETE",
        headers: { ...(this.config.headers || {}), "mcp-session-id": this.sessionId },
        signal: AbortSignal.timeout(2000)
      });
    } catch { /* best-effort session cleanup */ }
  }
}

async function listMcpTools(client) {
  const tools = [];
  let cursor;
  do {
    const result = await client.request("tools/list", cursor ? { cursor } : {});
    if (Array.isArray(result?.tools)) tools.push(...result.tools);
    cursor = result?.nextCursor;
  } while (cursor);
  return tools;
}

export default async function (pi) {
  const raw = process.env.AGENTHUB_PI_PROVIDER_CONFIG;
  if (raw) {
    const config = JSON.parse(raw);
    pi.registerProvider("agenthub", {
      ...config,
      apiKey: process.env.AGENTHUB_PI_API_KEY || "agenthub"
    });
  }

  const mcpClients = [];
  const mcpToolNames = [];
  const mcpErrors = [];
  const usedToolNames = new Set();
  const rawMcp = process.env.AGENTHUB_PI_MCP_SERVERS;
  const mcpConfigs = rawMcp ? JSON.parse(rawMcp) : [];
  for (const config of mcpConfigs) {
    let client;
    try {
      client = config.transport === "http" ? new HttpMcpClient(config) : new StdioMcpClient(config);
      await client.start();
      mcpClients.push(client);
      const tools = await listMcpTools(client);
      for (const tool of tools) {
        const registeredName = mcpToolName(config.name, tool.name, usedToolNames);
        mcpToolNames.push(registeredName);
        pi.registerTool({
          name: registeredName,
          label: config.name + ": " + (tool.title || tool.name),
          description: (tool.description || "MCP tool " + tool.name) + " (server: " + config.name + ")",
          promptSnippet: "Use " + registeredName + " to call " + config.name + "/" + tool.name + ".",
          parameters: toolParameters(tool.inputSchema),
          async execute(_toolCallId, params, signal) {
            try {
              const result = await client.request("tools/call", { name: tool.name, arguments: params || {} }, signal);
              return toolResult(result, config.name, tool.name);
            } catch (error) {
              return {
                content: [{ type: "text", text: mcpError(error) }],
                details: { server: config.name, tool: tool.name },
                isError: true
              };
            }
          }
        });
      }
    } catch (error) {
      mcpErrors.push(config.name + ": " + mcpError(error));
      await client?.close().catch(() => undefined);
    }
  }

  // Some OpenAI-compatible gateways terminate a stream without an error body.
  // Pi otherwise records stopReason=error with an empty errorMessage and does
  // not classify it as retryable. Give the built-in retry policy a useful,
  // transient error instead of silently settling the turn.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message?.role !== "assistant" || message.stopReason !== "error" || message.errorMessage) return;
    return {
      message: {
        ...message,
        errorMessage: "Transient provider server error: the response stream ended without an error message"
      }
    };
  });

  const powershellEnabled = process.env.AGENTHUB_PI_ENABLE_POWERSHELL === "1" && process.platform === "win32";
  if (powershellEnabled) pi.registerTool({
    name: "powershell",
    label: "PowerShell",
    description: "Run a command with native Windows PowerShell. Use this instead of bash on Windows.",
    promptGuidelines: [
      "On Windows, use the powershell tool for commands; do not call bash.",
      "Use Windows paths and PowerShell syntax."
    ],
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "PowerShell command to execute" },
        cwd: { type: "string", description: "Optional working directory" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds (default 120000)" }
      },
      required: ["command"],
      additionalProperties: false
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const timeoutMs = Number.isFinite(params.timeoutMs) ? Math.max(1000, Math.min(params.timeoutMs, 1800000)) : 120000;
      const cwd = params.cwd || ctx.cwd;
      return await new Promise((resolve) => {
        const child = spawn("powershell.exe", [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", params.command
        ], { cwd, windowsHide: true, env: process.env });
        let output = "";
        let finished = false;
        const append = (chunk) => {
          output = (output + String(chunk)).slice(-2097152);
          onUpdate?.({ content: [{ type: "text", text: output }], details: {} });
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const stop = () => {
          if (!finished) child.kill();
        };
        signal?.addEventListener("abort", stop, { once: true });
        const timer = setTimeout(stop, timeoutMs);
        child.on("error", (error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          resolve({ content: [{ type: "text", text: error.message }], details: { exitCode: 1 }, isError: true });
        });
        child.on("close", (code) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          const exitCode = code ?? 1;
          const text = output || "Command completed with no output";
          resolve({
            content: [{ type: "text", text: text + "\\n\\nProcess exited with code " + exitCode }],
            details: { exitCode },
            isError: exitCode !== 0
          });
        });
      });
    }
  });

  const enableAgentHubTools = () => {
    const active = pi.getActiveTools();
    const native = powershellEnabled ? [...active.filter((name) => name !== "bash"), "powershell"] : active;
    pi.setActiveTools([...new Set([...native, ...mcpToolNames])]);
  };
  // Pi action methods are unavailable while the extension factory is loading.
  // session_start runs after the extension runtime has been initialized.
  pi.on("session_start", (_event, ctx) => {
    enableAgentHubTools();
    for (const error of mcpErrors) ctx?.ui?.notify?.("MCP unavailable: " + error, "error");
  });
  pi.on("session_shutdown", async () => {
    await Promise.allSettled(mcpClients.map((client) => client.close()));
  });
}
`;

function hasAgentHubEndpoint(instance: AgentInstance): boolean {
  const value = instance.providerOptions?.baseUrl;
  return typeof value === "string" && value.trim().length > 0;
}

function effectivePiModel(instance: AgentInstance, model?: string): string | undefined {
  const selected = model?.trim();
  if (!selected) return undefined;
  if (!hasAgentHubEndpoint(instance)) return selected;
  return selected.startsWith("agenthub/") ? selected : `agenthub/${selected}`;
}

function configurePiProviderEnvironment(instance: AgentInstance, env: Record<string, string>): void {
  if (!hasAgentHubEndpoint(instance)) return;
  const configuredApi = instance.providerOptions?.apiType;
  const api = typeof configuredApi === "string" && PI_API_TYPES.has(configuredApi)
    ? configuredApi
    : "openai-completions";
  const models = (instance.models ?? []).map((model) => {
    const id = model.id.startsWith("agenthub/") ? model.id.slice("agenthub/".length) : model.id;
    const levels = model.reasoningEfforts.filter((level) => level !== "off");
    return {
      id,
      name: model.displayName?.trim() || id,
      reasoning: levels.length > 0,
      ...(levels.length ? { thinkingLevelMap: Object.fromEntries(levels.map((level) => [level, level])) } : {}),
      input: ["text", "image"],
      contextWindow: model.contextWindow ?? 128_000,
      maxTokens: 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    };
  });
  env.AGENTHUB_PI_PROVIDER_CONFIG = JSON.stringify({
    name: instance.displayName || "AgentHub API",
    baseUrl: String(instance.providerOptions?.baseUrl).replace(/\/+$/, ""),
    api,
    models
  });
}

function configurePiMcpEnvironment(
  request: AdapterStartRequest | AdapterResumeRequest,
  env: Record<string, string>
): void {
  if (!request.mcpServers?.length) {
    delete env.AGENTHUB_PI_MCP_SERVERS;
    return;
  }
  env.AGENTHUB_PI_MCP_SERVERS = JSON.stringify(request.mcpServers);
}

function agentHubPiExtensionPath(): string {
  const directory = join(tmpdir(), "agenthub-pi-provider");
  const path = join(directory, "agenthub-provider.mjs");
  mkdirSync(directory, { recursive: true });
  try {
    if (readFileSync(path, "utf8") === AGENTHUB_PI_EXTENSION) return path;
  } catch { /* create below */ }
  writeFileSync(path, AGENTHUB_PI_EXTENSION, "utf8");
  return path;
}

export function parsePiRpcEvent(value: RecordValue, state: PiParseState): AdapterEvent[] {
  const type = stringValue(value.type);
  if (type === "message_start") {
    const message = asRecord(value.message);
    if (message.role !== "assistant") return [];
    state.messageSequence += 1;
    state.currentMessageId = `pi-message-${state.messageSequence}`;
    state.currentThinkingId = `pi-thinking-${state.messageSequence}`;
    state.streamedText = false;
    state.streamedThinking = false;
    return [];
  }
  if (type === "message_update") {
    const delta = asRecord(value.assistantMessageEvent);
    if (delta.type === "text_delta") {
      state.streamedText = true;
      return [{ kind: "message", text: String(delta.delta ?? ""), phase: "delta", messageId: state.currentMessageId, raw: value }];
    }
    if (delta.type === "thinking_delta") {
      state.streamedThinking = true;
      return [{ kind: "thinking", text: String(delta.delta ?? ""), phase: "delta", messageId: state.currentThinkingId, raw: value }];
    }
    if (delta.type === "error") {
      state.modelError = true;
      return [{ kind: "error", error: new Error(stringValue(delta.error) ?? stringValue(delta.reason) ?? "Pi model response stream failed") }];
    }
    return [];
  }
  if (type === "message_end") {
    const message = asRecord(value.message);
    if (message.role !== "assistant") return [];
    const content = Array.isArray(message.content) ? message.content.map(asRecord) : [];
    const stopReason = stringValue(message.stopReason);
    state.lastAssistantStopReason = stopReason;
    state.modelError = stopReason === "error" || stopReason === "aborted";
    const events: AdapterEvent[] = [];
    if (!state.streamedText) {
      const text = content.filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("");
      if (text) events.push({ kind: "message", text, phase: "delta", messageId: state.currentMessageId, raw: value });
    }
    if (!state.streamedThinking) {
      const thinking = content.filter((part) => part.type === "thinking").map((part) => String(part.thinking ?? "")).join("");
      if (thinking) events.push({ kind: "thinking", text: thinking, phase: "delta", messageId: state.currentThinkingId, raw: value });
    }
    if (state.streamedThinking || content.some((part) => part.type === "thinking")) {
      events.push({ kind: "thinking", text: "", phase: "completed", messageId: state.currentThinkingId, raw: value });
    }
    events.push({ kind: "message", text: "", phase: "completed", messageId: state.currentMessageId, raw: value });
    const usage = asRecord(message.usage);
    if (Object.keys(usage).length) {
      events.push({
        kind: "usage",
        inputTokens: numberValue(usage.input),
        cachedInputTokens: numberValue(usage.cacheRead),
        outputTokens: numberValue(usage.output),
        reasoningOutputTokens: numberValue(usage.reasoning),
        contextUsed: numberValue(usage.totalTokens),
        raw: value
      });
    }
    const errorMessage = stringValue(message.errorMessage);
    if (state.modelError) {
      events.push({
        kind: "error",
        error: new Error(errorMessage ?? `Pi assistant stopped with ${stopReason ?? "an unknown model error"}`)
      });
    }
    return events;
  }
  if (type === "tool_execution_start") {
    const callId = String(value.toolCallId ?? "");
    const name = String(value.toolName ?? "tool");
    const args = asRecord(value.args);
    state.toolArgs.set(callId, { name, args });
    if (name === "bash") {
      return [{ kind: "command", callId, command: String(args.command ?? ""), phase: "started", raw: value }];
    }
    return [{ kind: "tool", callId, name, phase: "started", input: args, fileDiff: piFileDiff(name, args), raw: value }];
  }
  if (type === "tool_execution_end") {
    const callId = String(value.toolCallId ?? "");
    const stored = state.toolArgs.get(callId);
    const name = String(value.toolName ?? stored?.name ?? "tool");
    const output = toolResultText(value.result);
    const success = value.isError !== true;
    if (name === "bash") {
      return [{ kind: "command", callId, command: String(stored?.args.command ?? ""), phase: "completed", exitCode: success ? 0 : 1, output, raw: value }];
    }
    return [{ kind: "tool", callId, name, phase: "completed", input: stored?.args, output, success, fileDiff: stored ? piFileDiff(name, stored.args) : undefined, raw: value }];
  }
  if (type === "auto_retry_start") {
    return [{ kind: "raw", stream: "stderr", text: `Pi retry ${String(value.attempt ?? "")} / ${String(value.maxAttempts ?? "")}: ${String(value.errorMessage ?? "")}\n` }];
  }
  if (type === "extension_error") {
    return [{ kind: "error", error: new Error(String(value.error ?? "Pi extension failed")) }];
  }
  return [];
}

function piFileDiff(name: string, args: RecordValue): AdapterFileDiff | undefined {
  const path = stringValue(args.path);
  if (!path) return undefined;
  if (name === "write") return { operation: "write", path, before: "", after: String(args.content ?? "") };
  if (name !== "edit") return undefined;
  const edits = Array.isArray(args.edits) ? args.edits.map(asRecord) : [];
  if (edits.length === 1) {
    return { operation: "edit", path, before: String(edits[0]!.oldText ?? ""), after: String(edits[0]!.newText ?? "") };
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    return { operation: "edit", path, before: args.oldText, after: args.newText };
  }
  return undefined;
}

function toolResultText(value: unknown): string {
  const result = asRecord(value);
  const content = Array.isArray(result.content) ? result.content.map(asRecord) : [];
  const text = content.filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("\n");
  return text || (typeof value === "string" ? value : JSON.stringify(value ?? null));
}

async function* handleExtensionUi(
  request: AdapterStartRequest | AdapterResumeRequest,
  value: RecordValue,
  send: (value: RecordValue) => void
): AsyncGenerator<AdapterEvent> {
  const id = String(value.id ?? "");
  const method = String(value.method ?? "");
  if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(method)) {
    const text = stringValue(value.message) ?? stringValue(value.statusText) ?? stringValue(value.title);
    if (text) yield { kind: "raw", stream: value.notifyType === "error" ? "stderr" : "stdout", text: `${text}\n` };
    return;
  }
  if (!request.requestInteraction) {
    send({ type: "extension_ui_response", id, cancelled: true });
    return;
  }
  try {
    if (method === "confirm") {
      const response = await request.requestInteraction({
        kind: "approval",
        title: stringValue(value.title) ?? "Pi confirmation",
        detail: stringValue(value.message),
        options: [
          { id: "confirm", label: "Confirm", intent: "approve" },
          { id: "cancel", label: "Cancel", intent: "reject" }
        ]
      });
      send({ type: "extension_ui_response", id, confirmed: response.outcome === "selected" && response.optionId === "confirm" });
      return;
    }
    const options = Array.isArray(value.options) ? value.options.map(String) : undefined;
    const questionId = "value";
    const response = await request.requestInteraction({
      kind: "question",
      title: stringValue(value.title) ?? "Pi question",
      questions: [{
        id: questionId,
        question: stringValue(value.title) ?? "Enter a value",
        ...(options ? { options: options.map((option) => ({ id: option, label: option })) } : {}),
        ...(method === "editor" && stringValue(value.prefill) ? { header: String(value.prefill) } : {}),
        isOther: !options
      }]
    });
    const answer = response.answers?.[questionId]?.[0];
    if (response.outcome === "selected" && answer !== undefined) send({ type: "extension_ui_response", id, value: answer });
    else send({ type: "extension_ui_response", id, cancelled: true });
  } catch {
    send({ type: "extension_ui_response", id, cancelled: true });
  }
}

function imagePayloads(paths: string[]): Array<{ type: "image"; data: string; mimeType: string }> {
  return paths.map((path) => ({ type: "image", data: readFileSync(path).toString("base64"), mimeType: mimeType(path) }));
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return "image/png";
  }
}

type JsonLineItem = { kind: "json"; value: RecordValue } | { kind: "process"; event: Exclude<ProcessEvent, { kind: "stdout" }> };

const PI_MAX_RPC_FRAME_BYTES = 64 * 1024 * 1024;

async function* jsonLines(handle: PluginProcessHandle): AsyncGenerator<JsonLineItem> {
  let buffer = "";
  for await (const event of handle.events) {
    if (event.kind !== "stdout") {
      yield { kind: "process", event };
      continue;
    }
    buffer += event.text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    if (Buffer.byteLength(buffer) > PI_MAX_RPC_FRAME_BYTES) {
      throw new Error(`Pi RPC frame exceeded ${PI_MAX_RPC_FRAME_BYTES} bytes`);
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > PI_MAX_RPC_FRAME_BYTES) {
        throw new Error(`Pi RPC frame exceeded ${PI_MAX_RPC_FRAME_BYTES} bytes`);
      }
      try { yield { kind: "json", value: asRecord(JSON.parse(line)) }; }
      catch { yield { kind: "process", event: { kind: "stderr", text: `Invalid Pi RPC output: ${line}\n` } }; }
    }
  }
  if (buffer.trim()) {
    try { yield { kind: "json", value: asRecord(JSON.parse(buffer)) }; }
    catch { yield { kind: "process", event: { kind: "stderr", text: `Invalid Pi RPC output: ${buffer}\n` } }; }
  }
}

interface HandleLimits { timeoutMs?: number; idleTimeoutMs?: number; maxOutputBytes?: number }

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
      this.outputBytes += Buffer.byteLength(text);
      if (limits.maxOutputBytes && this.outputBytes > limits.maxOutputBytes) { this.timeout("max_output"); return; }
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
    if (limits.timeoutMs) this.overallTimer = setTimeout(() => this.timeout("timeout"), limits.timeoutMs);
    this.resetIdleTimer(limits.idleTimeoutMs);
  }

  get pid(): number | undefined { return this.child.pid; }
  write(input: string): void { if (this.child.stdin.writable) this.child.stdin.write(input); }
  wait(): Promise<{ exitCode: number | null; signal?: string }> { return this.exitPromise; }
  async cancel(): Promise<void> {
    if (this.child.exitCode === null) await killTree(this.child);
    await this.exitPromise.catch(() => undefined);
  }

  private timeout(reason: "timeout" | "idle" | "max_output"): void {
    if (this.closed) return;
    this.push({ kind: "timeout", reason });
    void killTree(this.child);
  }
  private resetIdleTimer(value?: number): void {
    if (!value || this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.timeout("idle"), value);
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
      if (event !== undefined) { yield event; continue; }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<ProcessEvent>>((resolve) => this.waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}

async function rpcCapture(
  command: string,
  args: string[],
  env: Record<string, string | undefined> | undefined,
  commands: RecordValue[]
): Promise<RecordValue[]> {
  const merged = { ...process.env, ...(env ?? {}), PI_OFFLINE: "1" } as Record<string, string>;
  const resolved = resolveSpawnCommand(command, args, merged);
  return await new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      env: merged,
      windowsHide: true,
      windowsVerbatimArguments: resolved.verbatim ?? false
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      void killTree(child);
      reject(new Error("Pi RPC model discovery timed out"));
    }, 15_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (exitCode !== 0) { reject(new Error(stderr.trim() || `Pi RPC exited with ${exitCode ?? "unknown"}`)); return; }
      const values = stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => asRecord(JSON.parse(line)));
      resolve(values);
    });
    for (const item of commands) child.stdin.write(`${JSON.stringify(item)}\n`);
    child.stdin.end();
  });
}

function capture(command: string, args: string[], env?: Record<string, string | undefined>): Promise<{ text: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let text = "";
    const resolved = resolveSpawnCommand(command, args, env);
    const child = spawn(resolved.command, resolved.args, {
      windowsHide: true,
      windowsVerbatimArguments: resolved.verbatim ?? false,
      env: env ? { ...process.env, ...env } as Record<string, string> : undefined
    });
    const timer = setTimeout(() => { void killTree(child); resolve({ text, exitCode: null }); }, 8_000);
    child.stdout.on("data", (chunk) => { text += String(chunk); });
    child.stderr.on("data", (chunk) => { text += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (exitCode) => { clearTimeout(timer); resolve({ text, exitCode }); });
  });
}

function killTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (platform() === "win32" && child.pid) {
    return new Promise((resolveKill) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => resolveKill());
      killer.once("close", () => resolveKill());
    });
  }
  child.kill("SIGTERM");
  return Promise.resolve();
}

function resolveSpawnCommand(command: string, args: string[], env?: Record<string, string | undefined>): { command: string; args: string[]; verbatim?: boolean } {
  if (platform() !== "win32") return { command, args };
  const merged = { ...process.env, ...env };
  const envValue = (key: string): string | undefined => {
    for (const [name, value] of Object.entries(merged)) if (name.toLowerCase() === key.toLowerCase()) return value as string | undefined;
    return undefined;
  };
  const hasDirectory = /[\\/]/.test(command) || /^[a-zA-Z]:/.test(command);
  const extensions = hasDirectory ? [""] : [...(envValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""];
  const directories = hasDirectory ? [""] : (envValue("PATH") ?? "").split(delimiter).filter(Boolean);
  let resolved: string | undefined;
  for (const dir of directories) {
    for (const extension of extensions) {
      const candidate = dir ? join(dir, command + extension) : command + extension;
      try { if (statSync(candidate).isFile()) { resolved = candidate; break; } } catch { /* continue */ }
    }
    if (resolved) break;
  }
  if (!resolved) return { command, args };
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args };
  const quote = (value: string): string => (value.length && !/[\s"&|<>^()%!]/.test(value) ? value : `"${value.replaceAll('"', '""')}"`);
  const line = `"${[quote(resolved), ...args.map(quote)].join(" ")}"`;
  return { command: "cmd.exe", args: ["/d", "/s", "/c", line], verbatim: true };
}

const factory: ProviderPluginFactory = () => new PiPluginAdapter();
export default factory;
