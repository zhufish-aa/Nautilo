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

/** Composition root for persistence. It exposes repositories, not SQL. */
export class Database {
  readonly connection: DatabaseConnection;
  readonly projects: ProjectRepository;
  readonly agents: AgentRepository;
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
  constructor(filePath: string) {
    this.connection = new DatabaseConnection(filePath);
    migrateDatabase(this.connection.raw);
    this.projects = new ProjectRepository(this.connection.raw);
    this.agents = new AgentRepository(this.connection.raw);
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
  }
  close(): void { this.connection.close(); }
}
