import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInstance } from "@agenthub/domain";
import { ProcessRuntime, type ProcessEvent } from "../../process-runtime.js";
import { JsonRpcProcessClient } from "../json-rpc-process.js";
import type { AdapterEvent, AdapterMcpServer, AdapterResumeRequest, AdapterRun, AdapterStartRequest } from "../types.js";
import type { RuntimeToolSpec } from "../runtime-tools.js";
import { parseCodexAppServerNotification, withSubagentDispatch } from "./app-server-events.js";
import { codexPermissionConfig } from "./commands.js";
import { resolveCodexInvocation } from "./executable.js";
import { buildCodexMcpConfigArgs } from "./mcp-config.js";
import { buildCodexProviderConfigArgs } from "./provider-config.js";
import {
  CODEX_IMAGE_GENERATION_TOOL,
  CODEX_IMAGE_GENERATION_TOOL_NAME,
  executeCodexImageGeneration,
  isCodexImageGenerationConfigured
} from "./image-generation.js";
import {
  extractInteractionPlan,
  isPlanExitTool,
  looksLikePlanApprovalQuestion,
  withPlanOptionIntents
} from "../plan-interaction.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => typeof value === "object" && value !== null ? value as RecordValue : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const CODEX_DYNAMIC_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;
const CODEX_WEB_SEARCH_MODE = "live";
const CODEX_MODEL_CATALOG_PREFIX = "agenthub-codex-model-";
const CODEX_MODEL_CATALOG_CONTEXT_WINDOW = 272_000;
const CODEX_MODEL_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

function codexWebSearchEnabled(instance: AgentInstance): boolean {
  const mode = instance.providerOptions?.webSearchMode;
  if (mode === "off" || mode === "official") return false;
  return instance.providerOptions?.webSearch !== false;
}

export const CODEX_APP_SERVER_INITIALIZE_PARAMS = {
  clientInfo: { name: "Nautilo", version: "0.1.0" },
  capabilities: { experimentalApi: true }
} as const;

function transportEvent(event: ProcessEvent): AdapterEvent | undefined {
  if (event.kind === "stdout") return { kind: "raw", stream: "stdout", text: event.text };
  if (event.kind === "stderr") return { kind: "raw", stream: "stderr", text: event.text };
  return event;
}

export function buildCodexDynamicTools(
  tools: RuntimeToolSpec[] | undefined,
  includeImageGeneration = false
): RecordValue[] | undefined {
  const source = includeImageGeneration
    ? [...(tools ?? []).filter((tool) => tool.name !== CODEX_IMAGE_GENERATION_TOOL_NAME), CODEX_IMAGE_GENERATION_TOOL]
    : tools;
  if (!source?.length) return undefined;
  return source.map((tool) => {
    if (!CODEX_DYNAMIC_TOOL_NAME.test(tool.name)) {
      throw new Error(`Invalid Codex dynamic tool name: ${tool.name}`);
    }
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    };
  });
}

function threadOptions(request: AdapterStartRequest | AdapterResumeRequest, includeDynamicTools = false): RecordValue {
  const permission = codexPermissionConfig(request.instance, request) ?? { approvalPolicy: "never" as const, sandbox: "workspace-write" as const };
  return {
    cwd: request.cwd,
    model: request.model || undefined,
    serviceTier: request.serviceTier || undefined,
    approvalPolicy: permission.approvalPolicy,
    sandbox: permission.sandbox,
    dynamicTools: includeDynamicTools
      ? buildCodexDynamicTools(request.runtimeTools, isCodexImageGenerationConfigured(request))
      : undefined
  };
}

