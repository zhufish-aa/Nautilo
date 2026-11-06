import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentInstance } from "@agenthub/domain";
import type { ProcessHandle } from "../../process-runtime.js";
import type { AdapterEvent, AdapterResumeRequest, AdapterRun, AdapterStartRequest } from "../types.js";
import type { CodexAppServerOwner } from "./app-server-pool.js";
import { startCodexAppServer } from "./app-server-run.js";

import { startAnthropicCompatProxy } from "./anthropic-compat-proxy.js";

type RecordValue = Record<string, unknown>;
type ChatContent = string | Array<RecordValue>;

interface ChatCompatProxy {
  baseUrl: string;
  token?: string;
  close(): Promise<void>;
}

interface ChatCompatConfig {
  remoteBaseUrl: string;
  environment?: Record<string, string | undefined>;
  allowNativeWebSearch?: boolean;
}

interface ResponseContext {
  responseId: string;
  messageId: string;
  reasoningId: string;
  model: string;
  createdAt: number;
  text: string;
  annotations: RecordValue[];
  reasoning: string;
  reasoningStarted: boolean;
  messageStarted: boolean;
  usage: RecordValue | null;
  toolCalls: Map<number, FunctionCallContext>;
  output: RecordValue[];
}

interface FunctionCallContext {
  index: number;
  itemId: string;
  callId: string;
  name: string;
  namespace: string;
  arguments: string;
  outputIndex: number;
  started: boolean;
  toolType: "function" | "custom";
}

/**
 * Runs the real Codex app-server behind a local Responses-to-Chat shim. This
 * is needed because recent Codex versions reject `wire_api = "chat"`, while
 * many OpenAI-compatible relays only expose `/chat/completions`.
 */
export function startCodexChatCompatAppServer(
  request: AdapterStartRequest | AdapterResumeRequest,
  resume: boolean,
  options: { owner?: CodexAppServerOwner; anthropic?: boolean } = {}
): AdapterRun {
  let proxy: ChatCompatProxy | undefined;
  let inner: AdapterRun | undefined;
  let cancelled = false;
  let eventsStarted = false;

  const events = async function* (): AsyncGenerator<AdapterEvent> {
    eventsStarted = true;
    try {
      if (options.anthropic && request.localImagePaths?.length) throw new Error("Anthropic compatibility does not support image input");
      if (options.anthropic && request.serviceTier && request.serviceTier !== "auto") throw new Error("Anthropic compatibility does not support service tier");
      const remoteBaseUrl = configuredBaseUrl(request.instance);
      if (!remoteBaseUrl) throw new Error("Protocol compatibility mode needs a configured API base URL");
      proxy = await (options.anthropic ? startAnthropicCompatProxy : startChatCompatProxy)({
        remoteBaseUrl,
        environment: request.env,
        allowNativeWebSearch: !options.anthropic && request.instance.providerOptions?.webSearchMode === "native"
      });
      if (cancelled) return;

      const instance: AgentInstance = {
        ...request.instance,
        providerOptions: {
          ...request.instance.providerOptions,
          baseUrl: proxy.baseUrl,
          wireApi: "responses",
          ...(options.anthropic ? { anthropicCompat: true } : {}),
          webSearch: !options.anthropic && request.instance.providerOptions?.webSearchMode === "native",
          webSearchMode: !options.anthropic && request.instance.providerOptions?.webSearchMode === "native" ? "native" : "off"
        }
      };
      const env = proxy.token ? compatibilityChildEnvironment(request.env, proxy.token, proxy.baseUrl) : request.env;
      inner = startCodexAppServer({ ...request, instance, env }, resume, { transient: true, owner: options.owner });
      if (cancelled) await inner.cancel();
      yield* inner.events;
    } catch (error) {
      if (!cancelled) yield { kind: "error", error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      await inner?.cancel().catch(() => undefined);
      await proxy?.close().catch(() => undefined);
      proxy = undefined;
      inner = undefined;
    }
  };

  const process: ProcessHandle = {
    get pid() { return inner?.process.pid; },
    get child(): ChildProcessWithoutNullStreams {
      if (!inner) throw new Error("Codex compatibility process has not started yet");
      return inner.process.child;
    },
    events: {
      async *[Symbol.asyncIterator]() {
        if (inner) yield* inner.process.events;
      }
    },
    write: (input) => inner?.write(input),
    cancel: async () => {
      cancelled = true;
      await inner?.cancel();
      await proxy?.close();
    },
    wait: async () => inner ? inner.process.wait() : { exitCode: eventsStarted ? null : null }
  };

  return {
    process,
    events: { [Symbol.asyncIterator]: events },
    cancel: process.cancel,
    steer: async (input) => {
      if (!inner?.steer) throw new Error("Protocol compatibility mode does not support steering before the Codex turn starts");
      await inner.steer(input);
    },
    write: process.write
  };
}

/** Remove upstream credentials even on case-insensitive Windows environments. */
export function compatibilityChildEnvironment(environment: Record<string, string | undefined> | undefined, token: string, baseUrl: string): Record<string, string | undefined> {
  const secrets = new Set(["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_AUTH_TOKEN", "AGENTHUB_API_KEY"]);
  return {
    ...Object.fromEntries(Object.entries(environment ?? {}).filter(([key]) => !secrets.has(key.toUpperCase()) && key.toUpperCase() !== "OPENAI_BASE_URL")),
    OPENAI_API_KEY: token,
    OPENAI_BASE_URL: baseUrl
  };
}

export async function startChatCompatProxy(config: ChatCompatConfig): Promise<ChatCompatProxy> {
  // Local clients receive a run-scoped capability, never the provider secret.
  chatEndpoint(config.remoteBaseUrl);
  const token = randomBytes(32).toString("hex");
  const controllers = new Set<AbortController>();
  const server = createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      writeJsonError(response, 401, "Invalid compatibility capability");
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    response.on("close", () => controller.abort());
    void handleProxyRequest(request, response, config, AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)])).catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      writeJsonError(response, 502, "Chat Completions compatibility request failed");
    }).finally(() => { controller.abort(); controllers.delete(controller); });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
    const onListening = (): void => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    token,
    close: () => closing ??= new Promise<void>((resolve) => {
      for (const controller of controllers) controller.abort();
      server.close(() => resolve());
      server.closeAllConnections();
    })
  };
}

