import type { ProcessEvent, ProcessHandle } from "../process-runtime.js";
import { AsyncQueue } from "./async-queue.js";

export type JsonRpcProcessEvent =
  | { kind: "notification"; method: string; params?: unknown }
  | { kind: "request"; id: string | number; method: string; params?: unknown }
  | { kind: "response"; id: string | number; result?: unknown; error?: unknown }
  | { kind: "transport"; event: ProcessEvent };

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function rpcError(value: unknown): Error {
  if (typeof value === "object" && value !== null && "message" in value) return new Error(String(value.message));
  return new Error(typeof value === "string" ? value : JSON.stringify(value));
}

export class JsonRpcProcessClient implements AsyncIterable<JsonRpcProcessEvent> {
  private readonly queue = new AsyncQueue<JsonRpcProcessEvent>();
  private readonly pending = new Map<string | number, PendingRequest>();
  private nextId = 1;

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

  [Symbol.asyncIterator](): AsyncIterator<JsonRpcProcessEvent> {
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
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
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
