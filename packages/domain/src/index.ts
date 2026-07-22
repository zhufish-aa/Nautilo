export type AgentId = string;
export type AgentInstanceId = string;
export type AgentRunId = string;
export type ArtifactId = string;
export type MessageId = string;
export type ProjectId = string;
export type ProjectRunId = string;
export type RoleId = string;
export type SessionId = string;
export type TaskId = string;
export type TeamId = string;

export * from "./slash-commands.js";

export type PlannerMode = "direct" | "delegate" | "plan";
export type RepositoryType = "git" | "none";
export type RunMode =
  | "headless_structured"
  | "headless_text"
  | "long_running_stdin"
  | "pty_interactive"
  | "provider_server";

export type AgentStatus =
  | "offline"
  | "available"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "error"
  | "disabled";

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "archived";

export type ProjectRunStatus =
  | "planning"
  | "plan_review"
  | "executing"
  | "waiting_user"
  | "paused"
  | "verifying"
  | "review_required"
  | "merge_ready"
  | "merging"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskStatus =
  | "draft"
  | "ready"
  | "blocked_dependency"
  | "queued"
  | "running"
  | "waiting_user"
  | "waiting_approval"
  | "verifying"
  | "review_required"
  | "merge_ready"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentRunStatus =
  | "created"
  | "starting"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "cancelling"
  | "completed"
  | "failed"
  | "timed_out"
  | "crashed"
  | "cancelled";

export type DelegationPolicy =
  | "autonomous"
  | "ask_before_delegate"
  | "direct_only";

export type CommandPolicyAction = "safe" | "approval" | "blocked";
export type ApprovalScope = "once" | "run" | "task" | "project" | "global";

export interface CommandPolicyRule {
  id: string;
  action: CommandPolicyAction;
  executable?: string;
  argsPrefix?: string[];
  sources?: Array<"agent" | "verification" | "system">;
  description?: string;
}

export interface PermissionPolicy {
  id: string;
  name: string;
  defaultCommandAction: CommandPolicyAction;
  commandRules: CommandPolicyRule[];
  environmentAllowlist: string[];
  allowedPaths: string[];
  updatedAt: string;
}

export interface ApprovalRecord {
  id: string;
  category: "command" | "file" | "network" | "merge" | "delegate";
  status: "pending" | "approved" | "rejected";
  scope?: ApprovalScope;
  operation: string;
  summary: string;
  projectId?: ProjectId;
  projectRunId?: ProjectRunId;
  taskId?: TaskId;
  sessionId?: SessionId;
  requestedBy: string;
  resolvedBy?: string;
  createdAt: string;
  resolvedAt?: string;
  consumedAt?: string;
}

