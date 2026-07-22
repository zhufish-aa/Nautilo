import { randomUUID } from "node:crypto";
import type { ApprovalRecord, ApprovalScope } from "@agenthub/domain";
import { Database } from "../../database/index.js";
import { CoreError } from "../../errors.js";

export class ApprovalService {
  constructor(private readonly database: Database) {}
  request(input: Omit<ApprovalRecord, "id" | "status" | "createdAt"> & { id?: string }): ApprovalRecord {
    const record: ApprovalRecord = { ...input, id: input.id ?? randomUUID(), status: "pending", createdAt: new Date().toISOString() };
    this.database.approvals.save(record);
    return record;
  }
  resolve(id: string, decision: "approved" | "rejected", scope: ApprovalScope, resolvedBy = "desktop-user"): ApprovalRecord {
    const current = this.database.approvals.get(id);
    if (!current || current.status !== "pending") throw new CoreError("APPROVAL_NOT_FOUND", { id });
    const record: ApprovalRecord = { ...current, status: decision, scope, resolvedBy, resolvedAt: new Date().toISOString() };
    this.database.approvals.save(record);
    return record;
  }
  list(input: { status?: ApprovalRecord["status"]; projectRunId?: string } = {}): ApprovalRecord[] { return this.database.approvals.list(input); }
  authorize(operation: string, context: { projectId?: string; projectRunId?: string; taskId?: string }): boolean {
    const grant = this.database.approvals.list({ status: "approved" }).find((record) => record.operation === operation && matchesScope(record, context));
    if (!grant) return false;
    if (grant.scope === "once" && !grant.consumedAt) this.database.approvals.save({ ...grant, consumedAt: new Date().toISOString() });
    return grant.scope !== "once" || !grant.consumedAt;
  }
}

function matchesScope(record: ApprovalRecord, context: { projectId?: string; projectRunId?: string; taskId?: string }): boolean {
  if (record.scope === "global") return true;
  if (record.scope === "project") return !!record.projectId && record.projectId === context.projectId;
  if (record.scope === "run") return !!record.projectRunId && record.projectRunId === context.projectRunId;
  if (record.scope === "task") return !!record.taskId && record.taskId === context.taskId;
  return record.scope === "once" && !record.consumedAt;
}
