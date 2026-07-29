import type {
  AcceptanceCriterion,
  ContextNeed,
  PlannerDecision,
  PlannedTask,
  RecoveryDecision
} from "@agenthub/domain";

export const schemaVersion = 1 as const;

function isAcceptanceCriterion(value: unknown): value is AcceptanceCriterion {
  if (!value || typeof value !== "object") return false;
  const criterion = value as Partial<AcceptanceCriterion>;
  return (
    typeof criterion.id === "string" &&
    typeof criterion.description === "string" &&
    typeof criterion.required === "boolean"
  );
}

function isContextNeed(value: unknown): value is ContextNeed {
  if (!value || typeof value !== "object") return false;
  const need = value as Partial<ContextNeed>;
  return (
    ["file", "artifact", "decision", "verification"].includes(String(need.kind)) &&
    typeof need.reference === "string" &&
    typeof need.reason === "string"
  );
}

function isPlannedTask(value: unknown): value is PlannedTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<PlannedTask>;
  return (
    typeof task.id === "string" &&
    typeof task.title === "string" &&
    typeof task.objective === "string" &&
    typeof task.taskType === "string" &&
    typeof task.assignedMemberId === "string" &&
    (task.targetSessionId === undefined || typeof task.targetSessionId === "string") &&
    Array.isArray(task.dependencies) &&
    task.dependencies.every((item) => typeof item === "string") &&
    Array.isArray(task.allowedPaths) &&
    task.allowedPaths.every((item) => typeof item === "string") &&
    Array.isArray(task.acceptanceCriteria) &&
    task.acceptanceCriteria.every(isAcceptanceCriterion) &&
    Array.isArray(task.contextNeeds) &&
    task.contextNeeds.every(isContextNeed) &&
    typeof task.assignmentReason === "string"
  );
}

export function isPlannerDecision(value: unknown): value is PlannerDecision {
  if (!value || typeof value !== "object") return false;
  const decision = value as Partial<PlannerDecision>;
  if (typeof decision.rationale !== "string") return false;
  if (decision.mode === "direct") return true;
  if (decision.mode === "delegate") return isPlannedTask(decision.task);
  return (
    decision.mode === "plan" &&
    Array.isArray(decision.tasks) &&
    decision.tasks.length > 0 &&
    decision.tasks.every(isPlannedTask)
  );
}

export function validatePlannerDecision(value: unknown): PlannerDecision {
  if (!isPlannerDecision(value)) {
    throw new Error("PLAN_SCHEMA_INVALID");
  }
  return value;
}

export function isRecoveryDecision(value: unknown): value is RecoveryDecision {
  if (!value || typeof value !== "object") return false;
  const decision = value as Partial<RecoveryDecision>;
  if (
    !["retry", "take_over", "continue"].includes(String(decision.action)) ||
    typeof decision.taskId !== "string" ||
    typeof decision.rationale !== "string"
  ) return false;
  return decision.action !== "retry" ||
    decision.assignedMemberId === undefined ||
    typeof decision.assignedMemberId === "string";
}

export function validateRecoveryDecision(value: unknown): RecoveryDecision {
  if (!isRecoveryDecision(value)) throw new Error("RECOVERY_SCHEMA_INVALID");
  return value;
}

export * from "./capability-import.js";
export * from "./ipc.js";
