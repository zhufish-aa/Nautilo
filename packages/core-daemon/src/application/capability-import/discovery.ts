import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DiscoveredMcpSource } from "@agenthub/schemas";
import { parseMcpConfigJson } from "./mcp-json.js";
import { parseMcpConfigToml } from "./mcp-toml.js";

/** Refuse to slurp a config file that is implausibly large. */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

interface ConfigLocation {
  id: string;
  label: string;
  path: string;
  format: "json" | "toml";
}

/** Per-OS install location of the Claude Desktop config. */
function claudeDesktopConfig(home: string): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || join(home, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(configHome, "Claude", "claude_desktop_config.json");
}

/** Known MCP config files, user-level first then project-level. */
export function mcpConfigLocations(projectRoot?: string): ConfigLocation[] {
  const home = homedir();
  const locations: ConfigLocation[] = [
    { id: "claude-code", label: "Claude Code", path: join(home, ".claude.json"), format: "json" },
    { id: "claude-desktop", label: "Claude Desktop", path: claudeDesktopConfig(home), format: "json" },
    { id: "cursor", label: "Cursor", path: join(home, ".cursor", "mcp.json"), format: "json" },
    { id: "codex", label: "Codex", path: join(home, ".codex", "config.toml"), format: "toml" }
  ];
  if (projectRoot?.trim()) {
    const root = projectRoot.trim();
    locations.push(
      { id: "project-mcp", label: "项目 .mcp.json", path: join(root, ".mcp.json"), format: "json" },
      { id: "project-cursor", label: "项目 .cursor", path: join(root, ".cursor", "mcp.json"), format: "json" },
      { id: "project-vscode", label: "项目 .vscode", path: join(root, ".vscode", "mcp.json"), format: "json" }
    );
  }
  return locations;
}

/** Reads every known config file; a missing file is reported, never thrown. */
export function discoverMcpSources(projectRoot?: string): DiscoveredMcpSource[] {
  return mcpConfigLocations(projectRoot).map((location) => {
    const base: DiscoveredMcpSource = {
      id: location.id,
      label: location.label,
      path: location.path,
      available: false,
      servers: []
    };
    try {
      if (!existsSync(location.path)) return base;
      if (statSync(location.path).size > MAX_CONFIG_BYTES) {
        return { ...base, available: true, error: "配置文件过大，已跳过" };
      }
      const text = readFileSync(location.path, "utf8");
      const parsed = location.format === "toml"
        ? parseMcpConfigToml(text, location.label)
        : parseMcpConfigJson(text, location.label);
      return {
        ...base,
        available: true,
        servers: parsed.servers,
        // "no mcpServers block" is normal for these files, not worth surfacing.
        ...(parsed.servers.length === 0 && parsed.errors.length > 0 ? { error: parsed.errors.join("；") } : {})
      };
    } catch (error) {
      return { ...base, available: true, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