async function handleDynamicToolCall(
  rpc: JsonRpcProcessClient,
  request: AdapterStartRequest | AdapterResumeRequest,
  event: { id: string | number; params?: unknown }
): Promise<AdapterEvent[]> {
  const params = record(event.params);
  const tool = String(params.tool ?? "");
  if (isPlanExitTool(tool) && request.requestInteraction) {
    try {
      const response = await request.requestInteraction({
        kind: "plan_approval",
        title: "计划已就绪",
        plan: extractInteractionPlan(params.arguments ?? params),
        options: [
          { id: "approve", label: "Approve", intent: "approve" },
          { id: "revise", label: "Revise", intent: "revise" }
        ]
      });
      const approved = response.outcome === "selected" && response.optionId === "approve";
      rpc.respond(event.id, {
        success: approved,
        contentItems: [{
          type: "inputText",
          text: approved ? "The user approved the plan. Exit plan mode and begin implementation." : "The user wants to continue refining the plan."
        }]
      });
    } catch (error) {
      rpc.respond(event.id, {
        success: false,
        contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }]
      });
    }
    return [];
  }
  if (tool === CODEX_IMAGE_GENERATION_TOOL_NAME) {
    try {
      const result = await executeCodexImageGeneration(request, params.arguments);
      rpc.respond(event.id, {
        success: true,
        contentItems: [{ type: "inputText", text: result.content }]
      });
      return [{
        kind: "artifact",
        artifactType: "image",
        name: result.name,
        mimeType: result.mimeType,
        path: result.path,
        raw: params
      }];
    } catch (error) {
      rpc.respond(event.id, {
        success: false,
        contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }]
      });
      return [];
    }
  }
  if (!tool || !request.executeRuntimeTool) {
    rpc.respond(event.id, {
      success: false,
      contentItems: [{ type: "inputText", text: `Nautilo runtime tool is unavailable: ${tool || "unknown"}` }]
    });
    return [];
  }
  try {
    const result = await request.executeRuntimeTool({
      providerId: request.instance.providerId,
      callId: String(params.callId ?? "") || undefined,
      name: tool,
      arguments: params.arguments
    });
    rpc.respond(event.id, {
      success: result.success,
      contentItems: [{ type: "inputText", text: result.content }]
    });
    return [];
  } catch (error) {
    rpc.respond(event.id, {
      success: false,
      contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }]
    });
    return [];
  }
}

const CODEX_APPROVAL_DECISIONS = ["accept", "acceptForSession", "decline", "cancel"] as const;

/** item/tool/requestUserInput — Codex's structured question tool (EXPERIMENTAL). */
async function handleRequestUserInput(
  rpc: JsonRpcProcessClient,
  request: AdapterStartRequest | AdapterResumeRequest,
  event: { id: string | number; params?: unknown }
): Promise<void> {
  if (!request.requestInteraction) {
    rpc.respondError(event.id, -32601, "Nautilo does not support app-server request item/tool/requestUserInput");
    return;
  }
  const params = record(event.params);
  const questions = (Array.isArray(params.questions) ? params.questions : []).map(record).map((question) => ({
    id: String(question.id ?? randomUUID()),
    header: typeof question.header === "string" ? question.header : undefined,
    question: String(question.question ?? ""),
    isOther: question.isOther === true || undefined,
    isSecret: question.isSecret === true || undefined,
    options: Array.isArray(question.options)
      ? question.options.map(record).map((option) => ({
          id: String(option.label ?? ""),
          label: String(option.label ?? ""),
          description: typeof option.description === "string" ? option.description : undefined
        }))
      : undefined
  }));
  try {
    if (looksLikePlanApprovalQuestion(params.title, questions)) {
      const question = questions[0]!;
      const options = withPlanOptionIntents(question.options ?? []);
      const response = await request.requestInteraction({
        kind: "plan_approval",
        title: "计划已就绪",
        plan: extractInteractionPlan(params),
        options
      });
      if (response.outcome === "cancelled" || !response.optionId) {
        rpc.respond(event.id, { answers: {} });
        return;
      }
      const selected = options.find((option) => option.id === response.optionId);
      rpc.respond(event.id, {
        answers: { [question.id]: { answers: selected ? [selected.label] : [] } }
      });
      return;
    }
    const response = await request.requestInteraction({ kind: "question", title: "请求用户输入", questions });
    if (response.outcome === "cancelled") {
      rpc.respond(event.id, { answers: {} });
      return;
    }
    const answers: RecordValue = {};
    for (const question of questions) {
      answers[question.id] = { answers: response.answers?.[question.id] ?? [] };
    }
    rpc.respond(event.id, { answers });
  } catch (error) {
    rpc.respondError(event.id, -32000, error instanceof Error ? error.message : String(error));
  }
}

