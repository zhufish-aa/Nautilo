export type SlashCommandAvailability = "always" | "idle";
export type SlashCommandIcon = "help" | "model" | "reasoning" | "speed" | "status" | "usage" | "rename";

export interface SlashCommandDefinition {
  id: string;
  name: string;
  aliases: string[];
  title: string;
  description: string;
  icon: SlashCommandIcon;
  availability: SlashCommandAvailability;
  /** AgentHub commands open structured local UI; provider commands are sent to the active CLI session. */
  execution?: "agenthub" | "provider";
  argumentHint?: string;
  argumentRequired?: boolean;
}

export interface SlashCommandOption {
  id: string;
  label: string;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
}

export interface SlashCommandSelection {
  mode: "single" | "multiple";
  options: SlashCommandOption[];
  minimum: number;
  maximum?: number;
}

export type SlashCommandResultSection =
  | { kind: "text"; text: string }
  | { kind: "key_value"; items: Array<{ label: string; value: string }> }
  | { kind: "list"; items: Array<{ label: string; description?: string }> };

export interface SlashCommandResultAction {
  id: string;
  label: string;
  kind: "primary" | "secondary" | "danger";
  requiresSelection?: boolean;
}

export interface SlashCommandResult {
  commandId: string;
  title: string;
  description?: string;
  sections: SlashCommandResultSection[];
  selection?: SlashCommandSelection;
  actions: SlashCommandResultAction[];
  completed: boolean;
  sessionPatch?: {
    title?: string;
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
  };
}
