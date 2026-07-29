import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { RuntimeToolExecutor, RuntimeToolSpec } from "./runtime-tools.js";

function publicToolName(name: string): string {
  if (name.startsWith("agenthub.")) return name.slice("agenthub.".length);
  if (name.startsWith("agenthub_")) return name.slice("agenthub_".length);
  return name;
}

export interface RuntimeMcpBridge {
  url: string;
  close(): Promise<void>;
}

/** Claude Code `--permission-prompt-tool` payload and verdict. */
export interface PermissionPromptRequest {
  toolName: string;
  input: Record<string, unknown>;
}

export interface PermissionPromptResult {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export const PERMISSION_PROMPT_TOOL_NAME = "permission_prompt";

/**
 * Exposes run-scoped AgentHub tools to a provider CLI over loopback Streamable
 * HTTP. The random path is a bearer capability and the server exists only for
 * one provider process, so tools never leak into another AgentHub session.
 */
export async function startRuntimeMcpBridge(
  providerId: string,
  tools: RuntimeToolSpec[],
  execute: RuntimeToolExecutor | undefined,
  onPermissionPrompt?: (request: PermissionPromptRequest) => Promise<PermissionPromptResult>
): Promise<RuntimeMcpBridge> {
  const byPublicName = new Map<string, RuntimeToolSpec>();
  for (const tool of tools) {
    const name = publicToolName(tool.name);
    if (byPublicName.has(name)) throw new Error(`Duplicate runtime tool name: ${name}`);
    byPublicName.set(name, tool);
  }

  const mcp = new Server(
    { name: "agenthub-runtime", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: "AgentHub session-scoped orchestration tools. Call them only when delegation is useful."
    }
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...[...byPublicName.entries()].map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema
      })),
      ...(onPermissionPrompt
        ? [{
            name: PERMISSION_PROMPT_TOOL_NAME,
            description: "AgentHub permission prompt bridge used by --permission-prompt-tool; not for direct model use.",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string" },
                input: { type: "object" }
              },
              required: ["tool_name", "input"]
            } as Record<string, unknown>
          }]
        : [])
    ]
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === PERMISSION_PROMPT_TOOL_NAME && onPermissionPrompt) {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await onPermissionPrompt({
          toolName: String(args.tool_name ?? ""),
          input: (typeof args.input === "object" && args.input !== null ? args.input : {}) as Record<string, unknown>
        });
        return { isError: false, content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    }
    const tool = byPublicName.get(request.params.name);
    if (!tool || !execute) return { isError: true, content: [{ type: "text", text: `Unknown AgentHub tool: ${request.params.name}` }] };
    try {
      const result = await execute({
        providerId,
        name: tool.name,
        arguments: request.params.arguments
      });
      return { isError: !result.success, content: [{ type: "text", text: result.content }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  });

  const token = randomUUID().replaceAll("-", "");
  const path = `/mcp/${token}`;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true
  });
  await mcp.connect(transport);

  let http!: HttpServer;
  await new Promise<void>((resolve, reject) => {
    http = createServer((request, response) => {
      const remote = request.socket.remoteAddress;
      const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (!local || pathname !== path) {
        response.writeHead(404).end();
        return;
      }
      void transport.handleRequest(request, response).catch((error) => {
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        if (!response.writableEnded) response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
    });
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });

  const address = http.address();
  if (!address || typeof address === "string") {
    await transport.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    throw new Error("AgentHub could not allocate a runtime tool endpoint");
  }

  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  };
}
