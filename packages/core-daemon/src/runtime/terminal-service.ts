import { randomUUID } from "node:crypto";
import { createOptionalPtyRuntime, type PtyHandle, type PtyRuntime } from "../pty-runtime.js";

interface TerminalSession {
  id: string; key: string; cwd: string; process: PtyHandle;
  scope?: string; tabId?: string;
  chunks: Buffer[]; start: number; end: number; lines: number; exitCode?: number;
  dispose: Array<() => void>;
}

/** The legacy host uses the same cursor/retention contract as the Rust PTY. */
export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly closedScopes = new Set<string>();
  constructor(private readonly runtime: PtyRuntime = createOptionalPtyRuntime()) {}
  static scope(sessionId: string | undefined, projectId: string) { return JSON.stringify(sessionId ? ["session", sessionId] : ["project", projectId]); }
  list(scope: string) {
    const latest = new Map<string, TerminalSession>();
    for (const session of this.sessions.values()) if (session.scope === scope) latest.set(session.key, session);
    return { items: [...latest.values()].map(session => this.metadata(session)) };
  }
  open(key: string, cwd: string, cols = 100, rows = 24, options: {scope?: string; tabId?: string; restoreOnly?: boolean} = {}) {
    if (options.scope && this.closedScopes.has(options.scope)) throw new Error("Terminal session has been deleted");
    const existing = [...this.sessions.values()].find(session => session.key === key && session.exitCode === undefined);
    if (existing) return this.metadata(existing);
    if (options.restoreOnly) {
      const previous = [...this.sessions.values()].filter(session => session.key === key).at(-1);
      if (!previous) throw new Error("Terminal tab is no longer available");
      return this.metadata(previous);
    }
    if ([...this.sessions.values()].filter(session => session.exitCode === undefined).length >= 32) throw new Error("已有 32 个终端正在运行，请先结束一个终端。");
    const process = this.runtime.start({ command: globalThis.process.platform === "win32" ? "powershell.exe" : globalThis.process.env.SHELL ?? "/bin/sh",
      args: globalThis.process.platform === "win32" ? ["-NoLogo"] : [], cwd, columns: Math.max(10, Math.min(cols, 1000)), rows: Math.max(2, Math.min(rows, 500)) });
    const session: TerminalSession = { id: randomUUID(), key, cwd, process, scope: options.scope, tabId: options.tabId, chunks: [], start: 0, end: 0, lines: 0, dispose: [] };
    session.dispose.push(process.onData(text => {
      const chunk = Buffer.from(text); session.chunks.push(chunk); session.end += chunk.length; session.lines += text.split("\n").length - 1;
      while (session.end - session.start > 8 * 1024 * 1024 || session.lines > 5000) {
        const dropped = session.chunks.shift(); if (!dropped) break;
        session.start += dropped.length; session.lines -= dropped.toString().split("\n").length - 1;
      }
    }), process.onExit(code => { session.exitCode = code; }));
    while (this.sessions.size >= 64) {
      const oldest = [...this.sessions.values()].find(session => session.exitCode !== undefined);
      if (!oldest) break;
      this.remove(oldest);
    }
    this.sessions.set(session.id, session); return this.metadata(session);
  }
  private metadata(session: TerminalSession) { return { id: session.id, cwd: session.cwd, pid: session.process.pid, kind: "shell" as const, tabId: session.tabId, exited: session.exitCode !== undefined, exitCode: session.exitCode }; }
  private get(id: string) { const session = this.sessions.get(id); if (!session) throw new Error("Terminal closed"); return session; }
  read(id: string, after: number) {
    const session = this.get(id), reset = after < session.start || after > session.end;
    const cursor = reset ? session.start : after;
    const data = Buffer.concat(session.chunks).subarray(cursor - session.start, cursor - session.start + 256 * 1024);
    return { data: data.toString("base64"), cursor: cursor + data.length, reset, exited: session.exitCode !== undefined && cursor + data.length === session.end, exitCode: session.exitCode };
  }
  write(id: string, data: string) { if (Buffer.byteLength(data) > 1024 * 1024) throw new Error("Terminal input exceeds 1 MiB"); this.get(id).process.write(data); return { ok: true as const }; }
  resize(id: string, cols: number, rows: number) { this.get(id).process.resize(Math.max(10, Math.min(cols, 1000)), Math.max(2, Math.min(rows, 500))); return { ok: true as const }; }
  stop(id: string) { const session = this.get(id); if (session.exitCode === undefined) session.process.kill(); return { ok: true as const }; }
  private remove(session: TerminalSession) { if (session.exitCode === undefined) session.process.kill(); for (const dispose of session.dispose) dispose(); this.sessions.delete(session.id); }
  close(id: string) { const session = this.sessions.get(id); if (session) for (const entry of [...this.sessions.values()]) if (entry.key === session.key) this.remove(entry); return { ok: true as const }; }
  closeTab(scope: string, tabId: string) { const key = JSON.stringify(["shell", scope, tabId]); const session = [...this.sessions.values()].find(session => session.key === key); return session ? this.close(session.id) : {ok:true as const}; }
  closeScope(scope: string) { this.closedScopes.add(scope); for (const session of [...this.sessions.values()]) if (session.scope === scope) this.remove(session); }
  closeAll() { for (const id of this.sessions.keys()) this.close(id); }
}
