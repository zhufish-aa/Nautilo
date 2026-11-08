import type { AgentInstance, ProviderModelCatalog } from "@agenthub/domain";
import type { AdapterDetectionResult, ProviderNativeCommand } from "../adapters/index.js";
import { AdapterRegistry, discoverOpenAiCompatibleModels, mergeInstanceModelConfig } from "../adapters/index.js";
import { Database } from "../database/index.js";
import { CoreError } from "../errors.js";
import { CredentialService, EnvironmentPolicyService, providerEnvironmentPassthrough, isolateLoginProfile, loginProfileDirectory } from "../runtime/security/index.js";

import type { AgentCliAdapter, HarnessPluginOperation } from "@agenthub/provider-sdk";
import { applyConnection, readConnection } from "../runtime/runtime-connection.js";

export class AgentService {
  async harnessPlugins(agentInstanceId: string, operation: HarnessPluginOperation, managerFor: (id: string) => AgentCliAdapter | undefined, connectionId?: string) {
    let instance = this.database.agents.get(agentInstanceId);
    if (!instance) throw new CoreError("IPC_NOT_FOUND", { resource: "agent", id: agentInstanceId });
    const adapter = this.adapters.find(instance.providerId);
    const manager = managerFor(instance.providerId);
    if (!adapter || !manager?.harnessPlugins) throw new Error("This harness has no plugin manager");
    if (connectionId) {
      const connection = readConnection(this.database, connectionId);
      if (!connection.enabled || connection.kind !== "login" || connection.harness !== instance.providerId) throw new Error("Select an enabled login for this harness");
      instance = applyConnection(connection, instance);
    }
    const env = isolateLoginProfile(instance, this.environment.build(undefined, providerEnvironmentPassthrough(instance, process.env, manager.descriptor)));
    return manager.harnessPlugins(instance, { env }, operation);
  }
  async listModes(agentInstanceId: string) {
    const instance = this.database.agents.get(agentInstanceId);
    if (!instance) throw new CoreError("IPC_NOT_FOUND", { resource: "agent", id: agentInstanceId });
    const adapter = this.adapters.find(instance.providerId);
    if (!adapter?.descriptor.modeDiscovery || !adapter.listModes) return { modes: [] };
    return adapter.listModes(instance, { env: this.environment.build(undefined, providerEnvironmentPassthrough(instance, process.env, adapter.descriptor)) });
  }
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

  nativeCommands(providerId: string): ProviderNativeCommand[] {
    return this.adapters.find(providerId)?.descriptor?.nativeCommands ?? [];
  }

  upsert(instance: AgentInstance): AgentInstance {
    if (!instance.executable.trim()) {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "executable" });
    }
    const directory = loginProfileDirectory(instance);
    const current = this.database.agents.get(instance.id);
    if (current && (directory !== loginProfileDirectory(current) || instance.providerId !== current.providerId)
      && (this.database.sessions.listAll().some((session) => session.agentInstanceId === instance.id)
        || this.database.runs.list().some((run) => run.agentInstanceId === instance.id))) {
      throw new CoreError("IPC_INVALID_REQUEST", { field: "loginProfileDirectory", reason: "Create a new instance to switch accounts; existing sessions retain their account" });
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

  async listModels(providerId: string, executable?: string, agentInstanceId?: string, options: { baseUrl?: string; apiKey?: string; apiType?: string } = {}): Promise<ProviderModelCatalog> {
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
      const apiType = options.apiType?.trim();
      const descriptor = this.adapters.find(providerId)?.descriptor;
      const instance = {
        ...probe,
        executable: command,
        providerOptions: {
          ...probe.providerOptions,
          ...(baseUrl ? { baseUrl } : {}),
          ...(apiType ? { apiType } : {})
        }
      };
      const credentialEnvironment = { ...(this.credentials?.environment(instance.id, instance.providerId) ?? {}) };
      if (apiKey) for (const key of descriptor?.credentialEnv ?? []) credentialEnvironment[key] = apiKey;
      const context = {
        env: isolateLoginProfile(instance, this.environment.build(undefined, { ...providerEnvironmentPassthrough(instance, process.env, descriptor), ...credentialEnvironment }))
      };
      // Instance-editor quick fetch must honor the unsaved endpoint currently
      // visible in the form. Once the user supplies a base URL, never silently
      // replace an API failure with the local CLI catalog: that makes a broken
      // endpoint look successful and overwrites the form with unrelated models.
      if (baseUrl) {
        const effectiveApiKey = apiKey || descriptor?.credentialEnv?.map((key) => credentialEnvironment[key]).find((value) => value?.trim());
        try {
          const generic = await discoverOpenAiCompatibleModels(baseUrl, effectiveApiKey, undefined, apiType);
          return mergeInstanceModelConfig({ ...generic, providerId }, instance.models);
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
      return await this.adapters.listModels(instance, context, true);
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
