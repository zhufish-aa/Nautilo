import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/** Official ACP authentication owns OAuth, refresh tokens and the OS keyring. */
export function authenticateAntigravity(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    let settled = false;
    const cleanup = (): void => { lines.close(); child.removeListener("exit", exited); child.removeListener("error", failed); child.stdin?.removeListener("error", failed); };
    const finish = (error?: Error): void => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(); };
    const failed = (): void => finish(new Error("Unable to start the Antigravity CLI"));
    const exited = (): void => finish(new Error("Antigravity closed before Google sign-in completed"));
    const send = (id: number, method: string, params: object): void => { child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); };
    lines.on("line", line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.id === 1) {
        if (value.error || value.result?.protocolVersion !== 1) { finish(new Error("This Antigravity CLI does not support ACP sign-in. Update agy and retry.")); return; }
        if (!value.result.authMethods?.some((method: { id: string }) => method.id === "oauth-personal")) { finish(new Error("Antigravity did not offer Google account sign-in")); return; }
        send(2, "authenticate", { methodId: "oauth-personal" });
      } else if (value.id === 2 && !value.method) {
        finish(value.error ? new Error(`Google sign-in failed: ${String(value.error.message ?? "Authentication failed")}`) : value.result && typeof value.result === "object" ? undefined : new Error("Antigravity returned an invalid sign-in response"));
      } else if (value.method && value.id !== undefined) {
        // We advertise no client terminal/fs capabilities. Never auto-approve an unexpected request.
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: value.id, error: { code: -32601, message: "Nautilo sign-in only supports agent-managed browser OAuth" } })}\n`);
      }
    });
    child.once("exit", exited); child.once("error", failed); child.stdin?.once("error", failed);
    child.stderr?.resume();
    send(1, "initialize", { protocolVersion: 1, clientInfo: { name: "nautilo", version: "0.2.15" }, clientCapabilities: {} });
  });
}
