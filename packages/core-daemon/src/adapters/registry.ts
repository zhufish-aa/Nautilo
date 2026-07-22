import { ClaudeCodeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex/index.js";
import { CustomCliAdapter } from "./custom.js";
import { KimiCodeAdapter } from "./kimi/index.js";
import { OpenCodeAdapter } from "./opencode.js";
import type { AdapterCapabilities, AdapterDiscoveryContext, AdapterResumeRequest, AdapterStartRequest, AgentCliAdapter } from "./types.js";
import type { AgentInstance, ProviderModelCatalog } from "@agenthub/domain";

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentCliAdapter>();
  constructor(adapters: AgentCliAdapter[] = [new CodexAdapter(), new ClaudeCodeAdapter(), new KimiCodeAdapter(), new OpenCodeAdapter(), new CustomCliAdapter()]) {
    for (const adapter of adapters) this.register(adapter);
  }
  register(adapter: AgentCliAdapter): void { this.adapters.set(adapter.providerId, adapter); }
  get(providerId: string): AgentCliAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error(`Unsupported provider: ${providerId}`);
    return adapter;
  }
  detect(instance: Parameters<AgentCliAdapter["detect"]>[0]): ReturnType<AgentCliAdapter["detect"]> { return this.get(instance.providerId).detect(instance); }
  listModels(instance: AgentInstance, context?: AdapterDiscoveryContext): Promise<ProviderModelCatalog> {
    const adapter = this.get(instance.providerId);
    if (!adapter.listModels) {
      return Promise.resolve({
        providerId: instance.providerId,
        models: [],
        source: "unavailable",
        fetchedAt: new Date().toISOString(),
        warning: "该 Provider 暂不支持自动获取模型，可继续手动填写。"
      });
    }
    return adapter.listModels(instance, context);
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