async function handleProxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ChatCompatConfig,
  signal: AbortSignal
): Promise<void> {
  if (request.method !== "POST" || !/^\/v1\/responses\/?$/.test(request.url ?? "")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Responses compatibility endpoint not found", type: "invalid_request_error" } }));
    return;
  }
  if (Number(request.headers["content-length"]) > 20 * 1024 * 1024) { writeJsonError(response, 413, "Request body exceeds size limit"); return; }
  let input: RecordValue;
  try {
    const parsed = asRecord(JSON.parse(await readRequestBody(request)));
    if (!parsed) throw new Error("Invalid request");
    input = parsed;
  } catch { writeJsonError(response, 400, "Invalid Responses request body"); return; }
  const chatRequest = responsesToChatRequest(input, config.allowNativeWebSearch === true);
  const remoteResponse = await fetch(chatEndpoint(config.remoteBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: bearer(config.environment)
    },
    body: JSON.stringify(chatRequest),
    redirect: "error",
    signal
  });
  if (!remoteResponse.ok) {
    await remoteResponse.body?.cancel();
    writeJsonError(response, remoteResponse.status, `Chat Completions upstream failed (${remoteResponse.status})`);
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  await writeResponsesStream(remoteResponse, response, input);
}

function responsesToChatRequest(input: RecordValue, allowNativeWebSearch = false): RecordValue {
  const messages: RecordValue[] = [];
  const instructions = input.instructions;
  if (typeof instructions === "string" && instructions.trim()) messages.push({ role: "system", content: instructions });
  const inputItems = input.input;
  if (typeof inputItems === "string") messages.push({ role: "user", content: inputItems });
  else if (Array.isArray(inputItems)) appendInputMessages(messages, inputItems);
  const request: RecordValue = {
    model: typeof input.model === "string" ? input.model : undefined,
    messages,
    stream: true
  };
  if (typeof input.temperature === "number") request.temperature = input.temperature;
  if (typeof input.top_p === "number") request.top_p = input.top_p;
  if (typeof input.max_output_tokens === "number") request.max_tokens = input.max_output_tokens;
  const reasoning = asRecord(input.reasoning);
  const reasoningEffort = stringValue(reasoning?.effort) ?? stringValue(input.reasoning_effort);
  if (reasoningEffort) request.reasoning_effort = reasoningEffort;
  if (typeof input.service_tier === "string") request.service_tier = input.service_tier;
  if (input.parallel_tool_calls !== undefined) request.parallel_tool_calls = input.parallel_tool_calls;
  const text = asRecord(input.text);
  const format = asRecord(text?.format);
  if (format?.type === "json_object") request.response_format = { type: "json_object" };
  if (format?.type === "json_schema") request.response_format = { type: "json_schema", json_schema: format };
  const tools = chatTools(input.tools);
  if (tools.length) request.tools = tools;
  if (allowNativeWebSearch && hasWebSearchTool(input.tools)) request.web_search_options = { search_context_size: "high" };
  if (input.tool_choice !== undefined) request.tool_choice = chatToolChoice(input.tool_choice);
  return request;
}

