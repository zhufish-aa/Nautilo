//! Composition root — port of application/core-daemon.ts.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::database::Database;
use crate::errors::CoreResult;
use crate::runtime::{EventService, EventSubscriptionService};
use crate::ipc_gateway::Router;
use crate::runtime::security::{CredentialService, RedactionService};
use crate::adapters::registry::AdapterRegistry;
use crate::application::{
    AgentService, CapabilityService, InteractionService, ProjectService, SessionService, TeamService,
};
use crate::runtime::run_service::RunService;
use crate::application::slash_commands::SlashCommandService;
use crate::application::capability_import::CapabilityImportService;
use crate::application::orchestration_service::OrchestrationService;
use crate::runtime::git_workflow_service::GitWorkflowService;
use crate::runtime::orchestration::runtime_tool_provider::MainAgentRuntimeToolProvider;
use crate::runtime::verification_engine::VerificationEngine;
use crate::runtime::plugins::PluginService;
use crate::runtime::observability::{AuditService, DiagnosticsService, MetricsService};
use crate::runtime::recovery_service::RecoveryService;
use crate::runtime::security::{ApprovalService, CommandPolicyService};

pub struct Daemon {
    pub data_dir: PathBuf,
    pub remote: Arc<crate::runtime::remote::RemoteService>,
    pub db: Arc<Mutex<Database>>,
    pub redaction: RedactionService,
    pub credentials: Arc<CredentialService>,
    pub events: Arc<EventService>,
    pub subscriptions: Arc<EventSubscriptionService>,
    pub projects: ProjectService,
    pub teams: TeamService,
    pub capabilities: CapabilityService,
    pub resources: crate::application::resource_service::ResourceService,
    pub integrations: crate::application::integration_service::IntegrationService,
    pub audit: Arc<AuditService>,
    pub metrics: MetricsService,
    pub command_policies: std::sync::Arc<CommandPolicyService>,
    pub approvals: std::sync::Arc<ApprovalService>,
    pub sessions: SessionService,
    pub adapters: AdapterRegistry,
    pub runs: std::sync::Arc<RunService>,
    pub terminals: Arc<crate::runtime::terminal_service::TerminalService>,
    pub source_control: crate::runtime::source_control::SourceControl,
    pub agents: AgentService,
    pub connections: crate::application::ConnectionService,
    pub connection_imports: crate::application::connection_import::ConnectionImportService,
    pub interactions: std::sync::Arc<InteractionService>,
    pub slash_commands: SlashCommandService,
    pub capability_imports: CapabilityImportService,
    pub orchestration: std::sync::Arc<OrchestrationService>,
    pub plugins: PluginService,
    pub recovery: RecoveryService,
    pub diagnostics: DiagnosticsService,
}

impl Daemon {
    pub async fn new(data_dir: PathBuf) -> CoreResult<Arc<Self>> {
        let db = Arc::new(Mutex::new(Database::open(&data_dir.join("agenthub.sqlite"))?));
        let credentials = Arc::new(CredentialService::new(db.clone(), &data_dir));
        let redaction_credentials = credentials.clone();
        let redaction = RedactionService::new(Arc::new(move || redaction_credentials.secret_values()));
        let events = Arc::new(EventService::new(db.clone(), redaction.clone()));
        let subscriptions = Arc::new(EventSubscriptionService::new(events.clone()));
        let audit = AuditService::new(db.clone(), redaction.clone());
        let adapters = AdapterRegistry::with_builtins();
        let command_policies = std::sync::Arc::new(CommandPolicyService::new(db.clone())?);
        let approvals = std::sync::Arc::new(ApprovalService::new(db.clone()));
        let runs = RunService::new(
            db.clone(),
            adapters.clone(),
            events.clone(),
            credentials.clone(),
            command_policies.clone(),
            approvals.clone(),
            redaction.clone(),
            audit.clone(),
        );
        let interactions = std::sync::Arc::new(InteractionService::new(db.clone(), events.clone()));
        runs.set_interaction_service(interactions.clone());
        let terminals=Arc::new(crate::runtime::terminal_service::TerminalService::default());
        runs.set_terminal_service(terminals.clone());
        let sessions = SessionService::new(db.clone());
        sessions.set_run_pipeline(runs.clone(), events.clone());
        let agents = AgentService::new(db.clone(), adapters.clone(), credentials.clone());
        let git_workflows = std::sync::Arc::new(GitWorkflowService::new(
            db.clone(),
            events.clone(),
            &data_dir.join("worktrees").to_string_lossy(),
            VerificationEngine::new(db.clone(), redaction.clone(), command_policies.clone()),
        ));
        let recovery = RecoveryService::new(db.clone(), audit.clone(), events.clone());
        let diagnostics = DiagnosticsService::new(db.clone(), audit.clone(), std::sync::Arc::new(MetricsService::new(db.clone())), redaction.clone(), &data_dir);
        let connections = crate::application::ConnectionService::new(db.clone(), credentials.clone(), adapters.clone());
        let daemon = Arc::new(Self {
            remote: crate::runtime::remote::RemoteService::new(db.clone(), credentials.clone(), events.clone()),
            data_dir: data_dir.clone(),
            terminals,
            source_control: crate::runtime::source_control::SourceControl::default(),
            projects: ProjectService::new(db.clone()),
            teams: TeamService::new(db.clone()),
            capabilities: CapabilityService::new(db.clone()),
            resources: crate::application::resource_service::ResourceService::new(db.clone(),credentials.clone(),redaction.clone()),
            integrations: crate::application::integration_service::IntegrationService::new(db.clone(),credentials.clone(),adapters.clone()),
            metrics: MetricsService::new(db.clone()),
            command_policies: command_policies.clone(),
            approvals: approvals.clone(),
            sessions,
            slash_commands: SlashCommandService::new(db.clone(), std::sync::Arc::new(agents.clone()), audit.clone(), runs.clone()),
            capability_imports: CapabilityImportService::new(CapabilityService::new(db.clone())),
            orchestration: {
                let orchestration = OrchestrationService::new(
                    db.clone(),
                    runs.clone(),
                    events.clone(),
                    Some(git_workflows),
                    approvals.clone(),
                );
                runs.set_runtime_tool_provider(std::sync::Arc::new(MainAgentRuntimeToolProvider::new(
                    db.clone(),
                    orchestration.clone(),
                    credentials.clone(),
                )));
                orchestration
            },
            plugins: PluginService::new(&data_dir.clone(), adapters.clone()),
            connection_imports: crate::application::connection_import::ConnectionImportService::new(connections.clone(), credentials.clone()),
            connections,
            agents,
            adapters,
            runs,
            interactions,
            recovery,
            diagnostics,
            db,
            redaction,
            credentials,
            events,
            subscriptions,
            audit,
        });
        // Plugin scan runs before IPC so provider.catalog and runs see every
        // loadable plugin; then mark anything a previous daemon left in flight.
        daemon.plugins.load_all().await;
        daemon.runs.start_mcp_pool().map_err(|error| crate::errors::invalid("mcpPool", &error.to_string()))?;
        daemon.recovery.recover_interrupted()?;
        Ok(daemon)
    }

