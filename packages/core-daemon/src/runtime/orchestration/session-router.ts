import { randomUUID } from "node:crypto";
import type { ProjectRun, Session, TeamDefinition, TeamMember } from "@agenthub/domain";
import { Database } from "../../database/index.js";
import { CoreError } from "../../errors.js";

export class SessionRouter {
  constructor(private readonly database: Database) {}

  main(projectRun: ProjectRun, team: TeamDefinition, existingSessionId?: string): Session {
    if (existingSessionId) {
      const existing = this.database.sessions.get(existingSessionId);
      if (existing && existing.projectId === projectRun.projectId) {
        const updated = { ...existing, teamId: team.id, projectRunId: projectRun.id, memberId: projectRun.mainMemberId, agentInstanceId: projectRun.mainAgentInstanceId, updatedAt: new Date().toISOString() };
        this.database.sessions.save(updated);
        return updated;
      }
    }
    return this.create(projectRun, projectRun.mainMemberId, `Run: ${projectRun.goal.slice(0, 80)}`, { teamId: team.id, agentInstanceId: projectRun.mainAgentInstanceId });
  }

  delegated(projectRun: ProjectRun, team: TeamDefinition, member: TeamMember, parent: Session, taskId: string, title: string, targetSessionId?: string): Session {
    if (targetSessionId) {
      const target = this.database.sessions.get(targetSessionId);
      if (
        !target ||
        target.projectId !== projectRun.projectId ||
        target.teamId !== team.id ||
        target.memberId !== member.id ||
        target.parentSessionId !== parent.id ||
        target.id === parent.id
      ) {
        throw new CoreError("PLAN_SCHEMA_INVALID", { reason: "invalid_continue_session", targetSessionId, memberId: member.id });
      }
      const continued: Session = {
        ...target,
        projectRunId: projectRun.id,
        parentSessionId: parent.id,
        taskId,
        status: "idle",
        updatedAt: new Date().toISOString()
      };
      this.database.sessions.save(continued);
      return continued;
    }
    const existing = this.database.sessions.list(projectRun.projectId, member.id)
      .find((session) => session.projectRunId === projectRun.id && session.taskId === taskId);
    if (existing) return existing;
    return this.create(projectRun, member.id, title, {
      teamId: team.id,
      parentSessionId: parent.id,
      taskId,
      model: member.model,
      reasoningEffort: member.reasoningEffort,
      serviceTier: member.serviceTier
    });
  }

  replacementMain(projectRun: ProjectRun, team: TeamDefinition, memberId: string, previous: Session): Session {
    const member = team.members.find((candidate) => candidate.id === memberId);
    return this.create(projectRun, memberId, `Recovery: ${projectRun.goal.slice(0, 80)}`, {
      teamId: team.id,
      parentSessionId: previous.id,
      agentInstanceId: member?.agentInstanceId,
      model: member?.model,
      reasoningEffort: member?.reasoningEffort,
      serviceTier: member?.serviceTier
    });
  }

  private create(
    projectRun: ProjectRun,
    memberId: string,
    title: string,
    context: Pick<Session, "teamId" | "parentSessionId" | "taskId" | "agentInstanceId" | "model" | "reasoningEffort" | "serviceTier"> = { teamId: projectRun.teamId }
  ): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      projectId: projectRun.projectId,
      projectRunId: projectRun.id,
      teamId: context.teamId ?? projectRun.teamId,
      parentSessionId: context.parentSessionId,
      taskId: context.taskId,
      agentInstanceId: context.agentInstanceId,
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      serviceTier: context.serviceTier,
      memberId,
      title,
      status: "idle",
      unreadCount: 0,
      createdAt: now,
      updatedAt: now
    };
    this.database.sessions.save(session);
    return session;
  }
}