function appendInputMessages(messages: RecordValue[], items: unknown[]): void {
  let pendingText = "";
  let pendingReasoning = "";
  let pendingAssistantContent: ChatContent | undefined;
  const pendingToolCalls: RecordValue[] = [];
  const flushText = (): void => {
    if (pendingText) {
      messages.push({ role: "user", content: pendingText });
      pendingText = "";
    }
  };
  const flushAssistant = (): void => {
    if (!pendingReasoning && !pendingAssistantContent && !pendingToolCalls.length) return;
    messages.push({
      role: "assistant",
      content: pendingAssistantContent ?? (pendingToolCalls.length ? null : ""),
      ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}),
      ...(pendingToolCalls.length ? { tool_calls: pendingToolCalls.splice(0) } : {})
    });
    pendingReasoning = "";
    pendingAssistantContent = undefined;
  };
  for (const raw of items) {
    if (typeof raw === "string") {
      flushAssistant();
      pendingText += raw;
      continue;
    }
    const item = asRecord(raw);
    if (!item) continue;
    const type = stringValue(item.type);
    if (type === "input_text" || type === "text") {
      flushAssistant();
      pendingText += stringValue(item.text) ?? "";
      continue;
    }
    if (type === "reasoning") {
      flushText();
      pendingReasoning += reasoningSummary(item);
      continue;
    }
    if (type === "function_call_output") {
      flushText();
      flushAssistant();
      messages.push({
        role: "tool",
        tool_call_id: stringValue(item.call_id) ?? stringValue(item.id) ?? randomUUID(),
        content: stringValue(item.output) ?? JSON.stringify(item.output ?? "")
      });
      continue;
    }
    if (type === "custom_tool_call_output") {
      flushText();
      flushAssistant();
      messages.push({
        role: "tool",
        tool_call_id: stringValue(item.call_id) ?? stringValue(item.id) ?? randomUUID(),
        content: stringValue(item.output) ?? JSON.stringify(item.output ?? "")
      });
      continue;
    }
    if (type === "function_call") {
      flushText();
      pendingToolCalls.push({
        id: stringValue(item.call_id) ?? stringValue(item.id) ?? randomUUID(),
        type: "function",
        function: { name: stringValue(item.name) ?? "function", arguments: stringValue(item.arguments) ?? "{}" }
      });
      continue;
    }
    if (type === "custom_tool_call") {
      flushText();
      pendingToolCalls.push({
        id: stringValue(item.call_id) ?? stringValue(item.id) ?? randomUUID(),
        type: "function",
        function: {
          name: stringValue(item.name) ?? "function",
          arguments: JSON.stringify({ input: stringValue(item.input) ?? "" })
        }
      });
      continue;
    }
    if (type === "message" || item.role) {
      flushText();
      const role = item.role === "assistant" || item.role === "system" ? item.role : "user";
      const content = chatContent(item.content ?? item.text);
      const reasoningContent = role === "assistant" ? stringValue(item.reasoning_content) : undefined;
      if (role === "assistant" && (pendingReasoning || pendingToolCalls.length)) {
        if (content !== undefined) pendingAssistantContent = mergeChatContent(pendingAssistantContent, content);
        if (reasoningContent) pendingReasoning += reasoningContent;
        continue;
      }
      flushAssistant();
      if (content !== undefined && (role !== "assistant" || content !== "" || reasoningContent)) {
        messages.push({
          role,
          content,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
        });
      }
    }
  }
  flushText();
  flushAssistant();
}

