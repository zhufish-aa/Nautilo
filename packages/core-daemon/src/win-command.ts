import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { platform } from "node:os";

export interface ResolvedSpawnCommand {
  command: string;
  args: string[];
  /**
   * True when args must reach the process untouched (cmd.exe wrapping):
   * Node's default Windows argument escaping injects backslashes that cmd
   * does not understand, so callers must set windowsVerbatimArguments.
   */
  verbatim?: boolean;
}

/**
 * Windows cannot spawn npm-style CLI shims (`opencode.cmd`, `codex.cmd`, …)
 * directly: CreateProcess needs the real file, and .cmd/.bat must run through
 * cmd.exe. On win32 this resolves the command against PATH/PATHEXT and wraps
 * script shims in `cmd.exe /d /s /c`; elsewhere (or when unresolved) the
 * invocation is returned unchanged so the caller's error handling still
 * applies.
 */
export function resolveSpawnCommand(
  command: string,
  args: string[],
  env?: Record<string, string | undefined>
): ResolvedSpawnCommand {
  if (platform() !== "win32") return { command, args };
  const merged = { ...process.env, ...env };
  const resolved = findOnPath(command, envValue(merged, "PATH") ?? "", envValue(merged, "PATHEXT"));
  if (!resolved) return { command, args };
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args };
  // cmd /s /c strips exactly one outer quote pair before running the line,
  // so the whole line is wrapped once; inside, the shim path and unsafe args
  // carry their own quotes.
  const line = `"${[quoteCmdArg(resolved), ...args.map(quoteCmdArg)].join(" ")}"`;
  return { command: "cmd.exe", args: ["/d", "/s", "/c", line], verbatim: true };
}

/** Case-insensitive env lookup: Windows typically spells it "Path". */
function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === key.toLowerCase()) return value;
  }
  return undefined;
}

function findOnPath(command: string, pathEnv: string, pathextEnv?: string): string | undefined {
  const hasDirectory = /[\\/]/.test(command) || /^[a-zA-Z]:/.test(command);
  // Try executable extensions first: an extensionless file next to a .cmd
  // shim (npm's git-bash wrapper) exists but cannot be spawned on win32.
  const extensions = hasDirectory
    ? [""]
    : [...(pathextEnv ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""];
  const directories = hasDirectory ? [""] : pathEnv.split(delimiter).filter(Boolean);
  for (const dir of directories) {
    for (const extension of extensions) {
      const candidate = dir ? join(dir, command + extension) : command + extension;
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* keep searching */ }
    }
  }
  return undefined;
}

function quoteCmdArg(value: string): string {
  if (value.length && !/[\s"&|<>^()%!]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
