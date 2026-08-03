import type { ProcessEvent } from "../../process-runtime.js";
import { ProcessRuntime } from "../../process-runtime.js";
import { JsonRpcProcessClient, type JsonRpcProcessEvent } from "../json-rpc-process.js";
import type { AdapterEvent, AdapterResumeRequest, AdapterRun, AdapterStartRequest } from "../types.js";
import { resolvePermissionMode } from "../permission-mode.js";
import { parseKimiAcpUpdate, type KimiAcpParseState } from "./acp-events.js";
import { KimiAcpTurnSegments } from "./acp-segments.js";
import { readKimiSessionUsage } from "./session-usage.js";
import { startKimiRuntimeMcpBridge, type KimiRuntimeMcpBridge } from "./runtime-mcp-server.js";
import { normalizeKimiPermissionInteraction } from "./interaction.js";
import { KimiSubagentWireWatcher } from "./subagent-wire.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => typeof value === "object" && value !== null ? value as RecordValue : {};
const KIMI_SUBAGENT_POLL_MS = 300;

function isKimiAgentTool(event: AdapterEvent): event is Extract<AdapterEvent, { kind: "tool" }> {
  return event.kind === "tool" && event.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "") === "agent";
}

async function nextRpcOrPoll(
  nextRpc: Promise<IteratorResult<JsonRpcProcessEvent>>,
  poll: boolean
): Promise<{ source: "rpc"; result: IteratorResult<JsonRpcProcessEvent> } | { source: "poll" }> {
  if (!poll) return { source: "rpc", result: await nextRpc };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      nextRpc.then((result) => ({ source: "rpc" as const, result })),
      new Promise<{ source: "poll" }>((resolve) => { timer = setTimeout(() => resolve({ source: "poll" }), KIMI_SUBAGENT_POLL_MS); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function transportEvent(event: ProcessEvent): AdapterEvent | undefined {
  if (event.kind === "stdout") return { kind: "raw", stream: "stdout", text: event.text };
  if (event.kind === "stderr") return { kind: "raw", stream: "stderr", text: event.text };
  return event;
}

async function applyConfig(rpc: JsonRpcProcessClient, sessionId: string, response: RecordValue, request: AdapterStartRequest): Promise<void> {
  const options = Array.isArray(response.configOptions) ? response.configOptions.map(record) : [];
  const selections: Array<[string | undefined, string[]]> = [
    [request.model, ["model"]],
    [request.reasoningEffort, ["thinking", "reasoning", "effort"]]
  ];
  for (const [value, hints] of selections) {
    if (!value) continue;
    const option = options.find((item) => hints.some((hint) => `${String(item.id ?? "")} ${String(item.name ?? "")} ${String(item.label ?? "")}`.toLowerCase().includes(hint)));
    if (!option?.id) continue;
    await rpc.request("session/set_config_option", { sessionId, configId: option.id, value }).catch(() => undefined);
  }
  // Permission mode must match exactly — a fuzzy "mode" hint would also hit the model option.
  // Session-level override wins; otherwise fall back to the instance setting
  // (same precedence as the codex/claude adapters).
  const mode = resolvePermissionMode(request.instance, request);
  if (mode) {
    const option = options.find((item) => {
      const id = String(item.id ?? "").toLowerCase();
      const name = String(item.name ?? "").toLowerCase();
      return id === "mode" || name === "mode" || id === "permission" || name === "permission";
    });
    // Older Nautilo builds saved "manual"; the CLI calls that mode "default".
    const value = mode === "manual" ? "default" : mode;
    if (option?.id) await rpc.request("session/set_config_option", { sessionId, configId: option.id, value }).catch(() => undefined);
  }
}

export function startKimiAcp(request: AdapterStartRequest | AdapterResumeRequest, resume: boolean): AdapterRun {
  const runtime = new ProcessRuntime();
  const process = runtime.start({
    command: request.instance.executable,
    args: ["acp"],
    cwd: request.cwd,
    env: request.env,
    timeoutMs: request.timeoutMs,
    idleTimeoutMs: request.idleTimeoutMs,
    // ACP can stream cumulative tool inputs (not user-visible output), making
    // transport bytes grow quadratically for file writes. Honor an explicit
    // caller limit, but do not apply the plain-text adapter's 20 MB default.
    maxOutputBytes: request.maxOutputBytes
  });
  const rpc = new JsonRpcProcessClient(process);
  let sessionId: string | undefined;
  let finished = false;
  let usageReceived = false;
  let runtimeMcp: KimiRuntimeMcpBridge | undefined;

  async function* events(): AsyncGenerator<AdapterEvent> {
    const state: KimiAcpParseState = {
      messageId: "kimi-message-1",
      thinkingId: "kimi-thinking-1",
      toolNames: new Map(),
      toolCalls: new Map()
    };
    const segments = new KimiAcpTurnSegments(state);
    try {
      const mcpServers: Array<Record<string, unknown>> = [];
      if (request.runtimeTools?.length && request.executeRuntimeTool) {
        runtimeMcp = await startKimiRuntimeMcpBridge(request.runtimeTools, request.executeRuntimeTool);
        mcpServers.push({ type: "http", name: "agenthub", url: runtimeMcp.url, headers: [] });
      }
      for (const server of request.mcpServers ?? []) {
        if (server.transport === "http" && server.url) {
          mcpServers.push({
            type: "http",
            name: server.name,
            url: server.url,
            headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value }))
          });
        } else if (server.transport === "stdio" && server.command) {
          mcpServers.push({
            name: server.name,
            command: server.command,
            args: server.args ?? [],
            env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value }))
          });
        }
      }
      await rpc.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: "Nautilo", version: "0.1.0" }
      });
      const sessionResponse = record(await rpc.request(resume ? "session/resume" : "session/new", resume
        ? { sessionId: (request as AdapterResumeRequest).providerSessionId, cwd: request.cwd, mcpServers }
        : { cwd: request.cwd, mcpServers }));
      sessionId = String(sessionResponse.sessionId ?? (resume ? (request as AdapterResumeRequest).providerSessionId : ""));
      if (!sessionId) throw new Error("Kimi ACP did not return a session id");
      yield { kind: "session", providerSessionId: sessionId };
      const subagentWires = new KimiSubagentWireWatcher(
        sessionId,
        request.env?.KIMI_CODE_HOME
      );
      await subagentWires.initialize();
      // Resume spawns a fresh CLI process whose mode/model reset to defaults
      // (the resume response carries configOptions too), so re-apply every time.
      await applyConfig(rpc, sessionId, sessionResponse, request);
      yield { kind: "status", phase: "turn_started" };
      const prompt = rpc.requestWithId("session/prompt", { sessionId, prompt: [{ type: "text", text: request.prompt }] });
      void prompt.promise.catch(() => undefined);

      const rpcEvents = rpc[Symbol.asyncIterator]();
      let nextRpc = rpcEvents.next();
      while (true) {
        const next = await nextRpcOrPoll(nextRpc, subagentWires.hasActive());
        if (next.source === "poll") {
          for (const item of await subagentWires.poll()) yield item;
          continue;
        }
        if (next.result.done) break;
        const event = next.result.value;
        nextRpc = rpcEvents.next();
        if (event.kind === "notification" && event.method === "session/update") {
          const update = record(event.params).update;
          const parsed = parseKimiAcpUpdate(update, state);
          for (const boundary of segments.flushBefore(parsed)) yield boundary;
          for (const item of parsed) {
            if (isKimiAgentTool(item) && item.callId && item.phase === "started") {
              subagentWires.track(item.callId, item.input);
            }
            if (isKimiAgentTool(item) && item.callId && item.phase === "completed") {
              for (const childItem of await subagentWires.poll()) yield childItem;
            }
            segments.append(item);
            if (item.kind === "usage") usageReceived = true;
            yield item;
            if (isKimiAgentTool(item) && item.callId && item.phase === "completed") {
              subagentWires.release(item.callId);
            }
          }
        } else if (event.kind === "request" && event.method === "session/request_permission") {
          const params = record(event.params);
          const options = Array.isArray(params.options) ? params.options.map(record) : [];
          if (request.requestInteraction) {
            const toolCall = record(params.toolCall);
            try {
              const response = await request.requestInteraction(normalizeKimiPermissionInteraction(toolCall, options));
              rpc.respond(event.id, response.outcome === "selected" && response.optionId
                ? { outcome: { outcome: "selected", optionId: response.optionId } }
                : { outcome: { outcome: "cancelled" } });
            } catch {
              rpc.respond(event.id, { outcome: { outcome: "cancelled" } });
            }
          } else {
            const allowed = options.find((option) => !String(option.kind ?? "").includes("reject"));
            if (allowed?.optionId) rpc.respond(event.id, { outcome: { outcome: "selected", optionId: allowed.optionId } });
            else rpc.respond(event.id, { outcome: { outcome: "cancelled" } });
          }
        } else if (event.kind === "request") {
          rpc.respondError(event.id, -32601, `Nautilo does not support ACP request ${event.method}`);
        } else if (event.kind === "response" && event.id === prompt.id) {
          for (const childItem of await subagentWires.poll()) yield childItem;
          for (const completed of [...segments.flushMessage(), ...segments.flushThinking()]) yield completed;
          if (!usageReceived && sessionId) {
            const configOptions = Array.isArray(sessionResponse.configOptions) ? sessionResponse.configOptions.map(record) : [];
            const modelOption = configOptions.find((option) => `${String(option.id ?? "")} ${String(option.name ?? "")}`.toLowerCase().includes("model"));
            const modelValues = Array.isArray(modelOption?.options) ? modelOption.options.map(record) : [];
            const selectedModel = request.model || String(modelOption?.currentValue ?? modelOption?.value ?? "");
            const selectedDefinition = modelValues.find((option) => String(option.value ?? option.id ?? "") === selectedModel);
            const contextWindow = Number(selectedDefinition?.contextWindow ?? selectedDefinition?.context_window ?? request.contextWindow);
            const fallback = await readKimiSessionUsage(sessionId, Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined);
            if (fallback) yield fallback;
          }
          yield { kind: "status", phase: event.error ? "turn_failed" : "turn_completed" };
          finished = true;
          await process.cancel();
          yield event.error
            ? { kind: "error", error: new Error(JSON.stringify(event.error)) }
            : { kind: "exit", exitCode: 0 };
          return;
        } else if (event.kind === "transport") {
          const mapped = transportEvent(event.event);
          if (mapped && !(finished && mapped.kind === "exit")) yield mapped;
        }
      }
    } catch (error) {
      yield { kind: "error", error: error instanceof Error ? error : new Error(String(error)) };
      if (!finished) await process.cancel().catch(() => undefined);
    } finally {
      await runtimeMcp?.close().catch(() => undefined);
    }
  }

  return {
    process,
    events: { [Symbol.asyncIterator]: events },
    write: process.write,
    cancel: async () => {
      if (sessionId) rpc.notify("session/cancel", { sessionId });
      await process.cancel();
      await runtimeMcp?.close().catch(() => undefined);
    }
  };
}
