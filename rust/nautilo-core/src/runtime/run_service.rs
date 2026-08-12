//! Run pipeline — port of runtime/run-service.ts.
//! Owns provider turns: launch, event consumption, message persistence,
//! cancellation, steering, and per-session serialization.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use serde_json::{json, Map, Value};
use tokio::sync::watch;
use uuid::Uuid;

use crate::adapters::registry::AdapterRegistry;
use crate::adapters::{AdapterEvent, AdapterRun, AdapterStartRequest, TimeoutKind};
use crate::application::interaction_service::InteractionService;
use crate::application::session_context::{build_session_turn_context, TurnContextInput};
use crate::database::{Database, Repositories};
use crate::errors::{now_iso, CoreError, CoreResult, ErrorCode};
use crate::runtime::artifact_service::{artifact_input, ArtifactService};
use crate::runtime::event_service::EventService;
use crate::runtime::message_attachment_service::MessageAttachmentService;
use crate::runtime::orchestration::member_router::MemberRouter;
use crate::runtime::run_diff_collector as diff_collector;
use crate::runtime::run_workspace_snapshot::{capture_workspace_snapshot, WorkspaceSnapshot};
use crate::runtime::security::environment_policy::{build_environment, provider_environment_passthrough};
use crate::runtime::security::{ApprovalService, CommandPolicyService, CredentialService, RedactionService};
use crate::runtime::session_run_queue::SessionRunQueue;
use crate::runtime::subagent_detection::subagent_meta;
use crate::runtime::RuntimeToolProvider;
use crate::runtime::observability::AuditService;

const TERMINAL_RUN_STATUSES: [&str; 5] = ["completed", "failed", "timed_out", "crashed", "cancelled"];

pub struct RunCompletion {
    pub run: Value,
    pub messages: Vec<Value>,
    pub final_message: Option<String>,
}

struct ActiveRun {
    session_id: String,
    cancel: Box<dyn FnOnce() -> crate::adapters::BoxFuture<()> + Send>,
    steer: Option<Arc<dyn Fn(String) -> crate::adapters::BoxFuture<CoreResult<()>> + Send + Sync>>,
    project_run_id: Option<String>,
}

/// Shared context for one run launch — mirrors RunContext.
#[derive(Clone, Default)]
pub struct RunContext {
    pub project_run_id: Option<String>,
    pub task_id: Option<String>,
    pub member_id: Option<String>,
    pub message_kind: Option<String>,
    pub working_directory: Option<String>,
    pub local_image_paths: Option<Vec<String>>,
    pub synchronize_provider_context: bool,
    pub presentation: Option<String>,
    pub provider_command: Option<String>,
    pub runtime_tool_version: Option<i64>,
    pub context_window_override: Option<i64>,
    pub queue_key: Option<String>,
}

pub struct RunService {
    db: Arc<Mutex<Database>>,
    adapters: AdapterRegistry,
    events: Arc<EventService>,
    credentials: Arc<CredentialService>,
    command_policies: Arc<CommandPolicyService>,
    approvals: Arc<ApprovalService>,
    redaction: RedactionService,
    audit: Arc<AuditService>,
    artifacts: ArtifactService,
    session_queue: SessionRunQueue,
    runtime_tool_provider: RwLock<Option<Arc<dyn RuntimeToolProvider>>>,
    interactions: RwLock<Option<Arc<InteractionService>>>,
    active: Arc<Mutex<HashMap<String, ActiveRun>>>,
    output_tails: Arc<Mutex<HashMap<String, String>>>,
    message_buffers: Arc<Mutex<HashMap<String, HashMap<String, String>>>>,
    touched_files: Arc<Mutex<HashMap<String, HashMap<String, (String, String)>>>>,
    workspace_baselines: Arc<Mutex<HashMap<String, WorkspaceSnapshot>>>,
    completion_waiters: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Receiver<RunCompletionSnapshot>>>>,
}

/// Serializable view of a finished run (orchestration consumes it later).
#[derive(Clone)]
pub struct RunCompletionSnapshot {
    pub run: Value,
    pub final_message: Option<String>,
}

