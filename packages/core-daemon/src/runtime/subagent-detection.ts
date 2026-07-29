import type { SubagentDispatch } from "@agenthub/event-protocol";

/**
 * Recognizes a provider CLI's native sub-agent dispatch from a plain tool call.
 *
 * Detection lives here — a single point in the run pipeline — instead of inside
 * each adapter: every CLI surfaces its dispatch as an ordinary tool call whose
 * name and input follow the same convention (Claude's `Task`, Kimi's `Agent`,
 * opencode's `task`, Codex's `spawn_agent`), so adapters stay untouched and
 * future provider plugins are covered automatically.
 */
const SUBAGENT_TOOL_NAMES = new Set(["task", "agent", "spawnagent", "subagent"]);
const TASK_TRUNCATE = 200;

function textField(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function subagentMeta(toolName: string, input: unknown): SubagentDispatch | undefined {
  const normalized = toolName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!SUBAGENT_TOOL_NAMES.has(normalized)) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  // A dispatch always carries some task text or an agent type; a bare name hit
  // without either is more likely a same-named unrelated tool.
  const agentType = textField(record, ["subagent_type", "subagentType", "agent_type", "agentType", "agent"]);
  const description = textField(record, ["description", "task", "title"]);
  const prompt = textField(record, ["prompt", "instruction", "instructions", "message", "goal"]);
  if (!agentType && !description && !prompt) return undefined;
  const task = description ?? (prompt && prompt.length > TASK_TRUNCATE ? `${prompt.slice(0, TASK_TRUNCATE)}…` : prompt);
  // Kimi's Agent tool uses run_in_background, opencode's task uses background.
  const background = record.run_in_background === true || record.runInBackground === true || record.background === true;
  return { agentType, task, ...(background ? { background: true } : {}) };
}
