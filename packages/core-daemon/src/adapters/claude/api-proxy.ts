import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AdapterStartRequest } from "../types.js";

type Json = Record<string, any>;
const text = (value: any): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(part => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n") : "";

const REASONING_SIGNATURE = "nautilo-responses-v1:";
export function messagesToChat(input: Json, model?: string, effort?: string, preserveReasoning = false): Json {
  const messages: Json[] = [];
  if (text(input.system)) messages.push({ role: "system", content: text(input.system) });
  for (const message of input.messages ?? []) {
    if (typeof message.content === "string") { messages.push({ role: message.role, content: message.content }); continue; }
    const content: Json[] = [], calls: Json[] = [], results: Json[] = [];
    let reasoning = "";
    const preserved: Json[] = [];
    for (const part of message.content ?? []) {
      if (part.type === "text") content.push({ type: "text", text: part.text });
      if (part.type === "image") content.push({ type: "image_url", image_url: { url: part.source?.type === "base64" ? `data:${part.source.media_type};base64,${part.source.data}` : part.source?.url } });
      if (part.type === "thinking") {
        reasoning += part.thinking ?? "";
        if (preserveReasoning && part.signature?.startsWith(REASONING_SIGNATURE)) {
          const item = JSON.parse(Buffer.from(part.signature.slice(REASONING_SIGNATURE.length), "base64").toString("utf8"));
          if (item.type === "reasoning") preserved.push(item);
        }
      }
      if (part.type === "tool_use") calls.push({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } });
      if (part.type === "tool_result") results.push({ role: "tool", tool_call_id: part.tool_use_id, content: text(part.content) });
    }
    if (content.length || calls.length || reasoning || preserved.length) messages.push({ role: message.role, content: content.length ? content : null, ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}), ...(preserved.length ? { _nautiloReasoning: preserved } : {}) });
    messages.push(...results);
  }
  return {
    model: model ?? input.model, messages, stream: input.stream === true,
    ...(input.max_tokens ? { max_tokens: input.max_tokens } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(input.tools?.length ? { tools: input.tools.map((tool: Json) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })) } : {}),
    ...(input.tool_choice?.type === "any" ? { tool_choice: "required" } : input.tool_choice?.type === "tool" ? { tool_choice: { type: "function", function: { name: input.tool_choice.name } } } : {}),
  };
}
function chatToResponses(chat: Json): Json {
  const input: Json[] = [], instructions: string[] = [];
  for (const message of chat.messages) {
    if (message.role === "system") { instructions.push(text(message.content)); continue; }
    if (message.role === "tool") { input.push({ type: "function_call_output", call_id: message.tool_call_id, output: text(message.content) }); continue; }
    input.push(...(message._nautiloReasoning ?? []));
    if (message.content) input.push({ role: message.role, content: Array.isArray(message.content) ? message.content.map((part: Json) => part.type === "image_url"
      ? { type: "input_image", image_url: part.image_url.url }
      : { type: message.role === "assistant" ? "output_text" : "input_text", text: part.text }) : message.content });
    for (const call of message.tool_calls ?? []) input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  return { model: chat.model, input, instructions: instructions.join("\n"), stream: chat.stream,
    ...(chat.max_tokens ? { max_output_tokens: chat.max_tokens } : {}),
    ...(chat.reasoning_effort ? { reasoning: { effort: chat.reasoning_effort, ...(chat.reasoning_effort !== "none" ? { summary: "auto" } : {}) } } : {}),
    include: ["reasoning.encrypted_content"],
    ...(chat.tool_choice ? { tool_choice: typeof chat.tool_choice === "string" ? chat.tool_choice : { type: "function", name: chat.tool_choice.function.name } } : {}),
    ...(chat.tools ? { tools: chat.tools.map((tool: Json) => ({ type: "function", ...tool.function })) } : {}),
  };
}
export function nativeMessage(reply: Json, responses: boolean, model: string): Json {
  const content: Json[] = [];
  let stop_reason = "end_turn";
  if (responses) {
    for (const item of reply.output ?? []) {
      if (item.type === "reasoning") content.push({ type: "thinking", thinking: (item.summary ?? []).map((part: Json) => part.text ?? "").join("\n"), signature: REASONING_SIGNATURE + Buffer.from(JSON.stringify(item)).toString("base64") });
      if (item.type === "message") for (const part of item.content ?? []) if (part.text) content.push({ type: "text", text: part.text });
      if (item.type === "function_call") { stop_reason = "tool_use"; content.push({ type: "tool_use", id: item.call_id, name: item.name, input: JSON.parse(item.arguments || "{}") }); }
    }
  } else {
    const message = reply.choices?.[0]?.message;
    if (!message) throw new Error("The selected API returned no assistant message");
    if (message.reasoning_content || message.reasoning) content.push({ type: "thinking", thinking: message.reasoning_content ?? message.reasoning, signature: "" });
    if (text(message.content)) content.push({ type: "text", text: text(message.content) });
    for (const call of message.tool_calls ?? []) { stop_reason = "tool_use"; content.push({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || "{}") }); }
    if (reply.choices[0].finish_reason === "length") stop_reason = "max_tokens";
  }
  const cached = reply.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const usage = responses ? { input_tokens: reply.usage?.input_tokens, output_tokens: reply.usage?.output_tokens }
    : { input_tokens: typeof reply.usage?.prompt_tokens === "number" ? Math.max(0, reply.usage.prompt_tokens - cached) : undefined, output_tokens: reply.usage?.completion_tokens, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
  return { id: reply.id ?? `msg_${randomUUID()}`, type: "message", role: "assistant", model, content, stop_reason, stop_sequence: null, usage };
}
function events(message: Json): string {
  const frames: Json[] = [{ type: "message_start", message: { ...message, content: [], stop_reason: null } }];
  message.content.forEach((block: Json, index: number) => {
    frames.push({ type: "content_block_start", index, content_block: block.type === "tool_use" ? { ...block, input: {} } : block.type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { ...block, text: "" } });
    frames.push({ type: "content_block_delta", index, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : block.type === "thinking" ? { type: "thinking_delta", thinking: block.thinking } : { type: "text_delta", text: block.text } });
    if (block.type === "thinking" && block.signature) frames.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    frames.push({ type: "content_block_stop", index });
  });
  frames.push({ type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage }, { type: "message_stop" });
  return frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
}

/** Incremental conversion: never waits for the final upstream response. */
export class NativeMessageStream {
  private blocks = new Map<string, { index: number; type: string; value: string; signature?: boolean }>();
  private calls = new Map<string, { id: string; name: string; arguments: string; sent: string }>();
  private outputIds = new Map<number, string>();
  private frames: Json[] = [];
  private started = false;
  private terminal = false;
  private stop = "end_turn";
  private usage: Json = { input_tokens: 0, output_tokens: 0 };
  constructor(private responses: boolean, private model: string) {}
  private begin(): void {
    if (this.started) return;
    this.started = true;
    this.frames.push({ type: "message_start", message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: this.usage } });
  }
  private block(key: string, type: string, extra: Json = {}): number {
    this.begin();
    let block = this.blocks.get(key);
    if (!block) {
      block = { index: this.blocks.size, type, value: "" }; this.blocks.set(key, block);
      this.frames.push({ type: "content_block_start", index: block.index, content_block: type === "tool_use" ? { type, ...extra, input: {} } : type === "thinking" ? { type, thinking: "", signature: "" } : { type, text: "" } });
    }
    return block.index;
  }
  private delta(key: string, type: string, value: string): void {
    if (!value) return;
    const index = this.block(key, type); this.blocks.get(key)!.value += value;
    this.frames.push({ type: "content_block_delta", index, delta: type === "thinking" ? { type: "thinking_delta", thinking: value } : { type: "text_delta", text: value } });
  }
  private full(key: string, type: string, value: string): void {
    const sent = this.blocks.get(key)?.value ?? "";
    if (value.startsWith(sent)) this.delta(key, type, value.slice(sent.length));
  }
  private tool(key: string, id?: string, name?: string, args = "", full = false): void {
    let call = this.calls.get(key);
    if (!call) { call = { id: "", name: "", arguments: "", sent: "" }; this.calls.set(key, call); }
    if (id) call.id = id;
    if (name) call.name = full ? name : call.name + name;
    call.arguments = full ? args : call.arguments + args;
    if (!call.name || !call.id) return;
    const index = this.block(key, "tool_use", { id: call.id, name: call.name });
    if (!call.arguments.startsWith(call.sent)) throw new Error("The API changed streamed tool arguments");
    const delta = call.arguments.slice(call.sent.length); call.sent = call.arguments;
    if (delta) this.frames.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: delta } });
    this.stop = "tool_use";
  }
  private item(item: Json, fallback: string): void {
    const id = item.id ?? fallback;
    if (item.type === "message") (item.content ?? []).forEach((part: Json, index: number) => this.full(`text:${id}:${index}`, "text", part.text ?? part.refusal ?? ""));
    if (item.type === "function_call") this.tool(`tool:${id}`, item.call_id, item.name, item.arguments ?? "", true);
    if (item.type === "reasoning") {
      const summaries = item.summary ?? [];
      summaries.forEach((part: Json, index: number) => this.full(`thinking:${id}:${index}`, "thinking", part.text ?? ""));
      const key = `thinking:${id}:${Math.max(0, summaries.length - 1)}`;
      const index = this.block(key, "thinking");
      if (!this.blocks.get(key)!.signature) {
        this.blocks.get(key)!.signature = true;
        this.frames.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: REASONING_SIGNATURE + Buffer.from(JSON.stringify(item)).toString("base64") } });
      }
    }
  }
  event(value: Json): Json[] {
    this.frames = []; this.begin();
    if (value.error || value.type === "error" || value.type === "response.failed") throw new Error(value.error?.message ?? value.response?.error?.message ?? "The selected API stream failed");
    if (!this.responses) {
      const choice = value.choices?.[0], delta = choice?.delta ?? {};
      this.delta("thinking", "thinking", delta.reasoning_content ?? delta.reasoning ?? "");
      this.delta("text", "text", text(delta.content));
      for (const call of delta.tool_calls ?? []) this.tool(`tool:${call.index ?? 0}`, call.id, call.function?.name, call.function?.arguments ?? "");
      if (choice?.finish_reason) { this.terminal = true; this.stop = choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "tool_calls" ? "tool_use" : this.stop; }
      if (value.usage) this.usage = nativeMessage({ choices: [{ message: {} }], usage: value.usage }, false, this.model).usage;
    } else {
      const id = value.item_id ?? this.outputIds.get(value.output_index) ?? `out_${value.output_index ?? 0}`;
      switch (value.type) {
        case "response.output_item.added": this.outputIds.set(value.output_index, value.item.id ?? id); break;
        case "response.output_text.delta": case "response.refusal.delta": this.delta(`text:${id}:${value.content_index ?? 0}`, "text", value.delta); break;
        case "response.output_text.done": this.full(`text:${id}:${value.content_index ?? 0}`, "text", value.text ?? ""); break;
        case "response.reasoning_summary_text.delta": case "response.reasoning_text.delta": this.delta(`thinking:${id}:${value.summary_index ?? 0}`, "thinking", value.delta); break;
        case "response.function_call_arguments.delta": {
          this.tool(`tool:${id}`, undefined, undefined, value.delta); break;
        }
        case "response.function_call_arguments.done": this.tool(`tool:${id}`, undefined, undefined, value.arguments ?? "", true); break;
        case "response.output_item.done": this.item(value.item, id); break;
        case "response.completed": case "response.incomplete": {
          if (value.type === "response.incomplete" && value.response?.incomplete_details?.reason !== "max_output_tokens") throw new Error("The API response did not complete");
          (value.response?.output ?? []).forEach((item: Json, index: number) => this.item(item, this.outputIds.get(index) ?? `out_${index}`));
          const usage = value.response?.usage ?? {}, cached = usage.input_tokens_details?.cached_tokens ?? 0;
          this.usage = { input_tokens: Math.max(0, (usage.input_tokens ?? 0) - cached), output_tokens: usage.output_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
          this.terminal = true; if (value.type === "response.incomplete") this.stop = "max_tokens";
        }
      }
      if (value.type === "response.output_item.added" && value.item.type === "function_call") this.tool(`tool:${value.item.id ?? id}`, value.item.call_id, value.item.name, value.item.arguments ?? "", true);
    }
    return this.frames;
  }
  finish(): Json[] {
    if (!this.terminal) throw new Error("The selected API stream ended before completion");
    for (const call of this.calls.values()) if (!call.name || !call.id) throw new Error("The API returned an incomplete tool call");
    return [...[...this.blocks.values()].map(block => ({ type: "content_block_stop", index: block.index })),
      { type: "message_delta", delta: { stop_reason: this.stop, stop_sequence: null }, usage: this.usage }, { type: "message_stop" }];
  }
}

