import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { IpcFailure, IpcHandler, IpcMethod, IpcRequestMap } from "@agenthub/schemas";
import { createAgentHubError } from "@agenthub/domain";
import { toAgentHubError } from "./errors.js";

export interface GatewayRequest {
  requestId?: string;
  method: IpcMethod;
  input: unknown;
}

export interface GatewayResponse {
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: IpcFailure["error"];
}

export type DispatchObserver = (request: GatewayRequest, response: GatewayResponse) => void | Promise<void>;

export type RequestHandler = <TMethod extends IpcMethod>(method: TMethod, input: IpcRequestMap[TMethod]["input"]) => Promise<IpcRequestMap[TMethod]["output"]>;

/** JSON-lines gateway used by Electron and headless clients. */
export class IpcGateway {
  private server?: Server;
  private readonly handlers = new Map<IpcMethod, IpcHandler<any>>();
  private token?: string;
  private socketPath?: string;
  private tokenPath?: string;
  private observer?: DispatchObserver;

  setObserver(observer: DispatchObserver): void {
    this.observer = observer;
  }

  register<TMethod extends IpcMethod>(method: TMethod, handler: IpcHandler<TMethod>): void {
    this.handlers.set(method, handler as IpcHandler<any>);
  }

  async dispatch(request: GatewayRequest): Promise<GatewayResponse> {
    const requestId = request.requestId ?? randomUUID();
    const handler = this.handlers.get(request.method);
    if (!handler) {
      const error = createAgentHubError("IPC_NOT_FOUND", { method: request.method });
      const response = { requestId, ok: false, error } satisfies GatewayResponse;
      await this.notifyObserver(request, response);
      return response;
    }
    try {
      const data = await handler(request.input);
      const response = { requestId, ok: true, data } satisfies GatewayResponse;
      await this.notifyObserver(request, response);
      return response;
    } catch (cause) {
      const error = toAgentHubError(cause);
      const response = { requestId, ok: false, error } satisfies GatewayResponse;
      await this.notifyObserver(request, response);
      return response;
    }
  }

  private async notifyObserver(request: GatewayRequest, response: GatewayResponse): Promise<void> {
    try {
      await this.observer?.(request, response);
    } catch {
      // Audit/telemetry must never break the request path.
    }
  }

  async startSocket(socketPath: string, tokenPath?: string): Promise<{ socketPath: string; token: string }> {
    if (this.server) throw new Error("IPC gateway already started");
    this.token = randomUUID();
    this.socketPath = socketPath;
    const resolvedTokenPath = tokenPath ?? (process.platform === "win32" ? join(tmpdir(), `agenthub-${randomUUID()}.token`) : `${socketPath}.token`);
    this.tokenPath = resolvedTokenPath;
    mkdirSync(dirname(resolvedTokenPath), { recursive: true });
    writeFileSync(resolvedTokenPath, this.token, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      try { chmodSync(resolvedTokenPath, 0o600); } catch { /* best effort */ }
    }
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(socketPath, () => { this.server!.removeListener("error", reject); resolve(); });
    });
    return { socketPath, token: this.token };
  }

  async startTcp(port = 0, host = "127.0.0.1"): Promise<{ port: number; token: string }> {
    if (this.server) throw new Error("IPC gateway already started");
    this.token = randomUUID();
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => { this.server!.removeListener("error", reject); resolve(); });
    });
    const address = this.server.address();
    return { port: typeof address === "object" && address ? address.port : port, token: this.token };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    if (this.socketPath && process.platform !== "win32") {
      try { unlinkSync(this.socketPath); } catch { /* already removed */ }
    }
    if (this.tokenPath) {
      try { unlinkSync(this.tokenPath); } catch { /* already removed */ }
    }
    this.server = undefined;
    this.socketPath = undefined;
    this.tokenPath = undefined;
  }

  private handleSocket(socket: Socket): void {
    let buffer = "";
    let authenticated = false;
    let processing = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        processing = processing.then(async () => { authenticated = await this.handleLine(socket, line, authenticated); });
      }
    });
  }

  private async handleLine(socket: Socket, line: string, authenticated: boolean): Promise<boolean> {
    try {
      const input = JSON.parse(line) as { token?: string; request?: GatewayRequest };
      if (!authenticated) {
        if (!this.token || input.token !== this.token) {
          socket.write(`${JSON.stringify({ requestId: "auth", ok: false, error: createAgentHubError("IPC_INVALID_REQUEST") })}\n`);
          socket.destroy();
          return false;
        }
        socket.write(`${JSON.stringify({ requestId: "auth", ok: true, data: { authenticated: true } })}\n`);
        return true;
      }
      if (!input.request || typeof input.request.method !== "string") throw new Error("request is missing");
      const response = await this.dispatch(input.request);
      socket.write(`${JSON.stringify(response)}\n`);
      return true;
    } catch (cause) {
      socket.write(`${JSON.stringify({ requestId: "invalid", ok: false, error: createAgentHubError("IPC_INVALID_REQUEST", { cause: String(cause) }) })}\n`);
      return authenticated;
    }
  }
}

export function readGatewayToken(tokenPath: string): string { return readFileSync(tokenPath, "utf8").trim(); }
