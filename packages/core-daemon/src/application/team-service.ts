import type { TeamDefinition } from "@agenthub/domain";
import { assertConnectionCompatible, readConnection } from "../runtime/runtime-connection.js";
import { Database } from "../database/index.js";
import { CoreError } from "../errors.js";

export class TeamService {
  constructor(private readonly database: Database) {}
  list(): TeamDefinition[] { return this.database.teams.list(); }
  get(id: string): TeamDefinition {
    const team = this.database.teams.get(id);
    if (!team) throw new CoreError("IPC_NOT_FOUND", { resource: "team", id });
    return team;
  }
  upsert(team: TeamDefinition): TeamDefinition {
    const previous = this.database.teams.get(team.id);
    const saved = { ...team, members: team.members.map((member) => {
      if (!member.connectionId) return member;
      const agent = this.database.agents.get(member.agentInstanceId);
      if (!agent) throw new CoreError("IPC_NOT_FOUND", { resource: "harness", id: member.agentInstanceId });
      const connection = readConnection(this.database, member.connectionId, member.connectionRevision);
      assertConnectionCompatible(connection, agent);
      return { ...member, connectionRevision: connection.revision };
    }) };
    this.database.teams.save(saved, saved.updatedAt);
    if (previous && delegationMembers(previous) !== delegationMembers(saved)) {
      for (const session of this.database.sessions.listAll()) {
        if (session.teamId !== saved.id || session.parentSessionId || !session.agentInstanceId) continue;
        if (this.database.agents.get(session.agentInstanceId)?.providerId === "codex") {
          this.database.sessions.save({ ...session, runtimeToolVersion: 0 });
        }
      }
    }
    return saved;
  }
  remove(id: string): { removed: true } {
    this.database.teams.remove(id);
    return { removed: true };
  }
}

function delegationMembers(team: TeamDefinition): string {
  return JSON.stringify(team.delegationPolicy === "direct_only" ? [] : team.members.filter((member) => member.enabled && member.id !== team.mainMemberId).map((member) => member.id).sort());
}
