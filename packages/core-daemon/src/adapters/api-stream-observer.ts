import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { AsyncQueue } from "./async-queue.js";
import type { AdapterEvent, AdapterRun, AdapterStartRequest } from "./types.js";

type Json = Record<string, any>;

/** Observe the selected wire without replacing the native agent loop. Some
 * CLIs omit thinking and buffer text in headless mode; their API still streams.
 * Non-streaming native callers receive the complete original protocol reply. */
export async function startApiStreamObserver(request: AdapterStartRequest): Promise<{ close(): Promise<void>; wrap(run: AdapterRun): AdapterRun } | undefined> {
  if (!request.instance.providerOptions?.runtimeConnectionId) return;
  const base = String(request.instance.providerOptions.baseUrl).replace(/\/$/, "");
  const wire = String(request.instance.providerOptions.apiType ?? "openai-completions");
  const key = request.env?.NAUTILO_CONNECTION_API_KEY;
  if (!key) throw new Error("The API connection has no credential");
  const capability = randomUUID();
  const events = new AsyncQueue<AdapterEvent>();
  const observed = { text: false, thinking: false };
  const controllers = new Set<AbortController>();
  let closed = false;
  const suffix = wire === "openai-responses" ? "responses" : wire === "anthropic-messages" ? "messages" : "chat/completions";
  const server = createServer((incoming, outgoing) => { void (async () => {
    if (incoming.url?.split("?")[0] !== `/${capability}/v1/${suffix}`) { outgoing.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of incoming) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new Error("API request exceeds the limit"); chunks.push(Buffer.from(chunk)); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json;
    const streaming = body.stream === true;
    body.stream = true;
    const effort = request.reasoningEffort;
    if (effort) {
      if (wire === "openai-responses") body.reasoning = { ...body.reasoning, effort, ...(!["none", "off"].includes(effort) ? { summary: "auto" } : {}) };
      else if (wire === "anthropic-messages") body.output_config = { ...body.output_config, effort };
      else body.reasoning_effort = effort;
    }
    const controller = new AbortController(); controllers.add(controller);
    outgoing.on("close", () => controller.abort());
    try {
      const response = await fetch(base.endsWith(`/${suffix}`) ? base : `${base}/${suffix}`, {
        method: "POST", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]),
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...(wire === "anthropic-messages" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : {}) }, body: JSON.stringify(body)
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
        const text = (await response.text()).split(key).join("[redacted]");
        outgoing.writeHead(response.status, { "content-type": "application/json" }).end(text); return;
      }
      const capture = new ApiCapture(wire, event => { if (event.kind === "message") observed.text = true; if (event.kind === "thinking") observed.thinking = true; events.push(event); });
      if (streaming) outgoing.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const decoder = new TextDecoder(); let pending = "", data: string[] = [];
      const parse = (line: string): void => {
        if (!line) { if (data.length && data.join("\n") !== "[DONE]") capture.accept(JSON.parse(data.join("\n"))); data = []; }
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      };
      for await (const bytes of response.body!) {
        if (streaming && !outgoing.write(bytes)) await once(outgoing, "drain", { signal: controller.signal });
        pending += decoder.decode(bytes, { stream: true });
        if (pending.length > 32 * 1024 * 1024) throw new Error("API stream frame exceeds the limit");
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, end).replace(/\r$/, ""); pending = pending.slice(end + 1); parse(line); }
      }
      if (!capture.terminal) throw new Error("The API stream ended before its completion event");
      capture.finish();
      if (!streaming) outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(capture.reply()));
      else outgoing.end();
    } finally { controllers.delete(controller); }
  })().catch(error => {
    if (outgoing.destroyed) return;
    if (outgoing.headersSent) outgoing.destroy();
    else outgoing.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: String(error.message ?? error).split(key).join("[redacted]") } }));
  }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start the API observer");
  const local = `http://127.0.0.1:${address.port}/${capability}/v1`;
  request.env = Object.fromEntries(Object.entries(request.env ?? {}).map(([name, value]) => [name, value === key ? capability : value]));
  for (const name of ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"]) if (request.env[name]) request.env[name] = local;
  request.instance = { ...request.instance, providerOptions: { ...request.instance.providerOptions, baseUrl: local } };
  const close = async (): Promise<void> => {
    if (closed) return; closed = true;
    for (const controller of controllers) controller.abort();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); events.close();
  };
  return { close, wrap(run) {
    const output = new AsyncQueue<AdapterEvent>();
    const pump = (async () => { for await (const event of events) output.push(event); })();
    void (async () => {
      try { for await (const event of run.events) {
        if (event.kind === "message" && observed.text || event.kind === "thinking" && observed.thinking) continue;
        output.push(event);
      } } catch(error) { output.push({kind:"error",error:error instanceof Error ? error : new Error(String(error))}); }
      finally { await close(); await pump; output.close(); }
    })();
    return { get process() { return run.process; }, events: output, write: input => run.write(input), steer: run.steer, cancel: async () => { await close(); await run.cancel(); } };
  } };
}

