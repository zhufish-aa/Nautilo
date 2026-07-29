import type { McpServerConfig } from "@agenthub/domain";
import type { MessageKey } from "./i18n";

/**
 * A value the user must supply before the template can be imported, addressed by
 * its position in `mcp.args` so the template stays a plain config object.
 */
export interface McpTemplateField {
  /** Index into `mcp.args` that this field fills. */
  argIndex: number;
  labelKey: MessageKey;
  placeholder: string;
}

export interface McpTemplate {
  id: string;
  /** Capability name; a product name, so it is not translated. */
  name: string;
  descriptionKey: MessageKey;
  tags: string[];
  mcp: McpServerConfig;
  fields?: McpTemplateField[];
}

/**
 * Curated launch commands for MCP servers, so common setups need a path instead
 * of twelve form fields.
 *
 * Every package here was checked against its registry. Servers that npm reports
 * as deprecated ("Package no longer supported") are deliberately absent — the
 * archived `@modelcontextprotocol/server-{github,postgres,brave-search,puppeteer,slack}`
 * packages among them. Add entries only after verifying the package still
 * publishes, and keep the argument order matching its own documentation.
 */
export const MCP_TEMPLATES: McpTemplate[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    descriptionKey: "agents.tools.import.templates.filesystem",
    tags: ["files"],
    mcp: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", ""] },
    fields: [{ argIndex: 2, labelKey: "agents.tools.import.fields.directory", placeholder: "D:\\work\\project" }]
  },
  {
    id: "git",
    name: "Git",
    descriptionKey: "agents.tools.import.templates.git",
    tags: ["git"],
    mcp: { transport: "stdio", command: "uvx", args: ["mcp-server-git", "--repository", ""] },
    fields: [{ argIndex: 2, labelKey: "agents.tools.import.fields.repository", placeholder: "D:\\work\\project" }]
  },
  {
    id: "fetch",
    name: "Fetch",
    descriptionKey: "agents.tools.import.templates.fetch",
    tags: ["web"],
    mcp: { transport: "stdio", command: "uvx", args: ["mcp-server-fetch"] }
  },
  {
    id: "memory",
    name: "Memory",
    descriptionKey: "agents.tools.import.templates.memory",
    tags: ["memory"],
    mcp: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] }
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    descriptionKey: "agents.tools.import.templates.sequentialThinking",
    tags: ["reasoning"],
    mcp: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] }
  },
  {
    id: "time",
    name: "Time",
    descriptionKey: "agents.tools.import.templates.time",
    tags: ["time"],
    mcp: { transport: "stdio", command: "uvx", args: ["mcp-server-time", "--local-timezone", "Asia/Shanghai"] },
    fields: [{ argIndex: 2, labelKey: "agents.tools.import.fields.timezone", placeholder: "Asia/Shanghai" }]
  },
  {
    id: "sqlite",
    name: "SQLite",
    descriptionKey: "agents.tools.import.templates.sqlite",
    tags: ["database"],
    mcp: { transport: "stdio", command: "uvx", args: ["mcp-server-sqlite", "--db-path", ""] },
    fields: [{ argIndex: 2, labelKey: "agents.tools.import.fields.database", placeholder: "D:\\work\\app.db" }]
  },
  {
    id: "playwright",
    name: "Playwright",
    descriptionKey: "agents.tools.import.templates.playwright",
    tags: ["browser"],
    mcp: { transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp"] }
  },
  {
    id: "everything",
    name: "Everything",
    descriptionKey: "agents.tools.import.templates.everything",
    tags: ["demo"],
    mcp: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] }
  }
];

/** Applies the user-entered field values to a copy of the template config. */
export function applyTemplateFields(template: McpTemplate, values: Record<number, string>): McpServerConfig {
  if (!template.fields?.length) return template.mcp;
  const args = [...(template.mcp.args ?? [])];
  for (const field of template.fields) {
    args[field.argIndex] = (values[field.argIndex] ?? "").trim();
  }
  return { ...template.mcp, args };
}

/** True when every field of the template has a non-empty value. */
export function templateReady(template: McpTemplate, values: Record<number, string>): boolean {
  return (template.fields ?? []).every((field) => (values[field.argIndex] ?? "").trim().length > 0);
}
