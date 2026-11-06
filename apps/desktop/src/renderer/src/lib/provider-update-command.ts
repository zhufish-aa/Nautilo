const UPDATE_ARGS: Partial<Record<string, string[]>> = {
  codex: ["update"],
  "kimi-code": ["update"],
  "claude-code": ["update"],
  opencode: ["upgrade"]
};

/** npm/pnpm/bun Codex entrypoints supply the installation metadata to the binary. */
export function providerUpdateCommand(providerId: string, executable: string): { executable: string; args: string[] } | undefined {
  const args = UPDATE_ARGS[providerId];
  if (!args || !executable) return undefined;
  if (providerId === "codex") {
    const normalized = executable.replace(/\\/g, "/");
    const packageRoot = normalized.match(/^(.*\/node_modules\/@openai\/codex)\/(?:node_modules\/|vendor\/)/i)?.[1];
    if (packageRoot) return { executable: "node", args: [`${packageRoot}/bin/codex.js`, ...args] };
  }
  return { executable, args: [...args] };
}