function reasoningSummary(item: RecordValue): string {
  if (!Array.isArray(item.summary)) return "";
  return item.summary.map((part) => {
    if (typeof part === "string") return part;
    return stringValue(asRecord(part)?.text) ?? "";
  }).filter(Boolean).join("\n");
}

function mergeChatContent(current: ChatContent | undefined, next: ChatContent): ChatContent {
  if (current === undefined) return next;
  if (typeof current === "string" && typeof next === "string") return `${current}${next}`;
  const currentParts = typeof current === "string" ? [{ type: "text", text: current }] : current;
  const nextParts = typeof next === "string" ? [{ type: "text", text: next }] : next;
  return [...currentParts, ...nextParts];
}

function chatContent(value: unknown): ChatContent | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const content: RecordValue[] = [];
  for (const part of value) {
    const item = asRecord(part);
    if (!item) continue;
    const type = stringValue(item.type);
    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = stringValue(item.text);
      if (text) content.push({ type: "text", text });
      continue;
    }
    if (type === "input_image" || type === "image_url") {
      const imageUrl = stringValue(item.image_url) ?? stringValue(asRecord(item.image_url)?.url);
      if (imageUrl) content.push({ type: "image_url", image_url: { url: imageUrl } });
    }
  }
  return content.length ? content : undefined;
}

function chatTools(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const tool = asRecord(raw);
    if (!tool) return [];
    if (tool.type === "function" && typeof tool.name === "string") {
      return [{
        type: "function",
        function: {
          name: tool.name,
          description: stringValue(tool.description),
          parameters: tool.parameters ?? { type: "object", properties: {} }
        }
      }];
    }
    if (tool.type === "custom" && typeof tool.name === "string") {
      const format = asRecord(tool.format);
      const grammar = stringValue(format?.definition);
      return [{
        type: "function",
        function: {
          name: tool.name,
          description: stringValue(tool.description),
          parameters: {
            type: "object",
            properties: {
              input: {
                type: "string",
                description: grammar
                  ? `Freeform tool input. It must follow this grammar:\n${grammar}`
                  : "Freeform tool input."
              }
            },
            required: ["input"],
            additionalProperties: false
          }
        }
      }];
    }
    if (tool.type === "namespace" && typeof tool.name === "string") {
      // Namespaced tool groups (codex built-ins like multi_agent_v1 and MCP
      // servers) must be flattened into plain chat functions; chat tool names
      // reject dots, so use a hyphen join and keep the mapping for the response
      // direction in responseToolTypes.
      const namespace = tool.name;
      const namespaceDescription = stringValue(tool.description);
      const flattened: RecordValue[] = [];
      const subs = Array.isArray(tool.tools) ? tool.tools : [];
      for (const sub of subs) {
        const subRecord = asRecord(sub);
        if (!subRecord) continue;
        const subType = subRecord.type;
        const subName = stringValue(subRecord.name);
        if (!subName || (subType !== "function" && subType !== "custom")) continue;
        const chatName = `${namespace}-${subName}`;
        const description = [
          namespaceDescription ? `[${namespace}]` : null,
          stringValue(subRecord.description),
          // Chat relays reject dotted tool names, so the namespace was flattened
          // to a hyphenated name. Tell the model the exact callable name
          // explicitly; models otherwise default to the codex dotted convention
          // (e.g. mcp__firecrawl.search) and fail the call.
          `Call this tool with the exact name \`${chatName}\` (hyphen, not dot).`
        ].filter(Boolean).join(" ");
        if (subType === "function") {
          flattened.push({
            type: "function",
            function: {
              name: chatName,
              description,
              parameters: subRecord.parameters ?? { type: "object", properties: {} }
            }
          });
        } else if (subType === "custom") {
          const format = asRecord(subRecord.format);
          const grammar = stringValue(format?.definition);
          flattened.push({
            type: "function",
            function: {
              name: chatName,
              description,
              parameters: {
                type: "object",
                properties: {
                  input: {
                    type: "string",
                    description: grammar
                      ? `Freeform tool input. It must follow this grammar:\n${grammar}`
                      : "Freeform tool input."
                  }
                },
                required: ["input"],
                additionalProperties: false
              }
            }
          });
        }
      }
      return flattened;
    }
    if (tool.type === "web_search_preview" || tool.type === "web_search") return [];
    return [];
  });
}

