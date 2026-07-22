import type { PlannerDecision, PlannedTask, RecoveryDecision, Task, TeamDefinition } from "@agenthub/domain";
import { validatePlannerDecision, validateRecoveryDecision } from "@agenthub/schemas";
import { CoreError } from "../../errors.js";
import { MemberRouter } from "./member-router.js";
import { PlannerDecisionParser } from "./planner-decision-parser.js";

export class DecisionValidator {
  private readonly parser = new PlannerDecisionParser();

  constructor(private readonly members: MemberRouter) {}

  planner(value: unknown, team: TeamDefinition): PlannerDecision {
    let decision: PlannerDecision;
    try { decision = validatePlannerDecision(this.parser.parse(value, team)); }
    catch { throw new CoreError("PLAN_SCHEMA_INVALID"); }
    if (decision.mode === "direct") return decision;
    if (team.delegationPolicy === "direct_only") throw new CoreError("PLAN_DELEGATION_NOT_ALLOWED", { teamId: team.id });

    const tasks = decision.mode === "delegate" ? [decision.task] : decision.tasks;
    this.validateTasks(tasks, team);
    return decision;
  }

  recovery(value: unknown, task: Task, team: TeamDefinition): RecoveryDecision {
    let decision: RecoveryDecision;
    try { decision = validateRecoveryDecision(value); }
    catch { throw new CoreError("RECOVERY_SCHEMA_INVALID", { taskId: task.id }); }
    if (decision.taskId !== task.id) throw new CoreError("RECOVERY_SCHEMA_INVALID", { expectedTaskId: task.id, actualTaskId: decision.taskId });
    if (decision.action === "retry" && decision.assignedMemberId) {
      this.members.resolve(team, decision.assignedMemberId, task.taskType);
    }
    return decision;
  }

  private validateTasks(tasks: PlannedTask[], team: TeamDefinition): void {
    if (tasks.length > 50) throw new CoreError("PLAN_SCHEMA_INVALID", { reason: "too_many_tasks", maximum: 50 });
    const ids = new Set<string>();
    for (const task of tasks) {
      if (!task.id.trim() || !task.title.trim() || !task.objective.trim() || !task.taskType.trim()) {
        throw new CoreError("PLAN_SCHEMA_INVALID", { taskId: task.id, reason: "blank_required_field" });
      }
      if (ids.has(task.id)) throw new CoreError("PLAN_SCHEMA_INVALID", { taskId: task.id, reason: "duplicate_task_id" });
      ids.add(task.id);
      this.members.resolve(team, task.assignedMemberId, task.taskType);
    }
    for (const task of tasks) {
      for (const dependency of task.dependencies) {
        if (!ids.has(dependency)) throw new CoreError("PLAN_DEPENDENCY_NOT_FOUND", { taskId: task.id, dependency });
        if (dependency === task.id) throw new CoreError("PLAN_DEPENDENCY_CYCLE", { taskId: task.id });
      }
    }
    this.assertAcyclic(tasks);
  }

  private assertAcyclic(tasks: PlannedTask[]): void {
    const dependencies = new Map(tasks.map((task) => [task.id, task.dependencies]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (taskId: string): void => {
      if (visiting.has(taskId)) throw new CoreError("PLAN_DEPENDENCY_CYCLE", { taskId });
      if (visited.has(taskId)) return;
      visiting.add(taskId);
      for (const dependency of dependencies.get(taskId) ?? []) visit(dependency);
      visiting.delete(taskId);
      visited.add(taskId);
    };
    for (const task of tasks) visit(task.id);
  }
}
