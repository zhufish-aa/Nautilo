import type { AdapterEvent } from "../types.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => typeof value === "object" && value !== null ? value as RecordValue : {};
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

function printable(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (Array.isArray(value)) {
    const parts = value.map(printable).filter((part): part is string => Boolean(part));
    return parts.length ? parts.join("\n") : undefined;
  }
  const object = record(value);
  if (typeof object.text === "string" && object.text.trim()) return object.text;
  if (object.content !== undefined) {
    const nested = printable(object.content);
    if (nested) return nested;
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export interface KimiAcpParseState {
  messageId: string;
  thinkingId: string;
  toolNames: Map<string, string>;
}

export function parseKimiAcpUpdate(value: unknown, state: KimiAcpParseState): AdapterEvent[] {
  const update = record(value);
  if (update.sessionUpdate === "available_commands_update") {
    const commands = Array.isArray(update.availableCommands) ? update.availableCommands.map(record).flatMap((command) => {
      const name = string(command.name);
      if (!name) return [];
      const input = record(command.input);
      return [{
        name,
        description: string(command.description) ?? name,
        inputHint: string(input.hint)
      }];
    }) : [];
    return commands.length ? [{ kind: "commands", commands, raw: value }] : [];
  }
  if (update.sessionUpdate === "usage_update") {
    return [{
      kind: "usage",
      contextUsed: typeof update.used === "number" ? update.used : undefined,
      contextWindow: typeof update.size === "number" ? update.size : undefined,
      raw: value
    }];
  }
  if (update.sessionUpdate === "agent_message_chunk") {
    const content = record(update.content);
    return content.type === "text" && typeof content.text === "string"
      ? [{ kind: "message", phase: "delta", messageId: state.messageId, text: content.text, raw: value }]
      : [];
  }
  if (update.sessionUpdate === "agent_thought_chunk") {
    const content = record(update.content);
    return content.type === "text" && typeof content.text === "string"
      ? [{ kind: "thinking", phase: "delta", messageId: state.thinkingId, text: content.text, raw: value }]
      : [];
  }
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return [];
  const callId = string(update.toolCallId);
  const suppliedName = string(update.title);
  if (callId && suppliedName) state.toolNames.set(callId, suppliedName);
  const name = (callId ? state.toolNames.get(callId) : undefined) ?? suppliedName ?? "tool";
  const status = string(update.status);
  const completed = status === "completed" || status === "failed";
  return [{
    kind: "tool",
    callId,
    name,
    phase: completed ? "completed" : "started",
    input: printable(update.rawInput),
    output: printable(update.rawOutput) ?? printable(update.content),
    success: status !== "failed",
    raw: value
  }];
}
