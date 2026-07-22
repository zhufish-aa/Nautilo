import type { ProcessRequest } from "./process-runtime.js";
import { createRequire } from "node:module";

/** Optional PTY adapter. The package is intentionally optional so headless
 * installations do not need native compilation; ProcessRuntime remains the
 * safe fallback for providers supporting non-interactive mode. */
export interface PtyHandle {
  pid?: number;
  write(input: string): void;
  resize(columns: number, rows: number): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (exitCode: number, signal?: number) => void): () => void;
  kill(): void;
}

export interface PtyRuntime {
  readonly available: boolean;
  start(request: ProcessRequest & { columns?: number; rows?: number }): PtyHandle;
}

export function createOptionalPtyRuntime(): PtyRuntime {
  let nodePty: { spawn: (file: string, args: string[], options: Record<string, unknown>) => any } | undefined;
  try {
    // Avoid a hard dependency on a native module in CI and packaged installs.
    nodePty = (requireOptional("node-pty") as typeof nodePty) ?? undefined;
  } catch { nodePty = undefined; }
  return {
    available: !!nodePty,
    start(request) {
      if (!nodePty) throw new Error("PTY runtime is unavailable; install node-pty or use structured mode");
      const pty = nodePty.spawn(request.command, request.args ?? [], {
        name: "xterm-color",
        cols: request.columns ?? 120,
        rows: request.rows ?? 32,
        cwd: request.cwd,
        env: { ...process.env, ...(request.env ?? {}) }
      });
      return {
        pid: pty.pid,
        write: (input: string) => pty.write(input),
        resize: (columns: number, rows: number) => pty.resize(columns, rows),
        onData: (callback: (data: string) => void) => { const d = pty.onData(callback); return () => d.dispose(); },
        onExit: (callback: (exitCode: number, signal?: number) => void) => { const d = pty.onExit((event: any) => callback(event.exitCode, event.signal)); return () => d.dispose(); },
        kill: () => pty.kill()
      };
    }
  };
}

function requireOptional(name: string): unknown {
  return createRequire(import.meta.url)(name);
}
