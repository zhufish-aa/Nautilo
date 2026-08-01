import { ClaudeCodeAdapter } from "./claude/index.js";
import { CodexAdapter } from "./codex/index.js";
import { CustomCliAdapter } from "./custom.js";
import { KimiCodeAdapter } from "./kimi/index.js";
import { mergeInstanceModelConfig } from "./model-config.js";
import type { AdapterCapabilities, AdapterDiscoveryContext, AdapterResumeRequest, AdapterStartRequest, AgentCliAdapter } from "./types.js";
import type { AgentInstance, ProviderModelCatalog } from "@agenthub/domain";

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentCliAdapter>();
  // OpenCode is deliberately NOT built in: it ships as a provider plugin
  // (packages/provider-plugin-opencode) and is registered by PluginService.
  constructor(adapters: AgentCliAdapter[] = [new CodexAdapter(), new ClaudeCodeAdapter(), new KimiCodeAdapter(), new CustomCliAdapter()]) {
    for (const adapter of adapters) this.register(adapter);
  }
  register(adapter: AgentCliAdapter): void { this.adapters.set(adapter.providerId, adapter); }
  unregister(providerId: string): boolean { return this.adapters.delete(providerId); }
  has(providerId: string): boolean { return this.adapters.has(providerId); }
  find(providerId: string): AgentCliAdapter | undefined { return this.adapters.get(providerId); }
  get(providerId: string): AgentCliAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error(`Provider "${providerId}" 不可用：适配器未注册（插件缺失或未启用）`);
    return adapter;
  }
  detect(instance: Parameters<AgentCliAdapter["detect"]>[0]): ReturnType<AgentCliAdapter["detect"]> { return this.get(instance.providerId).detect(instance); }
  listModels(instance: AgentInstance, context?: AdapterDiscoveryContext): Promise<ProviderModelCatalog> {
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
    return adapter.listModels(instance, context)
      .then((catalog) => mergeInstanceModelConfig(catalog, instance.models));
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
