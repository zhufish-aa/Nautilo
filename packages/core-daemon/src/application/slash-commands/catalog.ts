import type { SlashCommandDefinition } from "@agenthub/domain";
import { CLAUDE_SLASH_COMMANDS, claudeProviderCommand } from "./claude-catalog.js";
import { CODEX_SLASH_COMMANDS } from "./codex-catalog.js";
import { KIMI_SLASH_COMMANDS, kimiProviderCommand } from "./kimi-catalog.js";

const CATALOGS: Readonly<Record<string, readonly SlashCommandDefinition[]>> = {
  codex: CODEX_SLASH_COMMANDS,
  "kimi-code": KIMI_SLASH_COMMANDS,
  "claude-code": CLAUDE_SLASH_COMMANDS
};

interface ProviderCommandReport {
  name: string;
  description: string;
  inputHint?: string;
  providerCommand?: "compact";
}

const PROVIDER_COMMAND_FACTORIES: Readonly<Record<string, (input: ProviderCommandReport) => SlashCommandDefinition | undefined>> = {
  "kimi-code": kimiProviderCommand,
  "claude-code": claudeProviderCommand
};

/**
 * Fallback for providers without a built-in factory (plugin providers such as
 * OpenCode). Built-in CLIs dump their whole TUI command list, so their
 * factories whitelist; a plugin reports only the commands it can actually
 * execute headlessly, so every reported command maps through.
 */
function genericProviderCommand(providerId: string) {
  return (input: ProviderCommandReport): SlashCommandDefinition | undefined => {
    const name = input.name.replace(/^\//, "");
    if (!/^[\w-]+$/.test(name)) return undefined;
    const compact = input.providerCommand === "compact" || name === "compact";
    return {
      id: `${providerId}.native.${name}`,
      name: `/${name}`,
      aliases: [],
      title: name === "compact" ? "压缩上下文" : name,
      description: input.description,
      icon: compact || name === "usage" ? "usage" : name === "help" ? "help" : "status",
      availability: compact ? "idle" : "always",
      execution: "provider",
      ...(input.providerCommand ? { providerCommand: input.providerCommand } : {}),
      argumentHint: input.inputHint
    };
  };
}

export function slashCommandCatalog(
  providerId: string,
  providerCommands: ProviderCommandReport[] = []
): SlashCommandDefinition[] {
  const base = [...(CATALOGS[providerId] ?? [])];
  const factory = PROVIDER_COMMAND_FACTORIES[providerId] ?? genericProviderCommand(providerId);
  if (providerCommands.length === 0) return base;
  const byName = new Map(base.map((command) => [command.name, command]));
  for (const command of providerCommands) {
    const definition = factory(command);
    if (definition && !byName.has(definition.name)) byName.set(definition.name, definition);
  }
  return [...byName.values()];
}