export interface AuditRecord {
  id: string;
  actorType: "user" | "agent" | "system";
  actorId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  outcome: "success" | "failure" | "denied";
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface RuntimeMetrics {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  retriedTasks: number;
  conflicts: number;
  verificationTotal: number;
  verificationPassed: number;
  averageRunDurationMs: number;
}

export interface RecoverableProjectRun {
  projectRun: ProjectRun;
  currentMainMemberId: string;
  enabledMemberIds: string[];
  canResumeProviderSession: boolean;
}

export interface DiagnosticExportResult {
  path: string;
  createdAt: string;
  auditCount: number;
  eventCount: number;
}

export interface AgentInstance {
  id: AgentInstanceId;
  providerId: string;
  displayName: string;
  executable: string;
  baseArgs: string[];
  profile?: string;
  providerOptions?: Record<string, string | number | boolean | string[]>;
  capabilities: string[];
  enabled: boolean;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModel {
  /** Exact value passed to the provider CLI's model option. */
  id: string;
  displayName: string;
  description?: string;
  isDefault: boolean;
  contextWindow?: number;
  capabilities: string[];
  reasoningEfforts: string[];
  defaultReasoningEffort?: string;
  serviceTiers: ProviderServiceTier[];
  defaultServiceTier?: string;
}

export interface ProviderServiceTier {
  id: string;
  name: string;
  description?: string;
}

export interface ProviderModelCatalog {
  providerId: string;
  models: ProviderModel[];
  defaultModel?: string;
  source: "provider_cli" | "unavailable";
  fetchedAt: string;
  warning?: string;
}

export interface Role {
  id: RoleId;
  name: string;
  description: string;
  responsibilities: string[];
  strengths: Record<string, number>;
  limitations: string[];
  systemInstructions: string;
  permissionPolicyId: string;
}

export interface TeamMember {
  id: string;
  displayName: string;
  agentInstanceId: AgentInstanceId;
  /** Default model captured into each newly delegated child session. */
  model?: string;
  /** Default provider-native reasoning effort for newly delegated child sessions. */
  reasoningEffort?: string;
  /** Optional provider-native speed/service tier for newly delegated child sessions. */
  serviceTier?: string;
  roleId: RoleId;
  strengths: Record<string, number>;
  allowedTaskTypes: string[];
  maxConcurrentTasks: number;
  enabled: boolean;
}

export interface TeamDefinition {
  id: TeamId;
  name: string;
  /** @deprecated Main Agents are selected by sessions; teams only contain delegate candidates. */
  mainMemberId?: string;
  delegationPolicy: DelegationPolicy;
  /** User-authored role definitions referenced by TeamMember.roleId. */
  roles?: Role[];
  members: TeamMember[];
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: ProjectId;
  name: string;
  rootPath: string;
  repositoryType: RepositoryType;
  defaultBranch?: string;
  frontendPaths: string[];
  backendPaths: string[];
  ignoredPaths: string[];
  policyId: string;
  verificationTemplates?: VerificationCommandTemplate[];
}

export interface VerificationCommandTemplate {
  id: string;
  name: string;
  command: string;
  args: string[];
  relativeCwd?: string;
  timeoutMs: number;
  required: boolean;
  scopes: Array<"task" | "run" | "merge">;
}

export interface ProjectInspection {
  projectId: ProjectId;
  scannedAt: string;
  git: {
    isRepo: boolean;
    branch?: string;
    defaultBranch?: string;
    remote?: string;
    dirtyFiles: number;
    ahead?: number;
    behind?: number;
  };
  stacks: Array<{
    name: string;
    kind: "language" | "framework" | "tooling" | "runtime";
    detail?: string;
    confidence: number;
  }>;
  frontendPaths: string[];
  backendPaths: string[];
  risks: Array<{
    id: string;
    level: "info" | "warning" | "critical";
    textKey: string;
    detail?: string;
  }>;
}

export interface ProjectRun {
  id: ProjectRunId;
  projectId: ProjectId;
  teamId?: TeamId;
  goal: string;
  mainMemberId: string;
  /** The CLI instance selected by the user when creating the main session. */
  mainAgentInstanceId?: AgentInstanceId;
  mainSessionId?: SessionId;
  status: ProjectRunStatus;
  plannerDecision?: PlannerDecision;
  pendingApprovalId?: string;
  mergeApprovalId?: string;
  baseBranch?: string;
  baseCommit?: string;
  branchName?: string;
  workspacePath?: string;
  resultCommit?: string;
  conflicts?: GitConflict[];
  acceptedTaskFailures?: TaskId[];
  recoveryReason?: string;
  previousMainMemberIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: SessionId;
  projectId: ProjectId;
  memberId: string;
  teamId?: TeamId;
  projectRunId?: ProjectRunId;
  parentSessionId?: SessionId;
  taskId?: TaskId;
  agentInstanceId?: AgentInstanceId;
  /** Session-level overrides captured when the user creates the conversation. */
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  title: string;
  status: SessionStatus;
  providerSessionId?: string;
  /** Set after persisted AgentHub history is synchronized into the provider thread. */
  providerContextSyncedAt?: string;
  unreadCount: number;
  lastMessageAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  commandTemplateId?: string;
  required: boolean;
}

export interface ContextNeed {
  kind: "file" | "artifact" | "decision" | "verification";
  reference: string;
  reason: string;
}

export interface PlannedTask {
  id: TaskId;
  title: string;
  objective: string;
  taskType: string;
  assignedMemberId: string;
  /** Existing child session selected by the main Agent; omitted to start fresh. */
  targetSessionId?: SessionId;
  dependencies: TaskId[];
  allowedPaths: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  contextNeeds: ContextNeed[];
  assignmentReason: string;
}

export interface Task {
  id: TaskId;
  projectRunId: ProjectRunId;
  parentTaskId?: TaskId;
  title: string;
  objective: string;
  taskType: string;
  assignedMemberId?: string;
  targetSessionId?: SessionId;
  completedByMemberId?: string;
  baseCommit?: string;
  branchName?: string;
  workspacePath?: string;
  resultCommit?: string;
  diffArtifactId?: ArtifactId;
  verificationResultIds?: string[];
  pathViolations?: string[];
  conflicts?: GitConflict[];
  dependencies: TaskId[];
  allowedPaths: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  status: TaskStatus;
  attempt: number;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: AgentRunId;
  projectRunId?: ProjectRunId;
  taskId?: TaskId;
  sessionId: SessionId;
  agentInstanceId: AgentInstanceId;
  memberId?: string;
  mode: RunMode;
  status: AgentRunStatus;
  processId?: number;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  failureCode?: string;
}

export interface Message {
  id: MessageId;
  sessionId: SessionId;
  sender: "user" | "agent" | "system";
  kind?: "chat" | "planner_decision" | "delegation" | "result" | "recovery";
  projectRunId?: ProjectRunId;
  taskId?: TaskId;
  runId?: AgentRunId;
  fromMemberId?: string;
  toMemberId?: string;
  correlationId?: string;
  text: string;
  createdAt: string;
}

export interface Artifact {
  id: ArtifactId;
  kind: "diff" | "commit" | "api_contract" | "test_report" | "summary" | "image" | "file";
  name: string;
  contentHash: string;
  path?: string;
  projectRunId?: ProjectRunId;
  taskId?: TaskId;
  sessionId?: SessionId;
  content?: string;
  metadata?: Record<string, string | number | boolean | string[]>;
}

export interface GitChangedFile {
  path: string;
  changeType: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  diff: string;
}

export interface GitConflict {
  path: string;
  operation: "task_merge" | "final_merge";
  sourceBranch: string;
  targetBranch: string;
}

export interface VerificationResult {
  id: string;
  projectRunId: ProjectRunId;
  taskId?: TaskId;
  commandTemplateId: string;
  command: string;
  args: string[];
  cwd: string;
  passed: boolean;
  required: boolean;
  exitCode: number;
  durationMs: number;
  outputArtifactId?: ArtifactId;
  createdAt: string;
}

export type PlannerDecision =
  | {
      mode: "direct";
      rationale: string;
    }
  | {
      mode: "delegate";
      rationale: string;
      task: PlannedTask;
    }
  | {
      mode: "plan";
      rationale: string;
      tasks: PlannedTask[];
    };

export type RecoveryDecision =
  | {
      action: "retry";
      taskId: TaskId;
      rationale: string;
      assignedMemberId?: string;
    }
  | {
      action: "take_over";
      taskId: TaskId;
      rationale: string;
    }
  | {
      action: "continue";
      taskId: TaskId;
      rationale: string;
    };

export * from "./state.js";
export * from "./errors.js";
