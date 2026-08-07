#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const SERVER_INFO = { name: "trae-agent-files", version: "0.1.0" };
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 120_000;

const TOOLS = [
  {
    name: "read_file",
    title: "Read an encrypted file through TRAE Agent",
    description: "Use TRAE Agent's trusted Read tool and return its raw tool output. The file path must be absolute.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        file_path: { type: "string", description: "Absolute path of the file to read." }
      },
      required: ["file_path"]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "edit_file",
    title: "Edit an encrypted file through one TRAE Agent turn",
    description: "In one TRAE Agent turn, Read the target, apply one exact text replacement with Edit, then Read again to verify. Write, Bash, delete, move, and rename are denied by the bridge.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        file_path: { type: "string", description: "Absolute path of the existing file." },
        old_string: { type: "string", description: "Exact existing text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", default: false, description: "Replace every exact occurrence when true." }
      },
      required: ["file_path", "old_string", "new_string"]
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "edit_by_instruction",
    title: "Edit an encrypted file through TRAE Agent",
    description: "In one TRAE Agent turn, Read one target file, make the requested changes only with Edit, and Read it again to verify. Use edit_file for exact replacements when possible.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        file_path: { type: "string", description: "Absolute path of the existing file." },
        instructions: { type: "string", description: "Precise changes to make to this file only." }
      },
      required: ["file_path", "instructions"]
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "status",
    title: "Check the TRAE Agent bridge",
    description: "Start or inspect the underlying TRAE ACP process and report its active sessions.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

export function printable(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const values = value.map(printable).filter((entry) => entry !== undefined);
    return values.length ? values.join("\n") : undefined;
  }
  const object = asRecord(value);
  if (typeof object.text === "string") return object.text;
  if (object.content !== undefined) {
    const nested = printable(object.content);
    if (nested !== undefined) return nested;
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function normalizeToolName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function toolKind(value) {
  const name = normalizeToolName(value);
  if (name === "read" || name.startsWith("read_") || name.endsWith("_read") || name.includes("reading")) return "read";
  if (name === "edit" || name.startsWith("edit_") || name.endsWith("_edit") || name.includes("editing")) return "edit";
  return name;
}

function validAbsolutePath(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("file_path must be a non-empty absolute path");
  if (!isAbsolute(value)) throw new Error(`file_path must be absolute: ${value}`);
  return normalize(resolve(value));
}

class AsyncQueue {
  #items = [];
  #waiters = [];
  #closedError;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.#items.push(value);
  }

  close(error = new Error("TRAE ACP process closed")) {
    this.#closedError = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  next() {
    if (this.#items.length) return Promise.resolve(this.#items.shift());
    if (this.#closedError) return Promise.reject(this.#closedError);
    return new Promise((resolveNext, reject) => this.#waiters.push({ resolve: resolveNext, reject }));
  }
}

class JsonRpcProcess {
  #child;
  #events = new AsyncQueue();
  #pending = new Map();
  #nextId = 1;
  #stderr = "";

  constructor(command, args, cwd) {
    this.#child = spawn(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    stdout.on("line", (line) => this.#acceptLine(line));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-16_384);
    });
    this.#child.on("error", (error) => this.#close(error));
    this.#child.on("exit", (code, signal) => {
      const detail = this.#stderr.trim();
      this.#close(new Error(`TRAE ACP exited (code=${code ?? "null"}, signal=${signal ?? "null"})${detail ? `: ${detail}` : ""}`));
    });
  }

  request(method, params) {
    const { promise } = this.requestWithId(method, params);
    return promise;
  }

  requestWithId(method, params) {
    const id = this.#nextId++;
    const promise = new Promise((resolveRequest, reject) => this.#pending.set(id, { resolve: resolveRequest, reject }));
    this.#send({ jsonrpc: "2.0", id, method, params });
    return { id, promise };
  }

  respond(id, result) {
    this.#send({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message) {
    this.#send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  nextEvent() {
    return this.#events.next();
  }

  close() {
    if (!this.#child.killed) this.#child.kill();
  }

  #send(message) {
    if (!this.#child.stdin.writable) throw new Error("TRAE ACP stdin is not writable");
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #acceptLine(line) {
    if (!line.trim()) return;
    let value;
    try { value = JSON.parse(line); }
    catch {
      this.#events.push({ kind: "log", text: line });
      return;
    }
    const id = value.id;
    if (id !== undefined && (Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) && typeof value.method !== "string") {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        if (value.error !== undefined) pending.reject(new Error(printable(value.error) ?? "TRAE ACP request failed"));
        else pending.resolve(value.result);
      }
      this.#events.push({ kind: "response", id, result: value.result, error: value.error });
      return;
    }
    if (typeof value.method !== "string") return;
    this.#events.push(id === undefined
      ? { kind: "notification", method: value.method, params: value.params }
      : { kind: "request", id, method: value.method, params: value.params });
  }

  #close(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#events.close(error);
  }
}

