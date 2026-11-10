import { createServer, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

type Obj = Record<string, any>;
const LIMIT = 20 * 1024 * 1024;
const THINKING_PREFIX = "nautilo-anthropic-v1:";
const obj = (v: unknown): Obj => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected an object");
  return v as Obj;
};
const unsupported = (what: string): never => { throw new Error(`Anthropic compatibility does not support ${what}`); };
interface Tool { name: string; namespace?: string; custom: boolean; }

/** Pure, deliberately conservative Responses -> Messages translation. No provider SDK or credentials. */
export function responsesToAnthropicRequest(input: Obj): { request: Obj; tools: Map<string, Tool> } {
  if (typeof input.model !== "string" || !input.model.trim()) throw new Error("Model is required");
  if (input.stream === false) unsupported("non-streaming responses");
  if (input.truncation && input.truncation !== "disabled") unsupported("automatic truncation");
  if (input.service_tier && input.service_tier !== "auto") unsupported("service tier");
  if (input.previous_response_id) unsupported("previous_response_id; send full conversation history");
  if (input.text?.format && input.text.format.type !== "text") unsupported("structured output");
  if (input.store === true || input.background === true) unsupported("stored/background responses");
  const registry = new Map<string, Tool>();
  const tools: Obj[] = [];
  const addTool = (raw: unknown, namespace?: string) => {
    const t = obj(raw);
    if (t.type !== "function" && t.type !== "custom") unsupported(`tool type ${t.type}`);
    if (typeof t.name !== "string" || !t.name) throw new Error("Tool name is required");
    const name = namespace ? `${namespace}__${t.name}` : t.name;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name) || registry.has(name)) throw new Error("Invalid or colliding tool name");
    registry.set(name, { name: t.name, namespace, custom: t.type === "custom" && !namespace });
    const grammar = t.format?.definition;
    tools.push({ name, description: [t.description, grammar ? `Freeform input must follow this grammar:\n${grammar}` : undefined].filter(Boolean).join("\n"), input_schema: t.type === "custom" ? { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false } : t.parameters ?? { type: "object", properties: {} } });
  };
  for (const raw of input.tools ?? []) {
    const t = obj(raw);
    if (t.type === "namespace") {
      if (typeof t.name !== "string" || !Array.isArray(t.tools)) throw new Error("Invalid tool namespace");
      for (const sub of t.tools) addTool(sub, t.name);
    } else addTool(t);
  }
  const system: Obj[] = [];
  if (input.instructions) system.push({ type: "text", text: String(input.instructions) });
  const messages: Obj[] = [];
  const append = (role: string, content: Obj[]) => {
    if (!content.length) return;
    if (role === "system" || role === "developer") { system.push(...content); return; }
    if (role !== "user" && role !== "assistant") unsupported(`role ${role}`);
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...content); else messages.push({ role, content });
  };
  const content = (value: unknown): Obj[] => {
    if (typeof value === "string") return [{ type: "text", text: value }];
    if (!Array.isArray(value)) throw new Error("Invalid message content");
    return value.map(raw => {
      const p = obj(raw);
      if (["input_text", "output_text", "text"].includes(p.type) && typeof p.text === "string") return { type: "text", text: p.text };
      return unsupported(`content type ${p.type}`);
    });
  };
  const items = typeof input.input === "string" ? [{ role: "user", content: input.input }] : input.input;
  if (!Array.isArray(items)) throw new Error("input must be a string or array");
  for (const raw of items) {
    const i = obj(raw);
    if (i.type === "function_call" || i.type === "custom_tool_call") {
      const name = i.namespace ? `${i.namespace}__${i.name}` : i.name;
      if (!registry.has(name)) throw new Error("Unknown historical tool name");
      const args = i.type === "custom_tool_call" ? { input: i.input } : obj(JSON.parse(i.arguments));
      if (typeof i.call_id !== "string") throw new Error("Tool call ID is required");
      append("assistant", [{ type: "tool_use", id: i.call_id, name, input: args }]);
    } else if (i.type === "function_call_output" || i.type === "custom_tool_call_output") {
      if (typeof i.call_id !== "string") throw new Error("Tool result call ID is required");
      append("user", [{ type: "tool_result", tool_use_id: i.call_id, content: content(i.output), ...(i.is_error === true ? { is_error: true } : {}) }]);
    } else if (i.type === "reasoning" && typeof i.encrypted_content === "string" && i.encrypted_content.startsWith(THINKING_PREFIX)) {
      const block = obj(JSON.parse(Buffer.from(i.encrypted_content.slice(THINKING_PREFIX.length), "base64").toString("utf8")));
      if (block.type !== "thinking" && block.type !== "redacted_thinking") unsupported("foreign reasoning history");
      append("assistant", [block]);
    } else if (i.role && (!i.type || i.type === "message")) append(i.role, content(i.content));
    else unsupported(`input item ${i.type}`);
  }
  if (!messages.length) throw new Error("At least one message is required");
  const max = input.max_output_tokens ?? 4096;
  if (!Number.isInteger(max) || max <= 0) throw new Error("max_output_tokens must be positive");
  const request: Obj = { model: input.model, messages, max_tokens: max, stream: true };
  if (input.reasoning?.effort && input.reasoning.effort !== "none") request.output_config = { effort: input.reasoning.effort };
  if (system.length) request.system = system;
  if (tools.length) request.tools = tools;
  for (const k of ["temperature", "top_p"]) if (input[k] !== undefined) request[k] = input[k];
  const choice = input.tool_choice;
  if (choice === "auto" || choice === "required" || choice === "none") request.tool_choice = { type: choice === "required" ? "any" : choice };
  else if (choice !== undefined) {
    const c = obj(choice);
    if (c.type !== "function" && c.type !== "custom") unsupported("tool choice");
    const name = c.namespace ? `${c.namespace}__${c.name}` : c.name;
    if (!registry.has(name)) throw new Error("Unknown selected tool");
    request.tool_choice = { type: "tool", name };
  }
  if (input.parallel_tool_calls === false && tools.length) request.tool_choice = { ...(request.tool_choice ?? { type: "auto" }), disable_parallel_tool_use: true };
  return { request, tools: registry };
}

