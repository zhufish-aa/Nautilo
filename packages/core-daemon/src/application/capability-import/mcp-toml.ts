import type { McpCandidate } from "@agenthub/schemas";
import { toMcpCandidate } from "./mcp-json.js";

/**
 * Minimal TOML reader covering only what `~/.codex/config.toml` uses for MCP:
 * `[mcp_servers.<name>]` tables with string, string-array and inline-table
 * values. This mirrors the write side in `adapters/codex/mcp-config.ts`, which
 * emits exactly these shapes. Anything richer is out of scope on purpose — a
 * full TOML dependency is not worth it for one section.
 */
const TABLE_HEADER = /^\[\s*mcp_servers\s*\.\s*(.+?)\s*\]$/;
const OTHER_TABLE = /^\[/;
const KEY_VALUE = /^([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*")\s*=\s*(.+)$/;

function unquote(raw: string): string {
  const value = raw.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  return value;
}

/** Splits `a, b, c` respecting quoted segments. */
function splitTop(body: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of body) {
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseValue(raw: string): string | string[] | Record<string, string> | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitTop(value.slice(1, -1)).map(unquote);
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const record: Record<string, string> = {};
    for (const entry of splitTop(value.slice(1, -1))) {
      const match = KEY_VALUE.exec(entry);
      if (match) record[unquote(match[1])] = unquote(match[2]);
    }
    return record;
  }
  return unquote(value);
}

/** Reads `[mcp_servers.*]` tables out of a Codex config.toml. */
export function parseMcpConfigToml(text: string, origin?: string): { servers: McpCandidate[]; errors: string[] } {
  const servers: McpCandidate[] = [];
  const errors: string[] = [];
  let name: string | undefined;
  let current: Record<string, unknown> = {};

  const flush = (): void => {
    if (!name) return;
    const candidate = toMcpCandidate(name, current, origin);
    if (candidate) servers.push(candidate);
    else errors.push(`"${name}" 缺少 command 或 url，已跳过`);
    name = undefined;
    current = {};
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const header = TABLE_HEADER.exec(line);
    if (header) {
      flush();
      name = unquote(header[1]);
      continue;
    }
    if (OTHER_TABLE.test(line)) {
      flush();
      continue;
    }
    if (!name) continue;
    const pair = KEY_VALUE.exec(line);
    if (!pair) continue;
    const value = parseValue(pair[2]);
    if (value !== undefined) current[unquote(pair[1])] = value;
  }
  flush();
  return { servers, errors };
}
