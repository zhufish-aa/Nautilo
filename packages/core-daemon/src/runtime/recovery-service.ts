import type { RecoverableProjectRun } from "@agenthub/domain";
import { Database } from "../database/index.js";
import { AuditService } from "./observability/audit-service.js";

const INTERRUPTED_RUN = new Set(["created", "starting", "running", "waiting_input", "waiting_approval", "cancelling"]);
const INTERRUPTED_PROJECT = new Set(["planning", "plan_review", "executing", "verifying", "merging"]);

export class RecoveryService {
  constructor(private readonly database: Database, private readonly audit: AuditService) {}
  recoverInterrupted(): { agentRuns: number; projectRuns: number; sessions: number; tasks: number } {
    const now = new Date().toISOString();
    let agentRuns = 0;
    let projectRuns = 0;
    let sessions = 0;
    let tasks = 0;
    for (const run of this.database.runs.list()) if (INTERRUPTED_RUN.has(run.status)) {
      this.database.runs.save({ ...run, status: "crashed", endedAt: now, failureCode: "DAEMON_RESTARTED" });
      agentRuns += 1;
    }
    for (const session of this.database.sessions.listAll()) if (["running", "waiting_input", "waiting_approval"].includes(session.status)) {
      this.database.sessions.save({ ...session, status: "waiting_input", updatedAt: now });
      sessions += 1;
    }
    for (const run of this.database.projectRuns.listAll()) if (INTERRUPTED_PROJECT.has(run.status)) {
      this.database.projectRuns.save({ ...run, status: "paused", recoveryReason: "daemon_restarted", updatedAt: now });
      projectRuns += 1;
    }
    for (const task of this.database.tasks.listAll()) if (["queued", "running", "verifying"].includes(task.status)) {
      this.database.tasks.save({ ...task, status: "waiting_user", updatedAt: now });
      tasks += 1;
    }
    if (agentRuns + projectRuns + sessions + tasks > 0) this.audit.record({ actorType: "system", actorId: "core-daemon", action: "recovery.mark_interrupted", resourceType: "runtime", outcome: "success", details: { agentRuns, projectRuns, sessions, tasks } });
    return { agentRuns, projectRuns, sessions, tasks };
  }
  list(): RecoverableProjectRun[] {
    return this.database.projectRuns.listAll().filter((run) => ["paused", "failed"].includes(run.status)).flatMap((projectRun) => {
      const team = projectRun.teamId ? this.database.teams.get(projectRun.teamId) : undefined;
      if (!team) return [];
      const session = projectRun.mainSessionId ? this.database.sessions.get(projectRun.mainSessionId) : undefined;
      return [{
        projectRun,
        currentMainMemberId: projectRun.mainMemberId,
        enabledMemberIds: team.members.filter((member) => member.enabled && this.database.agents.get(member.agentInstanceId)?.enabled).map((member) => member.id),
        canResumeProviderSession: !!session?.providerSessionId
      }];
    });
  }
}
