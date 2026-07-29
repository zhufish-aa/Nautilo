import type { SessionStatus, TaskStatus } from "@agenthub/domain";
import type { RunLifecycle } from "./types";

const RUNNING_DELEGATED_TASK_STATUSES = new Set<TaskStatus>([
  "queued",
  "running",
  "verifying"
]);

export function isActiveLifecycle(lifecycle?: RunLifecycle): boolean {
  return lifecycle?.status === "running" || lifecycle?.status === "waiting_approval";
}

/** A project run alone does not prove that a child Agent was dispatched. */
export function hasRunningDelegatedTask(tasks: ReadonlyArray<{ status: TaskStatus }>): boolean {
  return tasks.some((task) => RUNNING_DELEGATED_TASK_STATUSES.has(task.status));
}

/** The orchestration outlives an individual provider turn in the main session. */
export function visibleSessionStatus(sessionStatus: SessionStatus, orchestration?: RunLifecycle): SessionStatus {
  if (orchestration?.status === "running") return "running";
  if (orchestration?.status === "waiting_approval") return "waiting_approval";
  return sessionStatus;
}
