/** Persisted, provider-independent workflow language and execution projection. */
export type WorkflowType = "text" | "number" | "boolean" | "json" | `list<${string}>` | { enum: string[] } | { properties: Record<string, WorkflowType>; required?: string[] };
export interface WorkflowExit { id: string; name: string }
export interface WorkflowRef { id: string; revision: number }
export interface WorkflowMention extends WorkflowRef { name: string }
export interface WorkflowNode {
  id: string;
  name?: string;
  kind: "main" | "dispatch" | "agent" | "join" | "condition" | "call";
  exits: WorkflowExit[];
  role?: string;
  bypass?: boolean;
  prompt?: string;
  completion?: "tool" | "structured_final";
  outputs?: Record<string, WorkflowType>;
  outputDescriptions?: Record<string, string>;
  exitMode?: "one" | "some";
  dispatch?: "all";
  session?: "fresh" | "reuse";
  dynamicSubflow?: { roles: string[]; maxInstances: number; maxDepth: number };
  fallbacks?: Record<string, unknown>;
  forEach?: { source: string; key: string; maxItems: number; maxParallel: number; emptyExit?: string };
  /** Omit verificationTemplates to inherit all task checks; [] selects only mandatory project checks. */
  workspace?: { mode?: "inherit" | "isolated"; allowedPaths?: string[]; verificationTemplates?: string[] };
  scope?: string;
  /** Explicit predecessors allow multiple overlapping joins within one dispatch batch. */
  sources?: string[];
  wait?: "all" | "firstValid" | "quorum";
  quorum?: number;
  remaining?: "continue" | "cancel";
  cases?: Array<{ path: string; operator?: "eq" | "ne" | "gt" | "ge" | "lt" | "le" | "exists" | "missing"; equals?: unknown; exit: string }>;
  otherwise?: string;
  ref?: WorkflowRef;
  input?: Record<string, unknown>;
  exitMap?: Record<string, string>;
  submissionPolicy?: Partial<WorkflowSubmissionPolicy>;
  onError?: string;
  maxAttempts?: number;
}
export interface WorkflowSubmissionPolicy {
  graceMs: number;
  reminderIntervalMs: number;
  maxReminders: number;
  timeoutMs: number;
}
export interface WorkflowEdge {
  from: [string, string];
  to: string;
  maxTraversals?: number;
  onLimit?: string;
}
export interface WorkflowDefinition {
  schemaVersion: 1;
  id: string;
  name?: string;
  description?: string;
  entry: string;
  inputs?: Record<string, WorkflowType>;
  inputDefaults?: Record<string, unknown>;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  limits?: { maxInstances?: number; timeoutMs?: number; maxParallel?: number; maxDepth?: number };
}
export interface WorkflowLayout {
  nodes: Record<string, { x: number; y: number }>;
  edgeRoutes?: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
}
export interface WorkflowTemplate {
  id: string; revision: number; name: string; definition: WorkflowDefinition; layout: WorkflowLayout;
  createdAt: string; updatedAt: string;
}
/** A binding selects an actual configured member or instance. Omitted settings inherit the selected member. */
export interface WorkflowBinding {
  memberId?: string;
  agentInstanceId?: string;
  connectionId?: string;
  connectionRevision?: number;
  model?: string;
}
export interface WorkflowPlanAssignment {
  agentInstanceId: string;
  connectionId?: string | null;
  connectionRevision?: number | null;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}
export interface WorkflowPlanNode {
  key: string;
  name: string;
  scope?: string;
  role: string;
  task: string;
  memberName?: string;
  assignment: WorkflowPlanAssignment;
}
export interface WorkflowPlan {
  id: string;
  sessionId: string;
  template: WorkflowMention;
  summary: string;
  nodes: WorkflowPlanNode[];
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  runId?: string;
}
export interface WorkflowStart {
  sessionId: string;
  requestId: string;
  ref?: WorkflowRef;
  definition?: WorkflowDefinition;
  inputs: Record<string, unknown>;
  bindings: Record<string, WorkflowBinding>;
  layout?: WorkflowLayout;
}
export type WorkflowNodeStatus = "ready" | "starting" | "running" | "waiting_submission" | "waiting_approval" | "waiting_retry" | "verifying" | "completed" | "failed" | "cancelled" | "waiting_join";
export interface WorkflowAcceptance { status: "pending" | "running" | "waiting_approval" | "passed" | "failed" | "uncertain" | "cancelled"; startedAt?: number | null; endedAt?: number | null; details: unknown }
export interface WorkflowInstance {
  id: string; nodeId: string; status: WorkflowNodeStatus; attempt: number; iteration: number;
  incoming: unknown; item?: unknown; prompt?: string; taskText?: string; sessionId?: string; runId?: string;
  approvalId?: string; childRunId?: string;
  acceptance?: WorkflowAcceptance;
  workspace?: { stage: string; context: Record<string, unknown>; outcome?: unknown; error?: string };
  nativeWork?: { runId: string; lastSequence: number; children: Record<string, "running" | "done" | "failed">; closed: boolean; released: boolean; detached: boolean; error?: string };
  branches?: string[]; result?: unknown; error?: string;
  lastOutput?: string; submissionError?: string;
  reminders: number; completedAt?: number | null; nextReminderAt?: number; deadlineAt?: number;
  createdAt: number; updatedAt: number;
}
export interface WorkflowEvent {
  sequence: number; type: string; timestamp: number; instanceId?: string; nodeId?: string;
  message: string; data?: unknown;
}
export interface WorkflowMessage {
  id: string; sessionId?: string; instanceId?: string; recipient: "child" | "main";
  status: "queued" | "delivering" | "delivered" | "resolved" | "uncertain" | "waiting_approval"; text: string; createdAt: number;
  approvalId?: string;
  runId?: string; error?: string;
}
export interface WorkflowRun {
  parentRunId?: string;
  approvalId?: string;
  id: string; revision: number; sessionId: string; projectId: string; requestId: string;
  definition: WorkflowDefinition; inputs: Record<string, unknown>; bindings: Record<string, WorkflowBinding>;
  assignments?: Record<string, { providerId?: string; model?: string }>;
  layout?: WorkflowLayout;
  status: "running" | "paused" | "finalizing" | "completed" | "needs_decision" | "cancelled" | "failed";
  acceptance?: WorkflowAcceptance;
  workspace?: { ownerRunId: string; stage: string; context: Record<string, unknown>; approvalId?: string; outcome?: unknown; error?: string };
  instances: WorkflowInstance[]; events: WorkflowEvent[]; messages: WorkflowMessage[];
  createdAt: number; updatedAt: number; result?: unknown; error?: string;
}
export interface WorkflowIssue { path: string; message: string; nodeId?: string; exitId?: string; warning?: boolean }
export interface WorkflowValidation { valid: boolean; issues: WorkflowIssue[] }