/** item/commandExecution/requestApproval and item/fileChange/requestApproval. */
async function handleCodexApproval(
  rpc: JsonRpcProcessClient,
  request: AdapterStartRequest | AdapterResumeRequest,
  event: { id: string | number; params?: unknown; method: string }
): Promise<void> {
  const isCommand = event.method === "item/commandExecution/requestApproval";
  if (!request.requestInteraction) {
    // Fail closed: without a user bridge, deny rather than silently approve.
    rpc.respond(event.id, { decision: "decline" });
    return;
  }
  const params = record(event.params);
  const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined;
  const decisions = CODEX_APPROVAL_DECISIONS.filter((decision) => !available || available.includes(decision));
  const title = isCommand ? "运行命令" : "修改文件";
  const detail = [
    isCommand && typeof params.command === "string" ? params.command : undefined,
    typeof params.reason === "string" ? params.reason : undefined,
    !isCommand && typeof params.grantRoot === "string" ? `grantRoot: ${params.grantRoot}` : undefined
  ].filter(Boolean).join("\n") || undefined;
  try {
    const response = await request.requestInteraction({
      kind: "approval",
      title,
      detail,
      options: decisions.map((decision) => ({ id: decision, label: decision }))
    });
    rpc.respond(event.id, { decision: response.outcome === "selected" && response.optionId ? response.optionId : "cancel" });
  } catch (error) {
    rpc.respondError(event.id, -32000, error instanceof Error ? error.message : String(error));
  }
}

export function buildCodexTurnInput(prompt: string, localImagePaths: string[] = []): RecordValue[] {  return [
    { type: "text", text: prompt },
    ...localImagePaths.map((path) => ({ type: "localImage", path, detail: "auto" }))
  ];
}

/**
 * Codex's native web-search switch is provider-wide, but it still consults
 * the model catalog before serializing the Responses request. Models that are
 * only discovered from a third-party `/models` endpoint consequently fall
 * back to `supports_search_tool = false` and never receive a `web_search`
 * tool, even when the upstream endpoint supports it.
 *
 * Supply a short-lived catalog for custom endpoints so the selected model is
 * described as search-capable. This keeps the actual model id in the outgoing
 * request; it does not alias or replace the user's model.
 */
export function buildCodexCustomModelCatalog(instance: AgentInstance, requestedModel?: string): RecordValue | undefined {
  const baseUrl = instance.providerOptions?.baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return undefined;

  const configured = new Map<string, { displayName?: string; reasoningEfforts?: string[]; contextWindow?: number }>();
  for (const model of instance.models ?? []) {
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id) continue;
    configured.set(id, {
      displayName: model.displayName,
      reasoningEfforts: model.reasoningEfforts,
      contextWindow: model.contextWindow
    });
  }
  const selected = typeof requestedModel === "string" ? requestedModel.trim() : "";
  if (selected && !configured.has(selected)) configured.set(selected, {});
  if (!configured.size) return undefined;

  return {
    models: [...configured.entries()].map(([id, model]) => {
      const efforts = normalizeReasoningEfforts(model.reasoningEfforts);
      const contextWindow = Number.isFinite(model.contextWindow) && (model.contextWindow ?? 0) > 0
        ? Math.floor(model.contextWindow!)
        : CODEX_MODEL_CATALOG_CONTEXT_WINDOW;
      return {
        prefer_websockets: false,
        support_verbosity: false,
        // Codex 0.146 deserializes these catalog fields as enums rather than
        // nullable values. A null here makes app-server exit before initialize.
        default_verbosity: "low",
        apply_patch_tool_type: "freeform",
        // Keep a valid catalog enum even when search is disabled. The
        // supports_search_tool flag below remains the authoritative switch.
        web_search_tool_type: "text",
        input_modalities: ["text", "image"],
        supports_image_detail_original: false,
        truncation_policy: { mode: "tokens", limit: 10_000 },
        supports_parallel_tool_calls: true,
        context_window: contextWindow,
        max_context_window: contextWindow,
        auto_compact_token_limit: null,
        reasoning_summary_format: "experimental",
        default_reasoning_summary: "auto",
        slug: id,
        display_name: model.displayName?.trim() || id,
        description: "Nautilo custom endpoint model.",
        default_reasoning_level: efforts[0],
        supported_reasoning_levels: efforts.map((effort) => ({
          effort,
          description: `Reasoning effort: ${effort}`
        })),
        shell_type: "shell_command",
        visibility: "list",
        minimal_client_version: "0.0.1",
        supported_in_api: true,
        availability_nux: null,
        upgrade: null,
        priority: 1,
        base_instructions: "",
        model_messages: null,
        include_skills_usage_instructions: false,
        supports_reasoning_summary_parameter: true,
        supports_search_tool: codexWebSearchEnabled(instance),
        service_tiers: [],
        additional_speed_tiers: [],
        supports_reasoning_summaries: true,
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        use_responses_lite: false,
        auto_review_model_override: null,
        tool_mode: null,
        multi_agent_version: null
      };
    })
  };
}

