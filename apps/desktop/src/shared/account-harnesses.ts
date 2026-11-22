export const ACCOUNT_HARNESSES = ["codex", "claude-code", "antigravity", "opencode", "kimi-code"] as const;

export type AccountHarness = typeof ACCOUNT_HARNESSES[number];

export function supportsAccountLogin(providerId: string): providerId is AccountHarness {
  return ACCOUNT_HARNESSES.some(harness => harness === providerId);
}