function chatToolChoice(value: unknown): unknown {
  const choice = asRecord(value);
  if (!choice || (choice.type !== "function" && choice.type !== "custom")) return value;
  const name = stringValue(choice.name) ?? stringValue(asRecord(choice.function)?.name);
  return name ? { type: "function", function: { name } } : value;
}

/**
 * Registry of chat-side tool names -> { namespace, codexName, type }.
 *
 * Namespaced tools (multi_agent_v1.*, mcp__*) are exposed to the chat model
 * as `{namespace}-{sub}` functions and come back to codex as `function_call`
 * items carrying the separate `namespace`/`name` fields. Codex routes on the
 * ToolName split (a single flattened name is never found) and its MCP /
 * multi-agent handlers only accept function payloads, so the call-back must
 * be a function_call (not custom_tool_call). Both the hyphenated chat name and
 * the dotted codex name are registered so whichever the model calls, the
 * call-back routes correctly.
 */
function responseToolTypes(value: unknown): Map<string, { namespace: string; codexName: string; type: "function" | "custom" }> {
  const result = new Map<string, { namespace: string; codexName: string; type: "function" | "custom" }>();
  if (!Array.isArray(value)) return result;
  for (const raw of value) {
    const tool = asRecord(raw);
    const name = stringValue(tool?.name);
    if (!name) continue;
    if (tool?.type === "function" || tool?.type === "custom") {
      result.set(name, { namespace: "", codexName: name, type: tool.type });
    } else if (tool?.type === "namespace") {
      const subs = Array.isArray(tool.tools) ? tool.tools : [];
      for (const sub of subs) {
        const subRecord = asRecord(sub);
        const subType = subRecord?.type;
        const subName = stringValue(subRecord?.name);
        if (!subName || (subType !== "function" && subType !== "custom")) continue;
        const value = { namespace: name, codexName: subName, type: "function" as const };
        result.set(`${name}-${subName}`, value);
        result.set(`${name}.${subName}`, value);
        result.set(`${name}__${subName}`, value);
        // Models frequently drop the namespace prefix and call the bare
        // sub-tool name; register that alias too unless another tool already
        // owns it (ambiguous otherwise).
        if (!result.has(subName)) result.set(subName, value);
      }
    }
  }
  return result;
}

function hasWebSearchTool(value: unknown): boolean {
  return Array.isArray(value) && value.some((raw) => {
    const tool = asRecord(raw);
    return tool?.type === "web_search_preview" || tool?.type === "web_search";
  });
}

