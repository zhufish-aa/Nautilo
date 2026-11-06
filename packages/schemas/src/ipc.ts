import type { RuntimeConnection, RuntimeConnectionInput } from "@agenthub/domain";
import type {
  AgentInstance,
  AgentRun,
  ApprovalRecord,
  ApprovalScope,
  Artifact,
  AuditRecord,
  DiagnosticExportResult,
  InteractionRequest,
  Message,
  PermissionPolicy,
  Project,
  ProjectInspection,
  ProjectRun,
  ProviderCapability,
  ProviderModelCatalog,
  RecoverableProjectRun,
  RuntimeMetrics,
  Session,
  SlashCommandDefinition,
  SlashCommandResult,
  TeamDefinition,
  Task,
  VerificationResult
} from "@agenthub/domain";

/** Missing permissionMode preserves the stored override; null explicitly resets inheritance. */
export type SessionUpsertInput = Omit<Session, "permissionMode" | "connectionId" | "connectionRevision"> & { permissionMode?: string | null; connectionId?: string | null; connectionRevision?: number | null; confirmConnectionChange?: boolean };

export interface MessageAttachmentInput {
  path: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  sizeBytes?: number;
}
import type { RuntimeEvent } from "@agenthub/event-protocol";
import type { ProviderDescriptor, ProviderPluginManifest, ProviderRegistryEntry } from "@agenthub/provider-sdk";

/** One provider plugin known to the daemon (loaded, disabled, or failed). */
export interface ProviderPluginInfo {
  id: string;
  enabled: boolean;
  status: "loaded" | "error" | "disabled";
  error?: string;
  dir: string;
  manifest?: ProviderPluginManifest;
}
import type {
  CapabilityImportConflictPolicy,
  CapabilityImportOutcome,
  CapabilityImportPreview,
  CapabilityImportSource,
  CapabilityScanResult,
  DiscoveredMcpSource
} from "./capability-import.js";

/** Independent of event replay: bound to one database and history scope. */
export interface HistoryCursor { epoch: string; scope: string; revision: number }
export interface HistoryItem<T> { value: T; order: { createdAt: string; ordinal: number } }
export interface HistoryProjection<T> { cursor: HistoryCursor; reset: boolean; items: HistoryItem<T>[] }
export interface SessionHistoryInput { sessionId: string; cursor?: HistoryCursor }
export type SessionHistory = HistoryProjection<Message> & { session: Session };
export type ArtifactChangesInput = ({ sessionId: string; projectRunId?: never } | { projectRunId: string; sessionId?: never }) & { cursor?: HistoryCursor };

export interface ProjectEventCursor extends HistoryCursor { sequence: number }
export interface ProjectPollInput {
  projectRunId: string;
  visibleSessionIds?: string[];
  sessions?: Array<{ sessionId: string; eventCursor?: ProjectEventCursor; historyCursor?: HistoryCursor }>;
  artifactCursor?: HistoryCursor;
}
export interface ProjectPollSnapshot {
  projectRun: ProjectRun; sessions: Session[]; tasks: Task[]; runs: AgentRun[]; verifications: VerificationResult[];
  artifacts: HistoryProjection<Artifact>; histories: SessionHistory[];
  feeds: Array<{ sessionId: string; reset: boolean; cursor: ProjectEventCursor; events: RuntimeEvent[] }>;
  followUps: Array<{ sessionId: string; afterSequence: number; interactions?: InteractionRequest[]; items: Array<{ messageId: string; text: string; queuedAt: string }> }>;
}

export type ProjectPollResult = ProjectPollSnapshot | { fallback: true; projectRun: ProjectRun };

export interface IpcRequestMap {
  "terminal.open": { input: { sessionId?: string; projectId?: string; cols?: number; rows?: number }; output: { id: string; cwd: string; pid?: number; kind: "shell" | "harness" } };
  "terminal.native": { input: { sessionId: string; cols?: number; rows?: number }; output: { id: string; cwd: string; pid?: number; kind: "harness" } };
  "terminal.read": { input: { terminalId: string; cursor: number }; output: { data: string; cursor: number; reset: boolean; exited: boolean; exitCode?: number } };
  "terminal.write": { input: { terminalId: string; data: string }; output: { ok: true } };
  "terminal.resize": { input: { terminalId: string; cols: number; rows: number }; output: { ok: true } };
  "terminal.close": { input: { terminalId: string }; output: { ok: true } };
  "terminal.status": { input: { sessionId: string }; output: { nativeActive: boolean; terminalId?: string } };
  "agent.runtimeCapabilities": { input: { sessionId?: string; agentInstanceId?: string }; output: import("@agenthub/provider-sdk").NativeRuntimeCapabilities };
  "connection.list": { input: Record<string, never>; output: RuntimeConnection[] };
  "connection.get": { input: { connectionId: string; revision?: number }; output: RuntimeConnection };
  "connection.upsert": { input: { connection: RuntimeConnectionInput; expectedRevision?: number; apiKey?: string; clearApiKey?: boolean }; output: RuntimeConnection };
  "connection.remove": { input: { connectionId: string }; output: { removed: boolean } };
  "connection.models": { input: { connectionId: string; revision?: number; agentInstanceId?: string }; output: ProviderModelCatalog };