function timeout(promise, ms, label) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function parsePrefixArgs() {
  const text = process.env.TRAE_CLI_PREFIX_ARGS_JSON?.trim();
  if (!text) return [];
  const value = JSON.parse(text);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("TRAE_CLI_PREFIX_ARGS_JSON must be a JSON string array");
  }
  return value;
}

export class TraeAgentBridge {
  #rpc;
  #sessions = new Map();
  #working = Promise.resolve();
  #timeoutMs;
  #command;
  #prefixArgs;

  constructor() {
    this.#timeoutMs = Number(process.env.TRAE_BRIDGE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.#command = process.env.TRAE_CLI_PATH?.trim() || "traecli";
    this.#prefixArgs = parsePrefixArgs();
  }

  enqueue(task) {
    const result = this.#working.then(task, task);
    this.#working = result.then(() => undefined, () => undefined);
    return result;
  }

  close() {
    this.#rpc?.close();
    this.#rpc = undefined;
    this.#sessions.clear();
  }

  async status() {
    await this.#ensureRpc(process.cwd());
    return {
      executable: this.#command,
      active: true,
      sessions: [...this.#sessions.entries()].map(([cwd, sessionId]) => ({ cwd, sessionId }))
    };
  }

  async readFile(filePath) {
    const target = validAbsolutePath(filePath);
    const result = await this.#prompt(target, ["read"], [
      "You are a trusted filesystem bridge.",
      `Target file: ${JSON.stringify(target)}`,
      "Use the Read tool to read exactly this file. Do not use Bash, Write, Edit, Replace, delete, move, or rename.",
      "After the tool finishes, reply only READ_OK. Do not reproduce or summarize the file in the assistant message."
    ].join("\n"));
    const read = [...result.tools].reverse().find((tool) => tool.kind === "read" && tool.status === "completed" && tool.output !== undefined);
    if (!read) throw new Error(`TRAE Agent completed without a readable Read tool result. Assistant output: ${result.message || "<empty>"}`);
    return { filePath: target, content: read.output, sessionId: result.sessionId };
  }

  async editFile(filePath, oldString, newString, replaceAll = false) {
    const target = validAbsolutePath(filePath);
    if (typeof oldString !== "string" || oldString.length === 0) throw new Error("old_string must be a non-empty string");
    if (typeof newString !== "string") throw new Error("new_string must be a string");
    const result = await this.#prompt(target, ["read", "edit"], [
      "You are a trusted filesystem bridge. Modify exactly one existing file.",
      `Target file: ${JSON.stringify(target)}`,
      `Exact old text: ${JSON.stringify(oldString)}`,
      `Exact new text: ${JSON.stringify(newString)}`,
      `Replace all exact occurrences: ${replaceAll ? "yes" : "no"}`,
      "Required sequence in this single turn: (1) Read the target, (2) use Edit for the exact replacement, (3) Read the target again and verify.",
      "Never use Write, Bash, Replace, delete, move, rename, temporary files, or any other file. If the exact old text is absent or ambiguous, stop without changing anything.",
      "Reply with a short factual result after verification."
    ].join("\n"));
    return this.#editResult(target, result);
  }

  async editByInstruction(filePath, instructions) {
    const target = validAbsolutePath(filePath);
    if (typeof instructions !== "string" || !instructions.trim()) throw new Error("instructions must be a non-empty string");
    const result = await this.#prompt(target, ["read", "edit"], [
      "You are a trusted filesystem bridge. Modify exactly one existing file.",
      `Target file: ${JSON.stringify(target)}`,
      `Requested change: ${JSON.stringify(instructions)}`,
      "Required sequence in this single turn: (1) Read the target, (2) make the smallest possible change using only Edit, (3) Read the target again and verify.",
      "Never use Write, Bash, Replace, delete, move, rename, temporary files, or any other file. Stop without changing anything if the request cannot be completed with Edit.",
      "Reply with a short factual result after verification."
    ].join("\n"));
    return this.#editResult(target, result);
  }

  #editResult(target, result) {
    const edits = result.tools.filter((tool) => tool.kind === "edit" && tool.status === "completed");
    const reads = result.tools.filter((tool) => tool.kind === "read" && tool.status === "completed");
    if (!edits.length) throw new Error(`TRAE Agent did not complete an Edit tool call. Assistant output: ${result.message || "<empty>"}`);
    if (edits.some((tool) => tool.success === false)) throw new Error(`TRAE Edit failed: ${edits.map((tool) => tool.output).filter(Boolean).join("\n")}`);
    if (reads.length < 2) throw new Error("TRAE Agent edited the file but did not complete the required post-edit Read verification");
    return {
      filePath: target,
      edited: true,
      verified: true,
      sessionId: result.sessionId,
      message: result.message,
      toolCalls: result.tools.map(({ title, kind, status, success, output }) => ({ title, kind, status, success, output }))
    };
  }

  async #ensureRpc(cwd) {
    if (this.#rpc) return;
    const variants = [
      [...this.#prefixArgs, "acp", "serve"],
      [...this.#prefixArgs, "acp"]
    ];
    let lastError;
    for (const args of variants) {
      const rpc = new JsonRpcProcess(this.#command, args, cwd);
      try {
        await timeout(rpc.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          clientInfo: SERVER_INFO
        }), Math.min(this.#timeoutMs, 15_000), "TRAE ACP initialize");
        this.#rpc = rpc;
        return;
      } catch (error) {
        lastError = error;
        rpc.close();
      }
    }
    throw lastError ?? new Error("Unable to start TRAE ACP");
  }

  async #sessionFor(target) {
    const cwd = dirname(target);
    await this.#ensureRpc(cwd);
    const existing = this.#sessions.get(cwd);
    if (existing) return { cwd, sessionId: existing };
    const response = asRecord(await timeout(this.#rpc.request("session/new", { cwd, mcpServers: [] }), this.#timeoutMs, "TRAE ACP session/new"));
    const sessionId = typeof response.sessionId === "string" ? response.sessionId : "";
    if (!sessionId) throw new Error("TRAE ACP session/new returned no sessionId");
    this.#sessions.set(cwd, sessionId);
    return { cwd, sessionId };
  }

  async #prompt(target, allowedKinds, prompt) {
    const { sessionId } = await this.#sessionFor(target);
    const { id, promise } = this.#rpc.requestWithId("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }]
    });
    void promise.catch(() => undefined);
    const run = this.#collectPrompt(id, sessionId, new Set(allowedKinds));
    try {
      return await timeout(run, this.#timeoutMs, "TRAE Agent turn");
    } catch (error) {
      this.#rpc?.close();
      this.#rpc = undefined;
      this.#sessions.clear();
      throw error;
    }
  }

  async #collectPrompt(promptId, sessionId, allowedKinds) {
    let message = "";
    const tools = new Map();
    while (true) {
      const event = await this.#rpc.nextEvent();
      if (event.kind === "request") {
        if (event.method === "session/request_permission") {
          this.#answerPermission(event, allowedKinds);
        } else {
          this.#rpc.respondError(event.id, -32601, `Unsupported ACP request: ${event.method}`);
        }
        continue;
      }
      if (event.kind === "notification" && event.method === "session/update") {
        const params = asRecord(event.params);
        if (params.sessionId && params.sessionId !== sessionId) continue;
        const update = asRecord(params.update);
        if (update.sessionUpdate === "agent_message_chunk") {
          const content = asRecord(update.content);
          if (content.type === "text" && typeof content.text === "string") message += content.text;
        }
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          const callId = String(update.toolCallId ?? `${tools.size + 1}`);
          const previous = tools.get(callId) ?? {};
          const title = typeof update.title === "string" ? update.title : previous.title ?? "tool";
          const status = typeof update.status === "string" ? update.status : previous.status ?? "in_progress";
          const output = printable(update.rawOutput) ?? printable(update.content) ?? previous.output;
          tools.set(callId, {
            ...previous,
            title,
            kind: toolKind(title),
            status,
            success: status !== "failed",
            input: update.rawInput ?? previous.input,
            output
          });
        }
        continue;
      }
      if (event.kind === "response" && event.id === promptId) {
        if (event.error !== undefined) throw new Error(printable(event.error) ?? "TRAE Agent prompt failed");
        return { sessionId, message, tools: [...tools.values()] };
      }
    }
  }

  #answerPermission(event, allowedKinds) {
    const params = asRecord(event.params);
    const toolCall = asRecord(params.toolCall);
    const kind = toolKind(toolCall.title ?? toolCall.name ?? "");
    const options = Array.isArray(params.options) ? params.options.map(asRecord) : [];
    const allowed = allowedKinds.has(kind);
    const option = allowed
      ? options.find((entry) => !String(entry.kind ?? "").toLowerCase().includes("reject"))
      : options.find((entry) => String(entry.kind ?? "").toLowerCase().includes("reject"));
    const optionId = option?.optionId ?? option?.id;
    this.#rpc.respond(event.id, optionId
      ? { outcome: { outcome: "selected", optionId } }
      : { outcome: { outcome: "cancelled" } });
  }
}

