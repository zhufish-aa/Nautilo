import { randomUUID } from "node:crypto";
import { mkdir, lstat, writeFile, readdir, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const PENDING = ".nautilo-pending-login.json";
export interface PendingAccountProfile { profileId: string; providerId: string; directory: string; createdAt: number }
function profileName(providerId: string, profileId: string): string {
  if (!["codex", "claude-code"].includes(providerId) || !/^account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId)) throw new Error("Invalid managed account profile");
  return `${providerId}-${profileId}`;
}
async function readPending(baseDirectory: string, providerId: string, profileId: string): Promise<PendingAccountProfile> {
  const directory = join(baseDirectory, "account-profiles", profileName(providerId, profileId));
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid managed account directory");
  await protect(directory);
  if (providerId === "claude-code") await protect(join(directory, "anthropic"));
  const path = join(directory, PENDING), metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) throw new Error("Invalid pending account record");
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value.profileId !== profileId || value.providerId !== providerId || value.directory !== directory || !Number.isFinite(value.createdAt)) throw new Error("Invalid pending account record");
  return { profileId, providerId, directory, createdAt: value.createdAt };
}
export async function recoverableAccountProfiles(baseDirectory: string): Promise<PendingAccountProfile[]> {
  const root = join(baseDirectory, "account-profiles");
  try { await protect(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: PendingAccountProfile[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).slice(0, 128)) {
    const match = /^(codex|claude-code)-(account-[0-9a-f-]+)$/i.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    try { result.push(await readPending(baseDirectory, match[1], match[2])); } catch { /* Not a known pending record; never inspect auth files. */ }
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
}
/** Acknowledge a saved connection by removing only its recovery metadata. */
export async function attachAccountProfile(baseDirectory: string, providerId: string, profileId: string): Promise<void> {
  await protect(join(baseDirectory, "account-profiles"));
  const record = await readPending(baseDirectory, providerId, profileId);
  await unlink(join(record.directory, PENDING));
}

async function protect(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Account directory is not a regular directory");
  if (process.platform !== "win32") {
    if (info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700) throw new Error("Account directory must be owned by the current user and private");
    return;
  }
  const system = process.env.SystemRoot || "C:\\Windows";
  if (!isAbsolute(system)) throw new Error("Windows system directory must be absolute");
  const { stdout } = await execute(join(system, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 10_000 });
  const sid = stdout.match(/S-1-\d+(?:-\d+)+/i)?.[0];
  if (!sid) throw new Error("Cannot determine the current Windows account");
  const script = "\n$ErrorActionPreference = 'Stop'\n$item = Get-Item -LiteralPath $env:NAUTILO_ACCOUNT_DIR -Force\nif (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point or non-directory rejected' }\n$old = Get-Acl -LiteralPath $env:NAUTILO_ACCOUNT_DIR\nif ($old.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $env:NAUTILO_OWNER_SID) { throw 'Foreign owner rejected' }\n$acl = New-Object System.Security.AccessControl.DirectorySecurity\n$acl.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;' + $env:NAUTILO_OWNER_SID + ')')\nSet-Acl -LiteralPath $env:NAUTILO_ACCOUNT_DIR -AclObject $acl\n$item = Get-Item -LiteralPath $env:NAUTILO_ACCOUNT_DIR -Force\nif (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point or non-directory rejected' }\n$verified = Get-Acl -LiteralPath $env:NAUTILO_ACCOUNT_DIR\nif ($verified.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $env:NAUTILO_OWNER_SID -or -not $verified.AreAccessRulesProtected) { throw 'Owner or inheritance verification failed' }\n$rules = @($verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))\nif ($rules.Count -ne 1) { throw 'Unexpected account directory access rules' }\n$rule = $rules[0]\nif ($rule.IdentityReference.Value -ne $env:NAUTILO_OWNER_SID -or $rule.IsInherited -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or [int]$rule.InheritanceFlags -ne 3 -or [int]$rule.PropagationFlags -ne 0) { throw 'Owner-only ACL verification failed' }\n";
  await execute(join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 10_000, env: { SystemRoot: system, WINDIR: system, NAUTILO_ACCOUNT_DIR: directory, NAUTILO_OWNER_SID: sid } });
}

/** App-owned, fresh directory per login. No user-supplied path or global auth swapping. */
export async function prepareAccountProfile(baseDirectory: string, providerId: string): Promise<{ profileId: string; directory: string }> {
  if (!["codex", "claude-code"].includes(providerId)) throw new Error("This harness does not support isolated account login");
  if (!isAbsolute(baseDirectory)) throw new Error("Application data directory must be absolute");
  const root = join(baseDirectory, "account-profiles");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await protect(root);
  const profileId = `account-${randomUUID()}`;
  const directory = join(root, `${providerId}-${profileId}`);
  await mkdir(directory, { mode: 0o700 });
  await protect(directory);
  if (providerId === "claude-code") { const anthropic = join(directory, "anthropic"); await mkdir(anthropic, { mode: 0o700 }); await protect(anthropic); }
  await writeFile(join(directory, PENDING), JSON.stringify({ profileId, providerId, directory, createdAt: Date.now() }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { profileId, directory };
}
