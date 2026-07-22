import type { ProcessEvent } from "../../process-runtime.js";
import { ProcessRuntime } from "../../process-runtime.js";
import { JsonRpcProcessClient } from "../json-rpc-process.js";
import type { AdapterEvent, AdapterResumeRequest, AdapterRun, AdapterStartRequest } from "../types.js";
import { parseKimiAcpUpdate, type KimiAcpParseState } from "./acp-events.js";
import { readKimiSessionUsage } from "./session-usage.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => typeof value === "object" && value !== null ? value as RecordValue : {};

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

  async function* events(): AsyncGenerator<AdapterEvent> {
    const state: KimiAcpParseState = {
      messageId: "kimi-message-1",
      thinkingId: "kimi-thinking-1",
      toolNames: new Map(),
      toolCalls: new Map()
    };
    let messageText = "";
    let thinkingText = "";
    let messageIndex = 1;
    const flushMessage = function* (): Generator<AdapterEvent> {
      if (messageText) yield { kind: "message", phase: "completed", messageId: state.messageId, text: messageText };
      messageText = "";
      messageIndex += 1;
      state.messageId = `kimi-message-${messageIndex}`;
    };
    try {
      await rpc.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: "AgentHub", version: "0.1.0" }
      });
      const sessionResponse = record(await rpc.request(resume ? "session/resume" : "session/new", resume
        ? { sessionId: (request as AdapterResumeRequest).providerSessionId, cwd: request.cwd, mcpServers: [] }
        : { cwd: request.cwd, mcpServers: [] }));
      sessionId = String(sessionResponse.sessionId ?? (resume ? (request as AdapterResumeRequest).providerSessionId : ""));
      if (!sessionId) throw new Error("Kimi ACP did not return a session id");
      yield { kind: "session", providerSessionId: sessionId };
      if (!resume) await applyConfig(rpc, sessionId, sessionResponse, request);
      yield { kind: "status", phase: "turn_started" };
      const prompt = rpc.requestWithId("session/prompt", { sessionId, prompt: [{ type: "text", text: request.prompt }] });
      void prompt.promise.catch(() => undefined);

      for await (const event of rpc) {
        if (event.kind === "notification" && event.method === "session/update") {
          const update = record(event.params).update;
          const parsed = parseKimiAcpUpdate(update, state);
          if (parsed.some((item) => item.kind === "tool" && item.phase === "started")) yield* flushMessage();
          for (const item of parsed) {
            if (item.kind === "message" && item.phase === "delta") messageText += item.text;
            if (item.kind === "thinking" && item.phase === "delta") thinkingText += item.text;
            if (item.kind === "usage") usageReceived = true;
            yield item;
          }
        } else if (event.kind === "request" && event.method === "session/request_permission") {
          const options = Array.isArray(record(event.params).options) ? record(event.params).options as unknown[] : [];
          const allowed = options.map(record).find((option) => !String(option.kind ?? "").includes("reject"));
          if (allowed?.optionId) rpc.respond(event.id, { outcome: { outcome: "selected", optionId: allowed.optionId } });
          else rpc.respond(event.id, { outcome: { outcome: "cancelled" } });
        } else if (event.kind === "request") {
          rpc.respondError(event.id, -32601, `AgentHub does not support ACP request ${event.method}`);
        } else if (event.kind === "response" && event.id === prompt.id) {
          yield* flushMessage();
          if (thinkingText) yield { kind: "thinking", phase: "completed", messageId: state.thinkingId, text: thinkingText };
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
    }
  }

  return {
    process,
    events: { [Symbol.asyncIterator]: events },
    write: process.write,
    cancel: async () => {
      if (sessionId) rpc.notify("session/cancel", { sessionId });
      await process.cancel();
    }
  };
}
