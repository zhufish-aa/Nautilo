import type { ProviderCapability } from "@agenthub/domain";
import { JsonRepository } from "./json-repository.js";
export class CapabilityRepository extends JsonRepository<ProviderCapability> {
  constructor(db: ConstructorParameters<typeof JsonRepository<ProviderCapability>>[0]) { super(db, "capabilities"); }
}
