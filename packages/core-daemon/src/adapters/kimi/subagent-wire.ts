import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AdapterEvent } from "../types.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => typeof value === "object" && value !== null ? value as RecordValue : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const MAX_PROMPT_BYTES = 512 * 1024;
const MAX_POLL_BYTES = 1024 * 1024;

export interface KimiSubagentWireParseState {
  agentId: string;
  messageIndex: number;
  toolCalls: Map<string, { name: string; input?: unknown }>;
  finished: boolean;
}

export function createKimiSubagentWireParseState(agentId: string): KimiSubagentWireParseState {
  return { agentId, messageIndex: 0, toolCalls: new Map(), finished: false };
}

function printable(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (Array.isArray(value)) {
    const parts = value.map(printable).filter((part): part is string => Boolean(part));
    return parts.length ? parts.join("\n") : undefined;
  }
  const object = record(value);
  if (typeof object.text === "string" && object.text.trim()) return object.text;
  if (object.output !== undefined) {
    const nested = printable(object.output);
    if (nested) return nested;
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/** Converts one provider-owned sub-agent wire record into nested activity. */
export function parseKimiSubagentWireLine(
  line: string,
  state: KimiSubagentWireParseState,
  subagentDispatchId: string
): AdapterEvent[] {
  let wrapper: RecordValue;
  try { wrapper = record(JSON.parse(line)); } catch { return []; }
  if (wrapper.type !== "context.append_loop_event") return [];
  const event = record(wrapper.event);
  if (event.type === "content.part") {
    const part = record(event.part);
    // Kimi's private `think` records are intentionally not projected. Text
    // parts are user-visible progress/final notes and are safe to surface.
    if (part.type !== "text") return [];
    const value = text(part.text);
    if (!value) return [];
    state.messageIndex += 1;
    return [{
      kind: "message",
      phase: "completed",
      messageId: `kimi-${state.agentId}-message-${state.messageIndex}`,
      text: value,
      subagentDispatchId,
      raw: wrapper
    }];
  }
  if (event.type === "tool.call") {
    const callId = text(event.toolCallId);
    const name = text(event.name) ?? "tool";
    const input = event.args;
    if (callId) state.toolCalls.set(callId, { name, input });
    return [{
      kind: "tool",
      callId,
      name,
      phase: "started",
      input,
      subagentDispatchId,
      raw: wrapper
    }];
  }
  if (event.type === "tool.result") {
    const callId = text(event.toolCallId);
    const previous = callId ? state.toolCalls.get(callId) : undefined;
    const result = record(event.result);
    return [{
      kind: "tool",
      callId,
      name: previous?.name ?? "tool",
      phase: "completed",
      input: previous?.input,
      output: printable(result.output ?? event.result),
      success: result.isError !== true,
      subagentDispatchId,
      raw: wrapper
    }];
  }
  if (event.type === "step.end" && event.finishReason === "end_turn") state.finished = true;
  return [];
}

interface ChildWire {
  agentId: string;
  path: string;
  size: number;
  modifiedMs: number;
}

interface DispatchState {
  callId: string;
  prompt?: string;
  resumeAgentId?: string;
  agentId?: string;
  wirePath?: string;
  offset: number;
  carry: string;
  decoder: StringDecoder;
  parser?: KimiSubagentWireParseState;
}

/**
 * Tails Kimi's provider-owned child-agent wires while ACP waits on `Agent`.
 * Kimi 0.27 only projects the parent Agent tool through ACP; the child tools
 * remain in `<session>/agents/agent-N/wire.jsonl` until the final result.
 */
export class KimiSubagentWireWatcher {
  private sessionDir?: string;
  private initialized = false;
  private readonly initialSizes = new Map<string, number>();
  private readonly claimedAgents = new Set<string>();
  private readonly promptCache = new Map<string, string>();
  private readonly dispatches = new Map<string, DispatchState>();

  constructor(
    private readonly providerSessionId: string,
    private readonly kimiHome = process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code")
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.sessionDir = await findSessionDir(join(this.kimiHome, "sessions"), this.providerSessionId);
    if (!this.sessionDir) return;
    for (const child of await listChildWires(this.sessionDir)) this.initialSizes.set(child.agentId, child.size);
    this.initialized = true;
  }

  track(callId: string, input: unknown): void {
    const value = record(input);
    const prompt = firstText(value, ["prompt", "instruction", "instructions", "message", "goal"]);
    const resumeAgentId = firstText(value, ["resume", "agent_id", "agentId"]);
    const existing = this.dispatches.get(callId);
    if (existing) {
      existing.prompt ??= prompt;
      existing.resumeAgentId ??= resumeAgentId;
      return;
    }
    this.dispatches.set(callId, {
      callId,
      prompt,
      resumeAgentId,
      offset: 0,
      carry: "",
      decoder: new StringDecoder("utf8")
    });
  }

  hasActive(): boolean {
    return this.dispatches.size > 0;
  }

  release(callId: string): void {
    this.dispatches.delete(callId);
  }

  async poll(): Promise<AdapterEvent[]> {
    if (!this.dispatches.size) return [];
    await this.initialize();
    if (!this.sessionDir) return [];
    const children = await listChildWires(this.sessionDir);
    await this.assignChildren(children);
    const events: AdapterEvent[] = [];
    for (const dispatch of this.dispatches.values()) {
      if (!dispatch.wirePath || !dispatch.parser) continue;
      const chunk = await readWireChunk(dispatch.wirePath, dispatch.offset).catch(() => undefined);
      if (!chunk) continue;
      if (chunk.reset) {
        dispatch.offset = 0;
        dispatch.carry = "";
        dispatch.decoder = new StringDecoder("utf8");
        dispatch.parser = createKimiSubagentWireParseState(dispatch.agentId ?? "subagent");
      }
      dispatch.offset += chunk.buffer.length;
      const combined = dispatch.carry + dispatch.decoder.write(chunk.buffer);
      const lines = combined.split(/\r?\n/);
      dispatch.carry = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) events.push(...parseKimiSubagentWireLine(line, dispatch.parser, dispatch.callId));
      }
    }
    return events;
  }

  private async assignChildren(children: ChildWire[]): Promise<void> {
    const available = children.filter((child) => !this.claimedAgents.has(child.agentId));
    if (!available.length) return;
    for (const dispatch of this.dispatches.values()) {
      if (dispatch.agentId || !dispatch.resumeAgentId) continue;
      const resumed = available.find((child) => child.agentId === dispatch.resumeAgentId);
      if (resumed) this.assign(dispatch, resumed);
    }
    for (const dispatch of this.dispatches.values()) {
      if (dispatch.agentId || !dispatch.prompt) continue;
      for (const child of available) {
        if (this.claimedAgents.has(child.agentId)) continue;
        const childPrompt = await this.childPrompt(child);
        if (childPrompt?.includes(dispatch.prompt)) {
          this.assign(dispatch, child);
          break;
        }
      }
    }
    const unresolved = [...this.dispatches.values()].filter((dispatch) => !dispatch.agentId);
    const newChildren = available
      .filter((child) => !this.claimedAgents.has(child.agentId) && !this.initialSizes.has(child.agentId))
      .sort((left, right) => left.modifiedMs - right.modifiedMs || left.agentId.localeCompare(right.agentId));
    // Older Kimi builds do not preserve the dispatch prompt in every child
    // profile. Pair only when counts agree, preserving creation/call order.
    if (unresolved.length > 0 && unresolved.length === newChildren.length) {
      unresolved.forEach((dispatch, index) => this.assign(dispatch, newChildren[index]!));
    }
  }

  private assign(dispatch: DispatchState, child: ChildWire): void {
    dispatch.agentId = child.agentId;
    dispatch.wirePath = child.path;
    dispatch.offset = this.initialSizes.get(child.agentId) ?? 0;
    dispatch.parser = createKimiSubagentWireParseState(child.agentId);
    this.claimedAgents.add(child.agentId);
  }

  private async childPrompt(child: ChildWire): Promise<string | undefined> {
    const cached = this.promptCache.get(child.agentId);
    if (cached) return cached;
    const buffer = await readStart(child.path, Math.min(child.size, MAX_PROMPT_BYTES)).catch(() => undefined);
    if (!buffer) return undefined;
    for (const line of buffer.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let wrapper: RecordValue;
      try { wrapper = record(JSON.parse(line)); } catch { continue; }
      if (wrapper.type !== "turn.prompt") continue;
      const input = Array.isArray(wrapper.input) ? wrapper.input.map(record) : [];
      const prompt = input.map((item) => text(item.text)).filter((item): item is string => Boolean(item)).join("\n");
      if (prompt) this.promptCache.set(child.agentId, prompt);
      return prompt || undefined;
    }
    return undefined;
  }
}

