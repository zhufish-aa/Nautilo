import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiagnosticExportResult } from "@agenthub/domain";
import { Database } from "../../database/index.js";
import { RedactionService } from "../security/redaction-service.js";
import { AuditService } from "./audit-service.js";
import { MetricsService } from "./metrics-service.js";

export class DiagnosticsService {
  private readonly outputDirectory: string;
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly redaction: RedactionService,
    dataDir: string
  ) {
    this.outputDirectory = join(dataDir, "diagnostics");
  }
  export(input: { projectId?: string; projectRunId?: string } = {}): DiagnosticExportResult {
    mkdirSync(this.outputDirectory, { recursive: true });
    const createdAt = new Date().toISOString();
    const events = this.database.events.replay(input.projectRunId ? { projectRunId: input.projectRunId } : {});
    const audit = this.audit.list({ limit: 500, resourceId: input.projectRunId });
    const payload = this.redaction.value({
      schemaVersion: 1,
      createdAt,
      platform: process.platform,
      node: process.version,
      metrics: this.metrics.snapshot(input.projectId),
      projects: this.database.projects.list().filter((project) => !input.projectId || project.id === input.projectId),
      agents: this.database.agents.list().map((agent) => ({ ...agent, providerOptions: redactProviderOptions(agent.providerOptions) })),
      projectRuns: this.database.projectRuns.listAll().filter((run) => !input.projectRunId || run.id === input.projectRunId),
      events,
      audit
    });
    const path = join(this.outputDirectory, `agenthub-diagnostics-${createdAt.replace(/[:.]/g, "-")}.json`);
    writeFileSync(path, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    return { path, createdAt, auditCount: audit.length, eventCount: events.length };
  }
}

function redactProviderOptions(options?: Record<string, string | number | boolean | string[]>): Record<string, unknown> | undefined {
  if (!options) return undefined;
  return Object.fromEntries(Object.entries(options).map(([key, value]) => [key, /key|token|secret|password/i.test(key) ? "[REDACTED]" : value]));
}