async function writeResponsesStream(
  remoteResponse: Response,
  response: ServerResponse,
  request: RecordValue
): Promise<void> {
  const context: ResponseContext = {
    responseId: `resp-${randomUUID()}`,
    messageId: `msg-${randomUUID()}`,
    reasoningId: `rsn-${randomUUID()}`,
    model: stringValue(request.model) ?? "unknown",
    createdAt: Math.floor(Date.now() / 1000),
    text: "",
    annotations: [],
    reasoning: "",
    reasoningStarted: false,
    messageStarted: false,
    usage: null,
    toolCalls: new Map(),
    output: []
  };
  const toolTypes = responseToolTypes(request.tools);
  writeEvent(response, "response.created", { type: "response.created", response: responseObject(context, "in_progress") });

  for await (const chunk of readChatStream(remoteResponse)) {
    const chunkRecord = asRecord(chunk) ?? {};
    const choice = Array.isArray(chunkRecord.choices) ? asRecord(chunkRecord.choices[0]) : undefined;
    const delta = asRecord(choice?.delta);
    const completedMessage = asRecord(choice?.message);
    const reasoning = stringValue(delta?.reasoning_content) ?? stringValue(delta?.reasoning) ?? stringValue(completedMessage?.reasoning_content) ?? "";
    if (reasoning) {
      ensureReasoningStarted(response, context);
      context.reasoning += reasoning;
      writeEvent(response, "response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        item_id: context.reasoningId,
        output_index: 0,
        summary_index: 0,
        delta: reasoning
      });
    }
    const toolCallValue = delta?.tool_calls ?? completedMessage?.tool_calls;
    if (Array.isArray(toolCallValue)) {
      for (const toolCall of toolCallValue) appendFunctionCallDelta(response, context, toolCall, toolTypes);
    }
    const text = stringValue(delta?.content);
    const annotationValue = delta?.annotations ?? completedMessage?.annotations;
    const annotations = Array.isArray(annotationValue)
      ? annotationValue.filter((item): item is RecordValue => !!asRecord(item))
      : [];
    context.annotations.push(...annotations);
    if (text) {
      ensureMessageStarted(response, context);
      context.text += text;
      writeEvent(response, "response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: context.messageId,
        output_index: messageOutputIndex(context),
        content_index: 0,
        delta: text
      });
    }
    const usage = asRecord(chunkRecord.usage);
    if (usage) context.usage = responsesUsage(usage);
  }

  if (context.reasoningStarted) {
    writeEvent(response, "response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: context.reasoningId,
      output_index: 0,
      summary_index: 0,
      text: context.reasoning
    });
    writeEvent(response, "response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: context.reasoningId,
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: context.reasoning }
    });
    writeEvent(response, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: { id: context.reasoningId, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: context.reasoning }] }
    });
  }
  const toolCalls = [...context.toolCalls.values()].sort((left, right) => left.index - right.index);
  for (const call of toolCalls) {
    const customInput = call.toolType === "custom" ? customToolInput(call.arguments) : undefined;
    if (call.toolType === "custom") {
      writeEvent(response, "response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta",
        item_id: call.itemId,
        output_index: call.outputIndex,
        delta: customInput
      });
      writeEvent(response, "response.custom_tool_call_input.done", {
        type: "response.custom_tool_call_input.done",
        item_id: call.itemId,
        output_index: call.outputIndex,
        input: customInput
      });
    } else {
      writeEvent(response, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: call.itemId,
        output_index: call.outputIndex,
        arguments: call.arguments
      });
    }
    const doneItem: RecordValue = call.toolType === "custom" ? {
        id: call.itemId,
        type: "custom_tool_call",
        status: "completed",
        call_id: call.callId,
        name: call.name,
        input: customInput
      } : {
        id: call.itemId,
        type: "function_call",
        status: "completed",
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments
      };
    if (call.namespace) doneItem.namespace = call.namespace;
    writeEvent(response, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: call.outputIndex,
      item: doneItem
    });
  }
  if (!context.text && !toolCalls.length) {
    context.output = context.reasoningStarted
      ? [{ id: context.reasoningId, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: context.reasoning }] }]
      : [];
    const failedResponse = responseObject(context, "failed");
    failedResponse.error = {
      code: "empty_upstream_response",
      message: "Chat Completions upstream returned neither an assistant message nor a tool call."
    };
    writeEvent(response, "response.failed", {
      type: "response.failed",
      response: failedResponse
    });
    response.end();
    return;
  }
  const message = context.messageStarted || context.text
    ? {
      id: context.messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: context.text, annotations: context.annotations }]
    }
    : undefined;
  if (message) {
    if (!context.messageStarted) ensureMessageStarted(response, context);
    const messageIndex = messageOutputIndex(context);
    writeEvent(response, "response.output_text.done", {
      type: "response.output_text.done",
      item_id: context.messageId,
      output_index: messageIndex,
      content_index: 0,
      text: context.text
    });
    writeEvent(response, "response.content_part.done", {
      type: "response.content_part.done",
      item_id: context.messageId,
      output_index: messageIndex,
      content_index: 0,
      part: { type: "output_text", text: context.text, annotations: context.annotations }
    });
    writeEvent(response, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: messageIndex,
      item: message
    });
  }
  context.output = [
    ...(context.reasoningStarted ? [{ id: context.reasoningId, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: context.reasoning }] }] : []),
    ...toolCalls.map((call) => {
      const item: RecordValue = {
        id: call.itemId,
        type: call.toolType === "custom" ? "custom_tool_call" : "function_call",
        status: "completed",
        call_id: call.callId,
        name: call.name,
        ...(call.toolType === "custom" ? { input: customToolInput(call.arguments) } : { arguments: call.arguments })
      };
      if (call.namespace) item.namespace = call.namespace;
      return item;
    }),
    ...(message ? [message] : [])
  ];
  writeEvent(response, "response.completed", {
    type: "response.completed",
    response: responseObject(context, "completed")
  });
  response.end();
}

