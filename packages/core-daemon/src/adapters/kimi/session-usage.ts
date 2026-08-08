import { open, readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent } from "../types.js";

const MAX_READ_BYTES = 8 * 1024 * 1024;

/** Reads Kimi's provider-owned wire log only when ACP omits usage_update. */
export async function readKimiSessionUsage(
  providerSessionId: string,
  contextWindow: number | undefined,
  kimiHome = process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code")
): Promise<AdapterEvent | undefined> {
  // The wire log's maxTokens is the REMAINING context, so the denominator
  // must be the window the CLI itself runs with — its own config.toml, not
  // the desktop's model catalog (catalogs go stale: K3-256k catalogs 256k
  // while the CLI runs k3 at 1M, which clamped every reading to 0).
  const window = readCliConfiguredWindow(kimiHome) ?? contextWindow;
  if (!window) return undefined;
  const wirePath = await findWirePath(join(kimiHome, "sessions"), providerSessionId);
  if (!wirePath) return undefined;
  const text = await readTail(wirePath);
  const used = parseKimiWireContextUsed(text, window);
  return used === undefined ? undefined : { kind: "usage", contextUsed: used, contextWindow: window };
}

/** Reads `max_context_size` from the CLI's own config.toml (plain line scan;
 * the file is small and the key is top-level). */
function readCliConfiguredWindow(kimiHome: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(join(kimiHome, "config.toml"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.startsWith("max_context_size")) continue;
    const value = Number(trimmed.split("=")[1]?.trim().replace(/^"|"$/g, ""));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

export function parseKimiWireContextUsed(text: string, contextWindow: number): number | undefined {
  let used: number | undefined;
  let sawRequest = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (event.type === "llm.request") {
      const maxTokens = finiteNumber(event.maxTokens);
      if (maxTokens !== undefined) {
        used = Math.max(0, contextWindow - maxTokens);
        sawRequest = true;
      }
      continue;
    }
    if (event.type !== "usage.record" || !sawRequest) continue;
    const usage = record(event.usage);
    const increment = ["inputOther", "inputCacheRead", "inputCacheCreation", "output"]
      .map((key) => finiteNumber(usage[key]) ?? 0)
      .reduce((sum, value) => sum + value, 0);
    used = (used ?? 0) + increment;
  }
  return used === undefined ? undefined : Math.min(contextWindow, Math.max(0, Math.round(used)));
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
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