function normalizeReasoningEfforts(values: string[] | undefined): string[] {
  const configured = (values ?? []).filter((value): value is string => typeof value === "string" && !!value.trim()).map((value) => value.trim());
  const unique = [...new Set(configured)];
  return unique.length ? unique : [...CODEX_MODEL_REASONING_EFFORTS];
}

interface CodexModelCatalogFile {
  path: string;
  cleanup: () => void;
}

function createCodexCustomModelCatalogFile(instance: AgentInstance, requestedModel?: string): CodexModelCatalogFile | undefined {
  const catalog = buildCodexCustomModelCatalog(instance, requestedModel);
  if (!catalog) return undefined;
  const directory = mkdtempSync(join(tmpdir(), CODEX_MODEL_CATALOG_PREFIX));
  const path = join(directory, "models.json");
  try {
    writeFileSync(path, JSON.stringify(catalog), "utf8");
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`Failed to prepare Codex custom model catalog: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    path,
    cleanup: () => {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort after Codex exits */ }
    }
  };
}

export function buildCodexAppServerArgs(
  instance: AgentInstance,
  environment: Record<string, string | undefined> | undefined,
  mcpServers?: AdapterMcpServer[],
  modelCatalogPath?: string
): string[] {
  const profileArgs = instance.profile ? ["--profile", instance.profile] : [];
  // Codex ships image generation as a feature-gated native extension.  The
  // app-server inherits the feature state from its invocation/config; without
  // explicitly enabling it, a custom model provider can still work for text
  // while the image_gen tool is omitted from the session's tool set.
  return [
    ...profileArgs,
    "app-server",
    "--stdio",
    "--enable",
    "image_generation",
    ...(codexWebSearchEnabled(instance)
      ? ["--config", `web_search=${JSON.stringify(CODEX_WEB_SEARCH_MODE)}`]
      : []),
    ...(modelCatalogPath ? ["--config", `model_catalog_json=${JSON.stringify(modelCatalogPath)}`] : []),
    // Codex 0.146 only accepts Responses in app-server. Chat mode is handled
    // by chat-completions-run.ts before this path is reached; keep discovery
    // and any defensive app-server calls on the supported wire format.
    ...buildCodexProviderConfigArgs(instance, environment, "responses"),
    ...buildCodexMcpConfigArgs(mcpServers)
  ];
}

export function startCodexAppServer(request: AdapterStartRequest | AdapterResumeRequest, resume: boolean): AdapterRun {
  const runtime = new ProcessRuntime();
  const modelCatalog = createCodexCustomModelCatalogFile(request.instance, request.model);
  let process: ReturnType<ProcessRuntime["start"]>;
  try {
    const invocation = resolveCodexInvocation(
      request.instance.executable,
      buildCodexAppServerArgs(request.instance, request.env, request.mcpServers, modelCatalog?.path)
    );
    process = runtime.start({
      command: invocation.command,
      args: invocation.args,
      cwd: request.cwd,
      env: request.env,
      timeoutMs: request.timeoutMs,
      idleTimeoutMs: request.idleTimeoutMs,
      maxOutputBytes: request.maxOutputBytes ?? 20 * 1024 * 1024
    });
    if (modelCatalog) process.child.once("close", modelCatalog.cleanup);
  } catch (error) {
    modelCatalog?.cleanup();
    throw error;
  }
  const rpc = new JsonRpcProcessClient(process);
  let threadId: string | undefined;
  let turnId: string | undefined;
  let finished = false;
  /** Child agent thread id → the collab tool call item that spawned it. */
  const childThreads = new Map<string, string>();

  async function* events(): AsyncGenerator<AdapterEvent> {
    try {
      await rpc.request("initialize", CODEX_APP_SERVER_INITIALIZE_PARAMS);
      rpc.notify("initialized", {});
      const threadResponse = record(await rpc.request(resume ? "thread/resume" : "thread/start", resume
        ? { threadId: (request as AdapterResumeRequest).providerSessionId, ...threadOptions(request, true) }
        : threadOptions(request, true)));
      const thread = record(threadResponse.thread);
      threadId = String(thread.id ?? (resume ? (request as AdapterResumeRequest).providerSessionId : ""));
      if (!threadId) throw new Error("Codex app-server did not return a thread id");
      yield { kind: "session", providerSessionId: threadId };
      const compact = request.providerCommand === "compact";
      if (compact && !resume) throw new Error("Codex thread compaction requires an existing provider session");
      if (compact) {
        // Manual compaction is a dedicated app-server RPC, not a chat turn.
        await rpc.request("thread/compact/start", { threadId });
      } else {
        const turnResponse = record(await rpc.request("turn/start", {
          threadId,
          input: buildCodexTurnInput(request.prompt, request.localImagePaths),
          cwd: request.cwd,
          model: request.model || undefined,
          serviceTier: request.serviceTier || undefined,
          effort: request.reasoningEffort || undefined,
          summary: "auto"
        }));
        turnId = String(record(turnResponse.turn).id ?? "");
      }

      for await (const event of rpc) {
        if (event.kind === "notification") {
          const params = record(event.params);
          const item = record(params.item);
          if ((event.method === "item/started" || event.method === "item/completed") && item.type === "collabAgentToolCall") {
            // A collab spawn names its child threads; subscribe so their items
            // arrive, and correlate them back to the dispatch item id.
            const dispatchId = text(item.id);
            const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
            for (const receiver of receivers) {
              const childId = text(receiver);
              if (!childId || !dispatchId) continue;
              if (!childThreads.has(childId)) void rpc.request("thread/subscribe", { threadId: childId }).catch(() => undefined);
              childThreads.set(childId, dispatchId);
            }
          }
          const events = parseCodexAppServerNotification(event.method, event.params);
          const eventThreadId = text(params.threadId);
          const subagentDispatchId = eventThreadId && eventThreadId !== threadId ? childThreads.get(eventThreadId) : undefined;
          yield* (subagentDispatchId ? withSubagentDispatch(events, subagentDispatchId) : events);
          if (compact && event.method === "thread/compacted") {
            finished = true;
            yield { kind: "message", text: "Codex 上下文已压缩" };
            await process.cancel();
            yield { kind: "exit", exitCode: 0 };
            return;
          }
          if (event.method === "turn/completed") {
            finished = true;
            await process.cancel();
            yield { kind: "exit", exitCode: 0 };
            return;
          }
        } else if (event.kind === "request" && event.method === "item/tool/call") {
          for (const emitted of await handleDynamicToolCall(rpc, request, event)) yield emitted;
        } else if (event.kind === "request" && event.method === "item/tool/requestUserInput") {
          await handleRequestUserInput(rpc, request, event);
        } else if (event.kind === "request" && (event.method === "item/commandExecution/requestApproval" || event.method === "item/fileChange/requestApproval")) {
          await handleCodexApproval(rpc, request, event);
        } else if (event.kind === "request") {
          rpc.respondError(event.id, -32601, `Nautilo does not support app-server request ${event.method}`);
        } else if (event.kind === "transport") {
          const mapped = transportEvent(event.event);
          if (mapped && !(finished && mapped.kind === "exit")) yield mapped;
        }
      }
    } catch (error) {
      yield { kind: "error", error: error instanceof Error ? error : new Error(String(error)) };
      if (!finished) await process.cancel().catch(() => undefined);
    }
  }

  return {
    process,
    events: { [Symbol.asyncIterator]: events },
    write: process.write,
    steer: async (input: string) => {
      if (!threadId || !turnId || finished) throw new Error("No active Codex turn is available to steer");
      const response = record(await rpc.request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: buildCodexTurnInput(input)
      }));
      turnId = String(response.turnId ?? turnId);
    },
    cancel: async () => {
      if (threadId && turnId) rpc.notify("turn/interrupt", { threadId, turnId });
      await process.cancel();
    }
  };
}
