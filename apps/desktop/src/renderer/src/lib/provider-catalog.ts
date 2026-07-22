import type { EnvironmentPolicy, ProviderMeta } from "./types";

/**
 * Presentation metadata only. Installation state and configured instances are
 * loaded from Core Daemon; this catalog never pretends that a CLI is installed.
 */
export const PROVIDERS: ProviderMeta[] = [
  {
    id: "codex",
    name: "Codex",
    vendor: "OpenAI",
    capabilities: ["headless_structured", "long_running_stdin"]
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    vendor: "Moonshot AI",
    capabilities: ["headless_structured", "pty_interactive"]
  },
  {
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    capabilities: ["headless_structured", "long_running_stdin", "pty_interactive"]
  },
  {
    id: "opencode",
    name: "OpenCode",
    vendor: "OpenCode",
    capabilities: ["headless_text", "provider_server"]
  },
  {
    id: "custom-cli",
    name: "Custom CLI",
    vendor: "Local",
    capabilities: ["headless_text"]
  }
];

/** Suggestions are UI conveniences, not detected installation data. */
export const MODEL_SUGGESTIONS: Record<string, string[]> = {
  codex: [],
  "kimi-code": [],
  "claude-code": [],
  opencode: [],
  "custom-cli": []
};

export const ENV_POLICIES: EnvironmentPolicy[] = [
  { id: "env-standard", nameKey: "envPolicies.env-standard.name", descriptionKey: "envPolicies.env-standard.description" },
  { id: "env-strict", nameKey: "envPolicies.env-strict.name", descriptionKey: "envPolicies.env-strict.description" },
  { id: "env-custom", nameKey: "envPolicies.env-custom.name", descriptionKey: "envPolicies.env-custom.description" }
];

export function providerMeta(providerId: string): ProviderMeta {
  return PROVIDERS.find((provider) => provider.id === providerId) ?? {
    id: providerId,
    name: providerId,
    vendor: "Custom",
    capabilities: ["headless_text"]
  };
}
