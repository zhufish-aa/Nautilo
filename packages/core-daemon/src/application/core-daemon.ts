import { homedir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry } from "../adapters/index.js";
import { Database } from "../database/index.js";
import { IpcGateway } from "../ipc-gateway.js";
import { EventService } from "../runtime/event-service.js";
import { RunService } from "../runtime/run-service.js";
import { registerIpcHandlers } from "./ipc-handlers.js";
import { ProjectService } from "./project-service.js";
import { SessionService } from "./session-service.js";
import { ProjectionService } from "../runtime/projection-service.js";
import { MaintenanceService } from "../runtime/maintenance-service.js";
import { OrchestrationService } from "./orchestration-service.js";
import { AgentService } from "./agent-service.js";
import { TeamService } from "./team-service.js";
import { GitWorkflowService } from "../runtime/git-workflow-service.js";
import {
  ApprovalService,
  CommandPolicyService,
  CredentialService,
  EnvironmentPolicyService,
  RedactionService
} from "../runtime/security/index.js";
import { AuditService, DiagnosticsService, MetricsService } from "../runtime/observability/index.js";
import { RecoveryService } from "../runtime/recovery-service.js";
import { EventSubscriptionService } from "../runtime/event-subscription-service.js";
import { SlashCommandService } from "./slash-commands/index.js";
import { CapabilityService } from "./capability-service.js";
import { CapabilityImportService } from "./capability-import/index.js";
import { InteractionService } from "./interaction-service.js";
import { MainAgentRuntimeToolProvider } from "../runtime/orchestration/index.js";
import { PluginService } from "../runtime/plugins/plugin-service.js";
import { CheckpointService } from "../runtime/checkpoint-service.js";

export interface CoreDaemonOptions { dataDir?: string; databasePath?: string; worktreeRoot?: string; enableGitWorkflows?: boolean; }

/** Composition root only: construction and lifecycle, no business rules. */
export class CoreDaemon {
  private stopped = false;
  readonly database: Database;
  readonly adapters: AdapterRegistry;
  readonly gateway: IpcGateway;
  readonly events: EventService;
  readonly runs: RunService;
  readonly projects: ProjectService;
  readonly agents: AgentService;
  readonly teams: TeamService;
  readonly sessions: SessionService;
  readonly projections: ProjectionService;
  readonly maintenance: MaintenanceService;
  readonly orchestration: OrchestrationService;
  readonly gitWorkflows?: GitWorkflowService;
  readonly credentials: CredentialService;
  readonly redaction: RedactionService;
  readonly environment: EnvironmentPolicyService;
  readonly commandPolicies: CommandPolicyService;
  readonly approvals: ApprovalService;
  readonly audit: AuditService;
  readonly metrics: MetricsService;
  readonly diagnostics: DiagnosticsService;
  readonly recovery: RecoveryService;
  readonly subscriptions: EventSubscriptionService;
  readonly slashCommands: SlashCommandService;
  readonly capabilities: CapabilityService;
  readonly capabilityImports: CapabilityImportService;
  readonly interactions: InteractionService;
  readonly plugins: PluginService;
  readonly checkpoints: CheckpointService;

  constructor(options: CoreDaemonOptions = {}) {
    const dataDir = options.dataDir ?? join(homedir(), ".agenthub");
    this.database = new Database(options.databasePath ?? join(dataDir, "agenthub.sqlite"));
    this.adapters = new AdapterRegistry();
    this.gateway = new IpcGateway();
    this.credentials = new CredentialService(this.database, dataDir, this.adapters);
    this.redaction = new RedactionService(() => this.credentials.secretValues());
    this.environment = new EnvironmentPolicyService();
    this.commandPolicies = new CommandPolicyService(this.database);
    this.approvals = new ApprovalService(this.database);
    this.audit = new AuditService(this.database, this.redaction);
    this.events = new EventService(this.database, this.redaction);
    this.runs = new RunService(
      this.database,
      this.adapters,
      this.events,
      this.credentials,
      this.environment,
      this.commandPolicies,
      this.approvals,
      this.redaction,
      this.audit
    );
    this.projects = new ProjectService(this.database);
    this.agents = new AgentService(this.database, this.adapters, this.credentials, this.environment);
    this.teams = new TeamService(this.database);
    this.sessions = new SessionService(this.database, this.runs);
    this.projections = new ProjectionService(this.database);
    this.maintenance = new MaintenanceService(this.database);
    this.gitWorkflows = options.enableGitWorkflows === false
      ? undefined
      : new GitWorkflowService(this.database, this.events, options.worktreeRoot ?? join(dataDir, "worktrees"), this.redaction);
    this.orchestration = new OrchestrationService(this.database, this.runs, this.events, this.gitWorkflows, this.approvals);
    this.runs.setRuntimeToolProvider(new MainAgentRuntimeToolProvider(this.database, this.orchestration));
    this.metrics = new MetricsService(this.database);
    this.diagnostics = new DiagnosticsService(this.database, this.audit, this.metrics, this.redaction, dataDir);
    this.recovery = new RecoveryService(this.database, this.audit);
    this.subscriptions = new EventSubscriptionService(this.events);
    this.slashCommands = new SlashCommandService(this.database, this.agents, this.audit, this.runs);
    this.capabilities = new CapabilityService(this.database);
    this.capabilityImports = new CapabilityImportService(this.capabilities);
    this.interactions = new InteractionService(this.database, this.events);
    this.runs.setInteractionService(this.interactions);
    this.plugins = new PluginService(dataDir, this.adapters);
    this.checkpoints = new CheckpointService(this.database, dataDir, this.events);
    this.runs.setCheckpointService(this.checkpoints);
    this.recovery.recoverInterrupted();
    this.gateway.setObserver((request, response) => {
      this.audit.ipc(
        request.method,
        request.input,
        response.ok ? "success" : response.error?.code === "COMMAND_BLOCKED" ? "denied" : "failure",
        response.ok ? undefined : response.error
      );
    });
    registerIpcHandlers(this.gateway, this);
  }
  health(): { service: "core-daemon"; status: "ok"; version: string } { return { service: "core-daemon", status: "ok", version: "0.1.0" }; }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.gateway.stop();
    this.database.close();
  }
}
