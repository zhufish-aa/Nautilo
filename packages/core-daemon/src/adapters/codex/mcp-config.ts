import type { AdapterMcpServer } from "../types.js";

function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(", ")} }`;
}

/**
 * Codex `-c key=value` config overrides for user-managed MCP servers. Values
 * are TOML-encoded so the app-server picks the servers up for every thread it
 * spawns, without touching the user's config.toml.
 */
export function buildCodexMcpConfigArgs(servers: AdapterMcpServer[] = []): string[] {
  const args: string[] = [];
  for (const server of servers) {
    const key = `mcp_servers.${tomlKey(server.name)}`;
    if (server.transport === "stdio" && server.command) {
      args.push("-c", `${key}.command=${tomlString(server.command)}`);
      if (server.args?.length) args.push("-c", `${key}.args=${tomlStringArray(server.args)}`);
      if (server.env && Object.keys(server.env).length) args.push("-c", `${key}.env=${tomlInlineTable(server.env)}`);
      if (server.cwd) args.push("-c", `${key}.cwd=${tomlString(server.cwd)}`);
    } else if (server.transport === "http" && server.url) {
      args.push("-c", `${key}.url=${tomlString(server.url)}`);
      if (server.headers && Object.keys(server.headers).length) args.push("-c", `${key}.headers=${tomlInlineTable(server.headers)}`);
    }
  }
  return args;
}
