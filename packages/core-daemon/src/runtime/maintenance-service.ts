import { Database } from "../database/index.js";
export interface RetentionPolicy { eventDays: number; artifactDays: number; }
export class MaintenanceService {
  constructor(private readonly database: Database) {}
  apply(policy: RetentionPolicy, now = Date.now()): { deletedEvents: number; deletedArtifacts: number } {
    const eventCutoff = new Date(now - policy.eventDays * 86_400_000).toISOString();
    const artifactCutoff = new Date(now - policy.artifactDays * 86_400_000).toISOString();
    return { deletedEvents: this.database.events.deleteBefore(eventCutoff), deletedArtifacts: this.database.artifacts.deleteBefore(artifactCutoff) };
  }
}