export function anthropicEndpoint(base: string): string {
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid Anthropic base URL");
  if (url.protocol === "http:" && !["127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Remote Anthropic endpoints require HTTPS");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/messages") ? path : path.endsWith("/v1") ? `${path}/messages` : `${path}/v1/messages`;
  return url.toString();
}

/** Each listener belongs to one invocation and requires a non-provider capability. */
export async function startAnthropicCompatProxy(config: { remoteBaseUrl: string; environment?: Record<string, string | undefined> }) {
  const endpoint = anthropicEndpoint(config.remoteBaseUrl);
  const apiKey = config.environment?.ANTHROPIC_API_KEY ?? config.environment?.OPENAI_API_KEY ?? config.environment?.CODEX_API_KEY ?? config.environment?.AGENTHUB_API_KEY;
  if (!apiKey) throw new Error("Anthropic compatibility needs an explicit API key");
  const token = randomBytes(32).toString("hex");
  const controllers = new Set<AbortController>();
  const server = createServer((req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    res.on("close", () => controller.abort());
    void (async () => {
      const supplied = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return; }
      if (req.method !== "POST" || req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
      if (Number(req.headers["content-length"]) > LIMIT) { res.writeHead(413, { connection: "close" }).end(); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > LIMIT) { res.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      let translated: ReturnType<typeof responsesToAnthropicRequest>;
      try { translated = responsesToAnthropicRequest(obj(JSON.parse(Buffer.concat(chunks).toString("utf8")))); }
      catch (e) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "invalid_request_error", message: (e as Error).message } })); return; }
      const upstream = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify(translated.request), redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]) });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        res.writeHead(upstream.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `Anthropic upstream failed (${upstream.status})` } }));
        return;
      }
      if (!upstream.headers.get("content-type")?.includes("text/event-stream") || !upstream.body) throw new Error("Expected Anthropic event stream");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      await translateStream(upstream.body, res, translated.tools, translated.request.model);
      res.end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Anthropic protocol bridge failed" } }));
      else if (!res.destroyed) { emit(res, "response.failed", { response: { status: "failed", error: { code: "upstream_error", message: "Anthropic stream failed or was incomplete" } } }); res.end(); }
    }).finally(() => { controller.abort(); controllers.delete(controller); });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let closing: Promise<void> | undefined;
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, token,
    close: () => closing ??= new Promise<void>(resolve => { for (const c of controllers) c.abort(); server.close(() => resolve()); server.closeAllConnections(); }) };
}

