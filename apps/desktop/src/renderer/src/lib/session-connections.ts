import type { RuntimeConnection } from "@agenthub/domain";
import type { AgentInstanceConfig } from "./types";
/** Mirrors backend compatibility; never advertise arbitrary protocol translation. */
export function connectionSupportsAgent(connection: RuntimeConnection, instance: AgentInstanceConfig): boolean {
  if (!connection.enabled || instance.baseArgs.length > 0 || instance.profile?.trim()) return false;
  if (connection.kind === "login") return (instance.providerId === "codex" || instance.providerId === "claude-code") && connection.harness === instance.providerId;
  if (instance.providerId === "claude-code") return connection.protocol === "anthropic";
  // Anthropic-to-Codex is experimental and cannot be advertised without a
  // daemon capability signal proving that its compatibility gate is enabled.
  return instance.providerId === "codex" && (connection.protocol === "responses" || connection.protocol === "chat");
}
