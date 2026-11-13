import type { AgentInstance, RuntimeConnection, Session } from "@agenthub/domain";
import { Database } from "../database/index.js";
import { CoreError } from "../errors.js";
import { loginProfileDirectory, isolateLoginProfile, type CredentialService } from "./security/index.js";
import type { ProviderDescriptor } from "@agenthub/provider-sdk";

export function connectionCredentialId(id: string, revision: number): string { return `connection:${id}:${revision}`; }
export function readConnection(database: Database, id: string, revision?: number): RuntimeConnection {
  const head = database.runtimeConnections.get(id);
  const value = revision === undefined ? head : database.runtimeConnections.version(id, revision);
  if (!head || !value) throw new CoreError("IPC_NOT_FOUND", { resource: "connection" });
  const gateway=database.integrationSettings.get("integration-settings")?.gateway;
  return { ...value, enabled: head.enabled, hasCredential: database.credentials.has(connectionCredentialId(id, value.revision)),accountGateway:value.kind==="login"&&gateway?.enabled===true&&gateway.connectionIds.includes(id) };
}
export function assertConnectionCompatible(connection: RuntimeConnection, agent: AgentInstance): void {
  if (!connection.enabled) throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionId", reason: "The selected connection is disabled" });
  if (agent.baseArgs.length || agent.profile) throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionId", reason: "Independent connections require standard CLI arguments and no CLI profile" });
  if (agent.providerId === "antigravity" && (connection.kind !== "login" || connection.harness !== "antigravity" || !connection.nativeLogin)) throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionId", reason: "Select an official Antigravity Google login account" });
  const supported = connection.kind === "login"
    ? connection.accountGateway===true || connection.harness === agent.providerId && ["codex", "claude-code", "antigravity"].includes(agent.providerId)
    : ["responses", "chat", "anthropic"].includes(connection.protocol ?? "");
  if (!supported) throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionId", reason: "This harness does not support the selected connection protocol or login identity" });
}
/** Never mutate a saved CLI instance. Endpoint and auth come from one immutable revision. */
export function applyConnection(connection: RuntimeConnection, agent: AgentInstance): AgentInstance {
  assertConnectionCompatible(connection, agent);
  const options = { ...agent.providerOptions };
  for (const key of ["baseUrl", "apiType", "wireApi", "loginProfileDirectory", "loginProfileLabel", "nativeLogin"]) delete options[key];
  if (connection.kind === "login") {
    if(connection.harness!==agent.providerId){options.accountGateway=true;options.apiType="openai-completions";if(agent.providerId==="codex")options.wireApi="chat";}
    else if (connection.harness === "antigravity" && connection.nativeLogin) options.nativeLogin = true;
    else{options.loginProfileDirectory = connection.loginProfileDirectory!;options.loginProfileLabel = connection.name;}
  } else {
    options.baseUrl = connection.baseUrl!;
    options.apiType = connection.protocol === "anthropic" ? "anthropic-messages" : connection.protocol === "responses" ? "openai-responses" : "openai-completions";
    if (agent.providerId === "codex") options.wireApi = connection.protocol!;
  }
  // Opaque revision changes participate in transport fingerprints, never contain a secret.
  options.runtimeConnectionId = connection.id;
  options.runtimeConnectionRevision = connection.revision;
  options.runtimeConnectionName = connection.name;
  const effective = { ...agent, providerOptions: options, models: connection.models ?? (connection.kind === "login" ? agent.models : []) };
  if (connection.kind === "login") loginProfileDirectory(effective);
  return effective;
}
export function boundConnection(database: Database, session: Session): RuntimeConnection | undefined {
  if (!session.connectionId) {
    if (session.connectionRevision !== undefined) throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionRevision" });
    return undefined;
  }
  if (!Number.isSafeInteger(session.connectionRevision) || session.connectionRevision! < 1) throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionRevision", reason: "Conversation has no fixed connection revision" });
  return readConnection(database, session.connectionId, session.connectionRevision);
}
export function bindNewSession(database: Database, session: Session, agent: AgentInstance): Session {
  if (!session.connectionId) { boundConnection(database, session); return session; }
  const connection = readConnection(database, session.connectionId, session.connectionRevision);
  assertConnectionCompatible(connection, agent);
  return { ...session, connectionRevision: connection.revision,
    model: session.model ?? connection.models?.find((model) => model.enabled !== false)?.id };
}
export function connectionEnvironment(connection: RuntimeConnection, agent: AgentInstance, environment: Record<string, string>, credentials?: CredentialService, descriptor?: ProviderDescriptor): Record<string, string> {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    if (["CODEX_HOME", "CLAUDE_CONFIG_DIR", "KIMI_CODE_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "TRAE_CONFIG_FILE"].includes(name.toUpperCase())) continue;
    if (/^(OPENAI_|CODEX_|ANTHROPIC_|KIMI_|DEEPSEEK_|GEMINI_|GOOGLE_|OPENROUTER_|OPENCODE_|AGENTHUB_PI_|AGENTHUB_OMP_|OMP_AUTH_|COMMAND_CODE_|CMD_|TRAECLI_|TRAE_CLI_|CLAUDE_CODE_(OAUTH|API|USE_|SESSION_ACCESS)|CLAUDE_CONFIG_DIR$|AGENTHUB_API_KEY$)/i.test(name)) delete result[name];
  }
  if (connection.kind === "login") return connection.harness!==agent.providerId?result:isolateLoginProfile(agent, result);
  const id = connectionCredentialId(connection.id, connection.revision);
  if (!credentials?.has(id)) throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionId", reason: "The selected API connection needs its own API key; local login is never used as a fallback" });
  const credential = Object.values(credentials.environment(id, agent.providerId))[0];
  if (!credential) throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionId", reason: "The selected connection has no usable API key" });
  result.NAUTILO_CONNECTION_API_KEY = credential;
  result.AGENTHUB_API_KEY = credential;
  result.NAUTILO_CONNECTION_DIRECTORY = credentials.connectionDirectory(connection.id, connection.revision);
  Object.assign(result, credentials.environment(id, agent.providerId));
  if (descriptor?.baseUrlEnv) result[descriptor.baseUrlEnv] = connection.baseUrl!;
  if (connection.protocol === "anthropic") {
    result.ANTHROPIC_API_KEY = credential;
    result.ANTHROPIC_BASE_URL = connection.baseUrl!;
  } else {
    result.OPENAI_API_KEY = credential;
    result.OPENAI_BASE_URL = connection.baseUrl!;
  }
  return result;
}