function firstText(value: RecordValue, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = text(value[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

async function findSessionDir(sessionsRoot: string, providerSessionId: string): Promise<string | undefined> {
  let workspaces: string[];
  try { workspaces = await readdir(sessionsRoot); } catch { return undefined; }
  for (const workspace of workspaces) {
    const candidate = join(sessionsRoot, workspace, providerSessionId);
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      // Session ids are globally unique; continue with the next workspace.
    }
  }
  return undefined;
}

async function listChildWires(sessionDir: string): Promise<ChildWire[]> {
  const agentsDir = join(sessionDir, "agents");
  let entries;
  try { entries = await readdir(agentsDir, { withFileTypes: true }); } catch { return []; }
  const children: ChildWire[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "main") continue;
    const path = join(agentsDir, entry.name, "wire.jsonl");
    try {
      const info = await stat(path);
      if (info.isFile()) children.push({ agentId: entry.name, path, size: info.size, modifiedMs: info.mtimeMs });
    } catch {
      // The directory can appear just before Kimi creates its wire file.
    }
  }
  return children;
}

async function readStart(path: string, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readWireChunk(path: string, offset: number): Promise<{ buffer: Buffer; reset: boolean } | undefined> {
  let info;
  try { info = await stat(path); } catch { return undefined; }
  const reset = info.size < offset;
  const start = reset ? 0 : offset;
  const length = Math.min(MAX_POLL_BYTES, info.size - start);
  if (length <= 0) return undefined;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return { buffer: buffer.subarray(0, bytesRead), reset };
  } finally {
    await handle.close();
  }
}
