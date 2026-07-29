import type { AgentInstance, PermissionPolicy } from "@agenthub/domain";

const PLATFORM_KEYS = process.platform === "win32"
  ? ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA"]
  : ["PATH", "HOME", "TMPDIR", "SHELL", "LANG", "LC_ALL"];

export const DEFAULT_ENVIRONMENT_ALLOWLIST = [...PLATFORM_KEYS, "CI", "NO_COLOR", "TERM"];

/**
 * Extra env for provider processes (model discovery and runs), sourced from
 * the shell environment and the instance's providerOptions. Which variables
 * pass through comes from the provider's descriptor (AdapterRegistry), so
 * plugins declare their own env needs. Stored credentials are merged on top
 * by callers so they always win over shell values.
 */
export function providerEnvironmentPassthrough(
  instance: AgentInstance,
  processEnv: NodeJS.ProcessEnv = process.env,
  spec: { envPassthrough?: readonly string[]; baseUrlEnv?: string } = {}
): Record<string, string> {
  const keys = spec.envPassthrough ?? [];
  const additions: Record<string, string> = {};
  for (const key of keys) {
    const value = processEnv[key]?.trim();
    if (value) additions[key] = value;
  }
  if (spec.baseUrlEnv) {
    const baseUrl = instance.providerOptions?.baseUrl;
    if (typeof baseUrl === "string" && baseUrl.trim()) additions[spec.baseUrlEnv] = baseUrl.trim();
  }
  return additions;
}

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
