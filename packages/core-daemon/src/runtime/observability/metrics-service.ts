import type { RuntimeMetrics } from "@agenthub/domain";
import { Database } from "../../database/index.js";

export class MetricsService {
  constructor(private readonly database: Database) {}
  snapshot(projectId?: string): RuntimeMetrics {
    const projectRunIds = new Set(this.database.projectRuns.listAll().filter((run) => !projectId || run.projectId === projectId).map((run) => run.id));
    const runs = this.database.runs.list().filter((run) => !run.projectRunId || projectRunIds.has(run.projectRunId));
    const tasks = this.database.tasks.listAll().filter((task) => projectRunIds.has(task.projectRunId));
    const verifications = this.database.verifications.listAll().filter((item) => projectRunIds.has(item.projectRunId));
    const events = this.database.events.replay({}).filter((event) => !event.projectRunId || projectRunIds.has(event.projectRunId));
    const durations = runs.flatMap((run) => run.startedAt && run.endedAt ? [new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()] : []);
    return {
      totalRuns: runs.length,
      completedRuns: runs.filter((run) => run.status === "completed").length,
      failedRuns: runs.filter((run) => ["failed", "crashed", "timed_out"].includes(run.status)).length,
      retriedTasks: tasks.filter((task) => task.attempt > 1).length,
      conflicts: events.filter((event) => event.type === "git.conflict").length,
      verificationTotal: verifications.length,
      verificationPassed: verifications.filter((item) => item.passed).length,
      averageRunDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0
    };
  }
}
