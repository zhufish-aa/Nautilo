import type { AdapterEvent } from "../types.js";
import { existsSync } from "node:fs";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => typeof value === "object" && value !== null ? value as RecordValue : {};
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

function printable(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function isCurrentCodexTurnDiff(paramsValue: unknown, threadId?: string, turnId?: string): boolean {
  const params = record(paramsValue);
  return Boolean(threadId && turnId) && params.threadId === threadId && params.turnId === turnId;
}

export function parseCodexAppServerNotification(method: string, paramsValue: unknown): AdapterEvent[] {
  const params = record(paramsValue);
  if (method === "turn/diff/updated") {
    if (typeof params.diff !== "string" || typeof params.threadId !== "string" || typeof params.turnId !== "string") return [];
    return [{ kind: "turn_diff", diff: params.diff, threadId: params.threadId, turnId: params.turnId, raw: paramsValue }];
  }
  if (method === "item/agentMessage/delta") {
    return [{ kind: "message", phase: "delta", messageId: text(params.itemId), text: text(params.delta) ?? "", raw: paramsValue }];
  }
  if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
    const id = text(params.itemId);
    return [{ kind: "thinking", phase: "delta", messageId: method === "item/reasoning/textDelta" && id ? `${id}:content` : id, text: text(params.delta) ?? "", raw: paramsValue }];
  }
  if (method === "turn/started") return [{ kind: "status", phase: "turn_started", raw: paramsValue }];
  if (method === "turn/completed") {
    const turn = record(params.turn);
    const failed = turn.status === "failed" || (turn.error !== undefined && turn.error !== null);
    return [{ kind: "status", phase: failed ? "turn_failed" : "turn_completed", raw: paramsValue },
      ...(failed ? [{ kind: "error" as const, error: new Error(text(record(turn.error).message) ?? "Codex turn failed before producing a reply") }] : [])];
  }
  if (method === "error") return params.willRetry === true
    ? [{ kind: "status", phase: "turn_started", raw: paramsValue }]
    : [{ kind: "error", error: new Error(text(record(params.error).message) ?? text(params.message) ?? "Codex reported an error") }];
  if (method === "thread/tokenUsage/updated") {
    const usage = record(params.tokenUsage ?? params.usage);
    const total = record(usage.total ?? usage);
    const last = record(usage.last ?? usage);
    return [{
      kind: "usage",
      usageScope: "session",
      usageKey: text(params.threadId),
      inputTokensIncludesCache: true,
      inputTokens: typeof total.inputTokens === "number" ? total.inputTokens : undefined,
      cachedInputTokens: typeof total.cachedInputTokens === "number" ? total.cachedInputTokens : undefined,
      outputTokens: typeof total.outputTokens === "number" ? total.outputTokens : undefined,
      reasoningOutputTokens: typeof total.reasoningOutputTokens === "number" ? total.reasoningOutputTokens : undefined,
      // `total` is cumulative for the entire thread and can legitimately exceed the
      // context window. `last` is the current model request and drives the context ring.
      contextUsed: typeof last.totalTokens === "number" ? last.totalTokens : undefined,
      contextWindow: typeof usage.modelContextWindow === "number" ? usage.modelContextWindow : undefined,
      raw: paramsValue
    }];
  }
  if (method !== "item/started" && method !== "item/completed") return [];

  const item = record(params.item);
  const phase = method === "item/completed" ? "completed" : "started";
  const id = text(item.id);
  if (item.type === "collabAgentToolCall") {
    // Provider-native dispatch, distinct from Nautilo team delegation.
    const states = record(item.agentsStates);
    const stateSummary = Object.entries(states)
      .map(([threadId, state]) => {
        const status = text(record(state).status) ?? "unknown";
        const message = text(record(state).message);
        return `${threadId}: ${status}${message ? ` — ${message}` : ""}`;
      })
      .join("\n");
    return [{
      kind: "tool",
      callId: id,
      name: text(item.tool) ?? "spawnAgent",
      phase,
      input: { agent_type: "Codex", prompt: text(item.prompt), model: text(item.model), receiverThreadIds: item.receiverThreadIds, agentsStates: item.agentsStates },
      output: phase === "completed" ? stateSummary || undefined : undefined,
      success: text(item.status) !== "failed",
      raw: paramsValue
    }];
  }
  if (item.type === "agentMessage") {
    if (phase === "started") return [];
    return [{ kind: "message", phase: "completed", messageId: id, text: text(item.text) ?? "", raw: paramsValue }];
  }
  if (item.type === "reasoning") {
    if (phase === "started") return [];
    const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === "string").join("\n") : "";
    const content = Array.isArray(item.content) ? item.content.filter((part): part is string => typeof part === "string").join("\n") : "";
    return [
      ...(summary ? [{ kind: "thinking" as const, phase: "completed" as const, messageId: id, text: summary, raw: paramsValue }] : []),
      ...(content ? [{ kind: "thinking" as const, phase: "completed" as const, messageId: id ? `${id}:content` : undefined, text: content, raw: paramsValue }] : [])
    ];
  }
  if (item.type === "commandExecution") {
    return [{
      kind: "command",
      callId: id,
      command: text(item.command) ?? "command",
      phase,
      exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
      output: text(item.aggregatedOutput),
      raw: paramsValue
    }];
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const name = item.type === "mcpToolCall"
      ? [text(item.server), text(item.tool)].filter(Boolean).join("/")
      : text(item.tool);
    return [{
      kind: "tool",
      callId: id,
      name: name || "tool",
      phase,
      input: item.arguments ?? item.input,
      output: printable(item.result ?? item.output ?? item.contentItems ?? item.error),
      success: phase === "completed"
        ? item.success !== false && item.status !== "failed" && item.error == null && record(item.result).isError !== true
        : undefined,
      raw: paramsValue
    }];
  }
  if (item.type === "webSearch") {
    return [{ kind: "tool", callId: id, name: "web_search", phase, input: item.action ?? item.query, output: phase === "completed" ? printable(item.action ?? item.query) : undefined, success: true, raw: paramsValue }];
  }
  if (item.type === "imageGeneration") {
    if (phase === "started") return [{ kind: "tool", callId: id, name: "image_generation", phase: "started", input: item.revisedPrompt, raw: paramsValue }];
    const result = text(item.result);
    const savedPath = text(item.savedPath);
    const persistedPath = savedPath && existsSync(savedPath) ? savedPath : undefined;
    const status = text(item.status);
    const events: AdapterEvent[] = [{
      kind: "tool",
      callId: id,
      name: "image_generation",
      phase: "completed",
      output: persistedPath ?? (result ? "图片已生成" : status),
      success: status !== "failed",
      raw: paramsValue
    }];
    if (result || persistedPath) events.push({
      kind: "artifact",
      artifactType: "image",
      name: persistedPath?.split(/[\\/]/).at(-1) ?? `generated-${id ?? "image"}.png`,
      mimeType: "image/png",
      // Codex already persisted the image. Prefer the path to avoid copying a
      // multi-megabyte base64 payload through SQLite, IPC, and React state.
      data: persistedPath ? undefined : result,
      path: persistedPath,
      raw: paramsValue
    });
    return events;
  }
  if (item.type === "fileChange" && phase === "completed") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return changes.flatMap((change) => {
      const value = record(change);
      const path = text(value.path);
      return path ? [{
        kind: "file" as const,
        path,
        changeType: text(value.kind),
        additions: typeof value.additions === "number" ? value.additions : undefined,
        deletions: typeof value.deletions === "number" ? value.deletions : undefined,
        diff: text(value.diff) ?? text(value.patch),
        raw: paramsValue
      }] : [];
    });
  }
  return [];
}

