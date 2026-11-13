import { randomUUID } from "node:crypto";
import type {
  RequestLog,
  RequestMilestone,
  SessionToolInventory,
} from "@agenthub/schemas";
import type { AgentInstance, Session } from "@agenthub/domain";
import type { AdapterEvent } from "../adapters/index.js";
import type { Database } from "../database/index.js";
import { RedactionService } from "./security/redaction-service.js";

export class RequestLogService {
  private readonly live = new Map<string, { start: number; row: RequestLog }>();
  constructor(
    private readonly db: Database,
    private readonly redaction = new RedactionService(),
  ) {
    db.requestLogs.interruptOpen();
  }
  begin(
    session: Session,
    agent: AgentInstance,
    operation: string,
    messageId?: string,
  ): string {
    const id = randomUUID(),
      now = new Date().toISOString();
    const row: RequestLog = {
      id,
      sessionId: session.id,
      projectId: session.projectId,
      agentInstanceId: agent.id,
      providerId: agent.providerId,
      connectionId: session.connectionId,
      connectionRevision: session.connectionRevision,
      model: session.model,
      messageId,
      operation,
      createdAt: now,
      updatedAt: now,
      status: "queued",
      milestones: { queued: 0 },
      suppliedTools: [],
      suppliedServers: [],
      observedTools: [],
    };
    this.live.set(id, { start: performance.now(), row });
    this.save(row);
    return id;
  }
  private save(row: RequestLog): void {
    row.updatedAt = new Date().toISOString();
    this.db.requestLogs.save(row, row.updatedAt);
  }
  mark(id: string | undefined, key: RequestMilestone): void {
    const r = id && this.live.get(id);
    if (!r || r.row.milestones[key] !== undefined) return;
    r.row.milestones[key] = Math.round(performance.now() - r.start);
    if (key === "preparing") r.row.status = "preparing";
    if (key === "dispatched") r.row.status = "running";
    this.save(r.row);
  }
  attach(id: string | undefined, runId: string): void {
    const r = id && this.live.get(id);
    if (r) {
      r.row.runId = runId;
      this.save(r.row);
    }
  }
  supplied(id: string | undefined, tools: unknown, servers: unknown): void {
    const r = id && this.live.get(id);
    if (r) {
      r.row.suppliedTools = names(tools);
      r.row.suppliedServers = names(servers);
      this.mark(id, "prepared");
      this.save(r.row);
    }
  }
  observe(id: string | undefined, event: AdapterEvent): void {
    const r = id && this.live.get(id);
    if (!r) return;
    const row = r.row;
    if (
      (event.kind === "message" || event.kind === "thinking") &&
      event.text &&
      !event.subagentDispatchId
    ) {
      this.mark(id, "firstEvent");
      this.mark(id, event.kind === "message" ? "firstText" : "firstThinking");
    }
    if (event.kind === "tool") {
      this.mark(id, "firstEvent");
      if (!row.observedTools.includes(event.name)) {
        row.observedTools.push(event.name);
        this.save(row);
      }
    }
    if (event.kind === "status" && event.phase === "runtime_ready") {
      this.mark(id, "runtimeReady");
      const raw = event.raw as Record<string, unknown> | undefined;
      if (raw) {
        const startup = raw.startupTimings as Record<string, unknown> | undefined;
        row.runtime = {
          reused: typeof raw.reused === "boolean" ? raw.reused : undefined,
          pid: typeof raw.pid === "number" ? raw.pid : undefined,
          attachMs: typeof raw.attachMs === "number" ? raw.attachMs : undefined,
          ...(startup && ["prepareMs", "bootstrapMs", "sessionOpenMs"].every(key => typeof startup[key] === "number" && Number.isFinite(startup[key]) && Number(startup[key]) >= 0)
            ? { startupTimings: { prepareMs: Number(startup.prepareMs), bootstrapMs: Number(startup.bootstrapMs), sessionOpenMs: Number(startup.sessionOpenMs) } } : {}),
        };
        const details = startup?.openDetails as Record<string, unknown> | undefined;
        if (row.runtime.startupTimings && details &&
          ["providerBindMs", "sessionCreateMs", "agentResolveMs", "preferencesMs"].every(key =>
            typeof details[key] === "number" && Number.isFinite(details[key]) && Number(details[key]) >= 0)) {
          row.runtime.startupTimings.openDetails = {
            providerBindMs: Number(details.providerBindMs),
            sessionCreateMs: Number(details.sessionCreateMs),
            agentResolveMs: Number(details.agentResolveMs),
            preferencesMs: Number(details.preferencesMs),
          };
          for (const key of ["loaderWaitMs", "providerUpdateMs"] as const) {
            if (typeof details[key] === "number" && Number.isFinite(details[key]) && details[key] >= 0) {
              row.runtime.startupTimings.openDetails[key] = details[key];
            }
          }
          if (Array.isArray(details.pendingPlugins)) {
            row.runtime.startupTimings.openDetails.pendingPlugins = details.pendingPlugins
              .filter((plugin): plugin is string => typeof plugin === "string");
          }
        }
        this.save(row);
      }
    }
    if (event.kind === "status" && event.phase === "runtime_capabilities") {
      const raw = event.raw as Record<string, unknown> | undefined;
      if (raw) {
        if (Array.isArray(raw.tools)) row.nativeTools = names(raw.tools);
        const servers = raw.mcpServers ?? raw.mcp_servers;
        if (Array.isArray(servers))
          row.nativeServers = servers
            .filter((s) => s && typeof s.name === "string")
            .map((s) => ({
              name: s.name,
              status: typeof s.status === "string" ? s.status : undefined,
            }));
        this.save(row);
      }
    }
    if (event.kind === "error") {
      row.failure = {
        stage: failureStage(row),
        message: this.redaction.text(event.error.message),
      };
      this.save(row);
    }
    if (event.kind === "exit") this.mark(id, "ended");
  }
  finish(
    id: string | undefined,
    status: string,
    code?: string,
    error?: string,
  ): void {
    const r = id && this.live.get(id);
    if (!r) return;
    this.mark(id, "ended");
    r.row.status =
      status === "completed" ||
      status === "cancelled" ||
      status === "interrupted"
        ? status
        : "failed";
    if (code || error)
      r.row.failure = {
        stage: failureStage(r.row),
        code: code ?? r.row.failure?.code,
        message: this.redaction.text(
          error ?? r.row.failure?.message ?? "Request failed",
        ),
      };
    this.save(r.row);
    this.live.delete(r.row.id);
  }
  cancelQueued(session: string, message: string): void {
    for (const r of this.live.values())
      if (
        r.row.sessionId === session &&
        r.row.messageId === message &&
        r.row.status === "queued"
      )
        this.finish(r.row.id, "cancelled");
  }
  inventory(sessionId: string): SessionToolInventory {
    const r = this.db.requestLogs.page({ sessionId, limit: 1 }).items[0];
    const tools = new Map<string, "native" | "observed" | "supplied">(),
      servers = new Map<string, SessionToolInventory["servers"][number]>();
    for (const [list, evidence] of [
      [r?.suppliedTools, "supplied"],
      [r?.observedTools, "observed"],
      [r?.nativeTools, "native"],
    ] as const)
      for (const name of list ?? []) tools.set(name, evidence);
    for (const name of r?.suppliedServers ?? [])
      servers.set(name, { name, evidence: "supplied" });
    for (const s of r?.nativeServers ?? [])
      servers.set(s.name, { ...s, evidence: "native" });
    return {
      sessionId,
      requestId: r?.id,
      checkedAt: new Date().toISOString(),
      nativeReported: !!r?.nativeTools,
      tools: [...tools].map(([name, evidence]) => ({ name, evidence })),
      servers: [...servers.values()],
    };
  }
}
function names(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((v) => (typeof v === "string" ? v : v?.name))
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.slice(0, 200))
    : [];
}
function failureStage(row: RequestLog): string {
  return row.milestones.dispatched === undefined
    ? "preparation"
    : row.milestones.runtimeReady === undefined
      ? "native_startup"
      : row.milestones.firstEvent === undefined
        ? "model_wait"
        : "execution";
}
