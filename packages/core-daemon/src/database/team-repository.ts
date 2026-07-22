import type { TeamDefinition } from "@agenthub/domain";
import { JsonRepository } from "./json-repository.js";
export class TeamRepository extends JsonRepository<TeamDefinition> {
  constructor(db: ConstructorParameters<typeof JsonRepository<TeamDefinition>>[0]) { super(db, "teams"); }
}
