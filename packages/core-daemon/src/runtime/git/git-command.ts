import { spawn } from "node:child_process";

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class GitCommandError extends Error {
  constructor(
    readonly cwd: string,
    readonly args: string[],
    readonly result: GitCommandResult
  ) {
    super(result.stderr.trim() || result.stdout.trim() || `git exited with ${result.exitCode}`);
    this.name = "GitCommandError";
  }
}

/** Executes Git without a shell and with interactive prompts disabled. */
export class GitCommandRunner {
  async run(cwd: string, args: string[], options: { allowFailure?: boolean; maxOutputBytes?: number } = {}): Promise<GitCommandResult> {
    const result = await new Promise<GitCommandResult>((resolve, reject) => {
      const child = spawn("git", ["--no-pager", "-C", cwd, ...args], {
        shell: false,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" }
      });
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      const limit = options.maxOutputBytes ?? 20 * 1024 * 1024;
      let size = 0;
      const append = (target: Buffer[], chunk: Buffer): void => {
        size += chunk.byteLength;
        if (size > limit) {
          child.kill();
          reject(new Error(`Git output exceeded ${limit} bytes`));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => append(chunks, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(errors, chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout: Buffer.concat(chunks).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8") }));
    });
    if (result.exitCode !== 0 && !options.allowFailure) throw new GitCommandError(cwd, args, result);
    return result;
  }
}
