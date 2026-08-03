import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentInstance } from "@agenthub/domain";
import type { ProcessHandle } from "../../process-runtime.js";
import type { AdapterEvent, AdapterResumeRequest, AdapterRun, AdapterStartRequest } from "../types.js";

type RecordValue = Record<string, unknown>;
type ChatMessage = { role: "user" | "assistant"; content: string };

const conversations = new Map<string, ChatMessage[]>();

/**
 * Codex 0.146 removed `wire_api = "chat"`. Keep Chat Completions support in
 * Nautilo instead of passing that rejected value to the Codex app-server.
 * This compatibility path intentionally focuses on text turns; Responses is
 * still the full Codex transport with native tools, MCP and file operations.
 */
export function startCodexChatCompletions(request: AdapterStartRequest): AdapterRun {
  return createChatCompletionsRun(request);
}

export function resumeCodexChatCompletions(request: AdapterResumeRequest): AdapterRun {
  return createChatCompletionsRun(request, request.providerSessionId);
}

function createChatCompletionsRun(
  request: AdapterStartRequest | AdapterResumeRequest,
  existingSessionId?: string
): AdapterRun {
  const sessionId = existingSessionId?.startsWith("chat-") ? existingSessionId : `chat-${randomUUID()}`;
  const abortController = new AbortController();
  let settled = false;

  const process: ProcessHandle = {
    get pid() { return undefined; },
    get child(): ChildProcessWithoutNullStreams {
      throw new Error("Chat Completions compatibility runs do not expose a child process");
    },
    events: { async *[Symbol.asyncIterator]() { /* network transport has no process events */ } },
    write: () => undefined,
    cancel: async () => { abortController.abort(); },
    wait: async () => ({ exitCode: settled ? 0 : null })
  };

  async function* events(): AsyncGenerator<AdapterEvent> {
    yield { kind: "session", providerSessionId: sessionId };
    yield { kind: "status", phase: "turn_started" };

    const history = [...(conversations.get(sessionId) ?? [])];
    history.push({ role: "user", content: request.prompt });
    try {
      const response = await fetch(chatCompletionsEndpoint(request.instance, request.env), {
        method: "POST",
        headers: chatHeaders(request.env),
        body: JSON.stringify({
          model: request.model || defaultModel(request.instance),
          messages: history,
          stream: true,
          ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {})
        }),
        signal: abortController.signal
      });
      if (!response.ok) throw new Error(`Chat Completions request failed (${response.status}): ${(await response.text()).slice(-2_000)}`);

      const messageId = `chat-message-${randomUUID()}`;
      let answer = "";
      let usage: RecordValue | undefined;
      for await (const chunk of readChatCompletion(response)) {
        if (chunk.id) {
          // Keep one stable local id; provider chunk ids are not guaranteed to
          // remain stable across relay implementations.
        }
        if (chunk.content) {
          answer += chunk.content;
          yield { kind: "message", phase: "delta", messageId, text: chunk.content };
        }
        if (chunk.usage) usage = chunk.usage;
      }
      if (!answer.trim()) throw new Error("Chat Completions returned no assistant text");

      conversations.set(sessionId, [...history, { role: "assistant", content: answer }]);
      if (usage) yield chatUsage(usage);
      yield { kind: "message", phase: "completed", messageId, text: answer };
      yield { kind: "status", phase: "turn_completed" };
      settled = true;
      yield { kind: "exit", exitCode: 0 };
    } catch (error) {
      if (abortController.signal.aborted) return;
      yield { kind: "error", error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      settled = true;
    }
  }

  return {
    process,
    events: { [Symbol.asyncIterator]: events },
    cancel: process.cancel,
    write: process.write
  };
}

function defaultModel(instance: AgentInstance): string {
  return instance.models?.[0]?.id || "gpt-5-codex";
}

function chatCompletionsEndpoint(instance: AgentInstance, environment?: Record<string, string | undefined>): string {
  const configured = instance.providerOptions?.baseUrl;
  const raw = typeof configured === "string" && configured.trim()
    ? configured.trim()
    : environment?.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
  const normalized = raw.replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(normalized) ? normalized : `${normalized}/chat/completions`;
}

function chatHeaders(environment?: Record<string, string | undefined>): Record<string, string> {
  const apiKey = environment?.OPENAI_API_KEY ?? environment?.CODEX_API_KEY ?? environment?.AGENTHUB_API_KEY;
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  };
}

interface ChatChunk {
  id?: string;
  content?: string;
  usage?: RecordValue;
}

async function* readChatCompletion(response: Response): AsyncGenerator<ChatChunk> {
  const body = response.body;
  if (!body) throw new Error("Chat Completions returned an empty response body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let sawSse = false;
  try {
    while (true) {
      const next = await reader.read();
      pending += decoder.decode(next.value, { stream: !next.done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
        sawSse = true;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        yield parseChatChunk(payload);
      }
      if (next.done) break;
    }
    const trailing = pending.trim();
    if (trailing.startsWith("data:")) {
      const payload = trailing.slice(5).trim();
      if (payload && payload !== "[DONE]") yield parseChatChunk(payload);
    } else if (!sawSse && trailing) {
      yield parseChatJson(trailing);
    }
  } finally {
    reader.releaseLock();
  }
}

function parseChatChunk(payload: string): ChatChunk {
  try {
    return parseChatJson(payload);
  } catch (error) {
    throw new Error(`Invalid Chat Completions stream chunk: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseChatJson(payload: string): ChatChunk {
  const value = JSON.parse(payload) as RecordValue;
  const choice = Array.isArray(value.choices) ? value.choices[0] as RecordValue | undefined : undefined;
  const delta = choice?.delta as RecordValue | undefined;
  const message = choice?.message as RecordValue | undefined;
  const content = typeof delta?.content === "string"
    ? delta.content
    : typeof message?.content === "string" ? message.content : undefined;
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    content,
    usage: value.usage && typeof value.usage === "object" ? value.usage as RecordValue : undefined
  };
}

function chatUsage(usage: RecordValue): AdapterEvent {
  const promptTokens = numberValue(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = numberValue(usage.completion_tokens ?? usage.output_tokens);
  return {
    kind: "usage",
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    raw: usage
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
