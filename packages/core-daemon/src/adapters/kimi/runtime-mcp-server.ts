import { startRuntimeMcpBridge, type RuntimeMcpBridge } from "../runtime-mcp-bridge.js";
import type { RuntimeToolExecutor, RuntimeToolSpec } from "../runtime-tools.js";

export type KimiRuntimeMcpBridge = RuntimeMcpBridge;

/**
 * Exposes run-scoped AgentHub tools to Kimi ACP over loopback Streamable HTTP.
 * The random path is a bearer capability and the server exists only for one
 * provider process, so tools never leak into another AgentHub/Kimi session.
 */
export function startKimiRuntimeMcpBridge(
  tools: RuntimeToolSpec[],
  execute: RuntimeToolExecutor
): Promise<KimiRuntimeMcpBridge> {
  return startRuntimeMcpBridge("kimi-code", tools, execute);
}
