import type {
  AgentInstance,
  AgentRun,
  ApprovalRecord,
  ApprovalScope,
  Artifact,
  AuditRecord,
  DiagnosticExportResult,
  Message,
  PermissionPolicy,
  Project,
  ProjectInspection,
  ProjectRun,
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

export interface MessageAttachmentInput {
  path: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  sizeBytes?: number;
}
import type { RuntimeEvent } from "@agenthub/event-protocol";

export interface IpcRequestMap {
  "health.get": { input: undefined; output: { status: "ok"; version: string } };
  "project.list": { input: undefined; output: Project[] };
  "project.add": { input: { rootPath: string; name?: string }; output: Project };
  "project.upsert": { input: Project; output: Project };
  "project.remove": { input: { projectId: string }; output: { removed: true } };
  "project.scan": { input: { projectId: string }; output: { project: Project; inspection: ProjectInspection } };
  "agent.list": { input: { projectId?: string }; output: AgentInstance[] };
  "agent.upsert": { input: AgentInstance; output: AgentInstance };
  "provider.detect": { input: { providerId: string; executable?: string }; output: { providerId: string; installed: boolean; compatible?: boolean; executable: string; version?: string; error?: string } };
  "provider.models": { input: { providerId: string; agentInstanceId?: string; executable?: string }; output: ProviderModelCatalog };
  "team.list": { input: undefined; output: TeamDefinition[] };
  "team.get": { input: { teamId: string }; output: TeamDefinition };
  "team.upsert": { input: TeamDefinition; output: TeamDefinition };
  "team.remove": { input: { teamId: string }; output: { removed: true } };
  "projectRun.list": { input: { projectId: string }; output: ProjectRun[] };
  "projectRun.get": { input: { projectRunId: string }; output: { projectRun: ProjectRun; mainSession: Session } };
  "orchestration.start": { input: { projectId: string; teamId: string; agentInstanceId?: string; goal: string; sessionId?: string; attachments?: MessageAttachmentInput[] }; output: { projectRun: ProjectRun; mainSession: Session } };
  "orchestration.resolveDelegation": { input: { projectRunId: string; approved: boolean; scope?: ApprovalScope }; output: ProjectRun };
  "orchestration.resolveMerge": { input: { projectRunId: string; approved: boolean; scope?: ApprovalScope }; output: ProjectRun };
  "orchestration.recover": { input: { projectRunId: string; memberId: string; mode: "resume" | "replace" }; output: ProjectRun };
  "orchestration.cancel": { input: { projectRunId: string }; output: ProjectRun };
  "session.list": { input: { projectId: string; memberId?: string }; output: Session[] };
  "session.get": { input: { sessionId: string }; output: { session: Session; messages: Message[] } };
  "session.create": { input: { projectId: string; memberId: string; title?: string }; output: Session };
  "session.upsert": { input: Session; output: Session };
  "session.send": { input: { sessionId: string; text: string; attachments?: MessageAttachmentInput[]; editMessageId?: string }; output: { accepted: true; runId: string } };
  "slashCommand.list": { input: { sessionId: string }; output: SlashCommandDefinition[] };
  "slashCommand.execute": { input: { sessionId: string; commandId: string; argument?: string }; output: SlashCommandResult };
  "slashCommand.continue": { input: { sessionId: string; commandId: string; actionId: string; selectedOptionIds?: string[] }; output: SlashCommandResult };
  "run.cancel": { input: { runId: string }; output: { cancelled: true } };
  "run.list": { input: { sessionId?: string; projectRunId?: string }; output: AgentRun[] };
  "task.list": { input: { projectRunId: string }; output: Task[] };
  "artifact.list": { input: { projectRunId?: string; taskId?: string; sessionId?: string }; output: Artifact[] };
  "verification.list": { input: { projectRunId: string; taskId?: string }; output: VerificationResult[] };
  "run.get": { input: { runId: string }; output: AgentRun };
  "policy.list": { input: undefined; output: PermissionPolicy[] };
  "policy.upsert": { input: PermissionPolicy; output: PermissionPolicy };
  "policy.evaluate": { input: { policyId?: string; command: string; args?: string[]; source: "agent" | "verification" | "system" }; output: { action: "safe" | "approval" | "blocked"; ruleId?: string; reason: string } };
  "approval.list": { input: { status?: ApprovalRecord["status"]; projectRunId?: string }; output: ApprovalRecord[] };
  "approval.resolve": { input: { approvalId: string; decision: "approved" | "rejected"; scope: ApprovalScope }; output: ApprovalRecord };
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
