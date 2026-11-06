import { randomUUID } from "node:crypto";
import type { ApprovalRecord, ApprovalScope } from "@agenthub/domain";
import { Database } from "../../database/index.js";
import { CoreError } from "../../errors.js";

export class ApprovalService {
  constructor(private readonly database: Database) {}
  request(input: Omit<ApprovalRecord, "id" | "status" | "createdAt"> & { id?: string }): ApprovalRecord {
    if (input.category === "command") {
      const existing = this.database.approvals.list({ status: "pending" }).find((record) => sameRequest(record, input));
      if (existing) return existing;
    }
    const record: ApprovalRecord = { ...input, id: input.id ?? randomUUID(), status: "pending", createdAt: new Date().toISOString() };
    this.database.approvals.save(record);
    return record;
  }
  resolve(id: string, decision: "approved" | "rejected", scope: ApprovalScope, resolvedBy = "desktop-user"): ApprovalRecord {
    return this.resolveMany(id, decision, scope, resolvedBy)[0];
  }
  resolveMany(id: string, decision: "approved" | "rejected", scope: ApprovalScope, resolvedBy = "desktop-user"): ApprovalRecord[] {
    const current = this.database.approvals.get(id);
    if (!current) throw new CoreError("APPROVAL_NOT_FOUND", { id });
    if (current.status !== "pending") {
      if (current.status === decision && current.scope === scope) return [current];
      throw new CoreError("APPROVAL_NOT_FOUND", { id });
    }
    const now = new Date().toISOString();
    const duplicates = current.category === "command" ? this.database.approvals.list({ status: "pending" }).filter((record) => record.id !== id && sameRequest(record, current)) : [];
    const records = [current, ...duplicates].map((item): ApprovalRecord => ({ ...item, status: decision, scope, resolvedBy, resolvedAt: now,
      ...(item.id !== id && decision === "approved" && scope === "once" ? { consumedAt: now } : {}) }));
    this.database.connection.raw.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) this.database.approvals.save(record);
      this.database.connection.raw.exec("COMMIT");
    } catch (error) {
      this.database.connection.raw.exec("ROLLBACK");
      throw error;
    }
    return records;
  }
  list(input: { status?: ApprovalRecord["status"]; projectRunId?: string } = {}): ApprovalRecord[] { return this.database.approvals.list(input); }
  authorize(operation: string, context: ApprovalContext): boolean {
    const grant = this.database.approvals.list({ status: "approved" }).find((record) => record.operation === operation && matchesScope(record, context));
    if (!grant) return false;
    if (grant.scope === "once" && !grant.consumedAt) this.database.approvals.save({ ...grant, consumedAt: new Date().toISOString() });
    return grant.scope !== "once" || !grant.consumedAt;
  }
}

type ApprovalContext = { projectId?: string; projectRunId?: string; taskId?: string; sessionId?: string };

function sameRequest(left: ApprovalRecord, right: Omit<ApprovalRecord, "id" | "status" | "createdAt">): boolean {
  return (["category", "operation", "projectId", "projectRunId", "taskId", "sessionId", "requestedBy"] as const).every((key) => (left[key] ?? null) === (right[key] ?? null))
    && (!!left.operation || left.summary === right.summary);
}

function matchesScope(record: ApprovalRecord, context: ApprovalContext): boolean {
  if (record.scope === "global") return true;
  if (record.scope === "project") return !!record.projectId && record.projectId === context.projectId;
  if (record.scope === "run") return record.projectRunId ? record.projectRunId === context.projectRunId : !!record.sessionId && record.sessionId === context.sessionId;
  if (record.scope === "task") return !!record.taskId && record.taskId === context.taskId;
  return record.scope === "once" && !record.consumedAt && (["projectId", "projectRunId", "taskId", "sessionId"] as const).every((key) => !record[key] || record[key] === context[key]);
}
