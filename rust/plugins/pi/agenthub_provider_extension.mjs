import { spawn } from "node:child_process";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_TIMEOUT_MS = 30000;

function mcpError(value) {
  if (!value) return "Unknown MCP error";
  if (typeof value === "string") return value;
  if (value.message) return String(value.message);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function mcpToolName(serverName, toolName, used) {
  const clean = (value) => String(value || "tool").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
  const base = ("mcp_" + clean(serverName) + "_" + clean(toolName)).slice(0, 120);
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = base.slice(0, 116) + "_" + suffix++;
  used.add(name);
  return name;
}

function toolParameters(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  return { type: "object", properties: {}, ...schema };
}

function toolResult(result, serverName, toolName) {
  const rawContent = Array.isArray(result?.content) ? result.content : [];
  const content = rawContent.map((part) => {
    if (part?.type === "text") return { type: "text", text: String(part.text || "") };
    if (part?.type === "image" && part.data && part.mimeType) {
      return { type: "image", data: String(part.data), mimeType: String(part.mimeType) };
    }
    return { type: "text", text: JSON.stringify(part ?? null) };
  });
  if (!content.length && result?.structuredContent !== undefined) {
    content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
  }
  if (!content.length) content.push({ type: "text", text: "MCP tool completed with no content" });
  return {
    content,
    details: { server: serverName, tool: toolName, structuredContent: result?.structuredContent },
    isError: result?.isError === true
  };
}

class StdioMcpClient {
  constructor(config) {
    this.config = config;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = "";
  }

  async start() {
    if (!this.config.command) throw new Error("STDIO MCP server is missing command");
    const useShell = process.platform === "win32" && /\\.(cmd|bat)$/i.test(this.config.command);
    this.child = spawn(this.config.command, this.config.args || [], {
      cwd: this.config.cwd || undefined,
      env: { ...process.env, ...(this.config.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: useShell
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) process.stderr.write("[AgentHub MCP " + this.config.name + "] " + text + "\\n");
    });
    this.child.on("close", (code) => {
      const error = new Error("MCP server " + this.config.name + " exited with code " + String(code));
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agenthub-pi", version: "0.2.5" }
    });
    this.notify("notifications/initialized", {});
  }

  onData(chunk) {
    this.buffer += String(chunk);
    const lines = this.buffer.split(/\\r?\\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      entry.cleanup();
      if (message.error) entry.reject(new Error(mcpError(message.error)));
      else entry.resolve(message.result);
    }
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new Error("MCP server " + this.config.name + " is not connected");
    this.child.stdin.write(JSON.stringify(message) + "\\n");
  }

  request(method, params, signal) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      let abortHandler;
      const cleanup = () => {
        clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP request timed out: " + method));
      }, MCP_TIMEOUT_MS);
      timer.unref?.();
      if (signal) {
        abortHandler = () => {
          this.pending.delete(id);
          cleanup();
          this.notify("notifications/cancelled", { requestId: id, reason: "AgentHub tool call aborted" });
          reject(new Error("MCP request aborted: " + method));
        };
        if (signal.aborted) return abortHandler();
        signal.addEventListener("abort", abortHandler, { once: true });
      }
      this.pending.set(id, { resolve, reject, cleanup });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }

  notify(method, params) {
    try { this.write({ jsonrpc: "2.0", method, params }); } catch { /* process is closing */ }
  }

  async close() {
    try { this.child?.stdin?.end(); } catch { /* already closed */ }
    if (this.child?.exitCode === null) this.child.kill();
  }
}

class HttpMcpClient {
  constructor(config) {
    this.config = config;
    this.nextId = 0;
    this.sessionId = undefined;
  }

  async start() {
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agenthub-pi", version: "0.2.5" }
    });
    await this.notify("notifications/initialized", {});
  }

  async post(message, signal) {
    if (!this.config.url) throw new Error("HTTP MCP server is missing URL");
    const timeout = AbortSignal.timeout(MCP_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(this.config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        ...(this.config.headers || {}),
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {})
      },
      body: JSON.stringify(message),
      signal: requestSignal
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    if (!response.ok) throw new Error("MCP HTTP " + response.status + ": " + (await response.text()).slice(0, 2000));
    if (response.status === 202 || response.status === 204) return undefined;
    const text = await response.text();
    if (!text.trim()) return undefined;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      const messages = [];
      for (const block of text.split(/\\r?\\n\\r?\\n/)) {
        const data = block.split(/\\r?\\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\\n");
        if (!data || data === "[DONE]") continue;
        try { messages.push(JSON.parse(data)); } catch { /* ignore non-JSON SSE data */ }
      }
      return messages.find((item) => item.id === message.id) || messages.at(-1);
    }
    return JSON.parse(text);
  }

  async request(method, params, signal) {
    const id = ++this.nextId;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
    if (response?.error) throw new Error(mcpError(response.error));
    return response?.result;
  }

  async notify(method, params) {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  async close() {
    if (!this.sessionId || !this.config.url) return;
    try {
      await fetch(this.config.url, {
        method: "DELETE",
        headers: { ...(this.config.headers || {}), "mcp-session-id": this.sessionId },
        signal: AbortSignal.timeout(2000)
      });
    } catch { /* best-effort session cleanup */ }
  }
}

