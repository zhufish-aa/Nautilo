import { delimiter, dirname, isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import { CoreError } from "../../errors.js";
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
    const runtime=process.env.AGENTHUB_NODE_PATH;
    const pathKey=Object.keys(environment).find(key=>key.toLowerCase()==="path");
    if (runtime && isAbsolute(runtime) && existsSync(runtime) && pathKey) {
      const directory=dirname(runtime);
      environment[pathKey]=[directory,...environment[pathKey].split(delimiter).filter(path=>path!==directory)].join(delimiter);
    }
    return environment;
  }
}

/** Profile directories are owned by the official CLI. Never read/copy credentials. */
export function loginProfileDirectory(instance: AgentInstance): string | undefined {
  const raw = instance.providerOptions?.loginProfileDirectory;
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string" || !raw.trim() || !isAbsolute(raw.trim()) || /[\r\n\0]/.test(raw)) {
    throw new CoreError("IPC_INVALID_REQUEST", { field: "loginProfileDirectory", reason: "Use an absolute account configuration directory" });
  }
  if (!["codex", "claude-code"].includes(instance.providerId)) {
    throw new CoreError("IPC_INVALID_REQUEST", { field: "loginProfileDirectory", reason: "This harness does not support isolated login profiles" });
  }
  if (instance.providerOptions?.baseUrl || instance.baseArgs.length || instance.profile) {
    throw new CoreError("IPC_INVALID_REQUEST", { field: "loginProfileDirectory", reason: "Account profiles cannot be combined with API endpoints, CLI profiles, or custom arguments" });
  }
  return raw.trim();
}

/** Apply LAST, after allowlists and stored credentials, to prevent API credentials
 * from silently taking precedence over the selected CLI login. */
export function isolateLoginProfile(instance: AgentInstance, environment: Record<string, string>): Record<string, string> {
  const directory = loginProfileDirectory(instance);
  if (!directory) return environment;
  const isolated = { ...environment };
  for (const key of Object.keys(isolated)) {
    if (/^(OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_CODE_(OAUTH|API|USE_|SESSION_ACCESS)|CLAUDE_CONFIG_DIR$|AGENTHUB_API_KEY$)/i.test(key)) delete isolated[key];
  }
  isolated[instance.providerId === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] = directory;
  // Official WIF resolution honors this before HOME/APPDATA. A global active
  // federation profile can otherwise outrank the selected claude.ai login.
  if (instance.providerId === "claude-code") isolated.ANTHROPIC_CONFIG_DIR = join(directory, "anthropic");
  return isolated;
}
