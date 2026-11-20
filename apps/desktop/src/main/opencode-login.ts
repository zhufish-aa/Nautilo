import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/** npm's Windows shim launches this same native binary; no shell is needed. */
export function resolveOpenCodeExecutable(executable: string): string {
  if (!executable || /[\r\n\0]/.test(executable)) return "";
  if (isAbsolute(executable) && !/\.(cmd|bat|ps1)$/i.test(executable)) return executable;
  const directories = isAbsolute(executable) ? [dirname(executable)] : /^opencode(?:\.exe)?$/i.test(executable)
    ? (Object.entries(process.env).find(([name]) => name.toLowerCase() === "path")?.[1] ?? "").split(delimiter) : [];
  for (const directory of directories.filter(Boolean)) {
    const candidates = process.platform === "win32"
      ? [join(directory, "opencode.exe"), join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe")]
      : [join(directory, "opencode")];
    const native = candidates.find(candidate => isAbsolute(candidate) && existsSync(candidate));
    if (native) return native;
  }
  return "";
}

/** Account credentials/history are private; native config, plugins and cache retain precedence. */
export function openCodeProfileEnvironment(directory: string, environment: Record<string, string>): Record<string, string> {
  const env = { ...environment };
  for (const key of Object.keys(env)) if (/^(XDG_DATA_HOME|XDG_STATE_HOME|OPENCODE_AUTH_CONTENT|OPENCODE_API_KEY)$/i.test(key)) delete env[key];
  env.XDG_DATA_HOME = join(directory, "data");
  env.XDG_STATE_HOME = join(directory, "state");
  return env;
}

/** Console login can exit zero after denial/expiry. Require persisted-account success and exit zero. */
export function authenticateOpenCode(child: ChildProcess, progress: (reason: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "", succeeded = false;
    const read = (chunk: Buffer | string): void => {
      output = (output + chunk.toString()).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").slice(-16384);
      succeeded ||= /Logged in as [^\r\n]+/.test(output);
      const url = output.match(/Go to:\s*(https:\/\/opencode\.ai\/[^\s\x1b]+)/)?.[1];
      const code = output.match(/Enter code:\s*([A-Za-z0-9-]+)/)?.[1];
      if (url) progress(code ? `${url}\n${code}` : url);
    };
    const fail = (): void => finish(new Error("Could not run OpenCode console login."));
    const exit = (code: number | null): void => {
      if (code === 0 && succeeded) finish();
      else finish(new Error(/Authorization denied/.test(output) ? "OpenCode authorization was denied." : /Device code expired/.test(output) ? "OpenCode device code expired. Start sign-in again." : "OpenCode console login did not confirm a signed-in account."));
    };
    function finish(error?: Error): void {
      child.stdout?.removeListener("data", read); child.stderr?.removeListener("data", read);
      child.removeListener("error", fail); child.removeListener("close", exit);
      if (error) reject(error); else resolve();
    }
    child.stdout?.on("data", read); child.stderr?.on("data", read);
    child.once("error", fail); child.once("close", exit);
  });
}
