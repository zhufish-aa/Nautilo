import type { SlashCommandDefinition } from "@agenthub/domain";
import { CODEX_SLASH_COMMANDS } from "./codex-catalog.js";
import { KIMI_SLASH_COMMANDS, kimiProviderCommand } from "./kimi-catalog.js";

const CATALOGS: Readonly<Record<string, readonly SlashCommandDefinition[]>> = {
  codex: CODEX_SLASH_COMMANDS,
  "kimi-code": KIMI_SLASH_COMMANDS
};

export function slashCommandCatalog(
  providerId: string,
  providerCommands: Array<{ name: string; description: string; inputHint?: string }> = []
): SlashCommandDefinition[] {
  const base = [...(CATALOGS[providerId] ?? [])];
  if (providerId !== "kimi-code" || providerCommands.length === 0) return base;
  const byName = new Map(base.map((command) => [command.name, command]));
  for (const command of providerCommands) {
    const definition = kimiProviderCommand(command);
    if (definition && !byName.has(definition.name)) byName.set(definition.name, definition);
  }
  return [...byName.values()];
}