function appendFunctionCallDelta(
  response: ServerResponse,
  context: ResponseContext,
  value: unknown,
  toolTypes: Map<string, { namespace: string; codexName: string; type: "function" | "custom" }>
): void {
  const raw = asRecord(value);
  if (!raw) return;
  const functionValue = asRecord(raw.function);
  const index = numberValue(raw.index) ?? context.toolCalls.size;
  const incomingName = stringValue(functionValue?.name);
  let call = context.toolCalls.get(index);
  if (!call) {
    const name = incomingName ?? "function";
    // Chat-side name -> { namespace, codex name, wire type }. Namespaced tools
    // are re-mapped so the codex CLI receives a `custom_tool_call` with the
    // separate namespace/name fields it routes on.
    const mapped = toolTypes.get(name) ?? { namespace: "", codexName: name, type: "function" as const };
    call = {
      index,
      itemId: `fc-${randomUUID()}`,
      callId: stringValue(raw.id) ?? `call-${randomUUID()}`,
      name: mapped.codexName,
      namespace: mapped.namespace,
      arguments: "",
      outputIndex: (context.reasoningStarted ? 1 : 0) + context.toolCalls.size,
      started: false,
      toolType: mapped.type
    };
    context.toolCalls.set(index, call);
  }
  if (stringValue(raw.id)) call.callId = stringValue(raw.id)!;
  if (incomingName) {
    const mapped = toolTypes.get(incomingName);
    if (mapped) {
      call.name = mapped.codexName;
      call.namespace = mapped.namespace;
      call.toolType = mapped.type;
    }
  }
  if (!call.started) {
    call.started = true;
    const item: RecordValue = {
      id: call.itemId,
      type: call.toolType === "custom" ? "custom_tool_call" : "function_call",
      status: "in_progress",
      call_id: call.callId,
      name: call.name,
      ...(call.toolType === "custom" ? { input: "" } : { arguments: "" })
    };
    if (call.namespace) item.namespace = call.namespace;
    writeEvent(response, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: call.outputIndex,
      item
    });
  }
  const argumentDelta = stringValue(functionValue?.arguments);
  if (!argumentDelta) return;
  call.arguments += argumentDelta;
  if (call.toolType === "custom") return;
  writeEvent(response, "response.function_call_arguments.delta", {
    type: "response.function_call_arguments.delta",
    item_id: call.itemId,
    output_index: call.outputIndex,
    delta: argumentDelta
  });
}

function customToolInput(argumentsValue: string): string {
  try {
    const parsed = JSON.parse(argumentsValue) as unknown;
    if (typeof parsed === "string") return parsed;
    const record = asRecord(parsed);
    return stringValue(record?.input) ?? stringValue(record?.command) ?? argumentsValue;
  } catch {
    return argumentsValue;
  }
}

