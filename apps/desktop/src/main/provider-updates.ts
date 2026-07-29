import { ipcMain } from "electron";
import { spawn, type ChildProcess } from "node:child_process";

export interface ProviderUpdateStartPayload {
  updateId: string;
  executable: string;
  args: string[];
}

export type ProviderUpdateStartResult = { ok: true } | { ok: false; reason: string };

/** Drop output past this cap so a chatty updater cannot grow renderer state unbounded. */
const MAX_OUTPUT_BYTES = 256 * 1024;

const activeUpdates = new Map<string, ChildProcess>();

function spawnUpdate(executable: string, args: string[]): ChildProcess {
  if (process.platform === "win32") {
    // Pass one command string with shell:true — Node then hands cmd a single
    // quoted line. Spawning cmd.exe with an argv array instead would make Node
    // re-quote and backslash-escape the embedded quotes, breaking the command.
    const line = [`"${executable}"`, ...args.map((arg) => `"${arg.replace(/"/g, "")}"`)].join(" ");
    return spawn(line, { shell: true, windowsHide: true });
  }
  return spawn(executable, args, { windowsHide: true });
}

/**
 * Runs a provider CLI's self-update command (`claude update`, `codex update`,
 * ...) and streams its output back to the requesting renderer. The renderer
 * owns correlation via updateId; exit is reported on provider:update-exit.
 */
export function registerProviderUpdateHandlers(): void {
  ipcMain.handle("provider:update-start", (event, payload: ProviderUpdateStartPayload): ProviderUpdateStartResult => {
    const updateId = typeof payload?.updateId === "string" ? payload.updateId : "";
    const executable = typeof payload?.executable === "string" ? payload.executable.trim() : "";
    const args = Array.isArray(payload?.args)
      ? payload.args.filter((arg): arg is string => typeof arg === "string" && arg.trim().length > 0)
      : [];
    if (!updateId || !executable || args.length === 0) return { ok: false, reason: "invalid-payload" };
    if (activeUpdates.has(updateId)) return { ok: false, reason: "busy" };

    const sender = event.sender;
    const send = (channel: "provider:update-output" | "provider:update-exit", data: Record<string, unknown>): void => {
      if (!sender.isDestroyed()) sender.send(channel, data);
    };

    let child: ChildProcess;
    try {
      child = spawnUpdate(executable, args);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    activeUpdates.set(updateId, child);

    let buffered = 0;
    // cmd and legacy CLI shims print in the OEM/GBK codepage on Windows.
    const decoder = new TextDecoder(process.platform === "win32" ? "gbk" : "utf-8");
    const onData = (chunk: Buffer): void => {
      buffered += chunk.length;
      if (buffered > MAX_OUTPUT_BYTES) return;
      send("provider:update-output", { updateId, chunk: decoder.decode(chunk, { stream: true }) });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      activeUpdates.delete(updateId);
      send("provider:update-exit", { updateId, exitCode: -1, error: error.message });
    });
    child.on("exit", (code) => {
      activeUpdates.delete(updateId);
      send("provider:update-exit", { updateId, exitCode: code ?? -1 });
    });
    return { ok: true };
  });

  ipcMain.handle("provider:update-cancel", (_event, updateId: string) => {
    if (typeof updateId === "string") activeUpdates.get(updateId)?.kill();
  });
}