    /// Copies WAL frames back into the main database and truncates the WAL
    /// file. Without an idle checkpoint the WAL grows without bound (writers
    /// only append), which ballooned the data dir to 700MB+ while the main
    /// DB stayed at ~110MB. Best-effort: skip on lock contention/errors so a
    /// checkpoint never disturbs an active run.
    pub fn checkpoint_wal(&self) {
        if let Ok(db) = self.db.try_lock() {
            let _ = db.raw.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
    }

    pub fn router(self: &Arc<Self>) -> Router {
        let mut router = Router::default();

        // Read-only IPC (polling, hydration, listings) is not audited: it used
        // to record ~99.9% of all audit rows (600k+ event.wait rows alone) and
        // ballooned the database. Only failures and mutations keep a trail.
        const READ_ONLY_IPC: &[&str] = &[
            "remote.status",
            "scm.status", "scm.diff",
            "health.get",
            "terminal.read", "terminal.list", "terminal.write", "terminal.resize", "terminal.status", "agent.runtimeCapabilities",
            "project.list",
            "agent.list",
            "connection.list", "connection.get", "connection.models", "connection.scanNative",
            "team.list",
            "team.get",
            "capability.list",
            "resource.inventory", "resource.history", "requestLog.list", "session.tools", "integration.get", "configuration.list", "configuration.export",
            "policy.list",
            "approval.list",
            "credential.status",
            "audit.list",
            "metrics.get",
            "session.list",
            "session.get",
            "session.followUp.list",
            "run.list",
            "run.get",
            "task.list",
            "projectRun.list",
            "projectRun.get",
            "artifact.list",
            "verification.list",
            "provider.catalog",
            "provider.detect",
            "provider.models",
            "interaction.list",
            "plugin.list",
            "plugin.registry",
            "capability.parseImport",
            "capability.discoverMcp",
            "capability.scanSkills",
            "slashCommand.list",
            "artifact.read",
            "recovery.list",
            "diagnostics.export",
            "event.subscribe",
            "event.replay",
            "event.wait",
        ];
        let audit = self.audit.clone();
        router.set_observer(Arc::new(move |request, response| {
            let listing_plugins = request.method == "provider.harnessPlugins" && request.input.pointer("/operation/action").and_then(Value::as_str) == Some("list");
            if response.ok && (READ_ONLY_IPC.contains(&request.method.as_str()) || listing_plugins) {
                return;
            }
            let outcome = if response.ok {
                "success"
            } else if response.error.as_ref().is_some_and(|e| e.code == "COMMAND_BLOCKED") {
                "denied"
            } else {
                "failure"
            };
            let details = if response.ok { None } else { response.error.as_ref().map(|e| serde_json::to_value(e).unwrap_or(Value::Null)) };
            audit.ipc(&request.method, &request.input, outcome, details.as_ref());
        }));

        crate::application::ipc_handlers::register_handlers(&mut router, self);
        router
    }
}
