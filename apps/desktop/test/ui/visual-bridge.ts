/** TEST-ONLY transport. Never touches disk, spawns commands, or makes network requests. */
import type { RuntimeConnection, PermissionPolicy, RuntimeMetrics, ProviderModelCatalog, RecoverableProjectRun, AuditRecord, ApprovalRecord, ProviderCapability } from "@agenthub/domain";
import type { ProviderRegistryEntry } from "@agenthub/provider-sdk";
import { parseMcpConfigJson } from "../../../../packages/core-daemon/src/application/capability-import/mcp-json";
import type { CapabilityImportPreview } from "@agenthub/schemas";
import type { ProviderPluginInfo } from "@agenthub/schemas";
import type { AgentHubBridge } from "../../src/renderer/src/types/bridge";
// Expose desktop-only UI for design review, without supplying a working native bridge.
export const isElectron = true;
export function getBridge(): AgentHubBridge | undefined { return undefined; }
// Explicit synthetic independent connections. No credentials exist or leave this fixture.
const sampleConnections: RuntimeConnection[] = [
  { id: "sample-connection-work", name: "开发代理 · 示例", kind: "api", revision: 2, enabled: true, protocol: "responses", baseUrl: "https://api.example.invalid/v1", hasCredential: true,
    models: [
      { id: "example-chat", displayName: "通用模型 · 示例", enabled: true, reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium", pricing: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 } },
      { id: "example-reasoning", displayName: "推理模型 · 示例", enabled: true, reasoningEfforts: ["high", "xhigh"], defaultReasoningEffort: "high" },
      { id: "example-mini", displayName: "轻量模型 · 示例", enabled: false, reasoningEfforts: [] },
    ], createdAt: "2026-11-03T02:00:00Z", updatedAt: "2026-11-03T02:00:00Z" },
  { id: "sample-connection-anthropic", name: "Anthropic 连接 · 示例", kind: "api", revision: 1, enabled: true, protocol: "anthropic", baseUrl: "https://anthropic.example.invalid", hasCredential: false, models: [], createdAt: "2026-11-03T02:00:00Z", updatedAt: "2026-11-03T02:00:00Z" },
  { id: "sample-connection-login", name: "个人登录 · 示例", kind: "login", revision: 1, enabled: true, harness: "codex", loginProfileDirectory: "/sample/accounts/example-codex", hasCredential: false, models: [], createdAt: "2026-11-03T02:00:00Z", updatedAt: "2026-11-03T02:00:00Z" },
];
const visualParams = new URLSearchParams(location.search);
if (visualParams.get("section") === "accounts") {
  const account = sampleConnections[2];
  if (visualParams.has("longPath")) account.loginProfileDirectory = `/sample/accounts/${"long-path-segment/".repeat(15)}isolated-codex`;
  account.models = sampleConnections[0].models?.slice(0, 2);
  account.accountGateway = true;
  account.accountMeta = {
    accountEmail: "codex@example.invalid", subscriptionPlan: "Pro", workspaceName: "研发工作区",
    authStatus: visualParams.has("unconfirmedLogin") ? "unverified" : "valid", lastVerifiedAt: new Date(Date.now() - 14 * 60_000).toISOString(), lastLatencyMs: 128,
    lastCheckedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
    localUsage: { requestsToday: 12, tokens7d: 124800, cacheHitRate7d: 53, lastUsedAt: new Date(Date.now() - 3 * 60_000).toISOString(), lastUsedContext: "示例项目" },
    referencedByHarnesses: ["opencode"], storageMeta: { configDir: account.loginProfileDirectory, authMethod: "cli_oauth", credentialUpdatedAt: account.updatedAt },
  };
  sampleConnections.push({ id: "sample-open-code", kind: "login", name: "OpenCode · 示例", harness: "opencode", enabled: true, nativeLogin: true, revision: 1, createdAt: account.createdAt, updatedAt: account.updatedAt,
    accountMeta: { authStatus: "unverified", localUsage: { requestsToday: 0, tokens7d: 0 }, storageMeta: { authMethod: "console_oauth" } } });
}
if (new URLSearchParams(location.search).get("scenario") === "conversation-inspector") {
  const date = "2026-11-03T02:00:00Z";
  sampleConnections.push(
    { id: "sample-claude", name: "Claude Code · 示例", kind: "login", revision: 1, enabled: true, harness: "claude-code", createdAt: date, updatedAt: date },
    { id: "sample-agy", name: "Antigravity · 示例", kind: "login", revision: 1, enabled: true, harness: "antigravity", nativeLogin: true, createdAt: date, updatedAt: date }
  );
}
export async function requestCore<T>(method: string, input?: unknown): Promise<T> {
  if (method === "connection.list") return structuredClone(sampleConnections) as T;
  if (method === "connection.quota") {
    if (visualParams.has("slowQuota")) await new Promise(resolve => setTimeout(resolve, 700));
    if (visualParams.has("failQuota")) throw new Error("Fixture quota request failed");
    const now = Date.now();
    const reset = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    const windows = [
      { id: "primary", usedPercent: 35, windowMinutes: 300, resetsAt: reset(224) },
      { id: "secondary", usedPercent: 41, windowMinutes: 10080, resetsAt: reset(9660) }
    ];
    if ((input as { connectionId?: string })?.connectionId === "sample-agy") {
      return { windows: [
        ...windows.map(window => ({ ...window, label: "Gemini" })),
        { id: "claude-gpt-week", label: "Claude & GPT", usedPercent: 0, windowMinutes: 10080, resetsAt: reset(6552) }
      ] } as T;
    }
    return { windows } as T;
  }
  if (method === "connection.get" || method === "connection.models") {
    const params = input as { connectionId?: string; revision?: number } | undefined;
    const connection = sampleConnections.find((item) => item.id === params?.connectionId && (params?.revision === undefined || item.revision === params.revision));
    if (!connection) throw new Error("界面示例：此连接版本不存在");
    if (method === "connection.get") return structuredClone(connection) as T;
    return { providerId: "sample-only", source: "provider_api", fetchedAt: "2026-11-03T02:00:00Z", warning: "界面示例模型，未请求任何服务商。价格为示例数值。", models: (connection.models ?? []).filter((item) => item.enabled !== false).map((item) => ({ ...item, displayName: item.displayName ?? item.id, isDefault: false, capabilities: [], serviceTiers: [] })) } satisfies ProviderModelCatalog as T;
  }
  if (method === "connection.upsert" || method === "connection.remove") throw new Error("界面测试为只读，不保存、删除连接或凭据。");
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