async function listMcpTools(client) {
  const tools = [];
  let cursor;
  do {
    const result = await client.request("tools/list", cursor ? { cursor } : {});
    if (Array.isArray(result?.tools)) tools.push(...result.tools);
    cursor = result?.nextCursor;
  } while (cursor);
  return tools;
}

export default async function (pi) {
  const raw = process.env.AGENTHUB_PI_PROVIDER_CONFIG;
  if (raw) {
    const config = JSON.parse(raw);
    pi.registerProvider("agenthub", {
      ...config,
      apiKey: process.env.AGENTHUB_PI_API_KEY || "agenthub"
    });
  }

  const mcpClients = [];
  const mcpToolNames = [];
  const mcpErrors = [];
  const usedToolNames = new Set();
  const rawMcp = process.env.AGENTHUB_PI_MCP_SERVERS;
  const mcpConfigs = rawMcp ? JSON.parse(rawMcp) : [];
  for (const config of mcpConfigs) {
    let client;
    try {
      client = config.transport === "http" ? new HttpMcpClient(config) : new StdioMcpClient(config);
      await client.start();
      mcpClients.push(client);
      const tools = await listMcpTools(client);
      for (const tool of tools) {
        const registeredName = mcpToolName(config.name, tool.name, usedToolNames);
        mcpToolNames.push(registeredName);
        pi.registerTool({
          name: registeredName,
          label: config.name + ": " + (tool.title || tool.name),
          description: (tool.description || "MCP tool " + tool.name) + " (server: " + config.name + ")",
          promptSnippet: "Use " + registeredName + " to call " + config.name + "/" + tool.name + ".",
          parameters: toolParameters(tool.inputSchema),
          async execute(_toolCallId, params, signal) {
            try {
              const result = await client.request("tools/call", { name: tool.name, arguments: params || {} }, signal);
              return toolResult(result, config.name, tool.name);
            } catch (error) {
              return {
                content: [{ type: "text", text: mcpError(error) }],
                details: { server: config.name, tool: tool.name },
                isError: true
              };
            }
          }
        });
      }
    } catch (error) {
      mcpErrors.push(config.name + ": " + mcpError(error));
      await client?.close().catch(() => undefined);
    }
  }

  // Some OpenAI-compatible gateways terminate a stream without an error body.
  // Pi otherwise records stopReason=error with an empty errorMessage and does
  // not classify it as retryable. Give the built-in retry policy a useful,
  // transient error instead of silently settling the turn.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message?.role !== "assistant" || message.stopReason !== "error" || message.errorMessage) return;
    return {
      message: {
        ...message,
        errorMessage: "Transient provider server error: the response stream ended without an error message"
      }
    };
  });

  const powershellEnabled = process.env.AGENTHUB_PI_ENABLE_POWERSHELL === "1" && process.platform === "win32";
  if (powershellEnabled) pi.registerTool({
    name: "powershell",
    label: "PowerShell",
    description: "Run a command with native Windows PowerShell. Use this instead of bash on Windows.",
    promptGuidelines: [
      "On Windows, use the powershell tool for commands; do not call bash.",
      "Use Windows paths and PowerShell syntax."
    ],
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "PowerShell command to execute" },
        cwd: { type: "string", description: "Optional working directory" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds (default 120000)" }
      },
      required: ["command"],
      additionalProperties: false
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const timeoutMs = Number.isFinite(params.timeoutMs) ? Math.max(1000, Math.min(params.timeoutMs, 1800000)) : 120000;
      const cwd = params.cwd || ctx.cwd;
      return await new Promise((resolve) => {
        const child = spawn("powershell.exe", [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", params.command
        ], { cwd, windowsHide: true, env: process.env });
        let output = "";
        let finished = false;
        const append = (chunk) => {
          output = (output + String(chunk)).slice(-2097152);
          onUpdate?.({ content: [{ type: "text", text: output }], details: {} });
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const stop = () => {
          if (!finished) child.kill();
        };
        signal?.addEventListener("abort", stop, { once: true });
        const timer = setTimeout(stop, timeoutMs);
        child.on("error", (error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          resolve({ content: [{ type: "text", text: error.message }], details: { exitCode: 1 }, isError: true });
        });
        child.on("close", (code) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          const exitCode = code ?? 1;
          const text = output || "Command completed with no output";
          resolve({
            content: [{ type: "text", text: text + "\\n\\nProcess exited with code " + exitCode }],
            details: { exitCode },
            isError: exitCode !== 0
          });
        });
      });
    }
  });

  const enableAgentHubTools = () => {
    const active = pi.getActiveTools();
    const native = powershellEnabled ? [...active.filter((name) => name !== "bash"), "powershell"] : active;
    pi.setActiveTools([...new Set([...native, ...mcpToolNames])]);
  };
  // Pi action methods are unavailable while the extension factory is loading.
  // session_start runs after the extension runtime has been initialized.
  pi.on("session_start", (_event, ctx) => {
    enableAgentHubTools();
    for (const error of mcpErrors) ctx?.ui?.notify?.("MCP unavailable: " + error, "error");
  });
  pi.on("session_shutdown", async () => {
    await Promise.allSettled(mcpClients.map((client) => client.close()));
  });
}
