import { createHash } from "node:crypto";
import { ModelCatalogCache } from "./model-catalog-cache.js";
import { ClaudeCodeAdapter } from "./claude/index.js";
import { CodexAdapter } from "./codex/index.js";
import { CustomCliAdapter } from "./custom.js";
import { KimiCodeAdapter } from "./kimi/index.js";
import { mergeInstanceModelConfig } from "./model-config.js";
import type { AdapterCapabilities, AdapterDiscoveryContext, AdapterResumeRequest, AdapterStartRequest, AgentCliAdapter } from "./types.js";
import type { AgentInstance, ProviderModelCatalog } from "@agenthub/domain";

export class AdapterRegistry {
  private readonly modelCatalogs = new ModelCatalogCache();
  private readonly adapters = new Map<string, AgentCliAdapter>();
  // OpenCode is deliberately NOT built in: it ships as a provider plugin
  // (packages/provider-plugin-opencode) and is registered by PluginService.
  constructor(adapters: AgentCliAdapter[] = [new CodexAdapter(), new ClaudeCodeAdapter(), new KimiCodeAdapter(), new CustomCliAdapter()]) {
    for (const adapter of adapters) this.register(adapter);
  }
  register(adapter: AgentCliAdapter): void { this.modelCatalogs.clear(); this.adapters.set(adapter.providerId, adapter); }
  unregister(providerId: string): boolean { this.modelCatalogs.clear(); return this.adapters.delete(providerId); }
  has(providerId: string): boolean { return this.adapters.has(providerId); }
  find(providerId: string): AgentCliAdapter | undefined { return this.adapters.get(providerId); }
  get(providerId: string): AgentCliAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error(`Provider "${providerId}" 不可用：适配器未注册（插件缺失或未启用）`);
    return adapter;
  }
  detect(instance: Parameters<AgentCliAdapter["detect"]>[0]): ReturnType<AgentCliAdapter["detect"]> { return this.get(instance.providerId).detect(instance); }
  listModels(instance: AgentInstance, context?: AdapterDiscoveryContext, forceRefresh = false): Promise<ProviderModelCatalog> {
    const adapter = this.get(instance.providerId);
    if (!adapter.listModels) {
      return Promise.resolve(mergeInstanceModelConfig({
        providerId: instance.providerId,
        models: [],
        source: "unavailable",
        fetchedAt: new Date().toISOString(),
        warning: "该 Provider 暂不支持自动获取模型，可继续手动填写。"
      }, instance.models));
    }
    const snapshot = structuredClone(instance);
    const contextSnapshot = context === undefined ? undefined : structuredClone(context);
    const { status: _status, createdAt: _createdAt, updatedAt: _updatedAt, ...configuration } = snapshot;
    const key = createHash("sha256").update(stableJson({
      instance: configuration, context: contextSnapshot, environment: process.env
    })).digest("hex");
    return this.modelCatalogs.get(key, () => adapter.listModels!(snapshot, contextSnapshot)
      .then((catalog) => mergeInstanceModelConfig(catalog, snapshot.models)), forceRefresh);
  }
  /** Context-window hints must not hold a user's turn behind slow CLI discovery. */
  async listModelsForRun(instance: AgentInstance, budgetMs = 250): Promise<ProviderModelCatalog | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.listModels(instance).catch(() => undefined),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), budgetMs); })
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  start(request: AdapterStartRequest): ReturnType<AgentCliAdapter["start"]> { return this.get(request.instance.providerId).start(request); }
  resume(request: AdapterResumeRequest): ReturnType<AgentCliAdapter["start"]> {
    const adapter = this.get(request.instance.providerId);
    if (!adapter.resume) throw new Error(`${adapter.providerId} does not support native resume`);
    return adapter.resume(request);
  }
  list(): AgentCliAdapter[] { return [...this.adapters.values()]; }
  capabilities(instance: AdapterStartRequest["instance"]): AdapterCapabilities {
    const base = this.get(instance.providerId).capabilities;
    if (instance.providerId !== "custom") return base;
    return { ...base, structuredOutput: instance.providerOptions?.outputMode === "jsonl", pty: false };
  }
}

/** Canonical object order makes equivalent env/config maps share one in-flight request. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
