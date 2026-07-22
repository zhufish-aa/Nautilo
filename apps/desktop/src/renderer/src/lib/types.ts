import type {
  AgentStatus,
  DelegationPolicy,
  RunMode,
  SessionStatus,
  TaskStatus,
  VerificationCommandTemplate
} from "@agenthub/domain";

/** UI-facing DTOs extend domain contracts with presentation-only fields. */

export type ProviderDetectionStatus = "ready" | "missing" | "outdated" | "error";

export interface ProviderMeta {
  id: string;
  name: string;
  vendor: string;
  homepage?: string;
  minVersion?: string;
  capabilities: RunMode[];
}

export interface ProviderInstallation {
  providerId: string;
  status: ProviderDetectionStatus;
  executable?: string;
  version?: string;
  message?: string;
  checkedAt: string;
}

export interface EnvironmentPolicy {
  id: string;
  nameKey: string;
  descriptionKey: string;
}

export interface AgentInstanceConfig {
  id: string;
  providerId: string;
  displayName: string;
  baseArgs: string[];
  executable: string;
  profile?: string;
  envPolicyId: string;
  /** Write-only editor value; it is never hydrated from Core. */
  apiKey?: string;
  credentialStored?: boolean;
  baseUrl?: string;
  enabled: boolean;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
}

export type RiskLevel = "info" | "warning" | "critical";

export interface ProjectRisk {
  id: string;
  level: RiskLevel;
  textKey: string;
  detail?: string;
}

export interface TechStackItem {
  name: string;
  kind: "language" | "framework" | "tooling" | "runtime";
  detail?: string;
  confidence: number;
}

export interface ProjectScanResult {
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
  stacks: TechStackItem[];
  frontendPaths: string[];
  backendPaths: string[];
  risks: ProjectRisk[];
}

export interface ActiveRunSummary {
  id: string;
  goal: string;
  status: "planning" | "executing" | "verifying" | "waiting_user";
  agentName: string;
  startedAt: string;
}

export interface UiProject {
  id: string;
  name: string;
  rootPath: string;
  repositoryType: "git" | "none";
  scan?: ProjectScanResult;
  scanning: boolean;
  activeRun?: ActiveRunSummary;
  verificationTemplates: VerificationCommandTemplate[];
  addedAt: string;
  lastOpenedAt?: string;
}

export type NavKey = "projects" | "agents" | "teams" | "tasks" | "sessions" | "runs" | "settings";

export type ThemePreference = "dark" | "light" | "system";

export const TASK_TYPE_KEYS = [
  "code",
  "refactor",
  "review",
  "test",
  "docs",
  "debug",
  "plan",
  "research"
] as const;

export type TaskTypeKey = (typeof TASK_TYPE_KEYS)[number];

export const STRENGTH_AREA_KEYS = [
  "coding",
  "refactor",
  "review",
  "testing",
  "docs",
  "debug",
  "planning",
  "research"
] as const;

export type StrengthAreaKey = (typeof STRENGTH_AREA_KEYS)[number];

/* --------------------------------------------------------------------------
 * Team layer (3.3). Mirrors domain Role / TeamMember / TeamDefinition.
 * ------------------------------------------------------------------------ */

export interface TeamRole {
  id: string;
  name: string;
  description: string;
  responsibilities: string[];
  strengths: Record<string, number>;
  limitations: string[];
  systemInstructions: string;
}

export interface UiTeamMember {
  id: string;
  displayName: string;
  agentInstanceId: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  role: TeamRole;
  allowedTaskTypes: string[];
  maxConcurrentTasks: number;
  enabled: boolean;
}

export interface UiTeam {
  id: string;
  name: string;
  delegationPolicy: DelegationPolicy;
  members: UiTeamMember[];
  createdAt: string;
  updatedAt: string;
}

export type TeamIssueLevel = "critical" | "warning" | "info";

export interface TeamIssue {
  id: string;
  level: TeamIssueLevel;
  textKey: string;
  values?: Record<string, string | number>;
}