async function* readEvents(response: Response): AsyncGenerator<Json> {
  if (!response.body) throw new Error("The API stream has no response body");
  const decoder = new TextDecoder(); let buffer = "";
  for await (const chunk of response.body as any) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer); if (!match) break;
      const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (data === "[DONE]") return;
      if (!data) continue;
      yield JSON.parse(data);
    }
    if (buffer.length > 16 * 1024 * 1024) throw new Error("The API stream event exceeds the size limit");
  }
  if (buffer.trim()) throw new Error("The API stream ended inside an event");
}

export async function startClaudeApiProxy(request: AdapterStartRequest): Promise<{ env: Record<string, string | undefined>; close(): Promise<void> } | undefined> {
  const options = request.instance.providerOptions;
  if (!options?.runtimeConnectionId) return undefined;
  const original = { ...request.env };
  if (request.model) for (const name of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) original[name] = request.model;
  request.env = original;
  if (options.apiType === "anthropic-messages") {
    request.env = { ...original, ANTHROPIC_BASE_URL: String(options.baseUrl).replace(/\/+$/, "").replace(/\/v1$/, ""), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
    return undefined;
  }
  const key = original.NAUTILO_CONNECTION_API_KEY;
  if (!key) throw new Error("The selected API connection has no credential");
  const capability = randomUUID();
  const base = String(options.baseUrl).replace(/\/+$/, "");
  const responses = options.apiType === "openai-responses";
  const active = new Set<AbortController>();
  const server = createServer((incoming, outgoing) => { void (async () => {
    const path = incoming.url?.split("?")[0];
    const error = (status: number, message: string) => { outgoing.writeHead(status, { "content-type": "application/json" }); outgoing.end(JSON.stringify({ type: "error", error: { type: "api_error", message: message.split(key).join("[redacted]") } })); };
    if (!path?.startsWith(`/${capability}/`)) { error(404, "Unknown endpoint"); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of incoming) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) { error(413, "Request is too large"); return; } chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (path.endsWith("/count_tokens")) { outgoing.writeHead(200, { "content-type": "application/json" }); outgoing.end(JSON.stringify({ input_tokens: Math.max(1, Math.ceil(bytes / 4)) })); return; }
    if (!path.endsWith("/messages")) { error(404, "Unknown endpoint"); return; }
    const controller = new AbortController(); active.add(controller);
    outgoing.once("close", () => controller.abort());
    try {
      const chat = messagesToChat(input, request.model, request.reasoningEffort, responses);
      const suffix = responses ? "/responses" : "/chat/completions";
      const upstream = await fetch(base.endsWith(suffix) ? base : base + suffix, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(responses ? chatToResponses(chat) : chat), signal: controller.signal });
      if (!upstream.ok) { error(upstream.status, await upstream.text()); return; }
      if (input.stream && upstream.headers.get("content-type")?.includes("text/event-stream")) {
        outgoing.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); outgoing.flushHeaders();
        const stream = new NativeMessageStream(responses, chat.model);
        const write = (frame: Json): Promise<void> => new Promise((resolve, reject) => outgoing.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`, error => error ? reject(error) : resolve()));
        try {
          for await (const event of readEvents(upstream)) for (const frame of stream.event(event)) await write(frame);
          for (const frame of stream.finish()) await write(frame);
        } catch (failure) {
          if (!outgoing.destroyed) await write({ type: "error", error: { type: "api_error", message: String(failure instanceof Error ? failure.message : failure).split(key).join("[redacted]") } });
        }
        outgoing.end(); return;
      }
      const message = nativeMessage(await upstream.json() as Json, responses, chat.model);
      outgoing.writeHead(200, { "content-type": input.stream ? "text/event-stream" : "application/json" });
      outgoing.end(input.stream ? events(message) : JSON.stringify(message));
    } catch { if (!outgoing.destroyed) error(502, "Unable to complete the request to the selected API endpoint"); }
    finally { active.delete(controller); }
  })().catch(() => { if (!outgoing.headersSent) outgoing.writeHead(400); outgoing.end(); }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("API bridge could not allocate a port");
  const env = Object.fromEntries(Object.entries(original).map(([name, value]) => [name, value === key ? capability : value]));
  for (const name of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH)/.test(name)) delete env[name];
  return { env: { ...env, ...(request.model ? { NAUTILO_BRIDGE_MODEL: request.model } : {}), ...(request.reasoningEffort ? { NAUTILO_BRIDGE_EFFORT: request.reasoningEffort } : {}), ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/${capability}`, ANTHROPIC_API_KEY: capability, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, close: async () => {
    for (const controller of active) controller.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
