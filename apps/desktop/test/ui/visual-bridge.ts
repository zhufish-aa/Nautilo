/** TEST-ONLY transport. Never touches disk, spawns commands, or makes network requests. */
import type { PermissionPolicy, RuntimeMetrics, ProviderModelCatalog, RecoverableProjectRun, AuditRecord, ApprovalRecord, ProviderCapability } from "@agenthub/domain";
import type { ProviderRegistryEntry } from "@agenthub/provider-sdk";
import { parseMcpConfigJson } from "../../../../packages/core-daemon/src/application/capability-import/mcp-json";
import type { CapabilityImportPreview } from "@agenthub/schemas";
import type { ProviderPluginInfo } from "@agenthub/schemas";
import type { AgentHubBridge } from "../../src/renderer/src/types/bridge";
// Expose desktop-only UI for design review, without supplying a working native bridge.
export const isElectron = true;
export function getBridge(): AgentHubBridge | undefined { return undefined; }
export async function requestCore<T>(method: string, input?: unknown): Promise<T> {
  if (method === "capability.parseImport") {
    if (!input || typeof input !== "object" || !("source" in input) || !("text" in input) || typeof input.text !== "string") throw new Error("界面测试：导入参数不完整");
    const source = input.source;
    if (source !== "mcpJson") throw new Error("界面测试仅连接真实 MCP JSON 解析器");
    const origin = "fileName" in input && typeof input.fileName === "string" ? input.fileName : undefined;
    const { servers, errors } = parseMcpConfigJson(input.text, origin);
    return { mcpServers: servers, skills: [], errors } satisfies CapabilityImportPreview as T;
  }
  const data: Record<string, unknown> = {
    "recovery.list": [] satisfies RecoverableProjectRun[],
    "audit.list": [] satisfies AuditRecord[],
    "approval.list": [] satisfies ApprovalRecord[],
    "capability.list": [] satisfies ProviderCapability[],
    "plugin.list": [] satisfies ProviderPluginInfo[],
    "metrics.get": { totalRuns: 0, completedRuns: 0, failedRuns: 0, conflicts: 0, retriedTasks: 0, averageRunDurationMs: 0, verificationTotal: 0, verificationPassed: 0 } satisfies RuntimeMetrics,
    "policy.list": [{ id: "default", name: "常规权限 · 示例", defaultCommandAction: "approval", commandRules: [], environmentAllowlist: [], allowedPaths: ["/sample/nautilo"], updatedAt: "2026-11-03T02:00:00Z" }] satisfies PermissionPolicy[],
    "plugin.registry": [] satisfies ProviderRegistryEntry[], "provider.models": { providerId: "codex", models: [], source: "unavailable", fetchedAt: "2026-11-03T02:00:00Z" } satisfies ProviderModelCatalog
  };
  if (method in data) return structuredClone(data[method]) as T;
  throw new Error(`界面测试不执行操作：${method}`);
}
