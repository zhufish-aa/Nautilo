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

export function parseCodexAppServerNotification(method: string, paramsValue: unknown): AdapterEvent[] {
  const params = record(paramsValue);
  if (method === "item/agentMessage/delta") {
    return [{ kind: "message", phase: "delta", messageId: text(params.itemId), text: text(params.delta) ?? "", raw: paramsValue }];
  }
  if (method === "item/reasoning/summaryTextDelta") {
    return [{ kind: "thinking", phase: "delta", messageId: text(params.itemId), text: text(params.delta) ?? "", raw: paramsValue }];
  }
  if (method === "turn/started") return [{ kind: "status", phase: "turn_started", raw: paramsValue }];
  if (method === "turn/completed") return [{ kind: "status", phase: "turn_completed", raw: paramsValue }];
  if (method === "thread/tokenUsage/updated") {
    const usage = record(params.tokenUsage ?? params.usage);
    const total = record(usage.total ?? usage);
    const last = record(usage.last ?? usage);
    return [{
      kind: "usage",
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
    // Codex multi-agent collab call (spawnAgent / sendInput / wait / …). The
    // spawnAgent variant is Nautilo's sub-agent dispatch; its receiver thread
    // ids are correlated back to this item's id by the run loop.
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
      input: { prompt: text(item.prompt), model: text(item.model) },
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
    return summary ? [{ kind: "thinking", phase: "completed", messageId: id, text: summary, raw: paramsValue }] : [];
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
      output: printable(item.result ?? item.output ?? item.error),
      success: item.status !== "failed" && item.error === undefined,
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
  return events.map((event) => {
    switch (event.kind) {
      case "message":
      case "thinking":
      case "tool":
      case "command":
        return { ...event, subagentDispatchId };
      default:
        return event;
    }
  });
}
