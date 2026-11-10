import { mkdir, writeFile, rm, lstat, readdir, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const MARKER = ".nautilo-run.json";
const MAGIC = "nautilo-private-claude-v1";
const RETENTION = 24 * 60 * 60_000;

async function privateRoot(): Promise<string> {
  let identity = String(process.getuid?.() ?? "windows");
  if (process.platform === "win32") {
    const result = await execute(join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 10_000 });
    const sid = result.stdout.match(/S-1-\d+(?:-\d+)+/i)?.[0];
    if (!sid) throw new Error("Cannot establish the current Windows account for private CLI configuration");
    identity = sid;
  }
  const root = join(tmpdir(), `nautilo-private-cli-${identity}`);
  await mkdir(root, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Private CLI configuration root is not a regular directory");
  if (process.platform === "win32") {
    // Harden the empty/root directory before writing ANY secret. Fixed argv,
    // no shell. Children inherit only this account's full-control grant.
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const script = "$ErrorActionPreference='Stop'; $item=Get-Item -LiteralPath $env:NAUTILO_CONFIG_DIR -Force; if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point rejected' }; $existing=Get-Acl -LiteralPath $env:NAUTILO_CONFIG_DIR; if ($existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $env:NAUTILO_OWNER_SID) { throw 'Foreign owner rejected' }; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;' + $env:NAUTILO_OWNER_SID + ')', [System.Security.AccessControl.AccessControlSections]::Access); [System.IO.Directory]::SetAccessControl($env:NAUTILO_CONFIG_DIR, $acl)";
    await execute(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 10_000, env: { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: tmpdir(), NAUTILO_CONFIG_DIR: root, NAUTILO_OWNER_SID: identity } });
  } else if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error("Private CLI configuration root must be owned by this user with mode 0700");
  }
  return root;
}
function definitelyDead(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
/** Conservative bounded reclamation: unknown/live/reused PIDs are never removed. */
export async function cleanupStaleClaudeConfigs(root: string, now = Date.now(), dead = definitelyDead): Promise<void> {
  const entries = (await readdir(root, { withFileTypes: true })).slice(0, 128);
  for (const entry of entries) {
    if (!/^\d+-[0-9a-f-]{36}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = join(root, entry.name);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || now - info.mtimeMs < RETENTION) continue;
      if (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) continue;
      const markerInfo = await lstat(join(directory, MARKER));
      if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 1024) continue;
      const marker = JSON.parse(await readFile(join(directory, MARKER), "utf8"));
      if (!Number.isSafeInteger(marker.parentPid) || marker.parentPid <= 0 || !Number.isSafeInteger(marker.childPid) || marker.childPid <= 0 || marker.magic !== MAGIC || !entry.name.startsWith(`${marker.parentPid}-`) || !dead(marker.parentPid) || !dead(marker.childPid)) continue;
      const files = await readdir(directory, { withFileTypes: true });
      if (files.some((file) => !file.isFile() || file.isSymbolicLink() || (file.name !== MARKER && !/^config-\d+\.json$/.test(file.name)))) continue;
      // Unlink only recognized leaves; rmdir fails safely if anything new appears.
      for (const file of files) await unlink(join(directory, file.name));
      await rmdir(directory);
    } catch { /* Ambiguous ownership, races or permissions: retain rather than guess. */ }
  }
}

/** Generated secrets are stored in owner-private files, never process argv. */
export async function privateClaudeConfig(args: string[]): Promise<{ args: string[]; cleanup: () => Promise<void>; recordChild: (pid?: number) => Promise<void> }> {
  let directory: string | undefined;
  const output = [...args];
  const cleanup = async (): Promise<void> => { if (directory) await rm(directory, { recursive: true, force: true }); };
  const recordChild = async (pid?: number): Promise<void> => {
    if (directory) await writeFile(join(directory, MARKER), JSON.stringify({ magic: MAGIC, parentPid: process.pid, childPid: pid ?? null }), { mode: 0o600 });
  };
  try {
    for (let index = 0; index < output.length - 2; index++) {
      if (!["--settings", "--mcp-config"].includes(output[index])) continue;
      const value = output[index + 1];
      if (!value.trimStart().startsWith("{")) continue;
      JSON.parse(value);
      if (!directory) {
        const root = await privateRoot();
        await cleanupStaleClaudeConfigs(root);
        directory = join(root, `${process.pid}-${randomUUID()}`);
        await mkdir(directory, { mode: 0o700 });
        await recordChild();
      }
      const path = join(directory, `config-${index}.json`);
      await writeFile(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
      output[index + 1] = path;
      index++;
    }
    return { args: output, cleanup, recordChild };
  } catch (error) { await cleanup(); throw error; }
}
