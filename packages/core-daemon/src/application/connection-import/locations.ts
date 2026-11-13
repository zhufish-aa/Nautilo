import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeConnection } from "@agenthub/domain";

export interface NativeLocation { harness: string; root: string; config?: string; }
export function nativeLocations(home: string, env: NodeJS.ProcessEnv, accounts: RuntimeConnection[]): NativeLocation[] {
  const entries: NativeLocation[] = [
    { harness: "codex", root: env.CODEX_HOME || join(home, ".codex") },
    { harness: "claude-code", root: env.CLAUDE_CONFIG_DIR || join(home, ".claude") },
    { harness: "kimi-code", root: env.KIMI_CODE_HOME || join(home, ".kimi-code") },
    { harness: "pi", root: env.PI_CODING_AGENT_DIR || join(home, ".pi/agent") },
    { harness: "omp", root: join(home, ".omp/agent") },
    { harness: "command-code", root: join(home, ".commandcode") },
    { harness: "trae", root: join(home, ".trae-agent") },
    { harness: "opencode", root: env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode") },
  ];
  const profile = env.OMP_PROFILE || env.PI_PROFILE;
  if (profile && /^[\w-]+$/.test(profile)) entries.push({ harness: "omp", root: join(home, ".omp/profiles", profile, "agent") });
  for (const [harness, key] of [["opencode", "OPENCODE_CONFIG"], ["trae", "TRAE_CONFIG_FILE"]]) {
    if (env[key]) entries.push({ harness, root: dirname(env[key]!), config: env[key] });
  }
  const dsh = env.DSH_HOME || join(home, ".dsh");
  entries.push({ harness: "deepseek", root: dsh });
  if (existsSync(join(dsh, "profiles"))) {
    try { entries.push(...readdirSync(join(dsh, "profiles"), { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== "node_modules").slice(0, 32).map(e => ({ harness: "deepseek", root: join(dsh, "profiles", e.name) }))); } catch { /* read failures are isolated */ }
  }
  entries.push(...accounts.filter(a => a.kind === "login" && a.loginProfileDirectory).slice(0, 64).map(a => ({ harness: a.harness!, root: a.loginProfileDirectory! })));
  return [...new Map(entries.map(e => [JSON.stringify(e), e])).values()];
}