  "health.get": { input: undefined; output: { status: "ok"; version: string } };
  "project.list": { input: undefined; output: Project[] };
  "project.add": { input: { rootPath: string; name?: string }; output: Project };
  "project.upsert": { input: Project; output: Project };
  "project.remove": { input: { projectId: string }; output: { removed: true } };
  "project.scan": { input: { projectId: string }; output: { project: Project; inspection: ProjectInspection } };
  "agent.list": { input: { projectId?: string }; output: AgentInstance[] };
  "agent.upsert": { input: AgentInstance; output: AgentInstance };
  "provider.detect": { input: { providerId: string; executable?: string }; output: { providerId: string; installed: boolean; compatible?: boolean; executable: string; version?: string; error?: string } };
  "provider.catalog": { input: undefined; output: ProviderDescriptor[] };
  "plugin.list": { input: undefined; output: ProviderPluginInfo[] };
  "plugin.registry": { input: { registryUrl?: string }; output: ProviderRegistryEntry[] };
  "plugin.install": { input: { source: { kind: "local"; path: string } | { kind: "registry"; pluginId: string; registryUrl?: string } }; output: ProviderPluginInfo };
  "plugin.uninstall": { input: { pluginId: string }; output: { removed: true } };
  "plugin.setEnabled": { input: { pluginId: string; enabled: boolean }; output: ProviderPluginInfo };
  "capability.list": { input: undefined; output: ProviderCapability[] };
  "capability.upsert": { input: ProviderCapability; output: ProviderCapability };
  "capability.remove": { input: { capabilityId: string }; output: { removed: true } };
  "capability.parseImport": { input: { source: CapabilityImportSource; text: string; fileName?: string }; output: CapabilityImportPreview };
  "capability.discoverMcp": { input: { projectRoot?: string }; output: { sources: DiscoveredMcpSource[] } };
  "capability.scanSkills": { input: { dir: string }; output: CapabilityScanResult };
  "capability.importMany": { input: { items: ProviderCapability[]; onConflict?: CapabilityImportConflictPolicy }; output: { results: CapabilityImportOutcome[] } };
  "provider.models": { input: { providerId: string; agentInstanceId?: string; executable?: string; baseUrl?: string; apiKey?: string; apiType?: string }; output: ProviderModelCatalog };
  "provider.modes": { input: { agentInstanceId: string; cwd?: string }; output: { modes: Array<{ id: string; name?: string; broken?: string; order?: number }>; defaultMode?: string } };
  "team.list": { input: undefined; output: TeamDefinition[] };
  "team.get": { input: { teamId: string }; output: TeamDefinition };
  "team.upsert": { input: TeamDefinition; output: TeamDefinition };
  "team.remove": { input: { teamId: string }; output: { removed: true } };
  "projectRun.list": { input: { projectId: string }; output: ProjectRun[] };
  "projectRun.poll": { input: ProjectPollInput; output: ProjectPollResult };
  "projectRun.get": { input: { projectRunId: string }; output: { projectRun: ProjectRun; mainSession: Session } };
  "orchestration.start": { input: { projectId: string; teamId: string; agentInstanceId?: string; goal: string; sessionId?: string; messageId?: string; attachments?: MessageAttachmentInput[] }; output: { projectRun: ProjectRun; mainSession: Session } };
  "orchestration.resolveDelegation": { input: { projectRunId: string; approved: boolean; scope?: ApprovalScope }; output: ProjectRun };
  "orchestration.resolveMerge": { input: { projectRunId: string; approved: boolean; scope?: ApprovalScope }; output: ProjectRun };
  "orchestration.recover": { input: { projectRunId: string; memberId: string; mode: "resume" | "replace" }; output: ProjectRun };
  "orchestration.cancel": { input: { projectRunId: string }; output: ProjectRun };
  "session.list": { input: { projectId: string; memberId?: string }; output: Session[] };
  "session.history": { input: SessionHistoryInput; output: SessionHistory };
  "session.historyBatch": { input: { items: SessionHistoryInput[] }; output: { items: SessionHistory[] } };
  "session.get": { input: { sessionId: string }; output: { session: Session; messages: Message[] } };
  "session.generateTitle": { input: { sessionId: string }; output: { title?: string } };
  "session.create": { input: { projectId: string; memberId: string; title?: string; connectionId?: string; connectionRevision?: number }; output: Session };
  "session.upsert": { input: SessionUpsertInput; output: Session };
  "session.delete": { input: { sessionId: string }; output: { removed: true; sessionIds: string[] } };
  "session.followUp": { input: { sessionId: string; text: string; messageId?: string; mode: "steer" | "queue" }; output: { accepted: true; mode: "steer" | "queue" } };
  "session.followUp.list": { input: { sessionId: string }; output: { items: Array<{ messageId: string; text: string; queuedAt: string }> } };
  "session.followUp.cancel": { input: { sessionId: string; messageId: string }; output: { cancelled: true } };
  "session.followUp.steer": { input: { sessionId: string; messageId: string }; output: { accepted: true; mode: "steer" | "queue" } };
  "session.send": { input: { sessionId: string; text: string; messageId?: string; attachments?: MessageAttachmentInput[]; editMessageId?: string }; output: { accepted: true; runId: string } };
  "slashCommand.list": { input: { sessionId: string }; output: SlashCommandDefinition[] };
  "slashCommand.execute": { input: { sessionId: string; commandId: string; argument?: string }; output: SlashCommandResult };
  "slashCommand.continue": { input: { sessionId: string; commandId: string; actionId: string; selectedOptionIds?: string[] }; output: SlashCommandResult };
  "run.cancel": { input: { runId: string }; output: { cancelled: true } };
  "run.list": { input: { sessionId?: string; projectRunId?: string }; output: AgentRun[] };
  "task.list": { input: { projectRunId: string }; output: Task[] };
  "artifact.changes": { input: ArtifactChangesInput; output: HistoryProjection<Artifact> };
  "artifact.list": { input: { projectRunId?: string; taskId?: string; sessionId?: string }; output: Artifact[] };
  "artifact.read": { input: { projectId: string; path: string }; output: { base64: string; mimeType: string; size: number; modifiedAt: string } };
  "verification.list": { input: { projectRunId: string; taskId?: string }; output: VerificationResult[] };
  "run.get": { input: { runId: string }; output: AgentRun };
  "policy.list": { input: undefined; output: PermissionPolicy[] };
  "policy.upsert": { input: PermissionPolicy; output: PermissionPolicy };
  "policy.evaluate": { input: { policyId?: string; command: string; args?: string[]; source: "agent" | "verification" | "system" }; output: { action: "safe" | "approval" | "blocked"; ruleId?: string; reason: string } };
  "approval.list": { input: { status?: ApprovalRecord["status"]; projectRunId?: string }; output: ApprovalRecord[] };
  "approval.resolve": { input: { approvalId: string; decision: "approved" | "rejected"; scope: ApprovalScope }; output: ApprovalRecord };
  "interaction.list": { input: { sessionId?: string; status?: InteractionRequest["status"] }; output: InteractionRequest[] };
  "interaction.respond": { input: { interactionId: string; outcome: "selected" | "cancelled"; optionId?: string; answers?: Record<string, string[]> }; output: InteractionRequest };
  "credential.set": { input: { agentInstanceId: string; apiKey: string; envName?: string }; output: { stored: true } };
  "credential.status": { input: { agentInstanceId: string }; output: { stored: boolean } };
  "credential.delete": { input: { agentInstanceId: string }; output: { removed: boolean } };
  "recovery.list": { input: undefined; output: RecoverableProjectRun[] };
  "audit.list": { input: { limit?: number; resourceId?: string }; output: AuditRecord[] };
  "metrics.get": { input: { projectId?: string }; output: RuntimeMetrics };
  "diagnostics.export": { input: { projectId?: string; projectRunId?: string }; output: DiagnosticExportResult };
  "event.subscribe": { input: { projectRunId?: string; sessionId?: string; afterSequence?: number }; output: { subscriptionId: string } };
  "event.replay": { input: { subscriptionId: string; afterSequence: number }; output: { events: RuntimeEvent[]; lastSequence: number } };
  "event.wait": { input: { subscriptionId: string; afterSequence: number; timeoutMs?: number }; output: { events: RuntimeEvent[]; lastSequence: number } };
}

export type IpcMethod = keyof IpcRequestMap;

export interface IpcEnvelope<TMethod extends IpcMethod = IpcMethod> {
  requestId: string;
  method: TMethod;
  input: IpcRequestMap[TMethod]["input"];
}

export interface IpcSuccess<T> {
  requestId: string;
  ok: true;
  data: T;
}

export interface IpcFailure {
  requestId: string;
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    retryStrategy: string;
    userAction: string;
  };
}

export type IpcResponse<TMethod extends IpcMethod> =
  | IpcSuccess<IpcRequestMap[TMethod]["output"]>
  | IpcFailure;

export type IpcHandler<TMethod extends IpcMethod> = (
  input: IpcRequestMap[TMethod]["input"]
) => Promise<IpcRequestMap[TMethod]["output"]>;