/* --------------------------------------------------------------------------
 * Sessions & timeline (3.4). Events carry a monotonic per-session sequence
 * so the renderer can resync after reconnects (F-036, plan §6.3).
 * ------------------------------------------------------------------------ */

export type SessionTarget =
  | { type: "team"; teamId: string }
  | { type: "member"; teamId: string; memberId: string }
  | { type: "agent"; instanceId: string; teamId?: string };

export interface UiSession {
  id: string;
  projectId: string;
  target: SessionTarget;
  title: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  status: SessionStatus;
  /** Set for sub-agent sessions spawned by a delegation: the owning run's main session. */
  parentSessionId?: string;
  /** Persistent Core Daemon orchestration aggregate. */
  projectRunId?: string;
  /** Groups all sessions of one run (main + sub-agent sessions). */
  runId?: string;
  unreadCount: number;
  lastMessageAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ChangedFile = {
  path: string;
  changeType: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  diff?: string;
};

export type ApprovalScope = "once" | "run" | "task" | "project" | "global";

export interface ApprovalRequest {
  id: string;
  title: string;
  description: string;
  kind: "command" | "merge" | "delegate";
  status: "pending" | "approved" | "rejected";
  decisionScope?: ApprovalScope;
  createdAt: string;
}

export interface SessionTask {
  id: string;
  title: string;
  objective?: string;
  memberId?: string;
  memberName?: string;
  status: TaskStatus;
  dependencies: string[];
}

export interface RunLifecycle {
  status: "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
  reason?: string;
  startedAt?: string;
}

export interface ContextUsage {
  inputTokens?: number;
  outputTokens?: number;
  contextUsed?: number;
  contextWindow?: number;
}

export type TimelinePayload =
    | { kind: "message"; sender: "user" | "agent" | "system"; authorName?: string; text: string; streaming?: boolean; messageId?: string }
  | { kind: "activity"; phase: "queued" | "starting" | "thinking" | "responding" | "completed"; detail?: string }
    | { kind: "reasoning"; text: string; streaming?: boolean }
  | { kind: "tool_activity"; toolName: string; status: "running" | "done" | "failed"; input?: string; output?: string }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; contextUsed?: number; contextWindow?: number }
  | { kind: "artifact"; artifactType: "image" | "file"; name: string; mimeType?: string; content?: string; path?: string }
  | { kind: "planner_decision"; mode: "direct" | "delegate" | "plan"; rationale: string }
  | { kind: "recovery_decision"; action: "retry" | "take_over" | "continue"; taskId: string; rationale: string }
  | { kind: "task_update"; taskId: string; title: string; memberName?: string; status: TaskStatus; sessionId?: string }
  | { kind: "handoff"; taskId?: string; fromName: string; toName: string; summary: string; sessionId?: string }
  | {
      kind: "command";
      command: string;
      status: "running" | "done" | "failed";
      exitCode?: number;
      output: string;
      attempts?: number;
      needsApproval?: boolean;
    }
  | { kind: "file_change"; files: ChangedFile[] }
  | {
      kind: "verification";
      command: string;
      status: "running" | "passed" | "failed";
      durationMs?: number;
      log: string;
    }
  | {
      kind: "git_merge";
      status: "running" | "completed" | "conflict";
      sourceBranch: string;
      targetBranch: string;
      commit?: string;
      paths?: string[];
    }
  | { kind: "approval"; approval: ApprovalRequest }
  | { kind: "approval_resolved"; approvalId: string; decision: "approved" | "rejected"; scope: ApprovalScope }
  | { kind: "error"; code: string; message: string; retryable: boolean }
  | { kind: "run_status"; run: RunLifecycle };

export interface TimelineEvent {
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  data: TimelinePayload;
}

export interface SessionArtifact {
  id: string;
  kind: "diff" | "api_contract" | "test_report" | "commit" | "image" | "file";
  name: string;
  content: string;
}

export const DELEGATION_POLICIES: DelegationPolicy[] = [
  "autonomous",
  "ask_before_delegate",
  "direct_only"
];
