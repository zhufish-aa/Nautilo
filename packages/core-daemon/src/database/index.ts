import { RuntimeConnectionRepository } from "./runtime-connection-repository.js";
import { DatabaseConnection } from "./connection.js";
import { migrateDatabase } from "./migrations.js";
import { AgentRepository } from "./agent-repository.js";
import { EventRepository } from "./event-repository.js";
import { ProjectRepository } from "./project-repository.js";
import { RunRepository } from "./run-repository.js";
import { SessionRepository } from "./session-repository.js";
import { TaskRepository } from "./task-repository.js";
import { TeamRepository } from "./team-repository.js";
import { ArtifactRepository } from "./artifact-repository.js";
import { ProjectRunRepository } from "./project-run-repository.js";
import { VerificationRepository } from "./verification-repository.js";
import { PolicyRepository } from "./policy-repository.js";
import { ApprovalRepository } from "./approval-repository.js";
import { AuditRepository } from "./audit-repository.js";
import { CredentialRepository } from "./credential-repository.js";
import { CapabilityRepository } from "./capability-repository.js";
import { RequestLogRepository } from "./request-log-repository.js";
import { JsonRepository } from "./json-repository.js";
import type { ConfigurationPreset, IntegrationSettings, ResourceSyncPlan } from "@agenthub/schemas";

/** Composition root for persistence. It exposes repositories, not SQL. */
export class Database {
  readonly connection: DatabaseConnection;
  readonly projects: ProjectRepository;
  readonly agents: AgentRepository;
  readonly runtimeConnections: RuntimeConnectionRepository;
  readonly teams: TeamRepository;
  readonly projectRuns: ProjectRunRepository;
  readonly sessions: SessionRepository;
  readonly tasks: TaskRepository;
  readonly runs: RunRepository;
  readonly events: EventRepository;
  readonly artifacts: ArtifactRepository;
  readonly verifications: VerificationRepository;
  readonly policies: PolicyRepository;
  readonly approvals: ApprovalRepository;
  readonly audit: AuditRepository;
  readonly credentials: CredentialRepository;
  readonly capabilities: CapabilityRepository;
  readonly requestLogs: RequestLogRepository;
  readonly resourceTransactions: JsonRepository<ResourceSyncPlan>;
  readonly configurationPresets: JsonRepository<ConfigurationPreset>;
  readonly integrationSettings: JsonRepository<IntegrationSettings>;
  constructor(filePath: string) {
    this.connection = new DatabaseConnection(filePath);
    migrateDatabase(this.connection.raw);
    // One-time compaction: drop verbatim message deltas journaled by older
    // builds (writes are coalesced now, and message text also lives in the
    // final agent.message event). Thinking deltas are NOT purged here — they
    // are the only record of past reasoning. Best-effort: VACUUM just fails
    // while another daemon holds the database open.
    const purged = this.connection.raw
      .prepare("DELETE FROM runtime_events WHERE json_extract(data, '$.type') = 'agent.message_delta'")
      .run().changes;
    if (purged > 50_000) {
      try { this.connection.raw.exec("VACUUM"); } catch { /* another daemon holds the lock */ }
    }
    this.projects = new ProjectRepository(this.connection.raw);
    this.agents = new AgentRepository(this.connection.raw);
    this.runtimeConnections = new RuntimeConnectionRepository(this.connection.raw);
    this.teams = new TeamRepository(this.connection.raw);
    this.projectRuns = new ProjectRunRepository(this.connection.raw);
    this.sessions = new SessionRepository(this.connection.raw);
    this.tasks = new TaskRepository(this.connection.raw);
    this.runs = new RunRepository(this.connection.raw);
    this.events = new EventRepository(this.connection.raw);
    this.artifacts = new ArtifactRepository(this.connection.raw);
    this.verifications = new VerificationRepository(this.connection.raw);
    this.policies = new PolicyRepository(this.connection.raw);
    this.approvals = new ApprovalRepository(this.connection.raw);
    this.audit = new AuditRepository(this.connection.raw);
    this.credentials = new CredentialRepository(this.connection.raw);
    this.capabilities = new CapabilityRepository(this.connection.raw);
    this.requestLogs = new RequestLogRepository(this.connection.raw);
    this.resourceTransactions = new JsonRepository(this.connection.raw,"resource_transactions");
    this.configurationPresets = new JsonRepository(this.connection.raw,"configuration_presets");
    this.integrationSettings = new JsonRepository(this.connection.raw,"integration_settings");
  }
  close(): void { this.connection.close(); }
}
