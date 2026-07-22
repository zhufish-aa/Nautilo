import { normalizeJson } from "../normalize.js";
import type { AdapterEvent } from "../types.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function itemEvents(type: string, item: JsonRecord, raw: unknown): AdapterEvent[] {
  const itemType = typeof item.type === "string" ? item.type : "";
  const completed = type === "item.completed";

  if (itemType === "agent_message" && completed && typeof item.text === "string") {
    return [{ kind: "message", text: item.text, raw }];
  }
  if (itemType === "reasoning" && completed && typeof item.text === "string") {
    return [{ kind: "thinking", text: item.text, raw }];
  }
  if (itemType === "command_execution" && typeof item.command === "string") {
    return [{
      kind: "command",
      command: item.command,
      phase: completed ? "completed" : "started",
      exitCode: completed ? number(item.exit_code) : undefined,
      output: completed && typeof item.aggregated_output === "string" ? item.aggregated_output : undefined,
      raw
    }];
  }
  if (itemType === "mcp_tool_call") {
    const name = [item.server, item.tool].filter((value) => typeof value === "string").join("/") || "mcp";
    return [{ kind: "tool", name, phase: completed ? "completed" : "started", input: item.arguments, output: item.result, raw }];
  }
  if (itemType === "web_search") {
    return [{ kind: "tool", name: "web_search", phase: completed ? "completed" : "started", input: item.query, raw }];
  }
  if (itemType === "file_change" && completed) {
    const changes = Array.isArray(item.changes) ? item.changes : [item];
    return changes.flatMap((change): AdapterEvent[] => {
      const entry = record(change);
      const path = entry && typeof entry.path === "string" ? entry.path : undefined;
      return path ? [{
        kind: "file",
        path,
        changeType: typeof entry?.kind === "string" ? entry.kind : "modified",
        additions: number(entry?.additions),
        deletions: number(entry?.deletions),
        diff: typeof entry?.diff === "string" ? entry.diff : typeof entry?.patch === "string" ? entry.patch : undefined,
        raw
      }] : [];
    });
  }
  return [];
}

export function parseCodexJsonEvent(value: unknown): AdapterEvent[] {
  const event = record(value);
  if (!event || typeof event.type !== "string") return normalizeJson(value);

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    return [{ kind: "session", providerSessionId: event.thread_id, raw: value }];
  }
  if (event.type === "turn.started") return [{ kind: "status", phase: "turn_started", raw: value }];
  if (event.type === "turn.completed") {
    const usage = record(event.usage);
    const events: AdapterEvent[] = [];
    if (usage) events.push({
      kind: "usage",
      inputTokens: number(usage.input_tokens),
      cachedInputTokens: number(usage.cached_input_tokens),
      outputTokens: number(usage.output_tokens),
      reasoningOutputTokens: number(usage.reasoning_output_tokens),
      raw: value
    });
    events.push({ kind: "status", phase: "turn_completed", raw: value });
    return events;
  }
  if (event.type === "turn.failed") {
    const failure = record(event.error);
    const message = typeof failure?.message === "string" ? failure.message : "Codex turn failed";
    return [{ kind: "status", phase: "turn_failed", raw: value }, { kind: "error", error: new Error(message) }];
  }
  if (event.type === "error") {
    return [{ kind: "error", error: new Error(typeof event.message === "string" ? event.message : "Codex reported an error") }];
  }
  if (event.type.startsWith("item.")) {
    const item = record(event.item);
    return item ? itemEvents(event.type, item, value) : [];
  }
  return normalizeJson(value);
}
