import type { AgentInstance } from "@agenthub/domain";
import type { RuntimeToolCall, RuntimeToolResult, RuntimeToolSpec } from "../../adapters/runtime-tools.js";
import type { Database } from "../../database/index.js";
import { buildCodexAppServerArgs, buildCodexTurnInput, CODEX_APP_SERVER_INITIALIZE_PARAMS, startCodexAppServer } from "../../adapters/codex/app-server-run.js";
import { JsonRpcProcessClient } from "../../adapters/json-rpc-process.js";
import { resolveCodexInvocation } from "../../adapters/codex/executable.js";
import { ProcessRuntime } from "../../process-runtime.js";
import type { CredentialService } from "../security/credential-service.js";
import { RUNTIME_TOOL_NAMES } from "./runtime-tool-names.js";
import { startCodexChatCompatAppServer } from "../../adapters/codex/chat-compat-proxy.js";

type RecordValue = Record<string, unknown>;

export const OFFICIAL_WEB_SEARCH_TOOL: RuntimeToolSpec = {
  name: RUNTIME_TOOL_NAMES.officialWebSearch,
  description: "Search the live web through the user-selected Codex instance. Use this when the current model provider does not have native web search.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1, description: "The exact web search query." },
      search_context_size: { type: "string", enum: ["low", "medium", "high"], description: "How much search context to provide." }
    }
  }
};

export function supportsOfficialWebSearch(agent: AgentInstance, database: Database): boolean {
  if (agent.providerOptions?.webSearchMode !== "official") return false;
  const targetId = stringValue(agent.providerOptions?.webSearchInstanceId);
  const target = targetId ? database.agents.get(targetId) : undefined;
  return !!target && target.enabled && target.status !== "disabled" && target.providerId === "codex";
}

export async function executeOfficialWebSearch(
  call: RuntimeToolCall,
  agent: AgentInstance,
  database: Database,
  credentials: CredentialService
): Promise<RuntimeToolResult> {
  const targetId = stringValue(agent.providerOptions?.webSearchInstanceId);
  const target = targetId ? database.agents.get(targetId) : undefined;
  if (!target || !target.enabled || target.status === "disabled") {
    return { success: false, content: "Web search is not configured. Select an enabled Codex search instance first." };
  }
  if (target.providerId !== "codex") {
    return { success: false, content: "The selected web search instance must use the Codex adapter." };
  }

  const baseUrl = stringValue(target.providerOptions?.baseUrl) ?? "https://api.openai.com/v1";
  let endpoint: URL;
  try {
    endpoint = new URL(`${baseUrl.replace(/\/+$/, "")}/responses`);
  } catch {
    return { success: false, content: "The selected official search instance has an invalid API URL." };
  }
  const environment = credentials.environment(target.id, target.providerId);
  const apiKey = environment.OPENAI_API_KEY ?? environment.CODEX_API_KEY ?? environment.AGENTHUB_API_KEY;

  const argumentsValue = parseArguments(call.arguments);
  const query = stringValue(argumentsValue.query)?.trim();
  if (!query) return { success: false, content: "Search query cannot be empty." };
  const contextSize = argumentsValue.search_context_size === "low" || argumentsValue.search_context_size === "high"
    ? argumentsValue.search_context_size
    : "medium";
  const model = stringValue(agent.providerOptions?.webSearchModel)
    ?? target.models?.find((item) => /^gpt-\d/i.test(item.id))?.id
    ?? "gpt-5.6";
  const reasoningEffort = stringValue(agent.providerOptions?.webSearchReasoningEffort);

  if (apiKey && target.providerOptions?.wireApi !== "chat") {
    // Responses-compatible third-party endpoints can use the same native
    // web_search request shape. Avoid starting a nested Codex process when
    // the configured instance already exposes that protocol.
    return executeResponsesWebSearch(endpoint, model, query, contextSize, apiKey, reasoningEffort);
  }

  // Third-party endpoints must go through a real Codex instance. Their
  // search tool schema is not guaranteed to match OpenAI's direct API, while
  // the Codex adapter already translates the configured wire API and passes
  // the instance's own credentials safely.
  // A Codex account authenticated through its own login state also uses this
  // path, so both official and third-party instances behave consistently.
  if (apiKey) return executeNativeOfficialWebSearch(target, model, query, environment, reasoningEffort);
  if (isOfficialResponsesInstance(target)) {
    return executePersistentCodexWebSearch(target, model, query, environment, reasoningEffort);
  }
  return executeNativeOfficialWebSearch(target, model, query, environment, reasoningEffort);
}

