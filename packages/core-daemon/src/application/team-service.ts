import type { TeamDefinition } from "@agenthub/domain";
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
    this.database.teams.save(team, team.updatedAt);
    return team;
  }
  remove(id: string): { removed: true } {
    this.database.teams.remove(id);
    return { removed: true };
  }
}
