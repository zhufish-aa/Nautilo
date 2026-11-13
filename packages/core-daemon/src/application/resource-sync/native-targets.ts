import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeConnection } from "@agenthub/domain";
import type { NativeResourceTarget } from "@agenthub/schemas";

export function nativeTargets(
  accounts: RuntimeConnection[],
): NativeResourceTarget[] {
  const home = homedir(),
    config = process.env.XDG_CONFIG_HOME || join(home, ".config"),
    targets: NativeResourceTarget[] = [];
  for (const [providerId, label, root, file] of [
    [
      "codex",
      "Codex",
      process.env.CODEX_HOME || join(home, ".codex"),
      "config.toml",
    ],
    [
      "claude-code",
      "Claude Code",
      process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
      "",
    ],
    [
      "kimi-code",
      "Kimi Code",
      process.env.KIMI_CODE_HOME || join(home, ".kimi-code"),
      "mcp.json",
    ],
    [
      "opencode",
      "OpenCode",
      process.env.OPENCODE_CONFIG_DIR || join(config, "opencode"),
      "opencode.json",
    ],
    [
      "pi",
      "Pi",
      process.env.PI_CODING_AGENT_DIR || join(home, ".pi/agent"),
      "",
    ],
    ["omp", "Oh My Pi", join(home, ".omp/agent"), ""],
    ["commandcode", "Command Code", join(home, ".commandcode"), ""],
    ["trae", "Trae", join(home, ".trae-agent"), ""],
    ["deepseek", "DeepSeek Harness", join(home, ".dsh"), ""],
  ]) {
    let mcpPath = file ? join(root, file) : undefined;
    if (providerId === "claude-code")
      mcpPath = process.env.CLAUDE_CONFIG_DIR
        ? join(root, ".claude.json")
        : join(home, ".claude.json");
    if (providerId === "opencode")
      mcpPath =
        process.env.OPENCODE_CONFIG ||
        (existsSync(join(root, "opencode.jsonc"))
          ? join(root, "opencode.jsonc")
          : mcpPath);
    const profile = process.env.OMP_PROFILE || process.env.PI_PROFILE;
    const skillRoot =
      providerId === "omp"
        ? profile && profile !== "default"
          ? join(
              home,
              process.env.PI_CONFIG_DIR || ".omp",
              "profiles",
              profile,
              "agent",
            )
          : process.env.PI_CODING_AGENT_DIR || root
        : root;
    targets.push({
      id: providerId,
      providerId,
      label,
      mcpPath,
      skillDirectory: ["trae", "deepseek"].includes(providerId)
        ? undefined
        : join(skillRoot, "skills"),
      mode: mcpPath ? "native-file" : "invocation",
    });
  }
  for (const a of accounts)
    if (
      a.kind === "login" &&
      a.enabled &&
      a.loginProfileDirectory &&
      ["codex", "claude-code"].includes(a.harness ?? "")
    )
      targets.push({
        id: `account:${a.id}`,
        providerId: a.harness!,
        accountId: a.id,
        label: a.name,
        mcpPath: join(
          a.loginProfileDirectory,
          a.harness === "codex" ? "config.toml" : ".claude.json",
        ),
        skillDirectory: join(a.loginProfileDirectory, "skills"),
        mode: "native-file",
      });
  return targets;
}
