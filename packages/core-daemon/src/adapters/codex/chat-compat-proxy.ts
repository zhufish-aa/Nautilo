import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentInstance } from "@agenthub/domain";
import type { ProcessHandle } from "../../process-runtime.js";
import type { AdapterEvent, AdapterResumeRequest, AdapterRun, AdapterStartRequest } from "../types.js";
import { startCodexAppServer } from "./app-server-run.js";

type RecordValue = Record<string, unknown>;
type ChatContent = string | Array<RecordValue>;

interface ChatCompatProxy {
  baseUrl: string;
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
  arguments: string;
  outputIndex: number;
  started: boolean;
}

/**
 * Runs the real Codex app-server behind a local Responses-to-Chat shim. This
 * is needed because recent Codex versions reject `wire_api = "chat"`, while
 * many OpenAI-compatible relays only expose `/chat/completions`.
 */
export function startCodexChatCompatAppServer(
  request: AdapterStartRequest | AdapterResumeRequest,
  resume: boolean
): AdapterRun {
  let proxy: ChatCompatProxy | undefined;
  let inner: AdapterRun | undefined;
  let cancelled = false;
  let eventsStarted = false;

  const events = async function* (): AsyncGenerator<AdapterEvent> {
    eventsStarted = true;
    try {
      const remoteBaseUrl = configuredBaseUrl(request.instance);
      if (!remoteBaseUrl) throw new Error("Chat Completions compatibility mode needs a configured API base URL");
      proxy = await startChatCompatProxy({
        remoteBaseUrl,
        environment: request.env,
        allowNativeWebSearch: request.instance.providerOptions?.webSearchMode === "native"
      });
      if (cancelled) return;

      const instance: AgentInstance = {
        ...request.instance,
        providerOptions: {
          ...request.instance.providerOptions,
          baseUrl: proxy.baseUrl,
          wireApi: "responses",
          webSearch: request.instance.providerOptions?.webSearchMode === "native",
          webSearchMode: request.instance.providerOptions?.webSearchMode === "native" ? "native" : "off"
        }
      };
      inner = startCodexAppServer({ ...request, instance }, resume);
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
      if (!inner?.steer) throw new Error("Chat Completions compatibility mode does not support steering before the Codex turn starts");
      await inner.steer(input);
    },
    write: process.write
  };
}

export async function startChatCompatProxy(config: ChatCompatConfig): Promise<ChatCompatProxy> {
  const server = createServer((request, response) => {
    void handleProxyRequest(request, response, config).catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      writeJsonError(response, 502, error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
    const onListening = (): void => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

async function handleProxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ChatCompatConfig
): Promise<void> {
  if (request.method !== "POST" || !/\/responses\/?$/i.test(request.url ?? "")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Responses compatibility endpoint not found", type: "invalid_request_error" } }));
    return;
  }
  const input = JSON.parse(await readRequestBody(request)) as RecordValue;
  const chatRequest = responsesToChatRequest(input, config.allowNativeWebSearch === true);
  const remoteResponse = await fetch(chatEndpoint(config.remoteBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: request.headers.authorization || bearer(config.environment)
    },
    body: JSON.stringify(chatRequest)
  });
  if (!remoteResponse.ok) {
    const detail = (await remoteResponse.text()).slice(-4_000);
    writeJsonError(response, remoteResponse.status, `Chat Completions upstream failed (${remoteResponse.status}): ${detail}`);
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
  if (input.tool_choice !== undefined) request.tool_choice = input.tool_choice;
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
    if (type === "function_call") {
      flushText();
      pendingToolCalls.push({
        id: stringValue(item.call_id) ?? stringValue(item.id) ?? randomUUID(),
        type: "function",
        function: { name: stringValue(item.name) ?? "function", arguments: stringValue(item.arguments) ?? "{}" }
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
    if (tool.type === "web_search_preview" || tool.type === "web_search") return [];
    return [];
  });
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
      for (const toolCall of toolCallValue) appendFunctionCallDelta(response, context, toolCall);
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
    writeEvent(response, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: call.itemId,
      output_index: call.outputIndex,
      arguments: call.arguments
    });
    writeEvent(response, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: call.outputIndex,
      item: {
        id: call.itemId,
        type: "function_call",
        status: "completed",
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments
      }
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
    ...toolCalls.map((call) => ({
      id: call.itemId,
      type: "function_call",
      status: "completed",
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments
    })),
    ...(message ? [message] : [])
  ];
  writeEvent(response, "response.completed", {
    type: "response.completed",
    response: responseObject(context, "completed")
  });
  response.end();
}

function appendFunctionCallDelta(response: ServerResponse, context: ResponseContext, value: unknown): void {
  const raw = asRecord(value);
  if (!raw) return;
  const functionValue = asRecord(raw.function);
  const index = numberValue(raw.index) ?? context.toolCalls.size;
  let call = context.toolCalls.get(index);
  if (!call) {
    call = {
      index,
      itemId: `fc-${randomUUID()}`,
      callId: stringValue(raw.id) ?? `call-${randomUUID()}`,
      name: stringValue(functionValue?.name) ?? "function",
      arguments: "",
      outputIndex: (context.reasoningStarted ? 1 : 0) + context.toolCalls.size,
      started: false
    };
    context.toolCalls.set(index, call);
  }
  if (stringValue(raw.id)) call.callId = stringValue(raw.id)!;
  if (stringValue(functionValue?.name)) call.name = stringValue(functionValue?.name)!;
  if (!call.started) {
    call.started = true;
    writeEvent(response, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: call.outputIndex,
      item: {
        id: call.itemId,
        type: "function_call",
        status: "in_progress",
        call_id: call.callId,
        name: call.name,
        arguments: ""
      }
    });
  }
  const argumentDelta = stringValue(functionValue?.arguments);
  if (!argumentDelta) return;
  call.arguments += argumentDelta;
  writeEvent(response, "response.function_call_arguments.delta", {
    type: "response.function_call_arguments.delta",
    item_id: call.itemId,
    output_index: call.outputIndex,
    delta: argumentDelta
  });
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
    yield await response.json() as RecordValue;
    return;
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const next = await reader.read();
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
    reader.releaseLock();
  }
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
