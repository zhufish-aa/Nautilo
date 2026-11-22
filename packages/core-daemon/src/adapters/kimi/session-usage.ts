import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { AdapterEvent } from "../types.js";

const MAX_READ_BYTES = 8 * 1024 * 1024;

/** Reads Kimi's provider-owned wire log only when ACP omits usage_update. */
export async function readKimiSessionUsage(
  providerSessionId: string,
  contextWindow: number | undefined,
  kimiHome?: string,
  model?: string
): Promise<AdapterEvent | undefined> {
  const root = kimiHome || process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
  const wirePath = await findWirePath(join(root, "sessions"), providerSessionId);
  if (!wirePath) return undefined;
  const measured = parseKimiWireContext(await readTail(wirePath));
  if (!measured) return undefined;
  return { kind: "usage", usageScope: "context",
    contextWindow: await readCliConfiguredWindow(root, model) ?? contextWindow, ...measured };
}

async function readCliConfiguredWindow(kimiHome: string, model?: string): Promise<number | undefined> {
  try {
    const config = parse(await readFile(join(kimiHome, "config.toml"), "utf8"));
    const id = model ?? (typeof config.default_model === "string" ? config.default_model : "");
    const limit = finiteNumber(record(record(config.models)[id]).max_context_size);
    return limit && limit > 0 ? limit : undefined;
  } catch {
    return undefined;
  }
}

export function parseKimiWireContext(text: string): { contextUsed: number; cachedInputTokens?: number } | undefined {
  for (const line of text.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (event.type === "token_counting.measured" || event.type === "token_counting.turn_recorded") {
      const tokens = finiteNumber(event.tokens);
      return tokens === undefined ? undefined : { contextUsed: tokens };
    }
    if (event.type !== "usage.record" || event.usageScope === "session") continue;
    const usage = record(event.usage);
    const input = finiteNumber(usage.inputOther);
    const read = finiteNumber(usage.inputCacheRead);
    const write = finiteNumber(usage.inputCacheCreation);
    const output = finiteNumber(usage.output);
    if (input === undefined || read === undefined || write === undefined || output === undefined) return undefined;
    return { contextUsed: input + read + write + output, cachedInputTokens: read };
  }
  return undefined;
}

export async function kimiWirePath(id: string, kimiHome?: string): Promise<string | undefined> {
  return findWirePath(join(kimiHome || process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code"), "sessions"), id);
}

export async function readKimiWireTurn(path: string, offset: number): Promise<AdapterEvent | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const length = (await handle.stat()).size - offset;
    if (length <= 0 || length > MAX_READ_BYTES) return undefined;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const reports = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/).flatMap(line => {
      try {
        const value = record(JSON.parse(line) as unknown);
        return value.type === "usage.record" && value.usageScope === "turn" ? [record(value.usage)] : [];
      } catch { return []; }
    });
    if (!reports.length) return undefined;
    const sum = (field: string) => {
      const counts = reports.map(usage => finiteNumber(usage[field]));
      return counts.every(count => count !== undefined) ? counts.reduce((total, count) => total + count, 0) : undefined;
    };
    return { kind: "usage", usageScope: "turn", inputTokensIncludesCache: false,
      inputTokens: sum("inputOther"), cachedInputTokens: sum("inputCacheRead"),
      cacheCreationInputTokens: sum("inputCacheCreation"), outputTokens: sum("output") };
  } finally { await handle.close(); }
}
async function findWirePath(sessionsRoot: string, providerSessionId: string): Promise<string | undefined> {
  let workspaces: string[];
  try { workspaces = await readdir(sessionsRoot); } catch { return undefined; }
  for (const workspace of workspaces) {
    const candidate = join(sessionsRoot, workspace, providerSessionId, "agents", "main", "wire.jsonl");
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue with the next workspace; session ids are globally unique.
    }
  }
  return undefined;
}

async function readTail(path: string): Promise<string> {
  const info = await stat(path);
  const length = Math.min(info.size, MAX_READ_BYTES);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, info.size - length));
    const text = buffer.toString("utf8");
    return info.size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
