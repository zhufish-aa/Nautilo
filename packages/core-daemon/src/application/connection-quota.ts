import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "smol-toml";
import type { AgentInstance } from "@agenthub/domain";
import { accountQuotaSource, type AccountQuota } from "@agenthub/schemas";
import { readCodexAppServer } from "../adapters/codex/models.js";
import { CoreError } from "../errors.js";

const agyScript = fileURLToPath(new URL("../../../../rust/plugins/antigravity/resources/model-gateway/quota.mjs", import.meta.url));
const exec = promisify(execFile);
type Window = AccountQuota["windows"][number];
type Report = Record<string, unknown>;
const object = (value: unknown): Report => value && typeof value === "object" ? value as Report : {};
const label = (value: unknown) => typeof value === "string" ? value : undefined;
const goUsage = "https://opencode.ai/inference/go/v1/usage";

function window(id: string, usedPercent: unknown, windowMinutes: unknown, name?: string, reset?: unknown): Window[] {
  if (typeof usedPercent !== "number" || !(usedPercent >= 0 && usedPercent <= 100)) return [];
  const resets = typeof reset === "number" ? reset * 1000 : typeof reset === "string" ? Date.parse(reset) : NaN;
  return [{
    id, usedPercent, label: name,
    windowMinutes: typeof windowMinutes === "number" && windowMinutes > 0 ? windowMinutes : undefined,
    resetsAt: Number.isFinite(new Date(resets).getTime()) ? new Date(resets).toISOString() : undefined
  }];
}

async function subscriptionReport(url: string, token: string): Promise<Report> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` },
    redirect: "error", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new CoreError("IPC_INTERNAL_ERROR", { reason: `Account quota service returned ${response.status}` });
  return object(await response.json());
}

function opencodeWindows(report: Report): Window[] {
  return ([["rolling", 300], ["weekly", 10080], ["monthly", undefined]] as const).flatMap(([id, period]) => {
    const row = object(object(report.usage)[id]);
    return window(id, row.percent, period, id === "monthly" ? "Monthly" : undefined, row.resetsAt);
  });
}

export async function readApiQuota(baseUrl: string, token: string): Promise<AccountQuota> {
  const source = accountQuotaSource({ kind: "api", baseUrl });
  if (source === "opencode") return { windows: opencodeWindows(await subscriptionReport(goUsage, token)) };
  if (source !== "kimi-code") return { windows: [] };
  const report = await subscriptionReport(new URL("/coding/v1/usages", baseUrl).href, token);
  return { windows: ([
    ["limit_5h", 300, undefined], ["limit_7d", 10080, undefined],
    ["limit_month_total", undefined, "Monthly"], ["limit_month_code", undefined, "Monthly · Code"]
  ] as const).flatMap(([id, period, name]) => {
    const row = object(object(report.usages)[id]);
    const raw = row.used_ratio;
    const ratio = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    return window(id, ratio * 100, period, name, row.reset_time);
  }) };
}

export async function readKimiLoginQuota(model?: string, root = process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code")): Promise<AccountQuota> {
  const text = await readFile(join(root, "config.toml"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (text === undefined) return { windows: [] };
  const config = object(parse(text));
  const modelName = model ?? label(config.default_model);
  const providerId = modelName && label(object(object(config.models)[modelName]).provider);
  if (!providerId) return { windows: [] };
  const provider = object(object(config.providers)[providerId]);
  const oauth = object(provider.oauth);
  const baseUrl = label(provider.base_url);
  if (oauth.storage !== "file" || oauth.key !== "oauth/kimi-code" || !baseUrl
    || accountQuotaSource({ kind: "api", baseUrl }) !== "kimi-code") return { windows: [] };
  const auth = object(JSON.parse(await readFile(join(root, "credentials", "kimi-code.json"), "utf8")));
  const token = label(auth.access_token);
  return token ? readApiQuota(baseUrl, token) : { windows: [] };
}

export async function readLoginQuota(agent: AgentInstance, env: Record<string, string>): Promise<AccountQuota> {
  const provider = agent.providerId;
  try {
    if (provider === "codex") {
      const report = object(await readCodexAppServer(agent, env, "account/rateLimits/read"));
      const pools = Object.entries(object(report.rateLimitsByLimitId));
      if (!pools.length) pools.push(["codex", report.rateLimits]);
      return { windows: pools.flatMap(([id, value]) => {
        const pool = object(value);
        return ["primary", "secondary"].flatMap(slot => {
          const entry = object(pool[slot]);
          return window(`${id}:${slot}`, entry.usedPercent, entry.windowDurationMins, label(pool.limitName) ?? (id !== "codex" ? id : undefined), entry.resetsAt);
        });
      }) };
    }
    if (provider === "claude-code") {
      const auth = object(JSON.parse(await readFile(join(env.CLAUDE_CONFIG_DIR, ".credentials.json"), "utf8")));
      const token = label(object(auth.claudeAiOauth).accessToken);
      if (!token) throw new Error("Missing OAuth login");
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
        redirect: "error", signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) throw new Error("Claude Code quota request failed");
      const report = object(await response.json());
      return { windows: ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus"].flatMap(id => {
        const entry = object(report[id]);
        return window(id, entry.utilization, id === "five_hour" ? 300 : 10080, id.endsWith("_sonnet") ? "Sonnet" : id.endsWith("_opus") ? "Opus" : undefined, entry.resets_at);
      }) };
    }
    if (provider === "opencode") {
      const data = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
      const entry = object(object(JSON.parse(await readFile(join(data, "opencode", "auth.json"), "utf8")))["opencode-go"]);
      const token = entry.type === "api" ? label(entry.key) : undefined;
      return token ? { windows: opencodeWindows(await subscriptionReport(goUsage, token)) } : { windows: [] };
    }
    if (provider === "kimi-code") return readKimiLoginQuota(undefined, env.KIMI_CODE_HOME);
    const { stdout } = await exec(process.execPath, [agyScript, agent.executable], { env, timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true });
    const report: Report[] = JSON.parse(stdout);
    return { windows: report.flatMap((row, index) => {
      const name = label(row.name);
      if (!name) return [];
      const minutes = typeof row.span === "number" ? row.span / 60 : undefined;
      return window(`${name}:${index}`, row.used, minutes, minutes ? name.split(" · ").slice(0, -1).join(" · ") || name : name, row.resetsAt);
    }) };
  } catch {
    throw new CoreError("IPC_INTERNAL_ERROR", { reason: "The selected account did not return subscription limits" });
  }
}
