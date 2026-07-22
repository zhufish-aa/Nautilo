import { canTransitionTask, type PlannedTask, type ProjectRunId, type Task, type TaskStatus } from "@agenthub/domain";
import { Database } from "../../database/index.js";

export class TaskGraph {
  constructor(private readonly database: Database) {}

  create(projectRunId: ProjectRunId, planned: PlannedTask[], waitingApproval = false): Task[] {
    const now = new Date().toISOString();
    const tasks = planned.map((item, index): Task => ({
      id: item.id,
      projectRunId,
      title: item.title,
      objective: item.objective,
      taskType: item.taskType,
      assignedMemberId: item.assignedMemberId,
      targetSessionId: item.targetSessionId,
      dependencies: item.dependencies,
      allowedPaths: item.allowedPaths,
      acceptanceCriteria: item.acceptanceCriteria,
      status: waitingApproval ? "waiting_approval" : item.dependencies.length === 0 ? "ready" : "blocked_dependency",
      attempt: 1,
      priority: index,
      createdAt: now,
      updatedAt: now
    }));
    for (const task of tasks) this.database.tasks.save(task);
    return tasks;
  }

  releaseApproval(projectRunId: ProjectRunId): Task[] {
    const tasks = this.database.tasks.list(projectRunId);
    for (const task of tasks) {
      if (task.status !== "waiting_approval") continue;
      this.saveStatus(task, task.dependencies.length === 0 ? "ready" : "blocked_dependency");
    }
    return this.database.tasks.list(projectRunId);
  }

  refresh(projectRunId: ProjectRunId): Task[] {
    const tasks = this.database.tasks.list(projectRunId);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const task of tasks) {
      if (task.status !== "blocked_dependency") continue;
      const dependencies = task.dependencies.map((id) => byId.get(id));
      if (dependencies.every((dependency) => dependency?.status === "completed")) this.saveStatus(task, "ready");
    }
    return this.database.tasks.list(projectRunId);
  }

  ready(projectRunId: ProjectRunId): Task[] {
    return this.refresh(projectRunId)
      .filter((task) => task.status === "ready")
      .sort((left, right) => left.priority - right.priority);
  }

  saveStatus(task: Task, status: TaskStatus, patch: Partial<Task> = {}): Task {
    if (task.status !== status && !canTransitionTask(task.status, status)) {
      throw new Error(`Invalid task transition ${task.status} -> ${status} for ${task.id}`);
    }
    const updated = { ...task, ...patch, status, updatedAt: new Date().toISOString() };
    this.database.tasks.save(updated);
    return updated;
  }

  cancelDependents(projectRunId: ProjectRunId, failedTaskId: string): Task[] {
    const tasks = this.database.tasks.list(projectRunId);
    const cancelled = new Set([failedTaskId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (cancelled.has(task.id) || task.status === "completed") continue;
        if (task.dependencies.some((dependency) => cancelled.has(dependency))) {
          cancelled.add(task.id);
          changed = true;
        }
      }
    }
    for (const task of tasks) {
      if (task.id !== failedTaskId && cancelled.has(task.id) && !["completed", "cancelled"].includes(task.status)) {
        this.saveStatus(task, "cancelled");
      }
    }
    return this.database.tasks.list(projectRunId);
  }
}
