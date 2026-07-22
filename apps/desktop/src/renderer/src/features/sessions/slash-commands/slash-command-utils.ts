import type { SlashCommandDefinition } from "@agenthub/domain";

export function slashCommandQuery(value: string): string | undefined {
  return /^\/[^\s]*$/.test(value) ? value.toLowerCase() : undefined;
}

export function filterSlashCommands(commands: SlashCommandDefinition[], query: string): SlashCommandDefinition[] {
  if (query === "/") return commands;
  return commands.filter((command) => [command.name, ...command.aliases]
    .some((candidate) => candidate.toLowerCase().includes(query)));
}

export function parseSlashCommand(value: string, commands: SlashCommandDefinition[]): { command: SlashCommandDefinition; argument?: string } | undefined {
  const trimmed = value.trim();
  const [name = "", ...argumentParts] = trimmed.split(/\s+/);
  const command = commands.find((item) => [item.name, ...item.aliases].some((candidate) => candidate.toLowerCase() === name.toLowerCase()));
  if (!command) return undefined;
  const argument = argumentParts.join(" ").trim();
  return { command, argument: argument || undefined };
}
