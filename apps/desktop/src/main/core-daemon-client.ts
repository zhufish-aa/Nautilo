import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

interface ReadyMessage { service: "core-daemon"; status: "ok"; socketPath: string; }

/** Owns the external Node daemon lifecycle; the Electron shell never imports SQLite. */
export class CoreDaemonClient {
  private process?: ChildProcess;
  private socketPath?: string;
  private tokenPath?: string;

  async start(userDataPath: string): Promise<void> {
    if (this.process) return;
    const daemonEntry = this.resolveDaemonEntry();
    const nodeCommand = process.env.AGENTHUB_NODE_PATH ?? (process.platform === "win32" ? "node.exe" : "node");
    const socketPath = process.platform === "win32" ? "\\\\.\\pipe\\agenthub-core" : join(userDataPath, "core.sock");
    this.tokenPath = join(userDataPath, "core.token");
    this.process = spawn(nodeCommand, [daemonEntry, "--serve"], {
      cwd: userDataPath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENTHUB_DATA_DIR: userDataPath, AGENTHUB_SOCKET: socketPath, AGENTHUB_TOKEN_PATH: this.tokenPath }
    });
    const ready = await this.waitForReady(this.process);
    this.socketPath = ready.socketPath;
  }

  private resolveDaemonEntry(): string {
    const candidates = [
      // Development/build layout: apps/desktop/out/main -> repository root.
      join(__dirname, "../../../../packages/core-daemon/dist/index.js"),
      // Packaged layout reserved for the release bundle.
      join(process.resourcesPath, "core-daemon/index.js")
    ];
    const entry = candidates.find((candidate) => existsSync(candidate));
    if (!entry) throw new Error(`Core Daemon entry was not found: ${candidates.join(", ")}`);
    return entry;
  }

  async request(request: { requestId?: string; method: string; input?: unknown }): Promise<unknown> {
    if (!this.socketPath || !this.tokenPath) throw new Error("Core Daemon is not ready");
    if (!existsSync(this.tokenPath)) throw new Error("Core Daemon authentication token is missing");
    const token = readFileSync(this.tokenPath, "utf8").trim();
    const socket = await this.connect(this.socketPath);
    const lines = this.readLines(socket);
    socket.write(`${JSON.stringify({ token })}\n`);
    const authenticated = await lines.next();
    if (!authenticated.value?.ok) { socket.destroy(); throw new Error("Core Daemon authentication failed"); }
    socket.write(`${JSON.stringify({ request })}\n`);
    const response = await lines.next();
    socket.end();
    if (!response.value?.ok) throw new Error(response.value?.error?.message ?? "Core Daemon request failed");
    return response.value.data;
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    this.socketPath = undefined;
    if (!child) return;
    child.kill();
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }

  private async waitForReady(child: ChildProcess): Promise<ReadyMessage> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("Core Daemon did not become ready")), 15_000);
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString("utf8");
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() ?? "";
        for (const line of parts) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as ReadyMessage;
            if (message.status === "ok") { clearTimeout(timer); resolve(message); return; }
          } catch { /* wait for the next complete JSON line */ }
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", (chunk) => console.error(`[core-daemon] ${chunk.toString("utf8")}`));
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { if (code !== 0) { clearTimeout(timer); reject(new Error(`Core Daemon exited with ${code}`)); } });
    });
  }

  private connect(path: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  private readLines(socket: Socket): AsyncIterator<any> {
    let buffer = "";
    const queue: any[] = [];
    const waiters: Array<(result: IteratorResult<any>) => void> = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) continue;
        const value = JSON.parse(line);
        const waiter = waiters.shift();
        if (waiter) waiter({ value, done: false }); else queue.push(value);
      }
    });
    socket.once("close", () => { for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true }); });
    return {
      next: async (): Promise<IteratorResult<any>> => queue.length ? { value: queue.shift(), done: false } : new Promise((resolve) => waiters.push(resolve)),
      return: async () => ({ value: undefined, done: true })
    };
  }
}
