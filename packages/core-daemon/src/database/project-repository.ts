import type { Project } from "@agenthub/domain";
import { JsonRepository } from "./json-repository.js";
export class ProjectRepository extends JsonRepository<Project> {
  constructor(db: ConstructorParameters<typeof JsonRepository<Project>>[0]) { super(db, "projects"); }
}