function emit(res: ServerResponse, type: string, fields: Obj) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`); }

async function translateStream(body: ReadableStream<Uint8Array>, res: ServerResponse, tools: Map<string, Tool>, model: string) {
  const response: Obj = { id: `resp_${randomUUID()}`, object: "response", model, created_at: Math.floor(Date.now() / 1000), status: "in_progress", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, error: null, incomplete_details: null };
  const blocks = new Map<number, { item: Obj; index: number; args: string; custom: boolean; stopped: boolean; native?: Obj }>();
  let started = false, stopped = false, stopReason = "";
  emit(res, "response.created", { response });
  for await (const event of sse(body)) {
    if (event.type === "ping") continue;
    if (event.type === "error") throw new Error("Upstream error");
    if (event.type === "message_start") {
      if (started) throw new Error("Duplicate message start");
      started = true;
      const u = event.message?.usage ?? {};
      response.usage.input_tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      response.usage.input_tokens_details = { cached_tokens: u.cache_read_input_tokens ?? 0 };
    } else if (event.type === "content_block_start") {
      if (!started || blocks.has(event.index)) throw new Error("Invalid block start");
      if (!Number.isInteger(event.index) || event.index < 0) throw new Error("Invalid block index");
      const b = obj(event.content_block);
      if (b.type === "text" && typeof b.text !== "string") throw new Error("Invalid text block");
      if (b.type === "tool_use" && (typeof b.id !== "string" || !b.id)) throw new Error("Invalid tool call ID");
      const index = response.output.length;
      let item!: Obj;
      let custom = false;
      if (b.type === "text") item = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", status: "in_progress", content: [{ type: "output_text", text: b.text ?? "", annotations: [] }] };
      else if (b.type === "thinking" || b.type === "redacted_thinking") item = { id: `rs_${randomUUID()}`, type: "reasoning", status: "in_progress", summary: b.type === "thinking" ? [{ type: "summary_text", text: b.thinking ?? "" }] : [] };
      else if (b.type === "tool_use") {
        const tool = tools.get(b.name);
        if (!tool) throw new Error("Upstream called unknown tool");
        custom = tool.custom;
        item = { id: `fc_${randomUUID()}`, type: custom ? "custom_tool_call" : "function_call", call_id: b.id, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), status: "in_progress", ...(custom ? { input: "" } : { arguments: "" }) };
      } else unsupported(`upstream block ${b.type}`);
      response.output.push(item);
      blocks.set(event.index, { item, index, args: b.type === "tool_use" && Object.keys(b.input ?? {}).length ? JSON.stringify(b.input) : "", custom, stopped: false, ...(item.type === "reasoning" ? { native: { ...b } } : {}) });
      emit(res, "response.output_item.added", { output_index: index, item });
      if (item.type === "message") emit(res, "response.content_part.added", { output_index: index, item_id: item.id, content_index: 0, part: item.content[0] });
      if (item.type === "reasoning" && item.summary.length) emit(res, "response.reasoning_summary_part.added", { output_index: index, item_id: item.id, summary_index: 0, part: item.summary[0] });
    } else if (event.type === "content_block_delta") {
      const b = blocks.get(event.index);
      if (!b || b.stopped) throw new Error("Invalid block delta");
      const d = obj(event.delta);
      if (d.type === "text_delta" && b.item.type === "message") {
        if (typeof d.text !== "string") throw new Error("Invalid text delta");
        b.item.content[0].text += d.text;
        emit(res, "response.output_text.delta", { output_index: b.index, item_id: b.item.id, content_index: 0, delta: d.text });
      } else if (d.type === "thinking_delta" && b.native?.type === "thinking") {
        if (typeof d.thinking !== "string") throw new Error("Invalid thinking delta");
        b.native.thinking = (b.native.thinking ?? "") + d.thinking;
        b.item.summary[0].text = b.native.thinking;
        emit(res, "response.reasoning_summary_text.delta", { output_index: b.index, item_id: b.item.id, summary_index: 0, delta: d.thinking });
      } else if (d.type === "signature_delta" && b.native?.type === "thinking") {
        if (typeof d.signature !== "string") throw new Error("Invalid thinking signature");
        b.native.signature = (b.native.signature ?? "") + d.signature;
      } else if (d.type === "input_json_delta" && ["function_call", "custom_tool_call"].includes(b.item.type)) {
        if (typeof d.partial_json !== "string") throw new Error("Invalid argument delta");
        b.args += d.partial_json;
        if (b.args.length > LIMIT) throw new Error("Tool arguments exceed limit");
        if (!b.custom) emit(res, "response.function_call_arguments.delta", { output_index: b.index, item_id: b.item.id, delta: d.partial_json });
      } else unsupported(`upstream delta ${d.type}`);
    } else if (event.type === "content_block_stop") {
      const b = blocks.get(event.index);
      if (!b || b.stopped) throw new Error("Invalid block stop");
      b.stopped = true;
      b.item.status = "completed";
      const fields = { output_index: b.index, item_id: b.item.id };
      if (b.item.type === "message") {
        emit(res, "response.output_text.done", { ...fields, content_index: 0, text: b.item.content[0].text });
        emit(res, "response.content_part.done", { ...fields, content_index: 0, part: b.item.content[0] });
      } else if (b.native) {
        // Keep the provider's signed block opaque so a later tool-result turn
        // can replay it byte-for-byte rather than forge a thinking signature.
        b.item.encrypted_content = THINKING_PREFIX + Buffer.from(JSON.stringify(b.native)).toString("base64");
        if (b.item.summary.length) {
          emit(res, "response.reasoning_summary_text.done", { ...fields, summary_index: 0, text: b.item.summary[0].text });
          emit(res, "response.reasoning_summary_part.done", { ...fields, summary_index: 0, part: b.item.summary[0] });
        }
      } else {
        const args = obj(JSON.parse(b.args || "{}"));
        if (b.custom) {
          if (typeof args.input !== "string") throw new Error("Custom tool requires string input");
          b.item.input = args.input;
          emit(res, "response.custom_tool_call_input.delta", { ...fields, delta: args.input });
          emit(res, "response.custom_tool_call_input.done", { ...fields, input: args.input });
        } else { b.item.arguments = JSON.stringify(args); emit(res, "response.function_call_arguments.done", { ...fields, arguments: b.item.arguments }); }
      }
      emit(res, "response.output_item.done", { output_index: b.index, item: b.item });
    } else if (event.type === "message_delta") {
      stopReason = event.delta?.stop_reason ?? stopReason;
      response.usage.output_tokens = event.usage?.output_tokens ?? response.usage.output_tokens;
    } else if (event.type === "message_stop") { stopped = true; break; }
    else unsupported(`upstream event ${event.type}`);
  }
  if (!response.output.some((item: Obj) => item.type !== "message" || item.content[0].text)) throw new Error("Empty upstream response");
  if (!started || !stopped || !stopReason || [...blocks.values()].some(b => !b.stopped)) throw new Error("Truncated stream");
  if (!["end_turn", "tool_use", "stop_sequence", "max_tokens"].includes(stopReason)) throw new Error("Unsupported stop reason");
  response.usage.total_tokens = response.usage.input_tokens + response.usage.output_tokens;
  response.status = stopReason === "max_tokens" ? "incomplete" : "completed";
  response.incomplete_details = stopReason === "max_tokens" ? { reason: "max_output_tokens" } : null;
  emit(res, `response.${response.status}`, { response });
}

async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<Obj> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "", total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      total += value?.length ?? 0;
      if (total > LIMIT) throw new Error("Upstream exceeds size limit");
      pending += decoder.decode(value, { stream: !done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
        if (data) yield obj(JSON.parse(data));
      }
      if (done) break;
    }
    if (pending.trim()) throw new Error("Incomplete SSE frame");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
