import type { AdapterEvent } from "./types.js";

function valueOf(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return keys.map((key) => record[key]).find((item) => item !== undefined);
}

export function normalizeJson(value: unknown): AdapterEvent[] {
  if (!value || typeof value !== "object") return [];
  const type = String(valueOf(value, ["type", "event", "kind"]) ?? "");
  const usage = value as Record<string, unknown>;
  const scope = usage.usageScope;
  if (type === "usage" && (scope === "context" || scope === "turn" || scope === "session")) {
    const number = (field: string) => {
      const count = usage[field];
      return typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : undefined;
    };
    return [{
      kind: "usage", usageScope: scope,
      usageKey: typeof usage.usageKey === "string" ? usage.usageKey : undefined,
      inputTokensIncludesCache: typeof usage.inputTokensIncludesCache === "boolean" ? usage.inputTokensIncludesCache : undefined,
      inputTokens: number("inputTokens"), cachedInputTokens: number("cachedInputTokens"),
      cacheCreationInputTokens: number("cacheCreationInputTokens"), outputTokens: number("outputTokens"),
      reasoningOutputTokens: number("reasoningOutputTokens"),
      contextUsed: number("contextUsed"), contextWindow: number("contextWindow"),
      reportedCost: number("reportedCost"), estimatedCost: number("estimatedCost"),
      currency: typeof usage.currency === "string" ? usage.currency : undefined, raw: value
    }];
  }
  const text = valueOf(value, ["text", "message", "content", "delta"]);
  const tool = valueOf(value, ["tool", "tool_name", "name"]);
  const path = valueOf(value, ["path", "file", "file_path"]);
  if (path) return [{ kind: "file", path: String(path), changeType: String(valueOf(value, ["change_type", "changeType"]) ?? "modified"), raw: value }];
  if (tool && (type.includes("tool") || type.includes("function"))) return [{ kind: "tool", name: String(tool), input: valueOf(value, ["input", "arguments"]), raw: value }];
  if (text !== undefined) {
    if (type.includes("think") || type.includes("reason")) return [{ kind: "thinking", text: String(text), raw: value }];
    if (type.includes("command")) return [{ kind: "command", command: String(text), raw: value }];
    return [{ kind: "message", text: String(text), raw: value }];
  }
  return [];
}

export function parseJsonLines(text: string): AdapterEvent[] {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return normalizeJson(JSON.parse(line) as unknown); }
    catch { return [{ kind: "raw", stream: "stdout", text: line }]; }
  });
}
