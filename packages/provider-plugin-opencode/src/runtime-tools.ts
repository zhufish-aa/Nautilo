import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AdapterStartRequest, RuntimeToolExecutor } from "@agenthub/provider-sdk";

export const RUNTIME_SERVER = "nautilo_runtime";
export interface OpenCodeRuntimeTools {
  url: string;
  update(request: AdapterStartRequest): void;
  inject(request: AdapterStartRequest): AdapterStartRequest;
  close(): Promise<void>;
}

/** Native MCP overlay, with a stable endpoint and a fresh callback each turn. */
export async function openRuntimeTools(request: AdapterStartRequest): Promise<OpenCodeRuntimeTools | undefined> {
  const tools = request.runtimeTools ?? [];
  if (!tools.length) return undefined;
  if (!request.executeRuntimeTool || !request.localSessionId) throw new Error("Nautilo runtime tools require a session executor");
  const path = `/mcp/${randomUUID().replaceAll("-", "")}`;
  let execute: RuntimeToolExecutor | undefined = request.executeRuntimeTool;
  const send = (response: ServerResponse, status: number, value?: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(value === undefined ? "" : JSON.stringify(value));
  };
  const server = createServer(async (incoming, response) => {
    if (incoming.url !== path || incoming.headers.origin) return send(response, 404);
    if (incoming.method === "DELETE") return send(response, 202);
    if (incoming.method !== "POST") return send(response, 405);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > 8 * 1024 * 1024) return send(response, 413);
        chunks.push(bytes);
      }
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: unknown; method: string; params?: Record<string, unknown> };
      if (message.id == null) return send(response, 202);
      const reply = (result: unknown): void => send(response, 200, { jsonrpc: "2.0", id: message.id, result });
      const error = (code: number, text: string): void => send(response, 200, { jsonrpc: "2.0", id: message.id, error: { code, message: text } });
      switch (message.method) {
        case "initialize": return reply({ protocolVersion: message.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: RUNTIME_SERVER, version: "0.1.0" } });
        case "ping": return reply({});
        case "tools/list": return reply({ tools });
        case "tools/call": {
          const tool = tools.find(tool => tool.name === message.params?.name);
          if (!tool) return error(-32602, "Unknown Nautilo runtime tool");
          const result = execute
            ? await execute({ providerId: "opencode", name: tool.name, arguments: message.params?.arguments ?? {} })
            : { success: false, content: "Native session was released" };
          return reply({ isError: !result.success, content: [{ type: "text", text: result.content }] });
        }
        default: return error(-32601, "Method not found");
      }
    } catch (error) {
      return send(response, 200, { jsonrpc: "2.0", id: null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  });
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing runtime MCP address");
  const url = `http://127.0.0.1:${address.port}${path}`;
  return {
    url,
    update(next) { execute = next.executeRuntimeTool; },
    inject(next) { return { ...next, mcpServers: [...(next.mcpServers ?? []), { name: RUNTIME_SERVER, transport: "http", url }] }; },
    async close() { execute = undefined; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