impl RunService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        db: Arc<Mutex<Database>>,
        adapters: AdapterRegistry,
        events: Arc<EventService>,
        credentials: Arc<CredentialService>,
        command_policies: Arc<CommandPolicyService>,
        approvals: Arc<ApprovalService>,
        redaction: RedactionService,
        audit: Arc<AuditService>,
    ) -> Arc<Self> {
        Arc::new(Self {
            artifacts: ArtifactService::new(db.clone()),
            db,
            adapters,
            events,
            credentials,
            command_policies,
            approvals,
            redaction,
            audit,
            session_queue: SessionRunQueue::default(),
            runtime_tool_provider: RwLock::new(None),
            interactions: RwLock::new(None),
            active: Arc::new(Mutex::new(HashMap::new())),
            output_tails: Arc::new(Mutex::new(HashMap::new())),
            message_buffers: Arc::new(Mutex::new(HashMap::new())),
            touched_files: Arc::new(Mutex::new(HashMap::new())),
            workspace_baselines: Arc::new(Mutex::new(HashMap::new())),
            completion_waiters: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn set_runtime_tool_provider(&self, provider: Arc<dyn RuntimeToolProvider>) {
        *self.runtime_tool_provider.write().unwrap() = Some(provider);
    }

    pub fn set_interaction_service(&self, interactions: Arc<InteractionService>) {
        *self.interactions.write().unwrap() = Some(interactions);
    }

    pub async fn cancel(&self, run_id: &str) -> CoreResult<()> {
        let active = self.active.lock().unwrap().remove(run_id);
        let existing = Repositories::new(&self.db.lock().unwrap().raw).runs().get(run_id)?;
        let Some(active) = active else {
            if let Some(existing) = existing {
                let status = existing.get("status").and_then(Value::as_str).unwrap_or("");
                if !TERMINAL_RUN_STATUSES.contains(&status) {
                    let mut updated = existing.as_object().cloned().unwrap_or_default();
                    updated.insert("status".to_string(), json!("cancelled"));
                    updated.insert("endedAt".to_string(), json!(now_iso()));
                    updated.insert("failureCode".to_string(), json!("RUN_CANCELLED"));
                    Repositories::new(&self.db.lock().unwrap().raw).runs().save(&Value::Object(updated))?;
                    let session_id = existing.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
                    self.update_session_status(&session_id, "idle");
                }
            }
            return Ok(());
        };
        if let Some(existing) = &existing {
            let mut updated = existing.as_object().cloned().unwrap_or_default();
            updated.insert("status".to_string(), json!("cancelling"));
            Repositories::new(&self.db.lock().unwrap().raw).runs().save(&Value::Object(updated))?;
        }
        (active.cancel)().await;
        // Resolve any pending provider approvals for this run right away.
        // Otherwise the plugin-side interaction handler stays parked on its
        // oneshot and the run's own stream never finalizes.
        if let Some(interactions) = self.interactions.read().unwrap().clone() {
            interactions.cancel_for_run(run_id);
        }
        let latest = Repositories::new(&self.db.lock().unwrap().raw).runs().get(run_id)?.or(existing);
        if let Some(latest) = latest {
            let mut updated = latest.as_object().cloned().unwrap_or_default();
            updated.insert("status".to_string(), json!("cancelled"));
            updated.insert("endedAt".to_string(), json!(now_iso()));
            updated.insert("failureCode".to_string(), json!("RUN_CANCELLED"));
            Repositories::new(&self.db.lock().unwrap().raw).runs().save(&Value::Object(updated))?;
            let session_id = latest.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
            self.update_session_status(&session_id, "idle");
            let mut audit_record = Map::new();
            audit_record.insert("actorType".to_string(), json!("system"));
            audit_record.insert("actorId".to_string(), json!("core-daemon"));
            audit_record.insert("action".to_string(), json!("run.cancelled"));
            audit_record.insert("resourceType".to_string(), json!("run"));
            audit_record.insert("resourceId".to_string(), json!(run_id));
            audit_record.insert("outcome".to_string(), json!("success"));
            self.audit.record(audit_record);
        }
        Ok(())
    }

    pub async fn cancel_project_run(&self, project_run_id: &str) -> CoreResult<()> {
        let run_ids: Vec<String> = self
            .active
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, active)| active.project_run_id.as_deref() == Some(project_run_id))
            .map(|(run_id, _)| run_id.clone())
            .collect();
        for run_id in run_ids {
            self.cancel(&run_id).await?;
        }
        Ok(())
    }

    /// True when the session's in-flight turn can accept immediate guidance.
    pub fn can_steer(&self, session_id: &str) -> bool {
        self.active
            .lock()
            .unwrap()
            .values()
            .any(|run| run.session_id == session_id && run.steer.is_some())
    }

    /// Sends new user guidance into an in-flight provider turn.
    pub async fn steer_session(&self, session_id: &str, input: &str) -> CoreResult<()> {
        let steer = {
            let active = self.active.lock().unwrap();
            active
                .values()
                .find(|run| run.session_id == session_id)
                .ok_or_else(|| invalid_field("sessionId", "There is no active run to guide."))?
                .steer
                .clone()
        };
        let Some(steer) = steer else {
            return Err(invalid_field("sessionId", "The active provider does not support immediate guidance. Use Queue instead."));
        };
        steer(input.to_string()).await
    }

    /// Awaits the terminal snapshot of a run launched via start().
    pub async fn wait_completion(&self, run_id: &str) -> Option<RunCompletionSnapshot> {
        let receiver = self.completion_waiters.lock().unwrap().remove(run_id);
        let receiver = receiver?;
        receiver.await.ok()
    }

    /// Serializes the turn per session and returns the run id once launched.
    pub async fn start(self: &Arc<Self>, session: &Value, agent: &Value, prompt: &str, context: RunContext) -> CoreResult<String> {
        let service = self.clone_handle();
        let session = session.clone();
        let agent = agent.clone();
        let prompt = prompt.to_string();
        let queue_key = context.queue_key.clone();
        let session_id = session.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        // Heal orphaned interaction requests before the run's events make the
        // renderer re-read the journal — a replayed request would otherwise
        // resurrect a card whose pending entry died with an older daemon.
        if let Some(interactions) = self.interactions.read().unwrap().clone() {
            interactions.heal_orphaned(&session_id);
        }
        let (result_sender, result_receiver) = tokio::sync::oneshot::channel();
        self.session_queue
            .enqueue_launch(&session_id, queue_key.as_deref(), move || async move {
                let launched = service.launch_now(&session, &agent, &prompt, context).await;
                match launched {
                    Ok((run_id, completion)) => {
                        let _ = result_sender.send(Ok(run_id.clone()));
                        Ok((run_id, completion))
                    }
                    Err(error) => {
                        let _ = result_sender.send(Err(error.to_string()));
                        Err(error.to_string())
                    }
                }
            })
            .await;
        match result_receiver.await {
            Ok(Ok(run_id)) => Ok(run_id),
            Ok(Err(message)) => Err(CoreError::reason(ErrorCode::RunStartFailed, message)),
            Err(_) => Err(CoreError::reason(ErrorCode::RunStartFailed, "run launch channel closed")),
        }
    }

    fn clone_handle(self: &Arc<Self>) -> Arc<Self> {
        Arc::clone(self)
    }

    /// Withdraws a queued (not yet started) turn by its queue key.
    pub fn cancel_queued(&self, session_id: &str, key: &str) -> bool {
        self.session_queue.cancel_pending(session_id, key)
    }

    async fn launch_now(
        self: &Arc<Self>,
        session: &Value,
        agent: &Value,
        prompt: &str,
        mut context: RunContext,
    ) -> CoreResult<(String, watch::Receiver<bool>)> {
        // An explicit per-model context window from the instance editor wins;
        // live discovery only runs when nothing is configured.
        let session_model = session.get("model").and_then(Value::as_str).unwrap_or("");
        let models = agent.get("models").and_then(Value::as_array).cloned().unwrap_or_default();
        let configured_context_window = models
            .iter()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some(session_model))
            .and_then(|entry| entry.get("contextWindow"))
            .and_then(Value::as_i64)
            .or_else(|| {
                if session_model.is_empty() && models.len() == 1 {
                    models[0].get("contextWindow").and_then(Value::as_i64)
                } else {
                    None
                }
            });
        // A window previously reported by the provider itself wins over the
        // configured catalog entry — catalogs go stale (K3-256k catalogs
        // 256k while the provider actually runs 1M), and the kimi usage
        // fallback divides by this value.
        let mut context_window = session
            .get("providerContextWindow")
            .and_then(Value::as_i64)
            .filter(|window| *window > 0)
            .or(configured_context_window);
        let provider_id = agent.get("providerId").and_then(Value::as_str).unwrap_or("");
        if context_window.is_none() {
            let discovery = self.adapters
                .find(provider_id)
                .map(|adapter| adapter.descriptor().get("contextWindowDiscovery").and_then(Value::as_bool) == Some(true))
                .unwrap_or(false);
            if discovery {
                let catalog = self.adapters.list_models(agent, None).await.ok();
                let model_id = if session_model.is_empty() {
                    catalog.as_ref().and_then(|c| c.get("defaultModel")).and_then(Value::as_str).map(str::to_string)
                } else {
                    Some(session_model.to_string())
                };
                context_window = catalog
                    .as_ref()
                    .and_then(|c| c.get("models"))
                    .and_then(Value::as_array)
                    .and_then(|models| {
                        models
                            .iter()
                            .find(|model| Some(model.get("id").and_then(Value::as_str).unwrap_or("")) == model_id.as_deref())
                            .and_then(|model| model.get("contextWindow"))
                            .and_then(Value::as_i64)
                    });
            }
        }

        let project = Repositories::new(&self.db.lock().unwrap().raw)
            .projects()
            .get(session.get("projectId").and_then(Value::as_str).unwrap_or(""))?;
        let policy_id = project.as_ref().and_then(|p| p.get("policyId")).and_then(Value::as_str).unwrap_or("default");
        let policy = self.command_policies.get(policy_id)?;
        let command_evaluation = self.command_policies.evaluate(&json!({
            "policyId": policy.get("id").cloned().unwrap_or_else(|| json!("default")),
            "command": agent.get("executable").cloned().unwrap_or(Value::Null),
            "args": agent.get("baseArgs").cloned().unwrap_or_else(|| json!([])),
            "source": "agent"
        }))?;
        let member_id = context.member_id.clone().or_else(|| session.get("memberId").and_then(Value::as_str).map(str::to_string));
        if command_evaluation.get("action").and_then(Value::as_str) == Some("blocked") {
            let mut details = Map::new();
            details.insert("actorType".to_string(), json!("agent"));
            details.insert("actorId".to_string(), member_id.clone().map(Value::String).unwrap_or(Value::Null));
            details.insert("action".to_string(), json!("command.blocked"));
            details.insert("resourceType".to_string(), json!("agentInstance"));
            details.insert("resourceId".to_string(), agent.get("id").cloned().unwrap_or(Value::Null));
            details.insert("outcome".to_string(), json!("denied"));
            details.insert("details".to_string(), json!({
                "command": agent.get("executable").cloned().unwrap_or(Value::Null),
                "ruleId": command_evaluation.get("ruleId").cloned().unwrap_or(Value::Null)
            }));
            self.audit.record(details);
            let mut error_details = Map::new();
            error_details.insert("command".to_string(), agent.get("executable").cloned().unwrap_or(Value::Null));
            error_details.insert("ruleId".to_string(), command_evaluation.get("ruleId").cloned().unwrap_or(Value::Null));
            return Err(CoreError::details(ErrorCode::CommandBlocked, error_details));
        }
        if command_evaluation.get("action").and_then(Value::as_str) == Some("approval") {
            let operation = format!("agent.launch:{}", agent.get("id").and_then(Value::as_str).unwrap_or(""));
            if !self.approvals.authorize(
                &operation,
                project.as_ref().and_then(|p| p.get("id")).and_then(Value::as_str),
                context.project_run_id.as_deref(),
                context.task_id.as_deref(),
            )? {
                let approval = self.approvals.request(&json!({
                    "category": "command",
                    "operation": operation,
                    "summary": format!("Launch {}", agent.get("displayName").and_then(Value::as_str).unwrap_or("")),
                    "projectId": project.as_ref().and_then(|p| p.get("id")).cloned().unwrap_or(Value::Null),
                    "projectRunId": context.project_run_id.clone(),
                    "taskId": context.task_id.clone(),
                    "sessionId": session.get("id").cloned().unwrap_or(Value::Null),
                    "requestedBy": member_id.clone()
                }))?;
                let mut waiting = session.as_object().cloned().unwrap_or_default();
                waiting.insert("status".to_string(), json!("waiting_approval"));
                waiting.insert("updatedAt".to_string(), json!(now_iso()));
                Repositories::new(&self.db.lock().unwrap().raw).sessions().save(&Value::Object(waiting))?;
                let _ = self.events.append_for_session(
                    session,
                    &json!({ "projectRunId": context.project_run_id, "taskId": context.task_id }),
                    "approval.requested",
                    json!({
                        "approvalId": approval.get("id").cloned().unwrap_or(Value::Null),
                        "category": "command",
                        "summary": approval.get("summary").cloned().unwrap_or(Value::Null)
                    }),
                );
                let mut audit_record = Map::new();
                audit_record.insert("actorType".to_string(), json!("agent"));
                audit_record.insert("actorId".to_string(), member_id.clone().map(Value::String).unwrap_or(Value::Null));
                audit_record.insert("action".to_string(), json!("command.approval_requested"));
                audit_record.insert("resourceType".to_string(), json!("approval"));
                audit_record.insert("resourceId".to_string(), approval.get("id").cloned().unwrap_or(Value::Null));
                audit_record.insert("outcome".to_string(), json!("success"));
                self.audit.record(audit_record);
                let mut error_details = Map::new();
                error_details.insert("approvalId".to_string(), approval.get("id").cloned().unwrap_or(Value::Null));
                return Err(CoreError::details(ErrorCode::CommandApprovalRequired, error_details));
            }
        }

        let run_id = Uuid::new_v4().to_string();
        let started_at = now_iso();
        let mut run = Map::new();
        run.insert("id".to_string(), json!(run_id));
        if let Some(id) = &context.project_run_id {
            run.insert("projectRunId".to_string(), json!(id));
        }
        if let Some(id) = &context.task_id {
            run.insert("taskId".to_string(), json!(id));
        }
        run.insert("sessionId".to_string(), session.get("id").cloned().unwrap_or(Value::Null));
        run.insert("agentInstanceId".to_string(), agent.get("id").cloned().unwrap_or(Value::Null));
        run.insert("memberId".to_string(), member_id.clone().map(Value::String).unwrap_or(Value::Null));
        run.insert("mode".to_string(), json!("headless_structured"));
        run.insert("status".to_string(), json!("starting"));
        run.insert("startedAt".to_string(), json!(started_at));
        let run = Value::Object(run);
        Repositories::new(&self.db.lock().unwrap().raw).runs().save(&run)?;
        let mut audit_record = Map::new();
        audit_record.insert("actorType".to_string(), json!("agent"));
        audit_record.insert("actorId".to_string(), member_id.clone().map(Value::String).unwrap_or(Value::Null));
        audit_record.insert("action".to_string(), json!("run.started"));
        audit_record.insert("resourceType".to_string(), json!("run"));
        audit_record.insert("resourceId".to_string(), json!(run_id));
        audit_record.insert("outcome".to_string(), json!("success"));
        self.audit.record(audit_record);
        let mut running = session.as_object().cloned().unwrap_or_default();
        running.insert("status".to_string(), json!("running"));
        running.insert("updatedAt".to_string(), json!(started_at));
        Repositories::new(&self.db.lock().unwrap().raw).sessions().save(&Value::Object(running))?;
        if context.presentation.as_deref() != Some("provider_command") {
            let _ = self.events.append(&run, session, "run.started", json!({ "runId": run_id }));
        }

        let descriptor = self.adapters.find(provider_id).map(|a| a.descriptor());
        let mut additions = provider_environment_passthrough(agent, descriptor.as_ref());
        additions.extend(self.credentials_environment(agent.get("id").and_then(Value::as_str).unwrap_or(""), provider_id));
        let provider_command = context.presentation.as_deref() == Some("provider_command");
        let runtime_tool_binding = if provider_command {
            None
        } else {
            self.runtime_tool_provider.read().unwrap().as_ref().and_then(|provider| {
                provider.for_run(session, &json!({ "projectRunId": context.project_run_id, "taskId": context.task_id }), agent)
            })
        };
        let request = AdapterStartRequest {
            instance: agent.clone(),
            prompt: prompt.to_string(),
            cwd: context
                .working_directory
                .clone()
                .or_else(|| project.as_ref().and_then(|p| p.get("rootPath")).and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()),
            model: session.get("model").and_then(Value::as_str).map(str::to_string),
            reasoning_effort: session.get("reasoningEffort").and_then(Value::as_str).map(str::to_string),
            service_tier: session.get("serviceTier").and_then(Value::as_str).map(str::to_string),
            permission_mode: session.get("permissionMode").and_then(Value::as_str).map(str::to_string),
            context_window,
            env: Some(build_environment(Some(&policy), additions)),
            timeout_ms: Some(30 * 60_000),
            idle_timeout_ms: Some(30 * 60_000),
            max_output_bytes: None,
            output_schema_path: None,
            local_image_paths: context.local_image_paths.clone(),
            runtime_tools: runtime_tool_binding.as_ref().map(|binding| Value::Array(binding.tools.clone())),
            execute_runtime_tool: runtime_tool_binding.map(|binding| binding.execute),
            request_interaction: if provider_command {
                None
            } else {
                self.interactions.read().unwrap().clone().map(|interactions| {
                    let session = session.clone();
                    let run_id = run_id.clone();
                    let provider_id = provider_id.to_string();
                    std::sync::Arc::new(move |input: Value| {
                        let interactions = interactions.clone();
                        let session = session.clone();
                        let run_id = run_id.clone();
                        let provider_id = provider_id.clone();
                        Box::pin(async move {
                            Ok(interactions.request(&session, Some(&run_id), &provider_id, input).await)
                        }) as crate::adapters::BoxFuture<anyhow::Result<Value>>
                    }) as Arc<dyn Fn(Value) -> crate::adapters::BoxFuture<anyhow::Result<Value>> + Send + Sync>
                })
            },
            skills: Some(self.resolve_skills(agent)),
            mcp_servers: Some(self.resolve_mcp_servers(agent)?),
            provider_command: context.provider_command.clone(),
        };

        if !provider_command {
            let is_git = diff_collector::is_git_workspace(&request.cwd).await;
            if !is_git {
                if let Ok(snapshot) = capture_workspace_snapshot(&request.cwd) {
                    self.workspace_baselines.lock().unwrap().insert(run_id.clone(), snapshot);
                }
            }
        }
        let current_session = Repositories::new(&self.db.lock().unwrap().raw)
            .sessions()
            .get(session.get("id").and_then(Value::as_str).unwrap_or(""))?
            .unwrap_or_else(|| session.clone());
        let must_recreate_codex_thread = provider_id == "codex"
            && request.runtime_tools.is_some()
            && current_session.get("runtimeToolVersion").and_then(Value::as_i64)
                != Some(crate::runtime::RUNTIME_TOOL_SCHEMA_VERSION);
        let provider_session_id = current_session.get("providerSessionId").and_then(Value::as_str).map(str::to_string);
        let native_resume = provider_session_id.is_some()
            && self.adapters
                .capabilities(agent)
                .map(|capabilities| capabilities.native_resume)
                .unwrap_or(false)
            && !must_recreate_codex_thread;
        let adapter_run = match (native_resume, provider_session_id) {
            (true, Some(provider_session_id)) => self.adapters.resume(crate::adapters::AdapterResumeRequest {
                start: request,
                provider_session_id,
            }),
            _ => self.adapters.start(request),
        };
        let adapter_run = match adapter_run {
            Ok(run) => run,
            Err(error) => {
                self.workspace_baselines.lock().unwrap().remove(&run_id);
                let failed = self.fail_run(&run, session, &error.to_string(), provider_command)?;
                let _ = failed;
                return Err(error);
            }
        };
        let (events, cancel, steer, _write) = adapter_run.into_parts();
        context.runtime_tool_version = if context.runtime_tool_version.is_some() {
            context.runtime_tool_version
        } else if !provider_command {
            Some(crate::runtime::RUNTIME_TOOL_SCHEMA_VERSION)
        } else {
            None
        };
        let (completion_sender, completion_receiver) = watch::channel(false);
        let (snapshot_sender, snapshot_receiver) = tokio::sync::oneshot::channel::<RunCompletionSnapshot>();
        self.completion_waiters.lock().unwrap().insert(run_id.clone(), snapshot_receiver);
        let consume_service = self.clone_handle();
        let consume_run = run.clone();
        let consume_session = current_session.clone();
        let consume_context = context.clone();
        let consume_run_id = run_id.clone();
        tokio::spawn(async move {
            let completion = consume_service
                .consume(&consume_run, &consume_session, events, consume_context)
                .await;
            let _ = snapshot_sender.send(completion);
            let _ = completion_sender.send(true);
            let service = consume_service;
            service.active.lock().unwrap().remove(&consume_run_id);
            let interactions = service.interactions.read().unwrap().clone();
            if let Some(interactions) = interactions {
                interactions.cancel_for_run(&consume_run_id);
            }
        });
        self.active.lock().unwrap().insert(
            run_id.clone(),
            ActiveRun {
                session_id: session.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                cancel,
                steer,
                project_run_id: context.project_run_id.clone(),
            },
        );
        Ok((run_id, completion_receiver))
    }

    fn credentials_environment(&self, agent_instance_id: &str, provider_id: &str) -> HashMap<String, String> {
        let credential = match self.credentials.read(agent_instance_id) {
            Ok(Some(credential)) => credential,
            _ => return HashMap::new(),
        };
        let api_key = credential.get("apiKey").and_then(Value::as_str).unwrap_or("");
        if api_key.is_empty() {
            return HashMap::new();
        }
        let mut environment = HashMap::new();
        if let Some(env_name) = credential.get("envName").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            environment.insert(env_name.to_string(), api_key.to_string());
            return environment;
        }
        let env_names: Vec<String> = self.adapters
            .find(provider_id)
            .and_then(|adapter| adapter.descriptor().get("credentialEnv").and_then(Value::as_array).cloned())
            .map(|names| names.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_else(|| match provider_id {
                "kimi" => vec!["KIMI_API_KEY".to_string()],
                "claude" => vec!["ANTHROPIC_API_KEY".to_string()],
                _ => vec![],
            });
        if env_names.is_empty() {
            environment.insert("AGENTHUB_API_KEY".to_string(), api_key.to_string());
        } else {
            for name in env_names {
                environment.insert(name, api_key.to_string());
            }
        }
        environment
    }

    /// User-managed MCP servers enabled for this run's provider.
    fn resolve_mcp_servers(&self, agent: &Value) -> CoreResult<Vec<Value>> {
        let provider_id = agent.get("providerId").and_then(Value::as_str).unwrap_or("");
        let capabilities = Repositories::new(&self.db.lock().unwrap().raw).capabilities().list_default()?;
        let servers = capabilities
            .iter()
            .filter(|capability| {
                capability.get("enabled").and_then(Value::as_bool) == Some(true)
                    && capability
                        .get("providerIds")
                        .and_then(Value::as_array)
                        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(provider_id)))
            })
            .filter_map(|capability| capability_to_mcp_server(capability))
            .collect();
        Ok(servers)
    }

    /// Provider-neutral skill bundles; each adapter decides how its CLI loads them.
    fn resolve_skills(&self, agent: &Value) -> Vec<Value> {
        let provider_id = agent.get("providerId").and_then(Value::as_str).unwrap_or("");
        let capabilities = Repositories::new(&self.db.lock().unwrap().raw)
            .capabilities()
            .list_default()
            .unwrap_or_default();
        capabilities
            .iter()
            .filter(|capability| {
                capability.get("kind").and_then(Value::as_str) == Some("skill")
                    && capability.get("enabled").and_then(Value::as_bool) == Some(true)
                    && capability
                        .get("providerIds")
                        .and_then(Value::as_array)
                        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(provider_id)))
                    && capability
                        .get("skill")
                        .and_then(|s| s.get("instructions"))
                        .and_then(Value::as_str)
                        .is_some_and(|i| !i.trim().is_empty())
            })
            .map(|capability| {
                let skill = capability.get("skill").cloned().unwrap_or(Value::Null);
                json!({
                    "id": capability.get("id").cloned().unwrap_or(Value::Null),
                    "name": capability.get("name").cloned().unwrap_or(Value::Null),
                    "description": capability.get("description").cloned().unwrap_or(Value::Null),
                    "instructions": skill.get("instructions").cloned().unwrap_or(Value::Null),
                    "resourceDir": skill.get("resourceDir").cloned().unwrap_or(Value::Null)
                })
            })
            .collect()
    }

    async fn consume(
        self: &Arc<Self>,
        run: &Value,
        session: &Value,
        mut adapter_events: tokio::sync::mpsc::UnboundedReceiver<AdapterEvent>,
        context: RunContext,
    ) -> RunCompletionSnapshot {
        let mut messages: Vec<Value> = vec![];
        let provider_command = context.presentation.as_deref() == Some("provider_command");
        let mut saw_exit = false;
        while let Some(event) = adapter_events.recv().await {
            if matches!(event, AdapterEvent::Exit { .. }) {
                saw_exit = true;
            }
            if let Some(message) = self.persist(run, session, &event, &context) {
                messages.push(message);
            }
        }
        if !provider_command {
            self.collect_run_diff(run, session, &context).await;
        }
        let latest = Repositories::new(&self.db.lock().unwrap().raw).runs().get(run.get("id").and_then(Value::as_str).unwrap_or("")).ok().flatten().unwrap_or_else(|| run.clone());
        let status = latest.get("status").and_then(Value::as_str).unwrap_or("");
        let run_id = run.get("id").and_then(Value::as_str).unwrap_or("");
        if ["failed", "timed_out", "cancelled", "cancelling", "crashed"].contains(&status) {
            let cancelled = status == "cancelled" || status == "cancelling";
            let detail = if cancelled {
                "CLI process cancelled".to_string()
            } else {
                self.output_tails
                    .lock()
                    .unwrap()
                    .get(run_id)
                    .map(|tail| tail.trim().to_string())
                    .filter(|tail| !tail.is_empty())
                    .unwrap_or_else(|| run_failure_detail(&latest))
            };
            if !provider_command {
                let _ = self.events.append(&latest, session, "run.failed", json!({
                    "code": latest.get("failureCode").and_then(Value::as_str).unwrap_or("RUN_START_FAILED"),
                    "message": detail.chars().skip(detail.chars().count().saturating_sub(4_000)).collect::<String>(),
                    "retryable": !cancelled
                }));
            }
            self.update_session_status(
                session.get("id").and_then(Value::as_str).unwrap_or(""),
                if provider_command || cancelled { "idle" } else { "failed" },
            );
            self.output_tails.lock().unwrap().remove(run_id);
            self.touched_files.lock().unwrap().remove(run_id);
            self.workspace_baselines.lock().unwrap().remove(run_id);
            return RunCompletionSnapshot { run: latest, final_message: last_message_text(&messages) };
        }
        if !saw_exit {
            // The stream closed without a real exit event: the provider
            // process died mid-run (killed, crashed, orphaned). Never report
            // this as a successful completion — mark it crashed so the UI
            // does not claim the turn finished while the child is still
            // running somewhere.
            let mut crashed = latest.as_object().cloned().unwrap_or_default();
            crashed.insert("status".to_string(), json!("crashed"));
            crashed.insert("endedAt".to_string(), json!(now_iso()));
            crashed.insert("failureCode".to_string(), json!("PLUGIN_PROCESS_LOST"));
            let crashed = Value::Object(crashed);
            let _ = Repositories::new(&self.db.lock().unwrap().raw).runs().save(&crashed);
            if !provider_command {
                let _ = self.events.append(&crashed, session, "run.failed", json!({
                    "code": "PLUGIN_PROCESS_LOST",
                    "message": "Provider process exited mid-run; the turn was interrupted.",
                    "retryable": true
                }));
            }
            self.update_session_status(
                session.get("id").and_then(Value::as_str).unwrap_or(""),
                if provider_command { "idle" } else { "failed" },
            );
            self.output_tails.lock().unwrap().remove(run_id);
            self.touched_files.lock().unwrap().remove(run_id);
            self.workspace_baselines.lock().unwrap().remove(run_id);
            return RunCompletionSnapshot { run: crashed, final_message: last_message_text(&messages) };
        }
        let mut completed = latest.as_object().cloned().unwrap_or_default();
        completed.insert("status".to_string(), json!("completed"));
        if completed.get("endedAt").is_none() {
            completed.insert("endedAt".to_string(), json!(now_iso()));
        }
        let completed = Value::Object(completed);
        let _ = Repositories::new(&self.db.lock().unwrap().raw).runs().save(&completed);
        let mut audit_record = Map::new();
        audit_record.insert("actorType".to_string(), json!("agent"));
        audit_record.insert("actorId".to_string(), run.get("memberId").cloned().or_else(|| session.get("memberId").cloned()).unwrap_or(Value::Null));
        audit_record.insert("action".to_string(), json!("run.completed"));
        audit_record.insert("resourceType".to_string(), json!("run"));
        audit_record.insert("resourceId".to_string(), json!(run_id));
        audit_record.insert("outcome".to_string(), json!("success"));
        self.audit.record(audit_record);
        if !provider_command {
            let _ = self.events.append(&completed, session, "run.completed", json!({
                "summary": last_message_text(&messages).unwrap_or_else(|| "CLI process completed".to_string())
            }));
        }
        self.update_session_status(
            session.get("id").and_then(Value::as_str).unwrap_or(""),
            if provider_command { "idle" } else { "completed" },
        );
        self.output_tails.lock().unwrap().remove(run_id);
        self.touched_files.lock().unwrap().remove(run_id);
        self.workspace_baselines.lock().unwrap().remove(run_id);
        RunCompletionSnapshot { run: completed, final_message: last_message_text(&messages) }
    }

    fn fail_run(&self, run: &Value, session: &Value, error: &str, provider_command: bool) -> CoreResult<Value> {
        let current = Repositories::new(&self.db.lock().unwrap().raw)
            .runs()
            .get(run.get("id").and_then(Value::as_str).unwrap_or(""))?
            .unwrap_or_else(|| run.clone());
        let mut failed = current.as_object().cloned().unwrap_or_default();
        failed.insert("status".to_string(), json!("failed"));
        failed.insert("endedAt".to_string(), json!(now_iso()));
        failed.insert("failureCode".to_string(), json!("RUN_START_FAILED"));
        let failed = Value::Object(failed);
        Repositories::new(&self.db.lock().unwrap().raw).runs().save(&failed)?;
        let mut audit_record = Map::new();
        audit_record.insert("actorType".to_string(), json!("agent"));
        audit_record.insert("actorId".to_string(), run.get("memberId").cloned().or_else(|| session.get("memberId").cloned()).unwrap_or(Value::Null));
        audit_record.insert("action".to_string(), json!("run.failed"));
        audit_record.insert("resourceType".to_string(), json!("run"));
        audit_record.insert("resourceId".to_string(), run.get("id").cloned().unwrap_or(Value::Null));
        audit_record.insert("outcome".to_string(), json!("failure"));
        self.audit.record(audit_record);
        if !provider_command {
            let _ = self.events.append(&failed, session, "run.failed", json!({
                "code": "RUN_START_FAILED",
                "message": error,
                "retryable": true
            }));
        }
        self.update_session_status(
            session.get("id").and_then(Value::as_str).unwrap_or(""),
            if provider_command { "idle" } else { "failed" },
        );
        Ok(failed)
    }

    fn update_session_status(&self, session_id: &str, status: &str) {
        let guard = self.db.lock().unwrap();
        let repos = Repositories::new(&guard.raw);
        if let Ok(Some(current)) = repos.sessions().get(session_id) {
            let mut updated = current.as_object().cloned().unwrap_or_default();
            updated.insert("status".to_string(), json!(status));
            updated.insert("updatedAt".to_string(), json!(now_iso()));
            let _ = repos.sessions().save(&Value::Object(updated));
        }
    }

    fn persist(&self, run: &Value, session: &Value, event: &AdapterEvent, context: &RunContext) -> Option<Value> {
        let provider_command = context.presentation.as_deref() == Some("provider_command");
        let run_id = run.get("id").and_then(Value::as_str).unwrap_or("");
        match event {
            AdapterEvent::Message { text, phase, message_id, subagent_dispatch_id, .. } => {
                let message_id = message_id.clone().unwrap_or_else(|| "default".to_string());
                // Sub-agent messages share the run; keep their delta buffers
                // separate and never persist them as chat history.
                let buffer_key = subagent_dispatch_id
                    .as_ref()
                    .map(|id| format!("sub:{id}:{message_id}"))
                    .unwrap_or_else(|| message_id.clone());
                if phase.as_deref() == Some("delta") {
                    let mut buffers = self.message_buffers.lock().unwrap();
                    let run_buffers = buffers.entry(run_id.to_string()).or_default();
                    run_buffers.entry(buffer_key.clone()).or_default().push_str(text);
                    drop(buffers);
                    if !provider_command {
                        let _ = self.events.append(run, session, "agent.message_delta", json!({
                            "messageId": buffer_key,
                            "text": self.redaction.text(text),
                            "subagentDispatchId": subagent_dispatch_id.clone().map(Value::String).unwrap_or(Value::Null)
                        }));
                    }
                    return None;
                }
                let buffered = self
                    .message_buffers
                    .lock()
                    .unwrap()
                    .get_mut(run_id)
                    .and_then(|buffers| buffers.remove(&buffer_key));
                let final_text = if !text.is_empty() { text.clone() } else { buffered.unwrap_or_default() };
                if final_text.is_empty() {
                    return None;
                }
                let mut message = Map::new();
                message.insert("id".to_string(), json!(Uuid::new_v4().to_string()));
                message.insert("sessionId".to_string(), session.get("id").cloned().unwrap_or(Value::Null));
                message.insert("sender".to_string(), json!("agent"));
                message.insert("kind".to_string(), context.message_kind.clone().map(Value::String).unwrap_or_else(|| json!("chat")));
                if let Some(id) = &context.project_run_id {
                    message.insert("projectRunId".to_string(), json!(id));
                }
                if let Some(id) = &context.task_id {
                    message.insert("taskId".to_string(), json!(id));
                }
                message.insert("runId".to_string(), json!(run_id));
                message.insert(
                    "fromMemberId".to_string(),
                    context.member_id.clone().or_else(|| session.get("memberId").and_then(Value::as_str).map(str::to_string)).map(Value::String).unwrap_or(Value::Null),
                );
                message.insert("text".to_string(), json!(self.redaction.text(&final_text)));
                message.insert("createdAt".to_string(), json!(now_iso()));
                let message = Value::Object(message);
                if !provider_command {
                    if subagent_dispatch_id.is_none() {
                        let _ = Repositories::new(&self.db.lock().unwrap().raw).sessions().save_message(&message);
                    }
                    let _ = self.events.append(run, session, "agent.message", json!({
                        "messageId": message.get("id").cloned().unwrap_or(Value::Null),
                        "text": message.get("text").cloned().unwrap_or(Value::Null),
                        "subagentDispatchId": subagent_dispatch_id.clone().map(Value::String).unwrap_or(Value::Null)
                    }));
                }
                Some(message)
            }
            AdapterEvent::Thinking { text, phase, message_id, subagent_dispatch_id, .. } => {
                if provider_command {
                    return None;
                }
                if phase.as_deref() == Some("delta") {
                    let _ = self.events.append(run, session, "agent.thinking_delta", json!({
                        "messageId": message_id.clone().unwrap_or_else(|| "default".to_string()),
                        "text": self.redaction.text(&cap_tail(text, THINKING_TEXT_LIMIT)),
                        "subagentDispatchId": subagent_dispatch_id.clone().map(Value::String).unwrap_or(Value::Null)
                    }));
                } else {
                    let _ = self.events.append(run, session, "agent.thinking_summary", json!({
                        "messageId": message_id.clone().map(Value::String).unwrap_or(Value::Null),
                        "text": self.redaction.text(&cap_tail(text, THINKING_TEXT_LIMIT)),
                        "subagentDispatchId": subagent_dispatch_id.clone().map(Value::String).unwrap_or(Value::Null)
                    }));
                }
                None
            }
            AdapterEvent::Status { phase, .. } => {
                if !provider_command {
                    let _ = self.events.append(run, session, "agent.status", json!({ "phase": phase }));
                }
                None
            }
            AdapterEvent::Session { provider_session_id, .. } => {
                let guard = self.db.lock().unwrap();
                let repos = Repositories::new(&guard.raw);
                if let Ok(Some(current)) = repos.sessions().get(session.get("id").and_then(Value::as_str).unwrap_or("")) {
                    let mut updated = current.as_object().cloned().unwrap_or_default();
                    updated.insert("providerSessionId".to_string(), json!(provider_session_id));
                    updated.insert("providerContextSyncedAt".to_string(), json!(now_iso()));
                    if let Some(version) = context.runtime_tool_version {
                        updated.insert("runtimeToolVersion".to_string(), json!(version));
                    }
                    updated.insert("updatedAt".to_string(), json!(now_iso()));
                    let _ = repos.sessions().save(&Value::Object(updated));
                }
                None
            }
            AdapterEvent::Usage { input_tokens, output_tokens, context_used, context_window, raw, .. } => {
                let _ = self.events.append(run, session, "usage.updated", json!({
                    "inputTokens": input_tokens.map(Value::from).unwrap_or(Value::Null),
                    "outputTokens": output_tokens.map(Value::from).unwrap_or(Value::Null),
                    "contextUsed": context_used.map(Value::from).unwrap_or(Value::Null),
                    "contextWindow": context.context_window_override.or(*context_window).map(Value::from).unwrap_or(Value::Null)
                }));
                // Provider-reported windows are ground truth (raw is set only
                // on live provider usage, not on computed fallbacks): persist
                // the window so future runs can prefer it over a stale model
                // catalog entry (e.g. K3-256k catalogs 256k, provider is 1M).
                if raw.is_some() {
                    if let Some(window) = context_window.filter(|w| *w > 0) {
                        let guard = self.db.lock().unwrap();
                        let repos = Repositories::new(&guard.raw);
                        if let Ok(Some(current)) = repos.sessions().get(session.get("id").and_then(Value::as_str).unwrap_or("")) {
                            if current.get("providerContextWindow").and_then(Value::as_i64) != Some(window) {
                                let mut updated = current.as_object().cloned().unwrap_or_default();
                                updated.insert("providerContextWindow".to_string(), json!(window));
                                updated.insert("updatedAt".to_string(), json!(now_iso()));
                                let _ = repos.sessions().save(&Value::Object(updated));
                            }
                        }
                    }
                }
                None
            }
            AdapterEvent::Commands { commands, .. } => {
                let agent_provider = Repositories::new(&self.db.lock().unwrap().raw)
                    .agents()
                    .get(session.get("agentInstanceId").and_then(Value::as_str).unwrap_or(""))
                    .ok()
                    .flatten()
                    .and_then(|agent| agent.get("providerId").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_else(|| "unknown".to_string());
                let _ = self.events.append(run, session, "provider.commands_updated", json!({
                    "providerId": agent_provider,
                    "commands": commands
                }));
                None
            }
            AdapterEvent::Artifact { artifact_type, name, mime_type, data, path, .. } => {
                let metadata = mime_type.as_ref().map(|mime| json!({ "mimeType": mime }));
                let input = artifact_input(
                    artifact_type,
                    name,
                    context.project_run_id.as_deref(),
                    context.task_id.as_deref(),
                    session.get("id").and_then(Value::as_str),
                    metadata,
                );
                let artifact = match path {
                    Some(path) => self.artifacts.save_file_reference(&input, path),
                    None => self.artifacts.save(&input, data.as_deref().unwrap_or("")),
                };
                if let Ok(artifact) = artifact {
                    let _ = self.events.append(run, session, "artifact.created", json!({
                        "artifactId": artifact.get("id").cloned().unwrap_or(Value::Null),
                        "kind": artifact_type,
                        "name": name,
                        "mimeType": mime_type.clone().map(Value::String).unwrap_or(Value::Null),
                        "path": path.clone().map(Value::String).unwrap_or(Value::Null)
                    }));
                }
                None
            }
            AdapterEvent::Tool { call_id, name, phase, input, output, success, file_diff, subagent_dispatch_id, .. } => {
                let completed = phase.as_deref() == Some("completed");
                let event_type = if completed { "tool.finished" } else { "tool.started" };
                let mut payload = Map::new();
                payload.insert("callId".to_string(), call_id.clone().map(Value::String).unwrap_or(Value::Null));
                payload.insert("toolName".to_string(), json!(name));
                if completed {
                    payload.insert("success".to_string(), json!(success.unwrap_or(true)));
                    payload.insert(
                        "outputSummary".to_string(),
                        self.event_detail(output.as_ref(), 2_000).map(Value::String).unwrap_or(Value::Null),
                    );
                }
                payload.insert(
                    "inputSummary".to_string(),
                    self.event_detail(input.as_ref(), tool_input_limit(name)).map(Value::String).unwrap_or(Value::Null),
                );
                if let Some(diff) = event_file_diff(file_diff.as_ref()) {
                    payload.insert("fileDiff".to_string(), diff);
                }
                if let Some(meta) = subagent_meta(name, input.as_ref()) {
                    payload.insert("subagent".to_string(), meta);
                }
                if let Some(id) = subagent_dispatch_id {
                    payload.insert("subagentDispatchId".to_string(), json!(id));
                }
                let _ = self.events.append(run, session, event_type, Value::Object(payload));
                None
            }
            AdapterEvent::Command { call_id, command, phase, exit_code, output, subagent_dispatch_id, .. } => {
                if phase.as_deref() == Some("completed") {
                    let _ = self.events.append(run, session, "command.finished", json!({
                        "callId": call_id.clone().map(Value::String).unwrap_or(Value::Null),
                        "command": command,
                        "exitCode": exit_code.unwrap_or(0),
                        "durationMs": 0,
                        "outputSummary": output.as_ref().map(|o| self.redaction.text(&o.chars().take(2_000).collect::<String>())).map(Value::String).unwrap_or(Value::Null),
                        "subagentDispatchId": subagent_dispatch_id.clone().map(Value::String).unwrap_or(Value::Null)
                    }));
                } else {
                    let cwd = context.working_directory.clone().or_else(|| {
                        Repositories::new(&self.db.lock().unwrap().raw)
                            .projects()
                            .get(session.get("projectId").and_then(Value::as_str).unwrap_or(""))
                            .ok()
                            .flatten()
                            .and_then(|project| project.get("rootPath").and_then(Value::as_str).map(str::to_string))
                    });
                    let _ = self.events.append(run, session, "command.started", json!({
                        "callId": call_id.clone().map(Value::String).unwrap_or(Value::Null),
                        "command": command,
                        "cwd": cwd.map(Value::String).unwrap_or(Value::Null),
                        "subagentDispatchId": subagent_dispatch_id.clone().map(Value::String).unwrap_or(Value::Null)
                    }));
                }
                None
            }
            AdapterEvent::File { path, change_type, additions, deletions, diff, .. } => {
                let change_type = normalize_change_type(change_type.as_deref());
                self.touched_files
                    .lock()
                    .unwrap()
                    .entry(run_id.to_string())
                    .or_default()
                    .insert(path.clone(), (path.clone(), change_type.clone()));
                // Providers often ship only the unified patch; derive the +/-
                // counts from it when explicit numbers are missing.
                let derived = diff_line_counts(diff.as_deref());
                let _ = self.events.append(run, session, "file.changed", json!({
                    "path": path,
                    "changeType": change_type,
                    "additions": additions.map(Value::from).or(derived.0.map(Value::from)).unwrap_or(Value::Null),
                    "deletions": deletions.map(Value::from).or(derived.1.map(Value::from)).unwrap_or(Value::Null),
                    "diff": diff.as_ref().map(|d| self.redaction.text(d)).map(Value::String).unwrap_or(Value::Null)
                }));
                None
            }
            AdapterEvent::Exit { exit_code, .. } => {
                let guard = self.db.lock().unwrap();
                let repos = Repositories::new(&guard.raw);
                if let Ok(Some(current)) = repos.runs().get(run_id) {
                    let status = current.get("status").and_then(Value::as_str).unwrap_or("");
                    // A provider process can exit cleanly after reporting a
                    // model/transport failure; do not let exit 0 erase that.
                    if !["failed", "timed_out", "cancelled", "cancelling", "crashed"].contains(&status) {
                        let mut updated = current.as_object().cloned().unwrap_or_default();
                        updated.insert("status".to_string(), json!(if *exit_code == Some(0) { "completed" } else { "failed" }));
                        updated.insert("endedAt".to_string(), json!(now_iso()));
                        if let Some(code) = exit_code {
                            updated.insert("exitCode".to_string(), json!(code));
                        }
                        let _ = repos.runs().save(&Value::Object(updated));
                    }
                }
                None
            }
            AdapterEvent::Timeout { reason } => {
                let guard = self.db.lock().unwrap();
                let repos = Repositories::new(&guard.raw);
                if let Ok(Some(current)) = repos.runs().get(run_id) {
                    let mut updated = current.as_object().cloned().unwrap_or_default();
                    updated.insert("status".to_string(), json!(if *reason == TimeoutKind::MaxOutput { "failed" } else { "timed_out" }));
                    updated.insert("endedAt".to_string(), json!(now_iso()));
                    updated.insert("failureCode".to_string(), json!(format!("RUN_{}", reason.as_str().to_uppercase())));
                    let _ = repos.runs().save(&Value::Object(updated));
                }
                None
            }
            AdapterEvent::Error { message } => {
                self.remember_output(run_id, message);
                let guard = self.db.lock().unwrap();
                let repos = Repositories::new(&guard.raw);
                if let Ok(Some(current)) = repos.runs().get(run_id) {
                    let mut updated = current.as_object().cloned().unwrap_or_default();
                    updated.insert("status".to_string(), json!("failed"));
                    updated.insert("endedAt".to_string(), json!(now_iso()));
                    updated.insert("failureCode".to_string(), json!("PROVIDER_ERROR"));
                    let _ = repos.runs().save(&Value::Object(updated));
                }
                None
            }
            AdapterEvent::Raw { text, .. } => {
                self.remember_output(run_id, text);
                None
            }
        }
    }

    fn remember_output(&self, run_id: &str, text: &str) {
        let redacted = self.redaction.text(text);
        let mut tails = self.output_tails.lock().unwrap();
        let tail = format!("{}{redacted}", tails.get(run_id).cloned().unwrap_or_default());
        tails.insert(run_id.to_string(), tail.chars().skip(tail.chars().count().saturating_sub(8_192)).collect());
    }

    fn event_detail(&self, value: Option<&Value>, limit: usize) -> Option<String> {
        let value = value?;
        if value.is_null() {
            return None;
        }
        let detail = match value {
            Value::String(text) => text.trim().to_string(),
            other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
        };
        if detail.is_empty() || detail == "\"\"" {
            return None;
        }
        Some(self.redaction.text(&detail.chars().take(limit).collect::<String>()))
    }

    async fn collect_run_diff(&self, run: &Value, session: &Value, context: &RunContext) {
        let run_id = run.get("id").and_then(Value::as_str).unwrap_or("");
        let touched: Vec<diff_collector::TouchedFile> = self
            .touched_files
            .lock()
            .unwrap()
            .get(run_id)
            .map(|files| {
                files
                    .values()
                    .map(|(path, change_type)| diff_collector::TouchedFile { path: path.clone(), change_type: change_type.clone() })
                    .collect()
            })
            .unwrap_or_default();
        if touched.is_empty() {
            return;
        }
        let project = Repositories::new(&self.db.lock().unwrap().raw)
            .projects()
            .get(session.get("projectId").and_then(Value::as_str).unwrap_or(""))
            .ok()
            .flatten();
        let cwd = context
            .working_directory
            .clone()
            .or_else(|| project.as_ref().and_then(|p| p.get("rootPath")).and_then(Value::as_str).map(str::to_string));
        let Some(cwd) = cwd else { return };
        let baseline = self.workspace_baselines.lock().unwrap().remove(run_id);
        let files = diff_collector::collect(&cwd, &touched, baseline.as_ref()).await;
        if files.is_empty() {
            return;
        }
        let title = session.get("title").and_then(Value::as_str).unwrap_or("");
        let title = if title.is_empty() { "run".to_string() } else { title.chars().take(80).collect::<String>() };
        let name = format!("{title}.diff.json");
        let input = artifact_input(
            "diff",
            &name,
            context.project_run_id.as_deref(),
            context.task_id.as_deref(),
            session.get("id").and_then(Value::as_str),
            Some(json!({
                "runId": run_id,
                "paths": files.iter().filter_map(|f| f.get("path").cloned()).collect::<Vec<_>>(),
                "fileCount": files.len()
            })),
        );
        if let Ok(artifact) = self.artifacts.save(&input, &json!({ "files": files }).to_string()) {
            let _ = self.events.append(run, session, "git.diff_collected", json!({
                "artifactId": artifact.get("id").cloned().unwrap_or(Value::Null),
                "taskId": context.task_id.clone().map(Value::String).unwrap_or(Value::Null),
                "fileCount": files.len()
            }));
        }
    }
}

