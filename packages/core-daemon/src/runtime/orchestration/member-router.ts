import type { AgentInstance, Role, Session, TeamDefinition, TeamMember } from "@agenthub/domain";
import { Database } from "../../database/index.js";
import { CoreError } from "../../errors.js";

export interface ResolvedMember {
  member: TeamMember;
  agent: AgentInstance;
  role?: Role;
}

/** Resolves only user-persisted team members; it never infers or hardcodes roles. */
export class MemberRouter {
  constructor(private readonly database: Database) {}

  resolve(team: TeamDefinition, memberId: string, taskType?: string): ResolvedMember {
    const member = team.members.find((candidate) => candidate.id === memberId);
    if (!member?.enabled) throw new CoreError("PLAN_MEMBER_NOT_FOUND", { teamId: team.id, memberId });
    if (
      taskType &&
      member.allowedTaskTypes.length > 0 &&
      !member.allowedTaskTypes.includes("*") &&
      !member.allowedTaskTypes.includes(taskType)
    ) throw new CoreError("PLAN_TASK_TYPE_NOT_ALLOWED", { memberId, taskType });
    const agent = this.database.agents.get(member.agentInstanceId);
    if (!agent?.enabled || agent.status === "disabled") {
      throw new CoreError("PLAN_MEMBER_NOT_FOUND", { memberId, agentInstanceId: member.agentInstanceId });
    }
    return { member, agent, role: team.roles?.find((role) => role.id === member.roleId) };
  }

  main(team: TeamDefinition): ResolvedMember {
    if (!team.mainMemberId) throw new CoreError("PLAN_MEMBER_NOT_FOUND", { teamId: team.id, reason: "main_agent_not_selected_by_session" });
    return this.resolve(team, team.mainMemberId);
  }

  sessionMain(team: TeamDefinition, agentInstanceId?: string): ResolvedMember {
    if (!agentInstanceId) return this.main(team);
    const legacyMain = team.mainMemberId
      ? team.members.find((member) => member.id === team.mainMemberId && member.agentInstanceId === agentInstanceId)
      : undefined;
    if (legacyMain) return this.resolve(team, legacyMain.id);
    const agent = this.database.agents.get(agentInstanceId);
    if (!agent?.enabled || agent.status === "disabled") {
      throw new CoreError("AGENT_NOT_FOUND", { agentInstanceId });
    }
    return {
      agent,
      member: {
        id: `main:${agent.id}`,
        displayName: agent.displayName,
        agentInstanceId: agent.id,
        roleId: "session-main",
        strengths: {},
        allowedTaskTypes: [],
        maxConcurrentTasks: 1,
        enabled: true
      }
    };
  }

  resolveSession(session: Session): AgentInstance {
    if (session.agentInstanceId) {
      const agent = this.database.agents.get(session.agentInstanceId);
      if (!agent?.enabled || agent.status === "disabled") throw new CoreError("AGENT_NOT_FOUND", { sessionId: session.id });
      return agent;
    }
    if (session.teamId) {
      const team = this.database.teams.get(session.teamId);
      if (!team) throw new CoreError("IPC_NOT_FOUND", { resource: "team", id: session.teamId });
      return this.resolve(team, session.memberId).agent;
    }
    const agent = this.database.agents.get(session.memberId);
    if (!agent?.enabled || agent.status === "disabled") throw new CoreError("AGENT_NOT_FOUND", { sessionId: session.id });
    return agent;
  }
}