function ensureReasoningStarted(response: ServerResponse, context: ResponseContext): void {
  if (context.reasoningStarted) return;
  context.reasoningStarted = true;
  writeEvent(response, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: context.reasoningId,
      type: "reasoning",
      status: "in_progress",
      summary: []
    }
  });
  writeEvent(response, "response.reasoning_summary_part.added", {
    type: "response.reasoning_summary_part.added",
    item_id: context.reasoningId,
    output_index: 0,
    summary_index: 0,
    part: { type: "summary_text", text: "" }
  });
}

function ensureMessageStarted(response: ServerResponse, context: ResponseContext): void {
  if (context.messageStarted) return;
  context.messageStarted = true;
  const outputIndex = messageOutputIndex(context);
  writeEvent(response, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: {
      id: context.messageId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: []
    }
  });
  writeEvent(response, "response.content_part.added", {
    type: "response.content_part.added",
    item_id: context.messageId,
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] }
  });
}

function messageOutputIndex(context: ResponseContext): number {
  return (context.reasoningStarted ? 1 : 0) + context.toolCalls.size;
}

async function* readChatStream(response: Response): AsyncGenerator<RecordValue> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    yield JSON.parse(await readBoundedResponse(response)) as RecordValue;
    return;
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      total += next.value?.byteLength ?? 0;
      if (total > 20 * 1024 * 1024) throw new Error("Upstream response exceeds size limit");
      pending += decoder.decode(next.value, { stream: !next.done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        yield JSON.parse(payload) as RecordValue;
      }
      if (next.done) break;
    }
    const trailing = pending.trim();
    if (trailing.startsWith("data:")) {
      const payload = trailing.slice(5).trim();
      if (payload && payload !== "[DONE]") yield JSON.parse(payload) as RecordValue;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error("Missing upstream body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 20 * 1024 * 1024) throw new Error("Upstream response exceeds size limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function responseObject(context: ResponseContext, status: string): RecordValue {
  return {
    id: context.responseId,
    object: "response",
    created_at: context.createdAt,
    status,
    model: context.model,
    output: context.output,
    output_text: context.text,
    error: null,
    incomplete_details: null,
    usage: context.usage,
    metadata: {}
  };
}

function responsesUsage(usage: RecordValue): RecordValue {
  const promptTokens = numberValue(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = numberValue(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = numberValue(usage.total_tokens ?? usage.totalTokens);
  const promptDetails = asRecord(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const completionDetails = asRecord(usage.completion_tokens_details ?? usage.output_tokens_details);
  const cachedTokens = numberValue(promptDetails?.cached_tokens ?? promptDetails?.cachedTokens);
  const reasoningTokens = numberValue(completionDetails?.reasoning_tokens ?? completionDetails?.reasoningTokens);
  return {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: totalTokens ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined),
    ...(cachedTokens !== undefined ? { input_tokens_details: { cached_tokens: cachedTokens } } : {}),
    ...(reasoningTokens !== undefined ? { output_tokens_details: { reasoning_tokens: reasoningTokens } } : {})
  };
}

function writeEvent(response: ServerResponse, event: string, value: RecordValue): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function writeJsonError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 20 * 1024 * 1024) throw new Error("Responses compatibility request is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function configuredBaseUrl(instance: AgentInstance): string | undefined {
  const value = instance.providerOptions?.baseUrl;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function chatEndpoint(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid Chat Completions base URL");
  if (parsed.protocol === "http:" && !["127.0.0.1", "[::1]"].includes(parsed.hostname)) throw new Error("Remote Chat Completions endpoints require HTTPS; use a literal loopback address for local HTTP");
  const normalized = baseUrl.replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(normalized) ? normalized : `${normalized}/chat/completions`;
}

function bearer(environment?: Record<string, string | undefined>): string {
  const key = environment?.OPENAI_API_KEY ?? environment?.CODEX_API_KEY ?? environment?.AGENTHUB_API_KEY;
  return key ? `Bearer ${key}` : "";
}

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
