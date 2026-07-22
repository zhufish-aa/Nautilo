import type { PermissionPolicy } from "@agenthub/domain";

const PLATFORM_KEYS = process.platform === "win32"
  ? ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA"]
  : ["PATH", "HOME", "TMPDIR", "SHELL", "LANG", "LC_ALL"];

export const DEFAULT_ENVIRONMENT_ALLOWLIST = [...PLATFORM_KEYS, "CI", "NO_COLOR", "TERM"];

export class EnvironmentPolicyService {
  build(policy: PermissionPolicy | undefined, additions: Record<string, string | undefined> = {}): Record<string, string> {
    const allowed = new Set(policy?.environmentAllowlist?.length ? policy.environmentAllowlist : DEFAULT_ENVIRONMENT_ALLOWLIST);
    const environment: Record<string, string> = {};
    for (const key of allowed) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
    for (const [key, value] of Object.entries(additions)) if (value !== undefined) environment[key] = value;
    return environment;
  }
}
