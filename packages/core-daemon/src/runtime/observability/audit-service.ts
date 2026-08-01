import { randomUUID } from "node:crypto";
import type { AuditRecord } from "@agenthub/domain";
import { Database } from "../../database/index.js";
import { RedactionService } from "../security/redaction-service.js";

const FLUSH_INTERVAL_MS = 500;
const FLUSH_THRESHOLD = 50;

export class AuditService {
  // High-frequency IPC requests would otherwise each trigger a synchronous
  // SQLite insert. Buffer records briefly and persist them in one transaction.
  private pending: AuditRecord[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly database: Database, private readonly redaction: RedactionService) {}

  record(input: Omit<AuditRecord, "id" | "timestamp">): AuditRecord {
    const record: AuditRecord = this.redaction.value({ ...input, id: randomUUID(), timestamp: new Date().toISOString() });
    this.pending.push(record);
    if (this.pending.length >= FLUSH_THRESHOLD) this.flush();
    else this.scheduleFlush();
    return record;
  }
  list(input: { limit?: number; resourceId?: string } = {}): AuditRecord[] {
    this.flush();
    return this.database.audit.list(input);
  }
  ipc(method: string, input: unknown, outcome: AuditRecord["outcome"], details?: unknown): void {
    this.record({ actorType: "user", actorId: "desktop-user", action: `ipc.${method}`, resourceType: "ipc", outcome, details: this.redaction.value({ input, result: details }) as Record<string, unknown> });
  }
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    this.database.audit.appendMany(batch);
  }
  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }
}
