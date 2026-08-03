import type { McpServerConfig } from "@agenthub/domain";

/** Where the text handed to `capability.parseImport` came from. */
export type CapabilityImportSource = "mcpJson" | "mcpToml" | "mcpCommand" | "skillMarkdown";

/** How `capability.importMany` resolves a name clash with an existing capability. */
export type CapabilityImportConflictPolicy = "skip" | "overwrite" | "rename";

/** An MCP server recovered from pasted text or a discovered config file. */
export interface McpCandidate {
  name: string;
  description: string;
  tags: string[];
  mcp: McpServerConfig;
  /** False when the source marked the server as disabled. */
  enabled: boolean;
  /** Non-fatal notes shown next to the candidate in the preview. */
  warnings: string[];
  /** Human-readable provenance, e.g. a file name. */
  origin?: string;
}

/** A skill recovered from Markdown. */
export interface SkillCandidate {
  name: string;
  description: string;
  tags: string[];
  instructions: string;
  source?: string;
  enabled: boolean;
  /** Core Daemon provider ids parsed from frontmatter; empty when unspecified. */
  providerIds: string[];
  warnings: string[];
  origin?: string;
  /** Set when the Markdown carries an Nautilo marker, i.e. we wrote this file. */
  existingId?: string;
  /**
   * Directory holding the scanned `SKILL.md`; its other files are the skill's
   * resources. Unset for loose Markdown files and pasted text.
   */
  resourceDir?: string;
}

export interface CapabilityImportPreview {
  mcpServers: McpCandidate[];
  skills: SkillCandidate[];
  /** Fatal problems that prevented parsing part or all of the input. */
  errors: string[];
}

/** One known MCP config location on this machine. */
export interface DiscoveredMcpSource {
  id: string;
  /** Product name, e.g. "Claude Desktop". */
  label: string;
  path: string;
  /** False when the file does not exist; not an error. */
  available: boolean;
  error?: string;
  servers: McpCandidate[];
}

export interface CapabilityScanResult extends CapabilityImportPreview {
  scannedFiles: number;
  /** True when a scan limit (depth, file count, file size) cut the walk short. */
  truncated: boolean;
}

export interface CapabilityImportOutcome {
  name: string;
  status: "created" | "updated" | "skipped" | "failed";
  capabilityId?: string;
  error?: string;
}