function isOfficialResponsesInstance(target: AgentInstance): boolean {
  if (target.providerOptions?.wireApi === "chat") return false;
  const baseUrl = stringValue(target.providerOptions?.baseUrl);
  if (!baseUrl) return true;
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname === "api.openai.com";
  } catch {
    return false;
  }
}

const persistentSearchWorkers = new Map<string, PersistentCodexSearchWorker>();

async function executePersistentCodexWebSearch(
  target: AgentInstance,
  model: string,
  query: string,
  environment: Record<string, string | undefined>,
  reasoningEffort?: string
): Promise<RuntimeToolResult> {
  let worker = persistentSearchWorkers.get(target.id);
  if (!worker || worker.closed) {
    worker = new PersistentCodexSearchWorker(target, model, environment);
    persistentSearchWorkers.set(target.id, worker);
  }
  try {
    return { success: true, content: await worker.search(query, model, reasoningEffort) };
  } catch (error) {
    persistentSearchWorkers.delete(target.id);
    await worker.close();
    return { success: false, content: `Codex native web search failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

class PersistentCodexSearchWorker {
  private readonly runtime = new ProcessRuntime();
  private readonly processHandle;
  private readonly rpc;
  private readonly ready: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | undefined;
  private threadId = "";
  closed = false;

  constructor(
    private readonly target: AgentInstance,
    private readonly initialModel: string,
    private readonly environment: Record<string, string | undefined>
  ) {
    const nativeTarget: AgentInstance = {
      ...target,
      providerOptions: {
        ...target.providerOptions,
        webSearch: true,
        webSearchMode: "native"
      }
    };
    const invocation = resolveCodexInvocation(
      target.executable,
      buildCodexAppServerArgs(nativeTarget, { ...environment }, undefined, undefined)
    );
    this.processHandle = this.runtime.start({
      command: invocation.command,
      args: invocation.args,
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      idleTimeoutMs: 5 * 60_000,
      maxOutputBytes: 8 * 1024 * 1024
    });
    this.rpc = new JsonRpcProcessClient(this.processHandle);
    this.ready = this.initialize();
  }

  async search(query: string, model: string, reasoningEffort?: string): Promise<string> {
    const run = this.serial.then(() => this.runSearch(query, model, reasoningEffort));
    this.serial = run.catch(() => undefined);
    return run;
  }

  private async initialize(): Promise<void> {
    await this.rpc.request("initialize", CODEX_APP_SERVER_INITIALIZE_PARAMS);
    this.rpc.notify("initialized", {});
    const response = await this.rpc.request("thread/start", {
      cwd: process.cwd(),
      model: this.initialModel,
      approvalPolicy: "never",
      sandbox: "workspace-write"
    }) as RecordValue;
    const thread = recordValue(response.thread);
    this.threadId = stringValue(thread?.id) ?? "";
    if (!this.threadId) throw new Error("Codex app-server did not return a thread id");
  }

  private async runSearch(query: string, model: string, reasoningEffort?: string): Promise<string> {
    await this.ready;
    if (this.closed) throw new Error("Codex search worker is closed");
    this.refreshIdleTimer();
    await this.rpc.request("turn/start", {
      threadId: this.threadId,
      input: buildCodexTurnInput([
        "Use your native web search tool exactly once to answer this query.",
        "Return a concise factual answer with source URLs or citations when available.",
        `Query: ${query}`
      ].join("\n")),
      cwd: process.cwd(),
      model,
      ...(reasoningEffort ? { effort: reasoningEffort } : {}),
      summary: "auto"
    });
    let answer = "";
    let completedMessage = "";
    const deadline = Date.now() + 120_000;
    for await (const event of this.rpc) {
      if (Date.now() > deadline) throw new Error("search timed out");
      if (event.kind === "notification") {
        const params = recordValue(event.params);
        if (event.method === "item/agentMessage/delta") answer += stringValue(params?.delta) ?? "";
        if (event.method === "item/completed") {
          const item = recordValue(params?.item);
          if (item?.type === "agentMessage") completedMessage = stringValue(item.text) ?? completedMessage;
        }
        if (event.method === "turn/completed") break;
      } else if (event.kind === "request") {
        this.rpc.respondError(event.id, -32601, `Persistent search does not support app-server request ${event.method}`);
      } else if (event.kind === "transport" && (event.event.kind === "error" || event.event.kind === "exit")) {
        throw new Error(event.event.kind === "error" ? event.event.error.message : "Codex app-server exited");
      }
    }
    const result = (answer.trim() || completedMessage.trim());
    if (!result) throw new Error("no search result returned");
    return result;
  }

  private refreshIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.close(); }, 5 * 60_000);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.processHandle.cancel().catch(() => undefined);
  }
}

async function executeResponsesWebSearch(
  endpoint: URL,
  model: string,
  query: string,
  contextSize: "low" | "medium" | "high",
  apiKey: string,
  reasoningEffort?: string
): Promise<RuntimeToolResult> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search", search_context_size: contextSize }],
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
        input: query,
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {})
      })
    });
  } catch (error) {
    return { success: false, content: `Web search request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const body = await response.json().catch(() => ({})) as RecordValue;
  if (!response.ok) {
    const error = recordValue(body.error);
    return { success: false, content: `Web search failed (${response.status}): ${stringValue(error?.message) ?? "unknown error"}` };
  }
  return { success: true, content: formatSearchResult(body) };
}

async function executeNativeOfficialWebSearch(
  target: AgentInstance,
  model: string,
  query: string,
  environment: Record<string, string | undefined>,
  reasoningEffort?: string
): Promise<RuntimeToolResult> {
  const nativeTarget: AgentInstance = {
    ...target,
    providerOptions: {
      ...target.providerOptions,
      webSearch: true,
      webSearchMode: "native"
    }
  };
  const request = {
    instance: nativeTarget,
    prompt: [
      "Use your native web search tool to answer the following query.",
      "Return a concise factual summary and include source URLs or citations when available.",
      `Query: ${query}`
    ].join("\n"),
    cwd: process.cwd(),
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    env: { ...process.env, ...environment },
    timeoutMs: 120_000,
    idleTimeoutMs: 60_000,
    maxOutputBytes: 8 * 1024 * 1024
  };
  const run = target.providerOptions?.wireApi === "chat"
    ? startCodexChatCompatAppServer(request, false)
    : startCodexAppServer(request, false);
  let answer = "";
  let completedMessage = "";
  let failure: string | undefined;
  try {
    for await (const event of run.events) {
      if (event.kind === "message") {
        if (event.phase === "delta") answer += event.text;
        else if (event.phase === "completed") completedMessage = event.text;
      } else if (event.kind === "error") {
        failure = event.error.message;
      } else if (event.kind === "raw" && event.stream === "stderr") {
        failure = event.text.trim() || failure;
      }
    }
  } finally {
    await run.cancel().catch(() => undefined);
  }
  const text = answer.trim() || completedMessage.trim();
  if (text) return { success: true, content: text };
  return { success: false, content: `Official Codex native web search failed: ${failure ?? "no search result returned"}` };
}

function formatSearchResult(body: RecordValue): string {
  const outputText = stringValue(body.output_text)?.trim() || extractResponsesMessageText(body.output);
  const output = Array.isArray(body.output) ? body.output : [];
  const citations = new Map<string, string>();
  for (const raw of output) {
    const item = recordValue(raw);
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const annotationsValue = recordValue(part)?.annotations;
      const annotations = Array.isArray(annotationsValue) ? annotationsValue : [];
      for (const annotation of annotations) {
        const value = recordValue(annotation);
        const url = stringValue(value?.url);
        if (url) citations.set(url, stringValue(value?.title) ?? url);
      }
    }
  }
  const text = outputText || "Official web search returned no summary.";
  if (!citations.size) return text;
  return `${text}\n\nSources:\n${[...citations].map(([url, title]) => `- [${title}](${url})`).join("\n")}`;
}

function extractResponsesMessageText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((raw) => {
    const item = recordValue(raw);
    if (item?.type !== "message") return "";
    if (typeof item.text === "string") return item.text;
    const content = Array.isArray(item.content) ? item.content : [];
    return content.map((part) => {
      const value = recordValue(part);
      return typeof value?.text === "string" ? value.text : "";
    }).filter(Boolean).join("\n");
  }).filter(Boolean).join("\n\n").trim();
}

function parseArguments(value: unknown): RecordValue {
  if (recordValue(value)) return value as RecordValue;
  if (typeof value === "string") {
    try { return recordValue(JSON.parse(value)) ?? {}; } catch { return {}; }
  }
  return {};
}

function recordValue(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
