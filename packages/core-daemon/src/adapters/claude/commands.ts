import type { AgentInstance } from "@agenthub/domain";
import type { AdapterMcpServer, AdapterResumeRequest, AdapterStartRequest } from "../types.js";
import { resolvePermissionMode } from "../permission-mode.js";
import { PERMISSION_PROMPT_TOOL_NAME, type RuntimeMcpBridge } from "../runtime-mcp-bridge.js";
import { CLAUDE_EFFORT_LEVELS } from "./models.js";

const CLAUDE_PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "auto", "dontAsk"]);

/** Server name used in --mcp-config; CLI-side tool names become mcp__agenthub__*. */
export const CLAUDE_RUNTIME_MCP_SERVER = "agenthub";

/** CLI-native permission mode → claude's --permission-mode flag; session override wins. */
export function claudePermissionArgs(instance: AgentInstance, request?: AdapterStartRequest): string[] {
  const mode = resolvePermissionMode(instance, request);
  return mode && CLAUDE_PERMISSION_MODES.has(mode) ? ["--permission-mode", mode] : [];
}

function modelArgs(request?: AdapterStartRequest): string[] {
  // "default" is an AgentHub catalog entry meaning "whatever the CLI is configured with".
  return request?.model && request.model !== "default" ? ["--model", request.model] : [];
}

function effortArgs(request?: AdapterStartRequest): string[] {
  const effort = request?.reasoningEffort;
  return effort && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(effort) ? ["--effort", effort] : [];
}

const CLAUDE_ENV_OVERRIDE_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/**
 * ~/.claude/settings.json `env` wins over the inherited process environment,
 * so deliberately configured values (instance baseUrl, vault credentials)
 * would silently lose. CLI `--settings` has higher precedence and merges
 * per-key, keeping unrelated user settings intact.
 */
export function claudeSettingsArgs(request?: AdapterStartRequest): string[] {
  const env: Record<string, string> = {};
  for (const key of CLAUDE_ENV_OVERRIDE_KEYS) {
    const value = request?.env?.[key]?.trim();
    if (value) env[key] = value;
  }
  return Object.keys(env).length ? ["--settings", JSON.stringify({ env })] : [];
}

/**
 * Headless MCP config: user-managed servers merged with the run-scoped
 * AgentHub tool bridge. User server tools are pre-allowed so headless runs do
 * not stall on a permission prompt.
 */
export function claudeRuntimeMcpArgs(bridgeUrl: string | undefined, servers: AdapterMcpServer[] = []): string[] {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    if (server.transport === "http" && server.url) {
      mcpServers[server.name] = {
        type: "http",
        url: server.url,
        ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {})
      };
    } else if (server.transport === "stdio" && server.command) {
      mcpServers[server.name] = {
        command: server.command,
        ...(server.args?.length ? { args: server.args } : {}),
        ...(server.env && Object.keys(server.env).length ? { env: server.env } : {})
      };
    }
  }
  if (bridgeUrl) mcpServers[CLAUDE_RUNTIME_MCP_SERVER] = { type: "http", url: bridgeUrl };
  const names = Object.keys(mcpServers);
  if (!names.length) return [];
  return [
    "--mcp-config",
    JSON.stringify({ mcpServers }),
    "--allowedTools",
    ...names.map((name) => `mcp__${name}`)
  ];
}

/**
 * Routes Claude Code permission prompts (including AskUserQuestion) through
 * the AgentHub interaction bridge. The flag points at the bridge's
 * permission_prompt tool, so it requires the bridge to be listening.
 */
export function claudePermissionPromptToolArgs(request: AdapterStartRequest | AdapterResumeRequest, bridge: RuntimeMcpBridge | undefined): string[] {
  return bridge && request.requestInteraction
    ? ["--permission-prompt-tool", `mcp__${CLAUDE_RUNTIME_MCP_SERVER}__${PERMISSION_PROMPT_TOOL_NAME}`]
    : [];
}

export function buildClaudeStartArgs(instance: AgentInstance, prompt: string, request?: AdapterStartRequest): string[] {
  if (instance.baseArgs.length) return [...instance.baseArgs, prompt];
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    // Emits stream_event deltas alongside the complete messages, so the
    // daemon's delta pipeline can stream text/thinking as they generate.
    "--include-partial-messages",
    ...modelArgs(request),
    ...effortArgs(request),
    ...claudePermissionArgs(instance, request),
    ...claudeSettingsArgs(request),
    prompt
  ];
}

export function buildClaudeResumeArgs(instance: AgentInstance, sessionId: string, prompt: string, request?: AdapterResumeRequest): string[] {
  if (instance.baseArgs.length) return [...instance.baseArgs, "--resume", sessionId, prompt];
  return [
    "-p",
    "--resume", sessionId,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...modelArgs(request),
    ...effortArgs(request),
    ...claudePermissionArgs(instance, request),
    ...claudeSettingsArgs(request),
    prompt
  ];
}
