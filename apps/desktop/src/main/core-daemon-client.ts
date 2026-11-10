import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { dirname, isAbsolute, join, delimiter } from "node:path";
import type {BrowserRunUpdate} from "@agenthub/event-protocol";

interface ReadyMessage { service: "core-daemon"; status: "ok"; socketPath: string; }

/** Owns the external Rust daemon lifecycle (with a legacy Node fallback). */
export class CoreDaemonClient {
  constructor(private readonly onAssistantText?:(stepId:string,text:string)=>void,
    private readonly onBrowserRun?:(update?:BrowserRunUpdate)=>void) {}
  private process?: ChildProcess;
  private socketPath?: string;
  private tokenPath?: string;

  async start(userDataPath: string, browserPort?: number): Promise<void> {
    if (this.process) return;
    const { command, args } = this.resolveDaemonCommand();
    // A development shell and a portable build can run at the same time. Each
    // Electron main process therefore needs its own Windows named pipe.
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\agenthub-core-${process.pid}`
      : join(userDataPath, "core.sock");
    this.tokenPath = join(userDataPath, "core.token");
    const nodeRuntime=this.resolveNodeCommand();
    const runtimeEnvironment:NodeJS.ProcessEnv={ ...process.env, NAUTILO_ASSISTANT_STREAM:this.onAssistantText?'1':'0',NAUTILO_BROWSER_STREAM:this.onBrowserRun?'1':'0' };
    if (isAbsolute(nodeRuntime) && existsSync(nodeRuntime)) {
      // Use the explicitly selected/bundled runtime for npm-based agent CLIs
      // as well as the legacy daemon, even when the daemon itself is Rust.
      const pathKey=Object.keys(runtimeEnvironment).find(key=>key.toLowerCase()==="path") ?? "PATH";
      runtimeEnvironment[pathKey]=`${dirname(nodeRuntime)}${delimiter}${runtimeEnvironment[pathKey] ?? ""}`;
    }
    this.process = spawn(command, args, {
      cwd: userDataPath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...runtimeEnvironment, ...(browserPort ? { NAUTILO_BROWSER_PORT: String(browserPort) } : {}), AGENTHUB_DATA_DIR: userDataPath, AGENTHUB_SOCKET: socketPath, AGENTHUB_TOKEN_PATH: this.tokenPath }
    });
    const ready = await this.waitForReady(this.process);
    this.socketPath = ready.socketPath;
  }

  private resolveDaemonEntry(): string {
    const candidates = [
      // Development/build layout: apps/desktop/out/main -> repository root.
      join(__dirname, "../../../../packages/core-daemon/dist/index.js"),
      // Packaged layout reserved for the release bundle.
      join(process.resourcesPath, "core-daemon/dist/index.js")
    ];
    const entry = candidates.find((candidate) => existsSync(candidate));
    if (!entry) throw new Error(`Core Daemon entry was not found: ${candidates.join(", ")}`);
    return entry;
  }

  private resolveNodeCommand(): string {
    if (process.env.AGENTHUB_NODE_PATH) return process.env.AGENTHUB_NODE_PATH;
    const executable = process.platform === "win32" ? "node.exe" : "node";
    const bundledRuntime = join(process.resourcesPath, "node", executable);
    return existsSync(bundledRuntime) ? bundledRuntime : executable;
  }

  /** Prefer the Rust daemon (nautilo-core); fall back to the TS daemon under Node. */
  private resolveDaemonCommand(): { command: string; args: string[] } {
    const exe = this.resolveDaemonExe();
    if (exe) return { command: exe, args: ["--serve"] };
    return { command: this.resolveNodeCommand(), args: [this.resolveDaemonEntry(), "--serve"] };
  }

  private resolveDaemonExe(): string | undefined {
    if (process.env.AGENTHUB_CORE_PATH && existsSync(process.env.AGENTHUB_CORE_PATH)) {
      return process.env.AGENTHUB_CORE_PATH;
    }
    const exe = process.platform === "win32" ? "nautilo-core.exe" : "nautilo-core";
    const candidates = [
      // Development layout: apps/desktop/out/main -> repository rust workspace.
      join(__dirname, "../../../../rust/target/x86_64-pc-windows-gnu/debug/nautilo-core.exe"),
      join(__dirname, "../../../../rust/target/x86_64-pc-windows-gnu/release/nautilo-core.exe"),
      join(__dirname, "../../../../rust/target/debug/nautilo-core"),
      join(__dirname, "../../../../rust/target/release/nautilo-core"),
      // Packaged layout: daemon ships in resources/.
      join(process.resourcesPath, "core-daemon", exe),
      join(process.resourcesPath, exe)
    ];
    return candidates.find((candidate) => existsSync(candidate));
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
    if (!response.value?.ok) {
      const reason = response.value?.error?.details?.reason;
      throw new Error(typeof reason === "string" ? reason : response.value?.error?.message ?? "Core Daemon request failed");
    }
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
      child.stdout?.setEncoding('utf8');
      const onData = (chunk: string): void => {
        buffer += chunk;
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() ?? "";
        for (const line of parts) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            if(message.event==="assistant.text" && typeof message.stepId==="string" && typeof message.text==="string") this.onAssistantText?.(message.stepId,message.text);
            else if(message.event === "browser.run" && typeof message.sessionId === "string" && typeof message.runId === "string" && Number.isInteger(message.sequence) && ["running","waiting","completed","failed","cancelled"].includes(message.state))this.onBrowserRun?.(message);
            else if (message.status === "ok") { clearTimeout(timer); resolve(message as ReadyMessage); }
          } catch { /* wait for the next complete JSON line */ }
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", (chunk) => console.error(`[core-daemon] ${chunk.toString("utf8")}`));
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { this.onBrowserRun?.(); if (code !== 0) { clearTimeout(timer); reject(new Error(`Core Daemon exited with ${code}`)); } });
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
