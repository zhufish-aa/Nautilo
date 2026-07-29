import type { AdapterEvent, AdapterFileDiff } from "../types.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => (value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {});
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

export interface ClaudeParseState {
  /** tool_use_id → tool name, so tool_result completions keep their tool identity. */
  toolNames: Map<string, string>;
  /** Current streaming message id, from message_start (partial messages mode). */
  streamMessageId?: string;
  /** content_block index → block type, so deltas can be attributed to text vs thinking. */
  streamBlocks: Map<number, string>;
  /** Latest single-request prompt size (input + cache tokens) — the real context footprint. */
  lastContextUsed?: number;
  /** Sticky context window learned from result modelUsage. */
  contextWindow?: number;
}

export function createClaudeParseState(): ClaudeParseState {
  return { toolNames: new Map(), streamBlocks: new Map() };
}

function printable(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (Array.isArray(value)) {
    const parts = value.map((item) => {
      const block = record(item);
      return block.type === "text" ? text(block.text) : printable(item);
    }).filter((part): part is string => Boolean(part));
    return parts.length ? parts.join("\n") : undefined;
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function fileDiff(toolName: string, input: unknown): AdapterFileDiff | undefined {
  const args = record(input);
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "write") {
    const content = text(args.content);
    return content === undefined ? undefined : { operation: "write", path: text(args.file_path), before: "", after: content };
  }
  if (normalized === "edit") {
    const before = text(args.old_string);
    const after = text(args.new_string);
    return before === undefined || after === undefined
      ? undefined
      : { operation: "edit", path: text(args.file_path), before, after };
  }
  if (normalized === "multiedit") {
    const edits = Array.isArray(args.edits) ? args.edits.map(record) : [];
    if (edits.length === 0) return undefined;
    const before = edits.map((edit) => text(edit.old_string) ?? "").join("\n");
    const after = edits.map((edit) => text(edit.new_string) ?? "").join("\n");
    return { operation: "edit", path: text(args.file_path), before, after };
  }
  if (normalized === "notebookedit") {
    const after = text(args.new_source);
    return after === undefined ? undefined : { operation: "edit", path: text(args.notebook_path), before: "", after };
  }
  return undefined;
}

function parseInit(event: RecordValue, raw: unknown): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  const sessionId = text(event.session_id);
  if (sessionId) events.push({ kind: "session", providerSessionId: sessionId, raw });
  const commands = Array.isArray(event.slash_commands)
    ? event.slash_commands
      .map((name) => (typeof name === "string" ? name.replace(/^\//, "").trim() : ""))
      .filter((name) => name.length > 0)
      .map((name) => ({ name, description: name }))
    : [];
  if (commands.length) events.push({ kind: "commands", commands, raw });
  return events;
}

function parseAssistant(event: RecordValue, state: ClaudeParseState, raw: unknown, subagentDispatchId?: string): AdapterEvent[] {
  const message = record(event.message);
  const messageId = text(message.id);
  const content = Array.isArray(message.content) ? message.content : [];
  const events: AdapterEvent[] = [];
  for (const blockValue of content) {
    const block = record(blockValue);
    if (block.type === "text") {
      const value = text(block.text);
      if (value) events.push({ kind: "message", phase: "completed", messageId, text: value, subagentDispatchId, raw });
    } else if (block.type === "thinking") {
      const value = text(block.thinking);
      if (value) events.push({ kind: "thinking", phase: "completed", messageId: messageId ? `${messageId}-thinking` : undefined, text: value, subagentDispatchId, raw });
    } else if (block.type === "tool_use") {
      const callId = text(block.id);
      const name = text(block.name) ?? "tool";
      if (callId) state.toolNames.set(callId, name);
      events.push({ kind: "tool", callId, name, phase: "started", input: block.input, fileDiff: fileDiff(name, block.input), subagentDispatchId, raw });
    }
  }
  // Per-request usage is the only truthful context-footprint source: the
  // result event's usage is cumulative across every API call of the CLI
  // session (cache reads included), which overcounts the window massively.
  // Sub-agent requests have their own contexts and must not move the indicator.
  if (!subagentDispatchId) {
    const usage = record(message.usage);
    const inputTokens = number(usage.input_tokens);
    const cachedInputTokens = (number(usage.cache_read_input_tokens) ?? 0) + (number(usage.cache_creation_input_tokens) ?? 0);
    if (inputTokens !== undefined || cachedInputTokens > 0) {
      const contextUsed = (inputTokens ?? 0) + cachedInputTokens;
      state.lastContextUsed = contextUsed;
      events.push({
        kind: "usage",
        inputTokens,
        cachedInputTokens: cachedInputTokens > 0 ? cachedInputTokens : undefined,
        outputTokens: number(usage.output_tokens),
        contextUsed,
        contextWindow: state.contextWindow,
        raw
      });
    }
  }
  return events;
}

function parseUser(event: RecordValue, state: ClaudeParseState, raw: unknown, subagentDispatchId?: string): AdapterEvent[] {
  const message = record(event.message);
  const content = Array.isArray(message.content) ? message.content : [];
  const events: AdapterEvent[] = [];
  for (const blockValue of content) {
    const block = record(blockValue);
    if (block.type !== "tool_result") continue;
    const callId = text(block.tool_use_id);
    const name = (callId ? state.toolNames.get(callId) : undefined) ?? "tool";
    events.push({
      kind: "tool",
      callId,
      name,
      phase: "completed",
      output: printable(block.content),
      success: block.is_error !== true,
      subagentDispatchId,
      raw
    });
  }
  return events;
}

function parseResult(event: RecordValue, state: ClaudeParseState, raw: unknown): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  const sessionId = text(event.session_id);
  if (sessionId) events.push({ kind: "session", providerSessionId: sessionId, raw });
  const usage = record(event.usage);
  const modelUsage = Object.values(record(event.modelUsage)).map(record);
  const contextWindow = modelUsage.map((entry) => number(entry.contextWindow)).find((value) => value !== undefined);
  if (contextWindow !== undefined) state.contextWindow = contextWindow;
  // result.usage totals are cumulative across the whole CLI session; they stay
  // useful as throughput numbers, but contextUsed must come from the latest
  // single request (tracked in parseAssistant), never from these sums.
  const inputTokens = number(usage.input_tokens);
  const cachedInputTokens = (number(usage.cache_read_input_tokens) ?? 0) + (number(usage.cache_creation_input_tokens) ?? 0);
  if (inputTokens !== undefined || cachedInputTokens > 0 || number(usage.output_tokens) !== undefined) {
    events.push({
      kind: "usage",
      inputTokens,
      cachedInputTokens: cachedInputTokens > 0 ? cachedInputTokens : undefined,
      outputTokens: number(usage.output_tokens),
      contextUsed: state.lastContextUsed,
      contextWindow,
      raw
    });
  }
  const failed = event.is_error === true;
  events.push({ kind: "status", phase: failed ? "turn_failed" : "turn_completed", raw });
  if (failed) events.push({ kind: "error", error: new Error(text(event.result) ?? `Claude Code turn failed (${text(event.subtype) ?? "unknown"})`) });
  return events;
}

/**
 * Parses a `stream_event` line emitted under --include-partial-messages. The
 * inner event follows the Anthropic API message-stream shape; only text and
 * thinking deltas surface — tool calls still arrive complete via `assistant`.
 */
function parseStreamEvent(wrapper: RecordValue, state: ClaudeParseState, raw: unknown, subagentDispatchId?: string): AdapterEvent[] {
  const event = record(wrapper.event);
  const type = event.type;
  if (type === "message_start") {
    state.streamMessageId = text(record(event.message).id);
    state.streamBlocks.clear();
    return [];
  }
  if (type === "content_block_start") {
    const index = number(event.index);
    const blockType = text(record(event.content_block).type);
    if (index !== undefined && blockType) state.streamBlocks.set(index, blockType);
    return [];
  }
  if (type === "content_block_stop") {
    const index = number(event.index);
    if (index !== undefined) state.streamBlocks.delete(index);
    return [];
  }
  if (type !== "content_block_delta") return [];
  const index = number(event.index);
  const blockType = index !== undefined ? state.streamBlocks.get(index) : undefined;
  const delta = record(event.delta);
  const messageId = state.streamMessageId;
  // Whitespace-only deltas are meaningful (paragraph breaks), so unlike the
  // text() helper they are kept here; only non-strings and "" are dropped.
  const deltaText = (value: unknown): string | undefined => (typeof value === "string" && value.length ? value : undefined);
  if (delta.type === "text_delta" || (!delta.type && blockType === "text")) {
    const value = deltaText(delta.text);
    return value ? [{ kind: "message", phase: "delta", messageId, text: value, subagentDispatchId, raw }] : [];
  }
  if (delta.type === "thinking_delta" || (!delta.type && blockType === "thinking")) {
    const value = deltaText(delta.thinking);
    return value ? [{ kind: "thinking", phase: "delta", messageId: messageId ? `${messageId}-thinking` : undefined, text: value, subagentDispatchId, raw }] : [];
  }
  return [];
}

/** Parses one `claude -p --output-format stream-json --verbose` line. */
export function parseClaudeJsonEvent(value: unknown, state: ClaudeParseState = createClaudeParseState()): AdapterEvent[] {
  const event = record(value);
  const type = event.type;
  // Sub-agent activity carries parent_tool_use_id pointing at the dispatching
  // Agent/Task tool call; surface it so the host can nest the activity.
  const subagentDispatchId = text(event.parent_tool_use_id);
  if (type === "system" && event.subtype === "init") return parseInit(event, value);
  if (type === "stream_event") return parseStreamEvent(event, state, value, subagentDispatchId);
  if (type === "assistant") return parseAssistant(event, state, value, subagentDispatchId);
  if (type === "user") return parseUser(event, state, value, subagentDispatchId);
  if (type === "result") {
    const events = parseResult(event, state, value);
    state.toolNames.clear();
    state.streamMessageId = undefined;
    state.streamBlocks.clear();
    return events;
  }
  return [];
}
