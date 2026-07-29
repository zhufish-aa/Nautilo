import type { AgentInstance, ProviderModelCatalog } from "@agenthub/domain";
import type { AdapterDetectionResult } from "../adapters/index.js";
import { AdapterRegistry } from "../adapters/index.js";
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

  async listModels(providerId: string, executable?: string, agentInstanceId?: string): Promise<ProviderModelCatalog> {
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
      const instance = { ...probe, executable: command };
      const credentialEnvironment = this.credentials?.environment(instance.id, instance.providerId) ?? {};
      return await this.adapters.listModels(instance, {
        env: this.environment.build(undefined, { ...providerEnvironmentPassthrough(instance, process.env, this.adapters.find(providerId)?.descriptor), ...credentialEnvironment })
      });
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
