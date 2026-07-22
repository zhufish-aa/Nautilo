import { randomUUID } from "node:crypto";
import type { AuditRecord } from "@agenthub/domain";
import { Database } from "../../database/index.js";
import { RedactionService } from "../security/redaction-service.js";

export class AuditService {
  constructor(private readonly database: Database, private readonly redaction: RedactionService) {}
  record(input: Omit<AuditRecord, "id" | "timestamp">): AuditRecord {
    const record: AuditRecord = this.redaction.value({ ...input, id: randomUUID(), timestamp: new Date().toISOString() });
    this.database.audit.append(record);
    return record;
  }
  list(input: { limit?: number; resourceId?: string } = {}): AuditRecord[] { return this.database.audit.list(input); }
  ipc(method: string, input: unknown, outcome: AuditRecord["outcome"], details?: unknown): void {
    this.record({ actorType: "user", actorId: "desktop-user", action: `ipc.${method}`, resourceType: "ipc", outcome, details: this.redaction.value({ input, result: details }) as Record<string, unknown> });
  }
}
