import { assistantModelStep } from "./assistant-model.js";
import { registerRemoteAccess } from "./remote-access.js";
import { assistantRecords, saveAssistantRecord, assistantSessions, assistantExcerpts } from "../database/assistant-reads.js";
import { TerminalService } from "../runtime/terminal-service.js";
import { SourceControl } from "../runtime/source-control.js";
import { sourceControlDirectory } from "./source-control.js";
import { ConnectionService } from "./connection-service.js";
import { ConnectionImportService } from "./connection-import/service.js";
import { ResourceService } from "./resource-service.js";
import { IntegrationService } from "./integration-service.js";
import { projectPollHealIds, projectPollLastSequence, readProjectPoll } from "../database/project-poll.js";
import { IpcGateway } from "../ipc-gateway.js";
import { join } from "node:path";
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
import { CapabilityService } from "./capability-service.js";
import { CapabilityImportService } from "./capability-import/index.js";
import { InteractionService } from "./interaction-service.js";
import type { PluginService } from "../runtime/plugins/plugin-service.js";
import { readWorkspaceArtifact } from "./artifact-read.js";
import { seedBuiltinCapabilities } from "./builtin-capabilities.js";
import { diagnoseMcp } from "../runtime/service-probe.js";
import { RedactionService } from "../runtime/security/redaction-service.js";