/** Preserve native terminal bodies, signed thinking and tool-call arguments. */
export class ApiCapture {
  terminal = false;
  private result: Json = {};
  private blocks = new Map<number, Json>();
  private args = new Map<number, string>();
  private parts = new Map<string, { thinking: boolean; text: string }>();
  private id = randomUUID();
  constructor(private wire: string, private emit: (event: AdapterEvent) => void) {}
  private delta(key: string, thinking: boolean, text: string): void {
    if (!text) return;
    const part = this.parts.get(key) ?? { thinking, text: "" }; part.text += text; this.parts.set(key, part);
    this.emit({ kind: thinking ? "thinking" : "message", phase: "delta", messageId: `api-${this.id}:${key}`, text });
  }
  private full(key: string, thinking: boolean, text: string): void { const sent = this.parts.get(key)?.text ?? ""; if (text.startsWith(sent)) this.delta(key, thinking, text.slice(sent.length)); }
  accept(event: Json): void {
    if (event.error || ["error", "response.failed", "response.incomplete"].includes(event.type)) throw new Error("The selected API returned a stream error");
    if (this.wire === "openai-responses") {
      if (event.type === "response.output_text.delta") this.delta(`text:${event.item_id}:${event.content_index ?? 0}`, false, event.delta);
      if (event.type === "response.reasoning_summary_text.delta") this.delta(`thought:${event.item_id}:${event.summary_index ?? 0}`, true, event.delta);
      if (event.type === "response.completed") {
        this.result = event.response; this.terminal = true;
        for (const item of this.result.output ?? []) { const thinking = item.type === "reasoning"; for (const [index, part] of (thinking ? item.summary ?? [] : item.content ?? []).entries()) this.full(`${thinking ? "thought" : "text"}:${item.id}:${index}`, thinking, part.text ?? ""); }
      }
    } else if (this.wire === "anthropic-messages") {
      const index = event.index ?? 0;
      if (event.type === "message_start") this.result = event.message;
      if (event.type === "content_block_start") { this.blocks.set(index, { ...event.content_block }); const thinking = event.content_block.type === "thinking"; this.delta(`block:${index}`, thinking, event.content_block[thinking ? "thinking" : "text"] ?? ""); }
      if (event.type === "content_block_delta") {
        const delta = event.delta, block = this.blocks.get(index)!;
        if (["thinking_delta", "text_delta"].includes(delta.type)) { const thinking = delta.type === "thinking_delta", field = thinking ? "thinking" : "text"; this.delta(`block:${index}`, thinking, delta[field] ?? ""); block[field] = (block[field] ?? "") + (delta[field] ?? ""); }
        if (delta.type === "signature_delta") block.signature = (block.signature ?? "") + delta.signature;
        if (delta.type === "input_json_delta") this.args.set(index, (this.args.get(index) ?? "") + delta.partial_json);
      }
      if (event.type === "content_block_stop" && this.args.has(index)) this.blocks.get(index)!.input = JSON.parse(this.args.get(index)!);
      if (event.type === "message_delta") { Object.assign(this.result, event.delta); this.result.usage = { ...this.result.usage, ...event.usage }; }
      if (event.type === "message_stop") this.terminal = true;
    } else {
      this.result.choices ??= [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: null }];
      Object.assign(this.result, { id: event.id, object: "chat.completion", created: event.created, model: event.model });
      const choice = event.choices?.[0], delta = choice?.delta ?? {}, message = this.result.choices[0].message;
      for (const [field, thinking] of [["content", false], ["reasoning_content", true]] as const) { const text = delta[field] ?? (thinking ? delta.reasoning : "") ?? ""; this.delta(field, thinking, text); message[field] = (message[field] ?? "") + text; }
      for (const tool of delta.tool_calls ?? []) { const call = this.blocks.get(tool.index ?? 0) ?? { type: "function", id: "", function: { name: "", arguments: "" } }; for (const field of ["id", "type"]) if (tool[field]) call[field] = tool[field]; for (const field of ["name", "arguments"]) call.function[field] += tool.function?.[field] ?? ""; this.blocks.set(tool.index ?? 0, call); }
      if (choice?.finish_reason) { this.terminal = true; this.result.choices[0].finish_reason = choice.finish_reason; }
      if (event.usage) this.result.usage = event.usage;
    }
  }
  finish(): void { for (const [key, part] of this.parts) this.emit({ kind: part.thinking ? "thinking" : "message", phase: "completed", messageId: `api-${this.id}:${key}`, text: part.text }); }
  reply(): Json { if (this.wire === "anthropic-messages") this.result.content = [...this.blocks.values()]; else if (this.wire !== "openai-responses" && this.blocks.size) this.result.choices[0].message.tool_calls = [...this.blocks.values()]; return this.result; }
}
