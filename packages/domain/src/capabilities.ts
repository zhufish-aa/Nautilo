export type CapabilityId = string;

export type CapabilityKind = "skill" | "mcp";

export type McpTransport = "stdio" | "http";

/** User-managed MCP server connection, injected into provider sessions at run time. */
export interface McpServerConfig {
  transport: McpTransport;
  /** stdio: executable used to launch the server. */
  command?: string;
  /** stdio: arguments passed to the command. */
  args?: string[];
  /** stdio: extra environment variables for the server process. */
  env?: Record<string, string>;
  /** stdio: names of daemon-process environment variables forwarded to the server. */
  envPassthrough?: string[];
  /** stdio: working directory for the server process. */
  cwd?: string;
  /** http: streamable HTTP endpoint URL. */
  url?: string;
  /** http: extra request headers. */
  headers?: Record<string, string>;
  /** http: name of a daemon-process env var whose value is sent as the Bearer token. */
  bearerTokenEnvVar?: string;
  /** http: header name → env var name; values are resolved from the daemon process env. */
  envHeaders?: Record<string, string>;
}

/** User-managed skill: a Markdown instruction body synced into provider skill directories. */
export interface SkillConfig {
  /** Markdown body of the skill. */
  instructions: string;
  /** Provenance label shown in the UI, e.g. "Built-in" / "Workspace" / "Custom". */
  source?: string;
  /**
   * Directory the skill was scanned from. Its sibling files (references/,
   * scripts/, …) are the skill's resources and are mirrored into directory-
   * based provider skill folders on sync.
   */
  resourceDir?: string;
}

/**
 * A user-managed capability (skill or MCP server) with a per-provider enable
 * list. `providerIds` uses Core Daemon provider ids (e.g. "codex",
 * "kimi-code", "claude-code", "opencode", "custom").
 */
export interface ProviderCapability {
  id: CapabilityId;
  kind: CapabilityKind;
  name: string;
  description: string;
  tags: string[];
  enabled: boolean;
  /** Providers this capability is enabled for; empty means none. */
  providerIds: string[];
  mcp?: McpServerConfig;
  skill?: SkillConfig;
  createdAt: string;
  updatedAt: string;
}
