import type { AgentInstance, InstanceModelConfig, ProviderModelCatalog, RuntimeConnection, RuntimeConnectionInput } from "@agenthub/domain";
import type { IpcRequestMap } from "@agenthub/schemas";
import { Database } from "../database/index.js";
import { CoreError } from "../errors.js";
import { AdapterRegistry, discoverOpenAiCompatibleModels, mergeInstanceModelConfig } from "../adapters/index.js";
import { validateModelEndpoint } from "../adapters/model-config.js";
import { CredentialService, EnvironmentPolicyService, loginProfileDirectory, providerEnvironmentPassthrough } from "../runtime/security/index.js";
import { applyConnection, connectionCredentialId, connectionEnvironment, readConnection } from "../runtime/runtime-connection.js";
import { diagnoseConnection } from "../runtime/service-probe.js";

function invalid(field: string, reason: string): never { throw new CoreError("IPC_INVALID_REQUEST", { field, reason }); }
function models(input: unknown): InstanceModelConfig[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 500) return invalid("models", "Use at most 500 model entries");
  const seen = new Set<string>();
  return input.map((raw) => {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id.trim() || seen.has(raw.id.trim())) return invalid("models", "Model IDs must be nonempty and unique");
    seen.add(raw.id.trim());
    const efforts = raw.reasoningEfforts ?? [];
    if (raw.inputModalities !== undefined && (!Array.isArray(raw.inputModalities) || !raw.inputModalities.length || raw.inputModalities.some((x: unknown) => x !== "text" && x !== "image"))) return invalid("models", "Invalid input modalities");
    if (!Array.isArray(efforts) || efforts.some((x: unknown) => typeof x !== "string")) return invalid("models", "Invalid reasoning values");
    const pricing: Record<string, number> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
      const value = raw.pricing?.[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return invalid("pricing", "Prices must be finite nonnegative values");
      pricing[key] = value;
    }
    return { id: raw.id.trim(), reasoningEfforts: [...efforts],
      ...(raw.inputModalities !== undefined ? { inputModalities: [...new Set<"text" | "image">(raw.inputModalities)] } : {}),
      ...(typeof raw.displayName === "string" ? { displayName: raw.displayName.trim() } : {}),
      ...(typeof raw.defaultReasoningEffort === "string" ? { defaultReasoningEffort: raw.defaultReasoningEffort } : {}),
      ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
      ...(Number.isSafeInteger(raw.contextWindow) && raw.contextWindow > 0 ? { contextWindow: raw.contextWindow } : {}),
      ...(Object.keys(pricing).length ? { pricing } : {}) };
  });
}
function normalize(input: RuntimeConnectionInput): RuntimeConnectionInput {
  if (!input || typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id)) return invalid("connectionId", "Invalid connection ID");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) return invalid("name", "A connection name is required");
  if (!["api", "login"].includes(input.kind) || typeof input.enabled !== "boolean") return invalid("connection", "Invalid connection kind or enabled flag");
  const common = { id: input.id, name: input.name.trim(), kind: input.kind, enabled: input.enabled, models: models(input.models) };
  if (input.kind === "api") {
    if (!["responses", "chat", "anthropic"].includes(input.protocol ?? "") || typeof input.baseUrl !== "string") return invalid("protocol", "Select an API protocol and endpoint");
    const url = new URL(validateModelEndpoint(input.baseUrl.trim()));
    // Anthropic SDKs append /v1/messages themselves. Keep relay prefixes intact.
    if (input.protocol === "anthropic") url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1(?:\/messages)?$/, "") || "/";
    return { ...common, protocol: input.protocol, baseUrl: url.toString().replace(/\/$/, "") };
  }
  const candidate = { providerId: input.harness, baseArgs: [], providerOptions: { loginProfileDirectory: input.loginProfileDirectory } } as unknown as AgentInstance;
  if (input.harness === "antigravity") {
    if (input.nativeLogin !== true) return invalid("nativeLogin", "Antigravity uses its official unified Google account");
    return { ...common, harness: input.harness, nativeLogin: true, loginProfileDirectory: input.loginProfileDirectory };
  }
  if (input.nativeLogin === true) return invalid("nativeLogin", "This harness requires an isolated account directory");
  const directory = loginProfileDirectory(candidate);
  if (!directory) return invalid("loginProfileDirectory", "Choose an isolated account directory");
  return { ...common, harness: input.harness, loginProfileDirectory: directory };
}
/** Immutable revisions keep earlier conversations and runs on their original endpoint/key. */
export class ConnectionService {
  constructor(private readonly database: Database, private readonly credentials: CredentialService, private readonly adapters: AdapterRegistry,
    private readonly environment = new EnvironmentPolicyService()) {}
  list(): RuntimeConnection[] { return this.database.runtimeConnections.list().map((c) => this.get(c.id)); }
  get(id: string, revision?: number): RuntimeConnection { return readConnection(this.database, id, revision); }
  upsert(input: IpcRequestMap["connection.upsert"]["input"]): RuntimeConnection {
    const value = normalize(input.connection);
    if (value.kind === "login" && value.harness === "antigravity" && this.database.runtimeConnections.list().some(item => item.id !== value.id && item.kind === "login" && item.harness === "antigravity")) return invalid("harness", "Antigravity shares one official Google account through the OS keyring; use the existing connection");
    if (input.clearApiKey !== undefined && typeof input.clearApiKey !== "boolean") return invalid("clearApiKey", "Use a boolean value");
    if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) return invalid("expectedRevision", "Use a positive integer revision");
    if (input.apiKey !== undefined && (typeof input.apiKey !== "string" || !input.apiKey.trim())) return invalid("apiKey", "API key cannot be blank");
    if (value.kind === "login" && (input.apiKey !== undefined || input.clearApiKey)) return invalid("apiKey", "Login accounts use the official CLI credential store");
    if (input.apiKey !== undefined && input.clearApiKey) return invalid("apiKey", "Choose set or clear, not both");
    const db = this.database.connection.raw;
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.runtimeConnections.get(value.id);
      if (current ? input.expectedRevision !== current.revision : input.expectedRevision !== undefined) invalid("expectedRevision", "Connection changed; reload before saving");
      if (current && current.kind !== value.kind) invalid("kind", "Create a separate connection to change authentication kind");
      const now = new Date().toISOString();
      const next: RuntimeConnection = { ...value, revision: (current?.revision ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now };
      const key = connectionCredentialId(next.id, next.revision);
      if (next.kind === "api") {
        if (input.apiKey !== undefined) this.credentials.set(key, { apiKey: input.apiKey });
        else if (!input.clearApiKey && current) {
          const previous = this.database.credentials.get(connectionCredentialId(current.id, current.revision));
          if (previous) this.database.credentials.save(key, previous);
        }
      }
      this.database.runtimeConnections.appendVersion(next);
      db.exec("COMMIT");
      return this.get(next.id);
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  remove(id: string): { removed: boolean } {
    const db = this.database.connection.raw;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (this.database.sessions.listAll().some((s) => s.connectionId === id) || this.database.runs.list().some((r) => r.connectionId === id))
        invalid("connectionId", "This connection is used by history; disable it instead of deleting it");
      const versions = db.prepare("SELECT data FROM runtime_connection_versions WHERE json_extract(data,'$.id') = ?").all(id);
      for (const row of versions) { const version = JSON.parse(String(row.data)) as RuntimeConnection; this.database.credentials.remove(connectionCredentialId(id, version.revision)); }
      db.prepare("DELETE FROM runtime_connection_versions WHERE json_extract(data,'$.id') = ?").run(id);
      const removed = this.database.runtimeConnections.remove(id); db.exec("COMMIT"); return { removed };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  async discover(input: IpcRequestMap["connection.models"]["input"]): Promise<ProviderModelCatalog> {
    try { return await this.discoverRaw(input); }
    catch { return { providerId:`connection:${input.connectionId}`,models:[],source:"unavailable",fetchedAt:new Date().toISOString(),warning:"Connection model discovery failed. Check the endpoint, protocol, credentials and CLI compatibility; secrets are not included in this error." }; }
  }
  async diagnose(input: IpcRequestMap["connection.diagnose"]["input"]) {
    return diagnoseConnection(this.get(input.connectionId,input.revision),()=>this.discoverRaw(input,false));
  }
  private async discoverRaw(input: IpcRequestMap["connection.models"]["input"], mergeConfigured = true): Promise<ProviderModelCatalog> {
    const connection = this.get(input.connectionId, input.revision);
    const unavailable = (warning: string): ProviderModelCatalog => ({ providerId: `connection:${connection.id}`, models: [], source: "unavailable", fetchedAt: new Date().toISOString(), warning });
    if (!connection.enabled) return unavailable("The selected connection is disabled");
      if (connection.kind === "api") {
        const env = this.credentials.environment(connectionCredentialId(connection.id, connection.revision), "codex");
        const catalog = await discoverOpenAiCompatibleModels(connection.baseUrl!, env.OPENAI_API_KEY ?? env.CODEX_API_KEY, undefined, connection.protocol === "anthropic" ? "anthropic-messages" : undefined);
        const result = { ...catalog, providerId: `connection:${connection.id}` };
        return mergeConfigured ? mergeInstanceModelConfig(result, connection.models) : result;
      }
      const matching = this.database.agents.list().filter((agent) => agent.providerId === connection.harness && agent.enabled);
      const original = input.agentInstanceId ? this.database.agents.get(input.agentInstanceId)
        : matching.find((agent) => agent.providerOptions?.configurationKind === "harness") ?? matching[0];
      if (input.agentInstanceId && (!original || original.providerId !== connection.harness)) return unavailable("Account and harness must match");
      const executable = original?.executable || this.adapters.get(connection.harness!).descriptor?.defaultExecutable;
      if (!executable) return unavailable("Install the account's harness to discover models");
      const now = new Date().toISOString();
      const probe: AgentInstance = { id: `connection-models:${connection.id}`, providerId: connection.harness!,
        displayName: connection.harness!, executable, baseArgs: [], capabilities: [], enabled: true,
        status: "available", createdAt: now, updatedAt: now };
      const agent = applyConnection(connection, probe);
      const passthrough = providerEnvironmentPassthrough(agent, process.env, this.adapters.get(agent.providerId).descriptor);
      return this.adapters.listModels(agent, { env: connectionEnvironment(connection, agent, this.environment.build(undefined, passthrough), this.credentials) }, true);
  }
}
