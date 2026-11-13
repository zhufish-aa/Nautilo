import type {
  AgentRunId,
  ArtifactId,
  InteractionRequest,
  ProjectId,
  ProjectRunId,
  SessionId,
  TaskId
} from "@agenthub/domain";

export interface CodeExecution {
  /** Incremental native dispatch update; omitted on historical full snapshots. */
  partial?: boolean;
  description?: string;
  calls: Array<{ callId: string; parentCallId?: string; name: string; input?: unknown; output?: string; meta?: unknown; status: "running" | "done" | "failed" }>;
}

export type RuntimeEventType =
  | "run.started"
  | "run.diff_updated"
  | "agent.status"
  | "provider.extension_ui"
  | "provider.runtime_ready"
  | "provider.runtime_capabilities"
  | "agent.message_delta"
  | "agent.message"
  | "agent.thinking_delta"
  | "agent.thinking_summary"
  | "planner.decision"
  | "recovery.decision"
  | "task.updated"
  | "handoff.created"
  | "tool.started"
  | "tool.updated"
  | "tool.finished"
  | "command.started"
  | "command.updated"
  | "command.finished"
  | "file.changed"
  | "approval.requested"
  | "approval.resolved"
  | "interaction.requested"
  | "interaction.resolved"
  | "verification.started"
  | "verification.finished"
  | "git.diff_collected"
  | "git.merge_started"
  | "git.merge_finished"
  | "git.conflict"
  | "usage.updated"
  | "provider.commands_updated"
  | "provider.runtime_closed"
  | "provider.background_error"
  | "session.checkpoint_reverted"
  | "session.native_history_synced"
  | "session.follow_up_queued"
  | "session.follow_up_cancelled"
  | "session.follow_up_steered"
  | "artifact.created"
  | "run.waiting"
  | "run.completed"
  | "run.cancelled"
  | "run.failed";

export interface ToolFileDiff {
  operation?: "edit" | "write";
  path?: string;
  before: string;
  after: string;
  truncated?: boolean;
}

/** A provider CLI's native sub-agent dispatch (Claude's Task, Kimi's Agent, opencode's task, …). */
export interface SubagentDispatch {
  /** State reported by the Harness, independently of the spawn tool's completion. */
  status?: "running" | "done" | "failed";
  model?: string;
  nativeAgentIds?: string[];
  /** CLI-specific sub-agent type (e.g. Claude's subagent_type), when declared. */
  agentType?: string;
  /** Short task description (the dispatch's description, else a truncated prompt). */
  task?: string;
  /** The dispatch runs in the background; the main agent continues without waiting. */
  background?: boolean;
}