export class McpBridgeServer {
  #bridge;

  constructor(bridge = new TraeAgentBridge()) {
    this.#bridge = bridge;
  }

  async handle(message) {
    if (!message || message.jsonrpc !== "2.0" || message.id === undefined) return undefined;
    try {
      let result;
      if (message.method === "initialize") {
        result = {
          protocolVersion: asRecord(message.params).protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO
        };
      } else if (message.method === "ping") {
        result = {};
      } else if (message.method === "tools/list") {
        result = { tools: TOOLS };
      } else if (message.method === "tools/call") {
        result = await this.#callTool(asRecord(message.params));
      } else {
        return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
      }
      return { jsonrpc: "2.0", id: message.id, result };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true
        }
      };
    }
  }

  async #callTool(params) {
    const name = params.name;
    const args = asRecord(params.arguments);
    const value = await this.#bridge.enqueue(async () => {
      if (name === "status") return this.#bridge.status();
      if (name === "read_file") return this.#bridge.readFile(args.file_path);
      if (name === "edit_file") return this.#bridge.editFile(args.file_path, args.old_string, args.new_string, args.replace_all === true);
      if (name === "edit_by_instruction") return this.#bridge.editByInstruction(args.file_path, args.instructions);
      throw new Error(`Unknown tool: ${name}`);
    });
    return {
      content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
      structuredContent: typeof value === "object" && value !== null ? value : { value },
      isError: false
    };
  }
}

export async function runStdio() {
  const bridge = new TraeAgentBridge();
  const server = new McpBridgeServer(bridge);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
        continue;
      }
      const response = await server.handle(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  } finally {
    bridge.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdio().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
