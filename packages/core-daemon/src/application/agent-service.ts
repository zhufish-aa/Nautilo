import type { AgentInstance, ProviderModelCatalog } from "@agenthub/domain";
import type { AdapterDetectionResult } from "../adapters/index.js";
import { AdapterRegistry, discoverOpenAiCompatibleModels, mergeInstanceModelConfig } from "../adapters/index.js";
import { Database } from "../database/index.js";
import { CoreError } from "../errors.js";
import { CredentialService, EnvironmentPolicyService, providerEnvironmentPassthrough } from "../runtime/security/index.js";

export class AgentService {
  constructor(
    private readonly database: Database,
    private readonly adapters: AdapterRegistry,
    private readonly credentials?: CredentialService,
    private readonly environment = new EnvironmentPolicyService()
  ) {}

  private defaultExecutable(providerId: string): string | undefined {
    return this.adapters.find(providerId)?.descriptor?.defaultExecutable;
  }

  list(): AgentInstance[] {
    return this.database.agents.list();
  }

  upsert(instance: AgentInstance): AgentInstance {
    if (!instance.executable.trim()) {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "executable" });
    }
    this.database.agents.save(instance, instance.updatedAt);
    return instance;
  }

  async detect(providerId: string, executable?: string): Promise<AdapterDetectionResult & { providerId: string }> {
    const configured = this.list().find((instance) => instance.providerId === providerId && instance.executable.trim());
    const command = executable?.trim() || configured?.executable || this.defaultExecutable(providerId);
    if (!command) {
      return {
        providerId,
        installed: false,
        compatible: false,
        executable: "",
        error: "该 Provider 尚未完成真实 CLI 探测；请先配置可执行文件"
      };
    }
    const now = new Date().toISOString();
    const probe: AgentInstance = configured ?? {
      id: `probe:${providerId}`,
      providerId,
      displayName: providerId,
      executable: command,
      baseArgs: [],
      capabilities: [],
      enabled: true,
      status: "offline",
      createdAt: now,
      updatedAt: now
    };
    return { providerId, ...(await this.adapters.detect({ ...probe, executable: command })) };
  }

  async listModels(providerId: string, executable?: string, agentInstanceId?: string, options: { baseUrl?: string; apiKey?: string } = {}): Promise<ProviderModelCatalog> {
    const configured = agentInstanceId
      ? this.list().find((instance) => instance.id === agentInstanceId && instance.providerId === providerId)
      : this.list().find((instance) => instance.providerId === providerId && instance.executable.trim());
    const command = executable?.trim() || configured?.executable || this.defaultExecutable(providerId);
    if (!command) {
      return {
        providerId,
        models: [],
        source: "unavailable",
        fetchedAt: new Date().toISOString(),
        warning: "请先检测 CLI 或填写可执行文件路径，然后再获取模型。"
      };
    }
    const now = new Date().toISOString();
    const probe: AgentInstance = configured ?? {
      id: `probe:${providerId}`,
      providerId,
      displayName: providerId,
      executable: command,
      baseArgs: [],
      capabilities: [],
      enabled: true,
      status: "offline",
      createdAt: now,
      updatedAt: now
    };
    try {
      const baseUrl = options.baseUrl?.trim();
      const apiKey = options.apiKey?.trim();
      const descriptor = this.adapters.find(providerId)?.descriptor;
      const instance = {
        ...probe,
        executable: command,
        providerOptions: { ...probe.providerOptions, ...(baseUrl ? { baseUrl } : {}) }
      };
      const credentialEnvironment = { ...(this.credentials?.environment(instance.id, instance.providerId) ?? {}) };
      if (apiKey) for (const key of descriptor?.credentialEnv ?? []) credentialEnvironment[key] = apiKey;
      const context = {
        env: this.environment.build(undefined, { ...providerEnvironmentPassthrough(instance, process.env, descriptor), ...credentialEnvironment })
      };
      // Instance-editor quick fetch: with a base URL every provider goes through
      // the generic OpenAI-compatible endpoint first; adapter discovery (which
      // falls back to the local CLI) remains the default and the fallback.
      if (baseUrl) {
        const effectiveApiKey = apiKey || descriptor?.credentialEnv?.map((key) => credentialEnvironment[key]).find((value) => value?.trim());
        try {
          const generic = await discoverOpenAiCompatibleModels(baseUrl, effectiveApiKey);
          return mergeInstanceModelConfig({ ...generic, providerId }, instance.models);
        } catch {
          // Fall through to adapter/CLI discovery below.
        }
      }
      return await this.adapters.listModels(instance, context);
    } catch (error) {
      return {
        providerId,
        models: [],
        source: "unavailable",
        fetchedAt: new Date().toISOString(),
        warning: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
