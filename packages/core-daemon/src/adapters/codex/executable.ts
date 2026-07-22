import { existsSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { platform } from "node:os";
import type { AdapterInvocation } from "../process-adapter.js";

function npmBinDirectory(executable: string, pathValue: string | undefined): string | undefined {
  if (isAbsolute(executable)) return dirname(executable);
  const directories = (pathValue ?? "").split(delimiter).filter(Boolean);
  return directories.find((directory) => existsSync(join(directory, "node_modules", "@openai", "codex", "bin", "codex.js")));
}

export function resolveCodexInvocation(executable: string, args: string[], pathValue: string | undefined = process.env.PATH): AdapterInvocation {
  if (platform() !== "win32" || extname(executable).toLowerCase() === ".exe") return { command: executable, args };

  const binDirectory = npmBinDirectory(executable, pathValue);
  if (!binDirectory) return { command: executable, args };
  const entrypoint = join(binDirectory, "node_modules", "@openai", "codex", "bin", "codex.js");
  if (!existsSync(entrypoint)) return { command: executable, args };
  const bundledNode = join(binDirectory, "node.exe");
  return { command: existsSync(bundledNode) ? bundledNode : process.execPath, args: [entrypoint, ...args] };
}