/** Tags events emitted from a subscribed child agent thread with their dispatch id. */
export function withSubagentDispatch(events: AdapterEvent[], subagentDispatchId: string): AdapterEvent[] {
  return events.flatMap((event): AdapterEvent[] => {
    switch (event.kind) {
      case "message":
      case "thinking":
      case "tool":
      case "command":
        return [{ ...event, subagentDispatchId }];
      case "file":
        return [event];
      default:
        return [];
    }
  });
}

export function updateNativeChild(dispatch: RecordValue, childId: string, status: string, message?: string): AdapterEvent[] {
  dispatch.agentsStates = { ...record(dispatch.agentsStates), [childId]: { status, message } };
  return parseCodexAppServerNotification("item/completed", { item: dispatch });
}

export function nativeChildHistory(threadValue: unknown, dispatchId: string): AdapterEvent[] {
  const thread = record(threadValue);
  return (Array.isArray(thread.turns) ? thread.turns : []).flatMap((turnValue): AdapterEvent[] => {
    const turn = record(turnValue);
    return (Array.isArray(turn.items) ? turn.items : []).flatMap((itemValue): AdapterEvent[] => {
      const item = record(itemValue);
      return withSubagentDispatch(parseCodexAppServerNotification(item.status === "inProgress" ? "item/started" : "item/completed", { item }), dispatchId);
    });
  });
}
