/**
 * Structured views over a sub-agent dispatch's raw input / output strings, so
 * the detail drawer can render them as readable sections instead of raw dumps.
 *
 * The output shape follows what CLI sub-agent tools return (kimi's Agent,
 * Claude's Task): an answer body, an optional `agentId: … (use SendMessage …)`
 * continuation line, and a trailing `<usage>key: value</usage>` block.
 */

export interface SubagentUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface SubagentResultView {
  body: string;
  agentId?: string;
  usage?: SubagentUsage;
}

const USAGE_BLOCK = /\s*<usage>([\s\S]*?)<\/usage>\s*$/;
const AGENT_ID_LINE = /^agentId:\s*([0-9A-Za-z_-]+)[^\n]*(?:\n|$)/m;
// opencode wraps the task tool's result in <task …><task_result>…</task_result></task>.
const TASK_OPEN = /^\s*<task\b[^>]*>\s*/;
const TASK_CLOSE = /\s*<\/task>\s*$/;
const TASK_RESULT_TAGS = /<\/?task_result>/g;

function usageNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseSubagentResult(output: string): SubagentResultView {
  let body = output;
  // Unwrap opencode's <task><task_result> envelope first so the answer body
  // renders as plain markdown.
  if (TASK_OPEN.test(body)) {
    body = body.replace(TASK_OPEN, "").replace(TASK_CLOSE, "").replace(TASK_RESULT_TAGS, "");
  }
  let usage: SubagentUsage | undefined;
  const usageMatch = body.match(USAGE_BLOCK);
  if (usageMatch) {
    const entries: Record<string, string> = {};
    for (const line of usageMatch[1].split("\n")) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      entries[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    usage = {
      totalTokens: usageNumber(entries.total_tokens),
      toolUses: usageNumber(entries.tool_uses),
      durationMs: usageNumber(entries.duration_ms)
    };
    if (usage.totalTokens === undefined && usage.toolUses === undefined && usage.durationMs === undefined) usage = undefined;
    body = body.slice(0, usageMatch.index);
  }
  let agentId: string | undefined;
  const agentMatch = body.match(AGENT_ID_LINE);
  if (agentMatch) {
    agentId = agentMatch[1];
    body = body.replace(AGENT_ID_LINE, "");
  }
  body = body.trim();
  return { body: body || output.trim(), agentId, usage };
}

export interface SubagentInputView {
  /** The task prompt text, when the input is a recognized dispatch object. */
  prompt?: string;
  /** Remaining scalar fields worth showing as key/value rows. */
  fields: [string, string][];
  /** Set when the input is not a JSON object — render as-is. */
  raw?: string;
}

const PROMPT_KEYS = ["prompt", "instruction", "instructions", "message", "goal"];
/** Keys already surfaced elsewhere (task title, agent-type tag). */
const COVERED_KEYS = new Set([...PROMPT_KEYS, "description", "task", "title", "subagent_type", "subagentType", "agent_type", "agentType", "agent"]);
const FIELD_VALUE_LIMIT = 300;

export function parseSubagentInput(input: string): SubagentInputView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { fields: [], raw: input };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { fields: [], raw: input };
  const record = parsed as Record<string, unknown>;
  let prompt: string | undefined;
  for (const key of PROMPT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      prompt = value.trim();
      break;
    }
  }
  const fields: [string, string][] = [];
  for (const [key, value] of Object.entries(record)) {
    if (COVERED_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) continue;
    fields.push([key, text.length > FIELD_VALUE_LIMIT ? `${text.slice(0, FIELD_VALUE_LIMIT)}…` : text]);
  }
  return { prompt, fields };
}

/** Compact duration for usage chips: 7777 → "7.8s", 65000 → "1m 5s". */
export function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}
