import type { AgentInstance, RuntimeConnection, Session } from "@agenthub/domain";
import { Database } from "../database/index.js";
import { CoreError } from "../errors.js";
import { loginProfileDirectory, isolateLoginProfile, type CredentialService } from "./security/index.js";

export function connectionCredentialId(id: string, revision: number): string { return `connection:${id}:${revision}`; }
export function readConnection(database: Database, id: string, revision?: number): RuntimeConnection {
  const head = database.runtimeConnections.get(id);
  const value = revision === undefined ? head : database.runtimeConnections.version(id, revision);
  if (!head || !value) throw new CoreError("IPC_NOT_FOUND", { resource: "connection" });
  return { ...value, enabled: head.enabled, hasCredential: database.credentials.has(connectionCredentialId(id, value.revision)) };
}
export function assertConnectionCompatible(connection: RuntimeConnection, agent: AgentInstance): void {
  if (!connection.enabled) throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionId", reason: "The selected connection is disabled" });
  if (agent.baseArgs.length || agent.profile) throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionId", reason: "Independent connections require standard CLI arguments and no CLI profile" });
  const supported = connection.kind === "login"
    ? connection.harness === agent.providerId && ["codex", "claude-code"].includes(agent.providerId)
    : agent.providerId === "codex" || (agent.providerId === "claude-code" && connection.protocol === "anthropic");
  if (!supported) throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionId", reason: "This harness does not support the selected connection protocol or login identity" });
}
/** Never mutate a saved CLI instance. Endpoint and auth come from one immutable revision. */
export function applyConnection(connection: RuntimeConnection, agent: AgentInstance): AgentInstance {
  assertConnectionCompatible(connection, agent);
  const options = { ...agent.providerOptions };
  for (const key of ["baseUrl", "apiType", "wireApi", "loginProfileDirectory", "loginProfileLabel"]) delete options[key];
  if (connection.kind === "login") {
    options.loginProfileDirectory = connection.loginProfileDirectory!;
    options.loginProfileLabel = connection.name;
  } else {
    options.baseUrl = connection.baseUrl!;
    options.apiType = connection.protocol === "anthropic" ? "anthropic-messages" : connection.protocol === "responses" ? "openai-responses" : "openai-completions";
    if (agent.providerId === "codex") options.wireApi = connection.protocol!;
  }
  // Opaque revision changes participate in transport fingerprints, never contain a secret.
  options.runtimeConnectionId = connection.id;
  options.runtimeConnectionRevision = connection.revision;
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
export function connectionEnvironment(connection: RuntimeConnection, agent: AgentInstance, environment: Record<string, string>, credentials?: CredentialService): Record<string, string> {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    if (/^(OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_CODE_(OAUTH|API|USE_|SESSION_ACCESS)|CLAUDE_CONFIG_DIR$|AGENTHUB_API_KEY$)/i.test(name)) delete result[name];
  }
  if (connection.kind === "login") return isolateLoginProfile(agent, result);
  const id = connectionCredentialId(connection.id, connection.revision);
  if (!credentials?.has(id)) throw new CoreError("IPC_INVALID_REQUEST", { field: "connectionId", reason: "The selected API connection needs its own API key; local login is never used as a fallback" });
  Object.assign(result, credentials.environment(id, agent.providerId));
  if (agent.providerId === "claude-code") result.ANTHROPIC_BASE_URL = connection.baseUrl!;
  return result;
}
