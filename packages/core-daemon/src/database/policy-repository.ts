import type { PermissionPolicy } from "@agenthub/domain";
import type { DatabaseSync } from "node:sqlite";
import { JsonRepository } from "./json-repository.js";

export class PolicyRepository extends JsonRepository<PermissionPolicy> {
  constructor(db: DatabaseSync) { super(db, "permission_policies"); }
}