fn invalid_field(field: &str, reason: &str) -> CoreError {
    let mut details = Map::new();
    details.insert("field".to_string(), json!(field));
    details.insert("reason".to_string(), json!(reason));
    CoreError::details(ErrorCode::IpcInvalidRequest, details)
}

fn last_message_text(messages: &[Value]) -> Option<String> {
    messages.last().and_then(|message| message.get("text")).and_then(Value::as_str).map(str::to_string)
}

/// Todo-tracking tools carry the whole task list in their input; the desktop
/// goal card needs the full JSON, so those inputs get a larger budget.
fn tool_input_limit(tool_name: &str) -> usize {
    let normalized: String = tool_name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    if ["todolist", "todo_list", "todowrite", "todo_write", "update_plan"].contains(&normalized.as_str()) {
        16_000
    } else {
        2_000
    }
}

/// Reasoning streams are display-only; the collapsed preview reads the latest
/// lines, so oversized streams are capped at the TAIL (keeping the newest
/// content) instead of the head. 20k chars is far beyond what the 384px
/// reasoning card renders usefully, and it bounds both the DB row and every
/// replay copy shipped to the renderer.
const THINKING_TEXT_LIMIT: usize = 20_000;

fn cap_tail(text: &str, limit: usize) -> String {
    let count = text.chars().count();
    if count <= limit {
        return text.to_string();
    }
    text.chars().skip(count - limit).collect()
}

