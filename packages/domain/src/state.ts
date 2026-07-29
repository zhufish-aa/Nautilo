import type {
  AgentRunStatus,
  ProjectRunStatus,
  SessionStatus,
  TaskStatus
} from "./index.js";

export type UiAction =
  | "send_message"
  | "stop_run"
  | "resume_run"
  | "retry_run"
  | "approve"
  | "reject"
  | "cancel_task"
  | "retry_task"
  | "merge"
  | "open_session";

const sessionTransitions: Record<SessionStatus, readonly SessionStatus[]> = {
  idle: ["running", "archived"],
  running: ["waiting_input", "waiting_approval", "completed", "failed", "idle"],
  waiting_input: ["running", "failed", "archived"],
  waiting_approval: ["running", "failed", "archived"],
  completed: ["idle", "archived"],
  failed: ["idle", "running", "archived"],
  archived: ["idle"]
};

const taskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["ready", "cancelled"],
  ready: ["queued", "blocked_dependency", "cancelled"],
  blocked_dependency: ["ready", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["waiting_user", "waiting_approval", "verifying", "completed", "failed", "cancelled"],
  waiting_user: ["running", "failed", "cancelled"],
  waiting_approval: ["ready", "blocked_dependency", "running", "failed", "cancelled"],
  verifying: ["review_required", "merge_ready", "completed", "failed"],
  review_required: ["merge_ready", "running", "failed"],
  merge_ready: ["completed", "running", "failed"],
  completed: [],
  failed: ["ready", "queued", "cancelled"],
  cancelled: ["ready"]
};

const projectRunTransitions: Record<ProjectRunStatus, readonly ProjectRunStatus[]> = {
  planning: ["plan_review", "executing", "waiting_user", "paused", "failed", "cancelled"],
  plan_review: ["planning", "executing", "cancelled"],
  executing: ["waiting_user", "paused", "verifying", "completed", "failed", "cancelled"],
  waiting_user: ["executing", "failed", "cancelled"],
  paused: ["planning", "executing", "cancelled"],
  verifying: ["paused", "review_required", "merge_ready", "completed", "failed"],
  review_required: ["merge_ready", "executing", "failed"],
  merge_ready: ["merging", "review_required", "executing", "failed"],
  merging: ["paused", "completed", "review_required", "failed"],
  // A chat session may receive another user turn after a previously completed
  // orchestration cycle; runtime-tool delegation reopens that same cycle.
  completed: ["executing", "waiting_user"],
  failed: ["planning", "executing", "cancelled"],
  cancelled: []
};

export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return sessionTransitions[from].includes(to);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return taskTransitions[from].includes(to);
}

export function canTransitionProjectRun(
  from: ProjectRunStatus,
  to: ProjectRunStatus
): boolean {
  return projectRunTransitions[from].includes(to);
}

export function availableActions(input: {
  sessionStatus?: SessionStatus;
  taskStatus?: TaskStatus;
  runStatus?: AgentRunStatus;
  approvalRequired?: boolean;
}): UiAction[] {
  const actions = new Set<UiAction>();

  if (input.sessionStatus && !["archived", "completed"].includes(input.sessionStatus)) {
    actions.add("send_message");
  }
  if (input.runStatus === "running" || input.runStatus === "waiting_input") {
    actions.add("stop_run");
  }
  if (input.runStatus === "failed" || input.runStatus === "crashed" || input.runStatus === "timed_out") {
    actions.add("retry_run");
  }
  if (input.runStatus === "cancelled" || input.runStatus === "cancelling") {
    actions.add("resume_run");
  }
  if (input.approvalRequired) {
    actions.add("approve");
    actions.add("reject");
  }
  if (input.taskStatus === "running" || input.taskStatus === "waiting_user") {
    actions.add("cancel_task");
  }
  if (input.taskStatus === "failed") {
    actions.add("retry_task");
  }
  if (input.taskStatus === "merge_ready") {
    actions.add("merge");
  }
  return [...actions];
}