export interface RuntimeEventPayloadMap {
  "session.native_history_synced": { providerSessionId: string; messageIds: string[]; messageCount: number };
  "provider.runtime_closed": { providerId: string; exitCode?: number | null; signal?: string | null };
  "provider.background_error": { providerId: string; message: string };
  "run.diff_updated": {
    diff: string;
    providerThreadId: string;
    providerTurnId: string;
    source: "provider";
  };
  "run.started": {
    runId: AgentRunId;
    providerSessionId?: string;
    /** Exact submitted input consumed by this turn, including queued follow-ups. */
    userMessageId?: string;
  };
  "provider.extension_ui": { method: string; key?: string; text: string; raw?: unknown };
  "provider.runtime_ready": { providerId: string; transport: string; pid?: number; reused: boolean; attachMs: number };
  "provider.runtime_capabilities": { providerId: string; source: "native-handshake"; transport: string; protocolVersion?: string | number; cliVersion?: string; nativeSessionId?: string; commands?: unknown; reported?: unknown };
  "agent.status": {
    phase: "provider_queued" | "provider_starting" | "turn_started" | "turn_completed" | "turn_failed";
  };
  "agent.message_delta": {
    messageId: string;
    text: string;
    subagentDispatchId?: string;
  };
  "agent.message": {
    providerMessageId?: string;
    messageId: string;
    text: string;
    isFinal?: boolean;
    subagentDispatchId?: string;
  };
  "agent.thinking_delta": {
    messageId: string;
    text: string;
    subagentDispatchId?: string;
  };
  "agent.thinking_summary": {
    messageId?: string;
    text: string;
    subagentDispatchId?: string;
  };
  "planner.decision": {
    mode: "direct" | "delegate" | "plan";
    rationale: string;
    taskIds?: TaskId[];
  };
  "recovery.decision": {
    action: "retry" | "take_over" | "continue";
    taskId: TaskId;
    rationale: string;
    assignedMemberId?: string;
  };
  "task.updated": {
    taskId: TaskId;
    status: string;
    assignedMemberId?: string;
  };
  "handoff.created": {
    fromMemberId: string;
    toMemberId: string;
    summary: string;
    artifactIds: ArtifactId[];
    taskId?: TaskId;
    targetSessionId?: SessionId;
  };
  "tool.started": {
    codeExecution?: CodeExecution;
    callId?: string;
    toolName: string;
    inputSummary?: string;
    fileDiff?: ToolFileDiff;
    /** Set when the tool call is the provider CLI's native sub-agent dispatch (e.g. Claude's Task). */
    subagent?: SubagentDispatch;
    /** Set when this call ran inside a native sub-agent; value is the dispatch's callId. */
    subagentDispatchId?: string;
  };
  "tool.finished": {
    codeExecution?: CodeExecution;
    callId?: string;
    toolName: string;
    success: boolean;
    inputSummary?: string;
    outputSummary?: string;
    fileDiff?: ToolFileDiff;
    subagent?: SubagentDispatch;
    subagentDispatchId?: string;
  };
  "tool.updated": {
    codeExecution?: CodeExecution;
    callId?: string;
    toolName: string;
    inputSummary?: string;
    outputSummary?: string;
    fileDiff?: ToolFileDiff;
    subagent?: SubagentDispatch;
    subagentDispatchId?: string;
  };
  "command.started": {
    callId?: string;
    command: string;
    cwd: string;
    approvalId?: string;
    subagentDispatchId?: string;
  };
  "command.finished": {
    callId?: string;
    command?: string;
    exitCode: number;
    durationMs: number;
    outputSummary?: string;
    subagentDispatchId?: string;
  };
  "command.updated": {
    callId?: string;
    command: string;
    outputSummary?: string;
    subagentDispatchId?: string;
  };
  "file.changed": {
    path: string;
    changeType: "added" | "modified" | "deleted" | "renamed";
    additions?: number;
    deletions?: number;
    diff?: string;
  };
  "approval.requested": {
    approvalId: string;
    category: "command" | "file" | "network" | "merge" | "delegate";
    summary: string;
    operation?: string;
  };
  "approval.resolved": {
    approvalId: string;
    decision: "approved" | "rejected";
    scope: "once" | "run" | "task" | "project" | "global";
  };
  "interaction.requested": {
    interaction: InteractionRequest;
  };
  "interaction.resolved": {
    interaction: InteractionRequest;
  };
  "verification.started": {
    verificationId: string;
    commandTemplateId: string;
  };
  "verification.finished": {
    verificationId: string;
    passed: boolean;
    exitCode: number;
    durationMs: number;
    outputArtifactId?: ArtifactId;
  };
  "git.diff_collected": {
    artifactId: ArtifactId;
    taskId?: TaskId;
    fileCount: number;
  };
  "git.merge_started": {
    sourceBranch: string;
    targetBranch: string;
    taskId?: TaskId;
  };
  "git.merge_finished": {
    sourceBranch: string;
    targetBranch: string;
    commit: string;
    taskId?: TaskId;
  };
  "git.conflict": {
    sourceBranch: string;
    targetBranch: string;
    paths: string[];
    taskId?: TaskId;
  };
  "usage.updated": {
    connectionId?: string;
    connectionRevision?: number;
    model?: string;
    pricingSnapshot?: import("@agenthub/domain").ModelPricing;
    agentInstanceId?: string;
    /** Cumulative snapshots: replace the same scope/key, never sum repeated snapshots. */
    usageScope?: "context" | "turn" | "session";
    usageKey?: string;
    inputTokensIncludesCache?: boolean;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningOutputTokens?: number;
    /** Provider-reported accounting cost, not evidence of a billed payment. */
    reportedCost?: number;
    currency?: string;
    inputTokens?: number;
    outputTokens?: number;
    contextUsed?: number;
    contextWindow?: number;
    estimatedCost?: number;
  };
  "provider.commands_updated": {
    providerId: string;
    commands: Array<{ name: string; description: string; inputHint?: string; providerCommand?: string }>;
  };
  "session.checkpoint_reverted": {
    checkpointId: string;
    restored: string[];
    removed: string[];
    skipped: string[];
    warning?: string;
  };
  "artifact.created": {
    artifactId: ArtifactId;
    kind: "image" | "file" | "diff";
    name: string;
    mimeType?: string;
    path?: string;
  };
  "run.waiting": {
    reason: "user_input" | "approval" | "dependency";
  };
  "run.completed": {
    summary: string;
    resultArtifactId?: ArtifactId;
  };
  "run.cancelled": { reason: "user" };
  "run.failed": {
    code: string;
    message: string;
    retryable: boolean;
    connectionId?: string;
  };
  "session.follow_up_queued": {
    messageId: string;
    text: string;
  };
  "session.follow_up_cancelled": {
    messageId: string;
  };
  "session.follow_up_steered": {
    messageId: string;
  };
}

export interface EventEnvelope<TType extends RuntimeEventType = RuntimeEventType> {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  projectId: ProjectId;
  projectRunId?: ProjectRunId;
  taskId?: TaskId;
  runId?: AgentRunId;
  sessionId?: SessionId;
  type: TType;
  timestamp: string;
  background?: boolean;
  payload: RuntimeEventPayloadMap[TType];
}

export type RuntimeEvent = {
  [TType in RuntimeEventType]: EventEnvelope<TType>;
}[RuntimeEventType];

/** Compact, journal-backed lifecycle signal for the owning desktop's browser UI. */
export interface BrowserRunUpdate {
  sessionId: string; runId: string; sequence: number;
  state: "running" | "waiting" | "completed" | "cancelled" | "failed";
}
export function browserRunUpdate(event:Pick<RuntimeEvent,"sessionId"|"runId"|"sequence"|"type">):BrowserRunUpdate|undefined {
  const states:Record<string,BrowserRunUpdate["state"]>={"run.started":"running","run.waiting":"waiting","run.completed":"completed","run.cancelled":"cancelled","run.failed":"failed"};
  const state=states[event.type];
  return state && event.sessionId && event.runId ? {sessionId:event.sessionId,runId:event.runId,sequence:event.sequence,state} : undefined;
}
