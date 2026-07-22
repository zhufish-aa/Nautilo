import type {
  AgentRunId,
  ArtifactId,
  ProjectId,
  ProjectRunId,
  SessionId,
  TaskId
} from "@agenthub/domain";

export type RuntimeEventType =
  | "run.started"
  | "agent.status"
  | "agent.message_delta"
  | "agent.message"
  | "agent.thinking_delta"
  | "agent.thinking_summary"
  | "planner.decision"
  | "recovery.decision"
  | "task.updated"
  | "handoff.created"
  | "tool.started"
  | "tool.finished"
  | "command.started"
  | "command.finished"
  | "file.changed"
  | "approval.requested"
  | "approval.resolved"
  | "verification.started"
  | "verification.finished"
  | "git.diff_collected"
  | "git.merge_started"
  | "git.merge_finished"
  | "git.conflict"
  | "usage.updated"
  | "provider.commands_updated"
  | "artifact.created"
  | "run.waiting"
  | "run.completed"
  | "run.failed";

export interface RuntimeEventPayloadMap {
  "run.started": {
    runId: AgentRunId;
    providerSessionId?: string;
  };
  "agent.status": {
    phase: "turn_started" | "turn_completed" | "turn_failed";
  };
  "agent.message_delta": {
    messageId: string;
    text: string;
  };
  "agent.message": {
    messageId: string;
    text: string;
    isFinal?: boolean;
  };
  "agent.thinking_delta": {
    messageId: string;
    text: string;
  };
  "agent.thinking_summary": {
    messageId?: string;
    text: string;
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
    callId?: string;
    toolName: string;
    inputSummary?: string;
  };
  "tool.finished": {
    callId?: string;
    toolName: string;
    success: boolean;
    outputSummary?: string;
  };
  "command.started": {
    callId?: string;
    command: string;
    cwd: string;
    approvalId?: string;
  };
  "command.finished": {
    callId?: string;
    command?: string;
    exitCode: number;
    durationMs: number;
    outputSummary?: string;
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
  };
  "approval.resolved": {
    approvalId: string;
    decision: "approved" | "rejected";
    scope: "once" | "run" | "task" | "project" | "global";
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
    inputTokens?: number;
    outputTokens?: number;
    contextUsed?: number;
    contextWindow?: number;
    estimatedCost?: number;
  };
  "provider.commands_updated": {
    providerId: string;
    commands: Array<{ name: string; description: string; inputHint?: string }>;
  };
  "artifact.created": {
    artifactId: ArtifactId;
    kind: "image" | "file";
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
  "run.failed": {
    code: string;
    message: string;
    retryable: boolean;
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
  payload: RuntimeEventPayloadMap[TType];
}

export type RuntimeEvent = {
  [TType in RuntimeEventType]: EventEnvelope<TType>;
}[RuntimeEventType];
