import type { AgentInstance } from "@agenthub/domain";

export const AGENTHUB_CODEX_PROVIDER_ID = "agenthub_proxy";
export const AGENTHUB_CODEX_API_KEY_ENV = "OPENAI_API_KEY";

/**
 * Converts AgentHub's per-instance endpoint into invocation-scoped Codex
 * configuration. This keeps provider routing out of the user's config.toml and
 * prevents a third-party endpoint from inheriting the built-in ChatGPT auth.
 */
export function buildCodexProviderConfigArgs(
  instance: AgentInstance,
  environment: Record<string, string | undefined> | undefined
): string[] {
  const baseUrl = configuredBaseUrl(instance);
  if (!baseUrl) return [];

  const prefix = `model_providers.${AGENTHUB_CODEX_PROVIDER_ID}`;
  const args = [
    "--config", `model_provider=${tomlString(AGENTHUB_CODEX_PROVIDER_ID)}`,
    "--config", `${prefix}.name=${tomlString("AgentHub custom endpoint")}`,
    "--config", `${prefix}.base_url=${tomlString(baseUrl)}`,
    "--config", `${prefix}.wire_api=${tomlString("responses")}`
  ];
  if (environment?.[AGENTHUB_CODEX_API_KEY_ENV]) {
    args.push("--config", `${prefix}.env_key=${tomlString(AGENTHUB_CODEX_API_KEY_ENV)}`);
  }
  return args;
}

function configuredBaseUrl(instance: AgentInstance): string | undefined {
  const raw = instance.providerOptions?.baseUrl;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid Codex API base URL: ${value}`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error(`Unsupported Codex API base URL protocol: ${parsed.protocol}`);
  }
  return value.replace(/\/+$/, "");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