fn event_file_diff(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    let limit = 20_000;
    let before = value.get("before").and_then(Value::as_str).unwrap_or("");
    let after = value.get("after").and_then(Value::as_str).unwrap_or("");
    let truncated = before.len() > limit || after.len() > limit;
    let mut diff = Map::new();
    if let Some(operation) = value.get("operation").cloned() {
        diff.insert("operation".to_string(), operation);
    }
    if let Some(path) = value.get("path").cloned() {
        diff.insert("path".to_string(), path);
    }
    diff.insert("before".to_string(), json!(before.chars().take(limit).collect::<String>()));
    diff.insert("after".to_string(), json!(after.chars().take(limit).collect::<String>()));
    if truncated {
        diff.insert("truncated".to_string(), json!(true));
    }
    Some(Value::Object(diff))
}

fn diff_line_counts(diff: Option<&str>) -> (Option<i64>, Option<i64>) {
    let Some(diff) = diff else {
        return (None, None);
    };
    let mut additions = 0i64;
    let mut deletions = 0i64;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (Some(additions), Some(deletions))
}

fn normalize_change_type(value: Option<&str>) -> String {
    match value {
        Some("added") | Some("add") | Some("create") => "added",
        Some("deleted") | Some("delete") | Some("remove") => "deleted",
        Some("renamed") | Some("rename") => "renamed",
        Some("modified") => "modified",
        _ => "modified",
    }
    .to_string()
}

