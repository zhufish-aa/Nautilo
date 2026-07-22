import { homedir } from "node:os";
import { join } from "node:path";
import { CoreDaemon } from "./application/core-daemon.js";

export * from "./adapters/index.js";
export * from "./database.js";
export * from "./ipc-gateway.js";
export * from "./process-runtime.js";
export * from "./pty-runtime.js";
export * from "./service.js";
export * from "./errors.js";
export * from "./runtime/run-service.js";
export * from "./runtime/session-run-queue.js";
export * from "./runtime/event-service.js";
export * from "./runtime/orchestration/index.js";
export * from "./runtime/git/index.js";
export * from "./runtime/security/index.js";
export * from "./runtime/observability/index.js";
export * from "./runtime/recovery-service.js";
export * from "./runtime/event-subscription-service.js";
export * from "./application/orchestration-service.js";
export * from "./application/agent-service.js";
export * from "./application/session-context.js";
export * from "./application/core-daemon.js";
export * from "./application/slash-commands/index.js";

export interface CoreDaemonHealth {
  service: "core-daemon";
  status: "ok";
  version: string;
}

export function getHealth(): CoreDaemonHealth {
  return { service: "core-daemon", status: "ok", version: "0.1.0" };
}

export async function startDaemon(options: { dataDir?: string; socketPath?: string; tokenPath?: string } = {}): Promise<{ daemon: CoreDaemon; socketPath: string; token: string }> {
  const dataDir = options.dataDir ?? process.env.AGENTHUB_DATA_DIR ?? join(homedir(), ".agenthub");
  const daemon = new CoreDaemon({ dataDir });
  const socketPath = options.socketPath ?? process.env.AGENTHUB_SOCKET ?? (process.platform === "win32" ? "\\\\.\\pipe\\agenthub-core" : join(dataDir, "core.sock"));
  const result = await daemon.gateway.startSocket(socketPath, options.tokenPath ?? process.env.AGENTHUB_TOKEN_PATH ?? join(dataDir, "core.token"));
  return { daemon, socketPath, token: result.token };
}

const isMainProcess = process.argv[1]?.replaceAll("\\", "/").endsWith("/dist/index.js") ?? false;
if (isMainProcess) {
  if (process.argv.includes("--serve")) {
    void startDaemon({}).then(({ daemon, socketPath }) => {
      console.log(JSON.stringify({ ...getHealth(), socketPath }));
      const shutdown = async (): Promise<void> => { await daemon.stop(); process.exit(0); };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    });
  } else {
    console.log(JSON.stringify(getHealth()));
  }
}
