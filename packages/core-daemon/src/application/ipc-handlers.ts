import { IpcGateway } from "../ipc-gateway.js";
import { Database } from "../database/index.js";
import { AdapterRegistry } from "../adapters/index.js";
import { EventService } from "../runtime/event-service.js";
import { RunService } from "../runtime/run-service.js";
import { ProjectService } from "./project-service.js";
import { SessionService } from "./session-service.js";
import { CoreError } from "../errors.js";
import { OrchestrationService } from "./orchestration-service.js";
import { AgentService } from "./agent-service.js";
import { TeamService } from "./team-service.js";
import { ApprovalService, CommandPolicyService, CredentialService } from "../runtime/security/index.js";
import { AuditService, DiagnosticsService, MetricsService } from "../runtime/observability/index.js";
import { RecoveryService } from "../runtime/recovery-service.js";
import { EventSubscriptionService } from "../runtime/event-subscription-service.js";
import { SlashCommandService } from "./slash-commands/index.js";

export interface ApplicationServices {
  database: Database;
  adapters: AdapterRegistry;
  events: EventService;
  runs: RunService;
  projects: ProjectService;
  agents: AgentService;
  teams: TeamService;
  sessions: SessionService;
  orchestration: OrchestrationService;
  commandPolicies: CommandPolicyService;
  approvals: ApprovalService;
  credentials: CredentialService;
  audit: AuditService;
  metrics: MetricsService;
  diagnostics: DiagnosticsService;
  recovery: RecoveryService;
  subscriptions: EventSubscriptionService;
  slashCommands: SlashCommandService;
}
export function registerIpcHandlers(gateway: IpcGateway, services: ApplicationServices): void {
  gateway.register("health.get", async () => ({ status: "ok", version: "0.1.0" }));
  gateway.register("project.list", async () => services.projects.list());
  gateway.register("project.add", async (input) => services.projects.add(input));
  gateway.register("project.upsert", async (input) => { services.database.projects.save(input, new Date().toISOString()); return input; });
  gateway.register("project.remove", async ({ projectId }) => services.projects.remove(projectId));
  gateway.register("project.scan", async ({ projectId }) => services.projects.scan(projectId));
  gateway.register("agent.list", async () => services.agents.list());
  gateway.register("agent.upsert", async (input) => services.agents.upsert(input));
  gateway.register("provider.detect", async (input) => services.agents.detect(input.providerId, input.executable));
  gateway.register("provider.models", async (input) => services.agents.listModels(input.providerId, input.executable, input.agentInstanceId));
  gateway.register("team.list", async () => services.teams.list());
  gateway.register("team.get", async ({ teamId }) => services.teams.get(teamId));
  gateway.register("team.upsert", async (input) => services.teams.upsert(input));
  gateway.register("team.remove", async ({ teamId }) => services.teams.remove(teamId));
  gateway.register("projectRun.list", async ({ projectId }) => services.database.projectRuns.list(projectId));
  gateway.register("projectRun.get", async ({ projectRunId }) => services.orchestration.get(projectRunId));
  gateway.register("orchestration.start", async (input) => services.orchestration.start(input));
  gateway.register("orchestration.resolveDelegation", async ({ projectRunId, approved, scope }) => services.orchestration.resolveDelegation(projectRunId, approved, scope));
  gateway.register("orchestration.resolveMerge", async ({ projectRunId, approved, scope }) => services.orchestration.resolveMerge(projectRunId, approved, scope));
  gateway.register("orchestration.recover", async ({ projectRunId, memberId, mode }) => services.orchestration.recover(projectRunId, memberId, mode));
  gateway.register("orchestration.cancel", async ({ projectRunId }) => services.orchestration.cancel(projectRunId));
  gateway.register("session.list", async (input) => services.sessions.list(input));
  gateway.register("session.get", async ({ sessionId }) => services.sessions.get(sessionId));
  gateway.register("session.create", async (input) => services.sessions.create(input));
  gateway.register("session.upsert", async (input) => services.sessions.upsert(input));
  gateway.register("session.send", async (input) => services.sessions.send(input));
  gateway.register("slashCommand.list", async ({ sessionId }) => services.slashCommands.list(sessionId));
  gateway.register("slashCommand.execute", async (input) => services.slashCommands.execute(input.sessionId, input.commandId, input.argument));
  gateway.register("slashCommand.continue", async (input) => services.slashCommands.continue(input));
  gateway.register("run.cancel", async ({ runId }) => { await services.runs.cancel(runId); return { cancelled: true }; });
  gateway.register("run.list", async ({ sessionId, projectRunId }) => services.database.runs.list().filter((run) =>
    (!sessionId || run.sessionId === sessionId) && (!projectRunId || run.projectRunId === projectRunId)
  ));
  gateway.register("task.list", async ({ projectRunId }) => services.database.tasks.list(projectRunId));
  gateway.register("artifact.list", async (input) => services.database.artifacts.list(input));
  gateway.register("verification.list", async ({ projectRunId, taskId }) => services.database.verifications.list(projectRunId, taskId));
  gateway.register("run.get", async ({ runId }) => services.database.runs.get(runId) ?? notFound("run", runId));
  gateway.register("policy.list", async () => services.commandPolicies.list());
  gateway.register("policy.upsert", async (policy) => services.commandPolicies.save(policy));
  gateway.register("policy.evaluate", async (input) => services.commandPolicies.evaluate(input));
  gateway.register("approval.list", async (input) => services.approvals.list(input));
  gateway.register("approval.resolve", async ({ approvalId, decision, scope }) => services.approvals.resolve(approvalId, decision, scope));
  gateway.register("credential.set", async ({ agentInstanceId, apiKey, envName }) => {
    services.credentials.set(agentInstanceId, { apiKey, envName });
    return { stored: true } as const;
  });
  gateway.register("credential.status", async ({ agentInstanceId }) => ({ stored: services.credentials.has(agentInstanceId) }));
  gateway.register("credential.delete", async ({ agentInstanceId }) => ({ removed: services.credentials.remove(agentInstanceId) }));
  gateway.register("recovery.list", async () => services.recovery.list());
  gateway.register("audit.list", async (input) => services.audit.list(input));
  gateway.register("metrics.get", async ({ projectId }) => services.metrics.snapshot(projectId));
  gateway.register("diagnostics.export", async (input) => services.diagnostics.export(input));
  gateway.register("event.subscribe", async ({ projectRunId, sessionId }) => services.subscriptions.subscribe({ projectRunId, sessionId }));
  gateway.register("event.replay", async ({ subscriptionId, afterSequence }) => services.subscriptions.replay(subscriptionId, afterSequence));
  gateway.register("event.wait", async ({ subscriptionId, afterSequence, timeoutMs }) => services.subscriptions.wait(subscriptionId, afterSequence, timeoutMs));
}
function notFound(resource: string, id: string): never { throw new CoreError("IPC_NOT_FOUND", { resource, id }); }