export interface ApplicationServices {
  database: Database;
  adapters: AdapterRegistry;
  events: EventService;
  runs: RunService;
  terminals: TerminalService;
  sourceControl: SourceControl;
  projects: ProjectService;
  agents: AgentService;
  connections: ConnectionService;
  connectionImports: ConnectionImportService;
  resources: ResourceService;
  integrations: IntegrationService;
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
  capabilities: CapabilityService;
  capabilityImports: CapabilityImportService;
  interactions: InteractionService;
  plugins: PluginService;
  dataDir: string;
}
export function registerIpcHandlers(gateway: IpcGateway, services: ApplicationServices): void {
  registerRemoteAccess(gateway);
  gateway.register("scm.status", async input => services.sourceControl.status(sourceControlDirectory(services.database,input)));
  gateway.register("scm.diff", async input => services.sourceControl.diff(sourceControlDirectory(services.database,input),input));
  gateway.register("scm.commit", async input => services.sourceControl.commitDetails(sourceControlDirectory(services.database,input),input));
  gateway.register("scm.commitDiff", async input => services.sourceControl.commitDiff(sourceControlDirectory(services.database,input),input));
  gateway.register("scm.history", async input => services.sourceControl.history(sourceControlDirectory(services.database,input),input));
  gateway.register("scm.file", async input => services.sourceControl.file(sourceControlDirectory(services.database,input),input));
  gateway.register("scm.save", async input => services.sourceControl.save(sourceControlDirectory(services.database,input),input));
  gateway.register("scm.mutate", async input => services.sourceControl.mutate(sourceControlDirectory(services.database,input),input));
  gateway.register("terminal.open", async ({sessionId, projectId, tabId = "default", restoreOnly, cols, rows}) => {
    const session = sessionId ? services.sessions.get(sessionId).session : undefined;
    const project = services.database.projects.get(projectId ?? session?.projectId ?? "");
    if (!project) throw new Error("Project not found");
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(tabId)) throw new Error("Invalid terminal tab identity");
    const scope = TerminalService.scope(sessionId, project.id);
    return services.terminals.open(JSON.stringify(["shell", scope, tabId]), session?.nativeWorkingDirectory ?? project.rootPath, cols, rows, {scope, tabId, restoreOnly});
  });
  gateway.register("terminal.list", async ({sessionId, projectId}) => services.terminals.list(TerminalService.scope(sessionId, projectId ?? "")));
  gateway.register("terminal.stop", async ({terminalId}) => services.terminals.stop(terminalId));
  gateway.register("terminal.read", async ({terminalId, cursor}) => services.terminals.read(terminalId, cursor));
  gateway.register("terminal.write", async ({terminalId, data}) => services.terminals.write(terminalId, data));
  gateway.register("terminal.resize", async ({terminalId, cols, rows}) => services.terminals.resize(terminalId, cols, rows));
  gateway.register("terminal.close", async input => "terminalId" in input ? services.terminals.close(input.terminalId) : services.terminals.closeTab(TerminalService.scope(input.sessionId,input.projectId ?? ""),input.tabId));
  gateway.register("terminal.status", async () => ({nativeActive:false}));
  gateway.register("terminal.native", async () => { throw new Error("原生会话交接需要使用 Rust 核心运行项目。"); });
  gateway.register("agent.runtimeCapabilities", async ({sessionId, agentInstanceId}) => {
    const session = sessionId ? services.sessions.get(sessionId).session : undefined;
    const agent = services.database.agents.get(agentInstanceId ?? session?.agentInstanceId ?? "");
    if (!agent) throw new Error("Agent not found");
    const adapter = services.adapters.find(agent.providerId);
    const reusable = agent.providerId === "codex" && !agent.baseArgs.length || agent.providerId === "opencode" && !agent.baseArgs.length;
    return {schemaVersion:1 as const,providerId:agent.providerId,evidence:{source:"adapter-contract" as const},
      session:{transport:"legacy-host",processReuse:reusable,resume:adapter?.supportsResume ? "native" as const : "unknown" as const},
      turn:{interrupt:"process" as const,steer:"queued" as const},interactions:{dialogs:[],nativeTerminal:false,unknownRequests:"visible-error" as const},
      resources:{nativeConfig:"unknown" as const,managedMcp:"unknown" as const,managedSkills:"unknown" as const}};
  });

  gateway.register("assistant.records", async input => assistantRecords(services.database.connection.raw, input));
  gateway.register("assistant.save", async input => saveAssistantRecord(services.database.connection.raw, input));
  gateway.register("assistant.modelStep", input => assistantModelStep(services, input));
  gateway.register("assistant.sessions", async input => assistantSessions(services.database.connection.raw, input));
  gateway.register("assistant.excerpts", async input => assistantExcerpts(services.database.connection.raw, input));
  gateway.register("connection.list", async () => services.connections.list());
  gateway.register("connection.scanNative", async () => services.connectionImports.scan());
  gateway.register("connection.importNative", async input => services.connectionImports.import(input));
  gateway.register("connection.get", async ({ connectionId, revision }) => services.connections.get(connectionId, revision));
  gateway.register("connection.gateway", async ({ connectionId, enabled }) => {
    services.integrations.setAccountRoute(connectionId, enabled);
    return services.connections.get(connectionId);
  });
  gateway.register("connection.upsert", async (input) => services.connections.upsert(input));
  gateway.register("connection.remove", async ({ connectionId }) => services.connections.remove(connectionId));
  gateway.register("connection.models", async (input) => services.connections.discover(input));
  const diagnosticRedaction = new RedactionService(() => services.credentials.secretValues());
  gateway.register("requestLog.list", async input => services.database.requestLogs.page(input));
  gateway.register("resource.inventory",async()=>services.resources.inventory());
  gateway.register("integration.get",async()=>services.integrations.get());
  gateway.register("integration.save",async input=>services.integrations.save(input));
  gateway.register("configuration.list",async()=>services.integrations.list());
  gateway.register("configuration.capture",async input=>services.integrations.capture(input.name));
  gateway.register("configuration.import",async input=>services.integrations.import(input.preset));
  gateway.register("configuration.export",async input=>services.integrations.export(input.presetId));
  gateway.register("configuration.remove",async input=>services.integrations.remove(input.presetId));
  gateway.register("configuration.preview",async input=>services.integrations.preview(input.presetId,input.replace));
  gateway.register("configuration.apply",async input=>services.integrations.apply(input.planId));
  gateway.register("resource.history",async()=>services.resources.history());
  gateway.register("resource.preview",async input=>services.resources.preview(input));
  gateway.register("resource.apply",async({planId})=>services.resources.apply(planId));
  gateway.register("resource.undo",async({planId})=>services.resources.apply(planId,true));
  gateway.register("session.tools", async ({ sessionId }) => services.runs.requestLogs.inventory(sessionId));
  gateway.register("connection.diagnose", async input => diagnosticRedaction.value(await services.connections.diagnose(input)));
  gateway.register("health.get", async () => ({ status: "ok", version: "0.1.0", features: {sourceControl:1,sourceControlHistory:1,sourceControlHistoryPaging:1,sourceControlEditing:1,terminalTabs:1} }));
  gateway.register("project.list", async () => services.projects.list());
  gateway.register("project.add", async (input) => services.projects.add(input));
  gateway.register("project.upsert", async (input) => { services.database.projects.save(input, new Date().toISOString()); return input; });
  gateway.register("project.remove", async ({ projectId }) => services.projects.remove(projectId));
  gateway.register("project.scan", async ({ projectId }) => services.projects.scan(projectId));
  gateway.register("agent.list", async () => services.agents.list());
  gateway.register("agent.upsert", async (input) => services.agents.upsert(input));
  gateway.register("provider.detect", async (input) => services.agents.detect(input.providerId, input.executable));
  // The renderer builds its whole provider UI (detection page, instance
  // editor, permission mode picker) from these descriptors — built-ins and
  // loaded plugins alike.
  gateway.register("provider.catalog", async () => services.adapters.list().map(adapter => ({
    ...adapter.descriptor,
    harnessPlugins: services.plugins.managerFor(adapter.descriptor.providerId) ? true : undefined
  })));
  gateway.register("plugin.list", async () => services.plugins.list());
  gateway.register("plugin.registry", async (input) => services.plugins.fetchRegistry(input.registryUrl));
  gateway.register("plugin.install", async (input) => {
    if (input.source.kind === "local") return services.plugins.installLocal(input.source.path);
    if (input.source.kind === "registry") return services.plugins.installFromRegistry(input.source.pluginId, input.source.registryUrl);
    throw new CoreError("IPC_INVALID_REQUEST", { field: "source.kind" });
  });
  gateway.register("plugin.uninstall", async ({ pluginId }) => services.plugins.uninstall(pluginId));
  gateway.register("plugin.setEnabled", async ({ pluginId, enabled }) => services.plugins.setEnabled(pluginId, enabled));
  gateway.register("capability.list", async () => {
    // Lazy seed: keeps CoreDaemon construction side-effect-free (tests never
    // touch the real provider skill dirs) while the real app seeds on boot,
    // since the renderer lists capabilities at startup. The bundled Python
    // toolchain is materialized under <dataDir>/builtin-skills.
    seedBuiltinCapabilities(services.capabilities, join(services.dataDir, "builtin-skills"));
    return services.capabilities.list();
  });
  gateway.register("capability.upsert", async (input) => services.capabilities.upsert(input));
  gateway.register("capability.remove", async ({ capabilityId }) => services.capabilities.remove(capabilityId));
  gateway.register("capability.diagnose", async ({ capabilityId }) => {
    const capability = services.capabilities.list().find(item => item.id === capabilityId);
    if (!capability) throw new CoreError("IPC_NOT_FOUND",{entity:"capability",id:capabilityId});
    return diagnosticRedaction.value(await diagnoseMcp(capability));
  });
  gateway.register("capability.parseImport", async (input) => services.capabilityImports.parse(input));
  gateway.register("capability.discoverMcp", async (input) => services.capabilityImports.discoverMcp(input));
  gateway.register("capability.scanSkills", async ({ dir }) => services.capabilityImports.scanSkills({ dir }));
  gateway.register("capability.importMany", async (input) => services.capabilityImports.importMany(input));
  gateway.register("provider.models", async (input) => services.agents.listModels(input.providerId, input.executable, input.agentInstanceId, {
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    apiType: input.apiType
  }));
  gateway.register("team.list", async () => services.teams.list());
  gateway.register("team.get", async ({ teamId }) => services.teams.get(teamId));
  gateway.register("team.upsert", async (input) => services.teams.upsert(input));
  gateway.register("team.remove", async ({ teamId }) => services.teams.remove(teamId));
  gateway.register("projectRun.list", async ({ projectId }) => services.database.projectRuns.list(projectId));
  gateway.register("projectRun.poll", async (input) => {
    const collect = (sessionId: string) => {
      services.interactions.healOrphaned(sessionId);
      services.sessions.healFollowUps(sessionId);
      const afterSequence = projectPollLastSequence(services.database, sessionId);
      return { sessionId, afterSequence, items: services.sessions.followUpList({ sessionId }).items,
        interactions: services.interactions.list({ sessionId, status: "pending" }) };
    };
    const followUps = projectPollHealIds(services.database, input).map(collect);
    let snapshot = readProjectPoll(services.database, input, followUps);
    // A second writer may truncate between preflight healing and the snapshot.
    // Repair only newly-reset scopes, then take one new consistent snapshot.
    if (!("fallback" in snapshot)) {
      const missing = snapshot.feeds.filter((feed) => feed.reset && !followUps.some((entry) => entry.sessionId === feed.sessionId));
      if (missing.length) {
        followUps.push(...missing.map((feed) => collect(feed.sessionId)));
        snapshot = readProjectPoll(services.database, input, followUps);
        if (!("fallback" in snapshot) && snapshot.feeds.some((feed) => feed.reset && !followUps.some((entry) => entry.sessionId === feed.sessionId))) {
          throw new CoreError("IPC_INTERNAL_ERROR", { reason: "Project changed during snapshot recovery; retry" });
        }
      }
    }
    return snapshot;
  });
  gateway.register("projectRun.get", async ({ projectRunId }) => services.orchestration.get(projectRunId));
  gateway.register("orchestration.start", async (input) => services.orchestration.start(input));
  gateway.register("orchestration.resolveDelegation", async ({ projectRunId, approved, scope }) => services.orchestration.resolveDelegation(projectRunId, approved, scope));
  gateway.register("orchestration.resolveMerge", async ({ projectRunId, approved, scope }) => services.orchestration.resolveMerge(projectRunId, approved, scope));
  gateway.register("orchestration.recover", async ({ projectRunId, memberId, mode }) => services.orchestration.recover(projectRunId, memberId, mode));
  gateway.register("orchestration.cancel", async ({ projectRunId }) => services.orchestration.cancel(projectRunId));
  gateway.register("session.list", async (input) => services.sessions.list(input));
  gateway.register("session.historyBatch", async ({ items }) => services.database.sessions.historyBatch(items));
  gateway.register("session.history", async ({ sessionId, cursor }) => services.database.sessions.history(sessionId, cursor));
  gateway.register("session.get", async ({ sessionId }) => services.sessions.get(sessionId));
  gateway.register("session.generateTitle", async ({ sessionId }) => services.runs.generateSessionTitle(sessionId));
  gateway.register("session.create", async (input) => services.sessions.create(input));
  gateway.register("session.upsert", async (input) => services.sessions.upsert(input));
  gateway.register("session.delete", async (input) => {
    const result = services.sessions.delete(input);
    for (const id of result.sessionIds) services.terminals.closeScope(TerminalService.scope(id,""));
    return result;
  });
  gateway.register("session.followUp", async (input) => services.sessions.followUp(input));
  gateway.register("session.followUp.list", async (input) => services.sessions.followUpList(input));
  gateway.register("session.followUp.cancel", async (input) => services.sessions.followUpCancel(input));
  gateway.register("session.followUp.steer", async (input) => services.sessions.followUpSteer(input));
  gateway.register("provider.modes", async (input) => services.agents.listModes(input.agentInstanceId));
  gateway.register("provider.harnessPlugins", async ({agentInstanceId, connectionId, operation}) =>
    services.agents.harnessPlugins(agentInstanceId, operation, id => services.plugins.managerFor(id), connectionId));
  gateway.register("session.send", async (input) => services.sessions.send(input));
  gateway.register("slashCommand.list", async ({ sessionId }) => services.slashCommands.list(sessionId));
  gateway.register("slashCommand.execute", async (input) => services.slashCommands.execute(input.sessionId, input.commandId, input.argument));
  gateway.register("slashCommand.continue", async (input) => services.slashCommands.continue(input));
  gateway.register("run.cancel", async ({ runId }) => { await services.runs.cancel(runId); return { cancelled: true }; });
  gateway.register("run.list", async ({ sessionId, projectRunId }) => services.database.runs.list().filter((run) =>
    (!sessionId || run.sessionId === sessionId) && (!projectRunId || run.projectRunId === projectRunId)
  ));
  gateway.register("task.list", async ({ projectRunId }) => services.database.tasks.list(projectRunId));
  gateway.register("artifact.changes", async (input) => services.database.artifacts.changes(input));
  gateway.register("artifact.list", async (input) => services.database.artifacts.list(input));
  gateway.register("artifact.read", async (input) => readWorkspaceArtifact(services.database, input));
  gateway.register("verification.list", async ({ projectRunId, taskId }) => services.database.verifications.list(projectRunId, taskId));
  gateway.register("run.get", async ({ runId }) => services.database.runs.get(runId) ?? notFound("run", runId));
  gateway.register("policy.list", async () => services.commandPolicies.list());
  gateway.register("policy.upsert", async (policy) => services.commandPolicies.save(policy));
  gateway.register("policy.evaluate", async (input) => services.commandPolicies.evaluate(input));
  gateway.register("approval.list", async (input) => services.approvals.list(input));
  gateway.register("approval.resolve", async ({ approvalId, decision, scope }) => {
    const records = services.approvals.resolveMany(approvalId, decision, scope);
    for (const record of records) {
      const session = record.sessionId ? services.database.sessions.get(record.sessionId) : undefined;
      if (session) services.events.appendForSession(session, { projectRunId: record.projectRunId, taskId: record.taskId }, "approval.resolved", { approvalId: record.id, decision, scope });
    }
    return records[0];
  });
  gateway.register("interaction.list", async (input) => services.interactions.list(input));
  gateway.register("interaction.respond", async ({ interactionId, outcome, optionId, answers }) =>
    services.interactions.respond(interactionId, { outcome, optionId, answers }));
  gateway.register("credential.set", async ({ agentInstanceId, apiKey, envName }) => {
    if (agentInstanceId.startsWith("connection:")) throw new CoreError("IPC_INVALID_REQUEST", { field: "agentInstanceId", reason: "Connection credentials are revisioned; use connection.upsert" });
    services.credentials.set(agentInstanceId, { apiKey, envName });
    return { stored: true } as const;
  });
  gateway.register("credential.status", async ({ agentInstanceId }) => ({ stored: services.credentials.has(agentInstanceId) }));
  gateway.register("credential.delete", async ({ agentInstanceId }) => {
    if (agentInstanceId.startsWith("connection:")) throw new CoreError("IPC_INVALID_REQUEST", { field: "agentInstanceId", reason: "Connection credentials are revisioned; use connection.upsert" });
    return { removed: services.credentials.remove(agentInstanceId) };
  });
  gateway.register("recovery.list", async () => services.recovery.list());
  gateway.register("audit.list", async (input) => services.audit.list(input));
  gateway.register("metrics.get", async ({ projectId }) => services.metrics.snapshot(projectId));
  gateway.register("diagnostics.export", async (input) => services.diagnostics.export(input));
  gateway.register("event.subscribe", async ({ projectRunId, sessionId }) => services.subscriptions.subscribe({ projectRunId, sessionId }));
  // A full replay re-reads the journal; cancel orphaned interaction requests
  // first so stale pending cards don't resurrect in the renderer.
  const healBeforeFullReplay = (subscriptionId: string, afterSequence: number): void => {
    if (afterSequence !== 0) return;
    const sessionId = services.subscriptions.sessionScope(subscriptionId);
    if (!sessionId) return;
    services.interactions.healOrphaned(sessionId);
    services.sessions.healFollowUps(sessionId);
  };
  gateway.register("event.replay", async ({ subscriptionId, afterSequence }) => {
    healBeforeFullReplay(subscriptionId, afterSequence);
    return services.subscriptions.replay(subscriptionId, afterSequence);
  });
  gateway.register("event.wait", async ({ subscriptionId, afterSequence, timeoutMs }) => {
    healBeforeFullReplay(subscriptionId, afterSequence);
    return services.subscriptions.wait(subscriptionId, afterSequence, timeoutMs);
  });
}
function notFound(resource: string, id: string): never { throw new CoreError("IPC_NOT_FOUND", { resource, id }); }
