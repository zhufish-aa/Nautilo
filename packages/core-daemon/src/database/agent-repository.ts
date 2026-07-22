import type { AgentInstance } from "@agenthub/domain";
import { JsonRepository } from "./json-repository.js";
export class AgentRepository extends JsonRepository<AgentInstance> {
  constructor(db: ConstructorParameters<typeof JsonRepository<AgentInstance>>[0]) { super(db, "agents"); }
}