fn run_failure_detail(run: &Value) -> String {
    match run.get("failureCode").and_then(Value::as_str) {
        Some("RUN_MAX_OUTPUT") => "CLI output exceeded the configured safety limit".to_string(),
        Some("RUN_IDLE") => "CLI process was idle for too long".to_string(),
        Some("RUN_TIMEOUT") => "CLI process exceeded the configured time limit".to_string(),
        _ => {
            if run.get("status").and_then(Value::as_str) == Some("timed_out") {
                "CLI process timed out".to_string()
            } else {
                "CLI process failed".to_string()
            }
        }
    }
}

/// Resolves a stored MCP capability into an adapter server spec, expanding
/// environment references from the daemon process environment.
fn capability_to_mcp_server(capability: &Value) -> Option<Value> {
    if capability.get("kind").and_then(Value::as_str) != Some("mcp") {
        return None;
    }
    let mcp = capability.get("mcp")?.as_object()?;
    let mut env = Map::new();
    if let Some(base) = mcp.get("env").and_then(Value::as_object) {
        for (key, value) in base {
            env.insert(key.clone(), value.clone());
        }
    }
    for name in mcp.get("envPassthrough").and_then(Value::as_array).cloned().unwrap_or_default() {
        if let Some(name) = name.as_str() {
            if !env.contains_key(name) {
                if let Ok(value) = std::env::var(name) {
                    env.insert(name.to_string(), json!(value));
                }
            }
        }
    }
    let mut headers = Map::new();
    if let Some(base) = mcp.get("headers").and_then(Value::as_object) {
        for (key, value) in base {
            headers.insert(key.clone(), value.clone());
        }
    }
    if let Some(env_var) = mcp.get("bearerTokenEnvVar").and_then(Value::as_str) {
        if let Ok(token) = std::env::var(env_var) {
            headers.entry("Authorization".to_string()).or_insert_with(|| json!(format!("Bearer {token}")));
        }
    }
    if let Some(env_headers) = mcp.get("envHeaders").and_then(Value::as_object) {
        for (header, env_name) in env_headers {
            if let Some(env_name) = env_name.as_str() {
                if let Ok(value) = std::env::var(env_name) {
                    headers.insert(header.clone(), json!(value));
                }
            }
        }
    }
    // Provider tool names derive from the server name; keep it CLI-safe.
    let name = capability.get("name").and_then(Value::as_str).unwrap_or("");
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }
    let name = slug.trim_matches('-').to_string();
    let name = if name.is_empty() { "mcp".to_string() } else { name };

    let mut server = Map::new();
    server.insert("name".to_string(), json!(name));
    server.insert("transport".to_string(), mcp.get("transport").cloned().unwrap_or(Value::Null));
    if let Some(command) = mcp.get("command").cloned() {
        server.insert("command".to_string(), command);
    }
    if let Some(args) = mcp.get("args").cloned() {
        server.insert("args".to_string(), args);
    }
    if !env.is_empty() {
        server.insert("env".to_string(), Value::Object(env));
    }
    if let Some(cwd) = mcp.get("cwd").cloned() {
        server.insert("cwd".to_string(), cwd);
    }
    if let Some(url) = mcp.get("url").cloned() {
        server.insert("url".to_string(), url);
    }
    if !headers.is_empty() {
        server.insert("headers".to_string(), Value::Object(headers));
    }
    Some(Value::Object(server))
}
