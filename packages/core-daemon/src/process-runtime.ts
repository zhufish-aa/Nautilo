import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { platform } from "node:os";
import type { ProcessEvent, ProcessHandle, ProcessRequest } from "@agenthub/provider-sdk";
import { resolveSpawnCommand } from "./win-command.js";

export type { ProcessEvent, ProcessHandle, ProcessRequest };

interface Queue<T> {
  values: T[];
  waiters: Array<(value: IteratorResult<T>) => void>;
  closed: boolean;
}

function createQueue<T>(): Queue<T> { return { values: [], waiters: [], closed: false }; }
function push<T>(queue: Queue<T>, value: T): void {
  const waiter = queue.waiters.shift();
  if (waiter) waiter({ value, done: false });
  else queue.values.push(value);
}
function closeQueue<T>(queue: Queue<T>): void {
  queue.closed = true;
  for (const waiter of queue.waiters.splice(0)) waiter({ value: undefined as T, done: true });
}

export class ProcessRuntime {
  start(request: ProcessRequest): ProcessHandle {
    const resolved = resolveSpawnCommand(request.command, request.args ?? [], request.env);
    const child = spawn(resolved.command, resolved.args, {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: resolved.verbatim ?? false,
      env: request.env ?? {}
    });
    const queue = createQueue<ProcessEvent>();
    let outputBytes = 0;
    let finished = false;
    let timeout: NodeJS.Timeout | undefined;
    let idleTimeout: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (timeout) clearTimeout(timeout);
      if (idleTimeout) clearTimeout(idleTimeout);
      timeout = undefined;
      idleTimeout = undefined;
    };
    const terminate = (): void => {
      if (finished) return;
      if (platform() === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    };
    const touchIdle = (): void => {
      if (!request.idleTimeoutMs) return;
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        push(queue, { kind: "timeout", reason: "idle" });
        terminate();
      }, request.idleTimeoutMs);
    };
    const onChunk = (kind: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (request.maxOutputBytes && outputBytes > request.maxOutputBytes) {
        push(queue, { kind: "timeout", reason: "max_output" });
        terminate();
        return;
      }
      touchIdle();
      push(queue, { kind, text: chunk.toString("utf8") });
    };
    child.stdout.on("data", (chunk: Buffer) => onChunk("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => onChunk("stderr", chunk));
    child.on("error", (error) => push(queue, { kind: "error", error }));
    child.on("close", (exitCode, signal) => {
      finished = true;
      clearTimers();
      push(queue, { kind: "exit", exitCode, signal: signal ?? undefined });
      closeQueue(queue);
    });
    if (request.timeoutMs) timeout = setTimeout(() => {
      push(queue, { kind: "timeout", reason: "timeout" });
      terminate();
    }, request.timeoutMs);
    touchIdle();

    const events: AsyncIterable<ProcessEvent> = {
      [Symbol.asyncIterator](): AsyncIterator<ProcessEvent> {
        return {
          next: async (): Promise<IteratorResult<ProcessEvent>> => {
            if (queue.values.length) return { value: queue.values.shift()!, done: false };
            if (queue.closed) return { value: undefined as never, done: true };
            return new Promise((resolve) => queue.waiters.push(resolve));
          }
        };
      }
    };
    return {
      pid: child.pid,
      events,
      child,
      write: (input) => child.stdin.write(input),
      cancel: async () => {
        terminate();
        if (!finished) await once(child, "close");
      },
      wait: async () => {
        if (finished) return { exitCode: child.exitCode };
        const [exitCode, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
        return { exitCode, signal: signal ?? undefined };
      }
    };
  }
}
