import { prepareAccountProfile, recoverableAccountProfiles, attachAccountProfile } from "./account-profile";
import { app, BrowserWindow, ipcMain } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, resolve, join } from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import { authenticateAntigravity } from "./antigravity-login";

export interface AccountLoginInput { profileId: string; providerId: string; executable: string; directory: string }
export interface AccountLoginStatus { state: "idle" | "running" | "succeeded" | "failed" | "cancelled"; reason?: string }
type Job = { status: AccountLoginStatus; terminalStatus?: AccountLoginStatus; providerId: string; directory: string; child?: ChildProcess; timer?: ReturnType<typeof setTimeout> };
const jobs = new Map<string, Job>();
const allowedEnv = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "HOME", "TMPDIR", "SHELL", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

export function loginInvocation(input: AccountLoginInput): { command: string; args: string[]; env: Record<string, string> } {
  if (!input || !input.profileId || !["codex", "claude-code", "antigravity"].includes(input.providerId) || !isAbsolute(input.directory) || /[\r\n\0]/.test(input.directory) || !input.executable?.trim() || /[\r\n\0]/.test(input.executable)) throw new Error("invalid-login-profile");
  // Do not invoke a shell. Windows npm users should select the native .exe or
  // configure a native CLI installation, rather than interpolating a .cmd shim.
  if (/\.(cmd|bat|ps1)$/i.test(input.executable)) throw new Error("Select a native CLI executable; shell shims are not supported for login");
  const env: Record<string, string> = {};
  for (const name of allowedEnv) {
    const key = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
    if (key && process.env[key] !== undefined) env[key] = process.env[key]!;
  }
  if (input.providerId !== "antigravity") env[input.providerId === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] = input.directory;
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    const key = Object.keys(process.env).find(key => key.toUpperCase() === name);
    if (key && process.env[key]) env[key] = process.env[key]!;
  }
  if (input.providerId === "claude-code") env.ANTHROPIC_CONFIG_DIR = join(input.directory, "anthropic");
  return { command: input.executable, args: input.providerId === "antigravity" ? ["acp"] : input.providerId === "codex" ? ["login"] : ["auth", "login"], env };
}

function stopLogin(job: Job, terminalStatus: AccountLoginStatus): void {
  if (job.status.state !== "running" || !job.child) return;
  job.terminalStatus = terminalStatus;
  job.status = { state: "running", reason: "Stopping login; the directory remains locked until the process exits." };
  clearTimeout(job.timer);
  job.child.kill();
  job.timer = setTimeout(() => { job.child?.kill("SIGKILL"); }, 2000);
}

export function registerAccountLoginHandlers(): void {
  ipcMain.handle("account:login-recoverable", () => recoverableAccountProfiles(app.getPath("userData")));
  ipcMain.handle("account:login-attached", (_event, input: { providerId: string; profileId: string }) => attachAccountProfile(app.getPath("userData"), input.providerId, input.profileId));
  ipcMain.handle("account:login-prepare", (_event, providerId: string) => prepareAccountProfile(app.getPath("userData"), providerId));
  ipcMain.handle("account:login-start", async (event, input: AccountLoginInput) => {
    try {
      const invocation = loginInvocation(input);
      if (jobs.get(input.profileId)?.status.state === "running") return { ok: false, reason: "Login is already running" };
      await mkdir(input.directory, { recursive: true, mode: 0o700 });
      const directory = await realpath(resolve(input.directory));
      if ([...jobs.values()].some((job) => job.status.state === "running" && job.directory === directory)) return { ok: false, reason: "This directory already has a login in progress" };
      if (jobs.get(input.profileId)?.status.state === "running") return { ok: false, reason: "Login is already running" };
      if (input.providerId === "antigravity" && [...jobs.values()].some(job => job.status.state === "running" && job.providerId === "antigravity")) return { ok: false, reason: "Google sign-in is already running" };
      const child = spawn(invocation.command, invocation.args, { env: invocation.env, cwd: directory, shell: false, windowsHide: true, stdio: input.providerId === "antigravity" ? "pipe" : "ignore" });
      const job: Job = { providerId: input.providerId, directory, child, status: { state: "running" } };
      jobs.set(input.profileId, job);
      const finish = (status: AccountLoginStatus): void => {
        if (job.status.state !== "running") return;
        job.status = job.terminalStatus ?? status;
        clearTimeout(job.timer);
        job.child = undefined;
        if (job.status.state === "succeeded" && !event.sender.isDestroyed?.()) { const window = BrowserWindow?.fromWebContents(event.sender); window?.show(); window?.focus(); }
      };
      child.once("error", () => {
        if (!child.pid) finish({ state: "failed", reason: "Could not start the native CLI. Check its executable path." });
        else job.status = { state: "running", reason: "Unable to stop or inspect the login process. Its directory remains locked until exit." };
      });
      child.once("exit", (code) => {
        if (input.providerId !== "antigravity") finish(code === 0 ? { state: "succeeded" } : { state: "failed", reason: "Login did not finish. Use the official CLI in a terminal if browser login requires interactive input." });
      });
      if (input.providerId === "antigravity") void authenticateAntigravity(child).then(() => {
        finish({ state: "succeeded" }); child.kill();
      }, error => {
        finish({ state: "failed", reason: error instanceof Error ? error.message : "Google sign-in failed" }); child.kill();
      });
      job.timer = setTimeout(() => stopLogin(job, { state: "failed", reason: "Login timed out after five minutes" }), 5 * 60_000);
      event.sender.once("destroyed", () => stopLogin(job, { state: "cancelled", reason: "Login process ended after cancellation; check the CLI account state before retrying." }));
      return { ok: true };
    } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "Unable to start login" }; }
  });
  ipcMain.handle("account:login-status", (_event, profileId: string): AccountLoginStatus => jobs.get(profileId)?.status ?? { state: "idle" });
  ipcMain.handle("account:login-cancel", (_event, profileId: string) => {
    const job = jobs.get(profileId);
    if (job?.status.state === "running") {
      stopLogin(job, { state: "cancelled", reason: "Login process ended after cancellation; check the CLI account state before retrying." });
    }
  });
}
