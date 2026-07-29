import type { AdapterEvent, AdapterFileDiff } from "../types.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => typeof value === "object" && value !== null ? value as RecordValue : {};
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const TOOL_INPUT_IDENTITY_KEYS = [
  "path",
  "file_path",
  "filePath",
  "target_path",
  "targetPath",
  "query",
  "pattern",
  "glob"
] as const;

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

function toolInput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const source = value as RecordValue;
  const prioritized: RecordValue = {};
  for (const key of TOOL_INPUT_IDENTITY_KEYS) {
    if (Object.hasOwn(source, key)) prioritized[key] = source[key];
  }
  for (const [key, entry] of Object.entries(source)) {
    if (!Object.hasOwn(prioritized, key)) prioritized[key] = entry;
  }
  return prioritized;
}

function mergeToolInput(previous: unknown, current: unknown): unknown {
  if (
    typeof previous !== "object" || previous === null || Array.isArray(previous)
    || typeof current !== "object" || current === null || Array.isArray(current)
  ) return current ?? previous;
  return toolInput({ ...previous as RecordValue, ...current as RecordValue });
}

function toolInputIdentity(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as RecordValue;
  const identity = TOOL_INPUT_IDENTITY_KEYS.flatMap((key) => {
    const entry = input[key];
    return typeof entry === "string" && entry.trim() ? [[key, entry.trim()] as const] : [];
  });
  return identity.length ? JSON.stringify(identity) : undefined;
}

function firstString(input: RecordValue, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function fileDiff(toolName: string, value: unknown): AdapterFileDiff | undefined {
  const normalized = toolName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const isEdit = normalized === "edit"
    || normalized.startsWith("edit_")
    || normalized.startsWith("editing_")
    || normalized.endsWith("_edit")
    || normalized.endsWith("_edit_file");
  const isWrite = normalized === "write"
    || normalized.startsWith("write_")
    || normalized.startsWith("writing_")
    || normalized.endsWith("_write")
    || normalized.endsWith("_write_file");
  if (!isEdit && !isWrite) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as RecordValue;
  const path = firstString(input, TOOL_INPUT_IDENTITY_KEYS);
  if (isWrite) {
    const content = firstString(input, ["content", "text", "data"]);
    return content === undefined ? undefined : { operation: "write", path, before: "", after: content };
  }
  const before = firstString(input, ["old_string", "oldString", "old_text", "oldText", "before"]);
  const after = firstString(input, ["new_string", "newString", "new_text", "newText", "after"]);
  if (before === undefined || after === undefined) return undefined;
  return {
    operation: "edit",
    path,
    before,
    after
  };
}

export interface KimiAcpParseState {
  messageId: string;
  thinkingId: string;
  toolNames: Map<string, string>;
  toolCalls: Map<string, {
    phase: "started" | "completed";
    input?: unknown;
    inputIdentity?: string;
    output?: string;
  }>;
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
    return content.type === "text" && typeof content.text === "string" && content.text.length > 0
      ? [{ kind: "thinking", phase: "delta", messageId: state.thinkingId, text: content.text, raw: value }]
      : [];
  }
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return [];
  const callId = string(update.toolCallId);
  const suppliedName = string(update.title);
  if (callId && suppliedName && !state.toolNames.has(callId)) state.toolNames.set(callId, suppliedName);
  const name = (callId ? state.toolNames.get(callId) : undefined) ?? suppliedName ?? "tool";
  const status = string(update.status);
  const completed = status === "completed" || status === "failed";
  const input = update.rawInput === undefined ? undefined : toolInput(update.rawInput);
  const output = printable(update.rawOutput) ?? printable(update.content);
  if (callId) {
    const previous = state.toolCalls.get(callId);
    const mergedInput = input === undefined ? previous?.input : mergeToolInput(previous?.input, input);
    const next = {
      phase: completed ? "completed" as const : "started" as const,
      input: mergedInput,
      inputIdentity: toolInputIdentity(mergedInput),
      output: output ?? previous?.output
    };
    state.toolCalls.set(callId, next);
    if (
      previous?.phase === "completed"
      || (!completed && previous?.phase === "started" && previous.inputIdentity === next.inputIdentity)
    ) return [];
    return [{
      kind: "tool",
      callId,
      name,
      phase: next.phase,
      input: next.input,
      output: next.output,
      success: status !== "failed",
      fileDiff: fileDiff(name, next.input),
      raw: value
    }];
  }
  return [{
    kind: "tool",
    callId,
    name,
    phase: completed ? "completed" : "started",
    input,
    output,
    success: status !== "failed",
    fileDiff: fileDiff(name, input),
    raw: value
  }];
}
