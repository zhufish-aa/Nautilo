//! Orchestration service — port of application/orchestration-service.ts.
//! Coordinates decisions and task execution; provider/process details stay
//! in RunService.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::database::{Database, Repositories};
use crate::domain::can_transition_project_run;
use crate::errors::{not_found, now_iso, CoreError, CoreResult, ErrorCode};
use crate::runtime::event_service::EventService;
use crate::runtime::git_workflow_service::GitWorkflowService;
use crate::runtime::message_attachment_service::MessageAttachmentService;
use crate::runtime::orchestration::conversation_continuity::{ConversationContinuityBuilder, ContinuityInput};
use crate::runtime::orchestration::decision_validator::DecisionValidator;
use crate::runtime::orchestration::json_extractor::extract_json_object;
use crate::runtime::orchestration::member_router::MemberRouter;
use crate::runtime::orchestration::message_router::MessageRouter;
use crate::runtime::orchestration::prompt_builder::OrchestrationPromptBuilder;
use crate::runtime::orchestration::runtime_tool_names::RuntimeToolDecisionBuilder;
use crate::runtime::orchestration::session_router::SessionRouter;
use crate::runtime::orchestration::task_graph::TaskGraph;
use crate::runtime::run_service::{RunContext, RunService};
use crate::runtime::security::ApprovalService;

fn invalid_plan(details: &[(&str, Value)]) -> CoreError {
    let mut map = Map::new();
    for (key, value) in details {
        map.insert(key.to_string(), value.clone());
    }
    CoreError::details(ErrorCode::PlanApprovalNotFound, map)
}

pub struct OrchestrationService {
    db: Arc<Mutex<Database>>,
    runs: Arc<RunService>,
    events: Arc<EventService>,
    git_workflows: Option<Arc<GitWorkflowService>>,
    approvals: Arc<ApprovalService>,
    active: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
}

impl OrchestrationService {
    pub fn new(
        db: Arc<Mutex<Database>>,
        runs: Arc<RunService>,
        events: Arc<EventService>,
        git_workflows: Option<Arc<GitWorkflowService>>,
        approvals: Arc<ApprovalService>,
    ) -> Arc<Self> {
        Arc::new(Self { db, runs, events, git_workflows, approvals, active: Arc::new(Mutex::new(HashMap::new())) })
    }

    fn members(&self) -> MemberRouter {
        MemberRouter::new(self.db.clone())
    }

    fn decisions(&self) -> DecisionValidator {
        DecisionValidator::new(MemberRouter::new(self.db.clone()))
    }

    fn graph(&self) -> TaskGraph {
        TaskGraph::new(self.db.clone())
    }

    fn session_router(&self) -> SessionRouter {
        SessionRouter::new(self.db.clone())
    }

    fn messages(&self) -> MessageRouter {
        MessageRouter::new(self.db.clone())
    }

    // ------------------------------------------------------------ public API

    pub fn start(self: &Arc<Self>, input: &Value) -> CoreResult<Value> {
        let project_id = input.get("projectId").and_then(Value::as_str).unwrap_or("");
        let team_id = input.get("teamId").and_then(Value::as_str).unwrap_or("");
        let project = Repositories::new(&self.db.lock().unwrap().raw)
            .projects()
            .get(project_id)?
            .ok_or_else(|| not_found("project", project_id))?;
        let team = self.require_team(team_id)?;
        let main = self
            .members()
            .session_main(&team, input.get("agentInstanceId").and_then(Value::as_str))?;
        let goal = input.get("goal").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if goal.is_empty() {
            return Err(crate::errors::invalid("goal", ""));
        }

        let now = now_iso();
        let native_runtime_tools = team.get("mainMemberId").is_none() && input.get("agentInstanceId").is_some();
        let mut project_run = Map::new();
        let project_run_id = Uuid::new_v4().to_string();
        project_run.insert("id".to_string(), json!(project_run_id));
        project_run.insert("projectId".to_string(), json!(project_id));
        project_run.insert("teamId".to_string(), team.get("id").cloned().unwrap_or(Value::Null));
        project_run.insert("goal".to_string(), json!(goal));
        project_run.insert("mainMemberId".to_string(), main.member.get("id").cloned().unwrap_or(Value::Null));
        project_run.insert("mainAgentInstanceId".to_string(), main.agent.get("id").cloned().unwrap_or(Value::Null));
        project_run.insert(
            "status".to_string(),
            json!(if native_runtime_tools { "executing" } else { "planning" }),
        );
        project_run.insert(
            "workspaceMode".to_string(),
            project.get("workspaceMode").cloned().filter(|v| !v.is_null()).unwrap_or_else(|| json!("direct")),
        );
        project_run.insert("createdAt".to_string(), json!(now_iso()));
        project_run.insert("updatedAt".to_string(), json!(now_iso()));
        let mut project_run = Value::Object(project_run);
        let main_session = self.session_router().main(&project_run, &team, input.get("sessionId").and_then(Value::as_str))?;
        project_run
            .as_object_mut()
            .unwrap()
            .insert("mainSessionId".to_string(), main_session.get("id").cloned().unwrap_or(Value::Null));
        Repositories::new(&self.db.lock().unwrap().raw).project_runs().save(&project_run)?;
        let user_message = self.messages().user_goal(&main_session, &project_run, input.get("messageId").and_then(Value::as_str))?;

        let service = self.clone_arc();
        let attachments_input = input.get("attachments").and_then(Value::as_array).cloned().unwrap_or_default();
        let scheduled_session = main_session.clone();
        let scheduled_run_id = project_run_id.clone();
        self.schedule(&project_run_id, async move {
            let main_session = scheduled_session;
            let project_run_id = scheduled_run_id;
            let attachments = MessageAttachmentService::new(service.db.clone()).save(&main_session, &attachments_input)?;
            if !attachments.is_empty() {
                let mut updated = user_message.as_object().cloned().unwrap_or_default();
                updated.insert(
                    "attachmentIds".to_string(),
                    Value::Array(attachments.iter().filter_map(|a| a.get("id").cloned()).collect()),
                );
                let db = service.db.lock().unwrap();
                Repositories::new(&db.raw).sessions().save_message(&Value::Object(updated))?;
            }
            if let Some(git) = &service.git_workflows {
                let current = service.require_project_run(&project_run_id)?;
                let initialized = git.initialize_run(&current).await?;
                service.save_project_run(&initialized)?;
            }
            if native_runtime_tools {
                service.execute_main_turn(&project_run_id).await
            } else {
                service.plan(&project_run_id).await
            }
        });
        Ok(json!({ "projectRun": project_run, "mainSession": main_session }))
    }

    pub fn get(&self, project_run_id: &str) -> CoreResult<Value> {
        let project_run = self.require_project_run(project_run_id)?;
        let main_session = self.require_main_session(&project_run)?;
        Ok(json!({ "projectRun": project_run, "mainSession": main_session }))
    }

    pub fn resolve_delegation(self: &Arc<Self>, project_run_id: &str, approved: bool, scope: Option<&str>) -> CoreResult<Value> {
        let scope = scope.unwrap_or("run");
        let project_run = self.require_project_run(project_run_id)?;
        let planner_decision = project_run.get("plannerDecision").cloned();
        let valid = project_run.get("status").and_then(Value::as_str) == Some("waiting_user")
            && project_run.get("pendingApprovalId").is_some()
            && planner_decision.as_ref().and_then(|d| d.get("mode")).and_then(Value::as_str).is_some()
            && planner_decision.as_ref().and_then(|d| d.get("mode")).and_then(Value::as_str) != Some("direct");
        if !valid {
            let mut details = Map::new();
            details.insert("projectRunId".to_string(), json!(project_run_id));
            return Err(CoreError::details(ErrorCode::PlanApprovalNotFound, details));
        }
        let main_session = self.require_main_session(&project_run)?;
        let pending_id = project_run.get("pendingApprovalId").and_then(Value::as_str).unwrap_or("");
        self.approvals.resolve(pending_id, if approved { "approved" } else { "rejected" }, &json!(scope))?;
        let _ = self.events.append_for_session(
            &main_session,
            &json!({ "projectRunId": project_run_id }),
            "approval.resolved",
            json!({ "approvalId": pending_id, "decision": if approved { "approved" } else { "rejected" }, "scope": scope }),
        );

        let runtime_tool_request = planner_decision
            .as_ref()
            .and_then(|d| d.get("rationale"))
            .and_then(Value::as_str)
            == Some("runtime_tool");
        if approved {
            self.graph().release_approval(project_run_id)?;
            let mut updated = project_run.as_object().cloned().unwrap_or_default();
            updated.insert("status".to_string(), json!("executing"));
            updated.remove("pendingApprovalId");
            let executing = self.save_project_run(&Value::Object(updated))?;
            let service = self.clone_arc();
            let id = project_run_id.to_string();
            self.schedule(project_run_id, async move { service.execute_tasks(&id, None, None, None).await });
            return Ok(executing);
        }

        let tasks = Repositories::new(&self.db.lock().unwrap().raw).tasks().list(project_run_id)?;
        for task in tasks {
            self.update_task(&main_session, &task, "cancelled", None)?;
        }
        let mut updated = project_run.as_object().cloned().unwrap_or_default();
        updated.insert("status".to_string(), json!("executing"));
        updated.remove("pendingApprovalId");
        let executing = self.save_project_run(&Value::Object(updated))?;
        if runtime_tool_request {
            let service = self.clone_arc();
            let id = project_run_id.to_string();
            self.schedule(project_run_id, async move { service.notify_runtime_delegation_rejected(&id).await });
            return Ok(executing);
        }
        let service = self.clone_arc();
        let id = project_run_id.to_string();
        self.schedule(project_run_id, async move { service.execute_direct(&id, true).await });
        Ok(executing)
    }

    pub async fn resolve_merge(&self, project_run_id: &str, approved: bool, scope: Option<&str>) -> CoreResult<Value> {
        let scope = scope.unwrap_or("project");
        let project_run = self.require_project_run(project_run_id)?;
        let valid = project_run.get("status").and_then(Value::as_str) == Some("merge_ready")
            && project_run.get("mergeApprovalId").is_some()
            && self.git_workflows.is_some();
        if !valid {
            let mut details = Map::new();
            details.insert("projectRunId".to_string(), json!(project_run_id));
            details.insert("category".to_string(), json!("merge"));
            return Err(CoreError::details(ErrorCode::PlanApprovalNotFound, details));
        }
        let main_session = self.require_main_session(&project_run)?;
        let merge_approval_id = project_run.get("mergeApprovalId").and_then(Value::as_str).unwrap_or("");
        self.approvals.resolve(merge_approval_id, if approved { "approved" } else { "rejected" }, &json!(scope))?;
        let _ = self.events.append_for_session(
            &main_session,
            &json!({ "projectRunId": project_run_id }),
            "approval.resolved",
            json!({ "approvalId": merge_approval_id, "decision": if approved { "approved" } else { "rejected" }, "scope": scope }),
        );
        if !approved {
            let mut updated = project_run.as_object().cloned().unwrap_or_default();
            updated.insert("status".to_string(), json!("review_required"));
            updated.remove("mergeApprovalId");
            return self.save_project_run(&Value::Object(updated));
        }
        let mut updated = project_run.as_object().cloned().unwrap_or_default();
        updated.insert("status".to_string(), json!("merging"));
        updated.remove("mergeApprovalId");
        self.save_project_run(&Value::Object(updated))?;
        let merged = self
            .git_workflows
            .as_ref()
            .unwrap()
            .merge_final(&self.require_project_run(project_run_id)?, &main_session)
            .await?;
        let has_conflicts = merged.get("conflicts").and_then(Value::as_array).is_some_and(|c| !c.is_empty());
        let mut merged_obj = merged.as_object().cloned().unwrap_or_default();
        merged_obj.insert("status".to_string(), json!(if has_conflicts { "review_required" } else { "completed" }));
        self.save_project_run(&Value::Object(merged_obj))
    }

    pub async fn cancel(&self, project_run_id: &str) -> CoreResult<Value> {
        let project_run = self.require_project_run(project_run_id)?;
        self.runs.cancel_project_run(project_run_id).await?;
        // Stopping an already terminal run is a no-op: clients must be able to
        // "stop" a stale UI without tripping the transition guard.
        let status = project_run.get("status").and_then(Value::as_str).unwrap_or("");
        if ["completed", "failed", "cancelled"].contains(&status) {
            return Ok(project_run);
        }
        let main_session = self.require_main_session(&project_run)?;
        let tasks = Repositories::new(&self.db.lock().unwrap().raw).tasks().list(project_run_id)?;
        for task in tasks {
            let task_status = task.get("status").and_then(Value::as_str).unwrap_or("");
            if !["completed", "cancelled"].contains(&task_status) {
                self.update_task(&main_session, &task, "cancelled", None)?;
            }
        }
        let mut updated = self.require_project_run(project_run_id)?.as_object().cloned().unwrap_or_default();
        updated.insert("status".to_string(), json!("cancelled"));
        self.save_project_run(&Value::Object(updated))
    }

    pub fn recover(self: &Arc<Self>, project_run_id: &str, member_id: &str, mode: &str) -> CoreResult<Value> {
        let project_run = self.require_project_run(project_run_id)?;
        let status = project_run.get("status").and_then(Value::as_str).unwrap_or("");
        if !["paused", "failed"].contains(&status) {
            let mut details = Map::new();
            details.insert("projectRunId".to_string(), json!(project_run_id));
            details.insert("status".to_string(), json!(status));
            return Err(CoreError::details(ErrorCode::RecoveryNotAvailable, details));
        }
        let team = self.require_team(project_run.get("teamId").and_then(Value::as_str).unwrap_or(""))?;
        let previous_session = self.require_main_session(&project_run)?;
        let native_runtime_tools = team.get("mainMemberId").is_none()
            && project_run.get("mainAgentInstanceId").and_then(Value::as_str).is_some();
        if mode == "resume" && member_id != project_run.get("mainMemberId").and_then(Value::as_str).unwrap_or("") {
            let mut details = Map::new();
            details.insert("reason".to_string(), json!("resume_requires_same_member"));
            return Err(CoreError::details(ErrorCode::RecoveryNotAvailable, details));
        }
        let replacement = if mode == "replace" { Some(self.members().resolve(&team, member_id, None)?) } else { None };
        let main_session = if mode == "resume" {
            let mut updated = previous_session.as_object().cloned().unwrap_or_default();
            updated.insert("status".to_string(), json!("idle"));
            updated.insert("updatedAt".to_string(), json!(now_iso()));
            Value::Object(updated)
        } else {
            self.session_router().replacement_main(&project_run, &team, member_id, &previous_session)?
        };
        Repositories::new(&self.db.lock().unwrap().raw).sessions().save(&main_session)?;
        let tasks = Repositories::new(&self.db.lock().unwrap().raw).tasks().list(project_run_id)?;
        for task in tasks {
            let task_status = task.get("status").and_then(Value::as_str).unwrap_or("");
            if !["completed", "cancelled"].contains(&task_status) {
                let mut updated = task.as_object().cloned().unwrap_or_default();
                updated.insert("status".to_string(), json!("cancelled"));
                updated.insert("updatedAt".to_string(), json!(now_iso()));
                let updated = Value::Object(updated);
                Repositories::new(&self.db.lock().unwrap().raw).tasks().save(&updated)?;
                self.emit_task(&main_session, &updated);
            }
        }
        let mut recovered = project_run.as_object().cloned().unwrap_or_default();
        recovered.insert("mainMemberId".to_string(), json!(member_id));
        recovered.insert(
            "mainAgentInstanceId".to_string(),
            replacement
                .map(|r| r.agent.get("id").cloned().unwrap_or(Value::Null))
                .unwrap_or_else(|| project_run.get("mainAgentInstanceId").cloned().unwrap_or(Value::Null)),
        );
        recovered.insert("mainSessionId".to_string(), main_session.get("id").cloned().unwrap_or(Value::Null));
        recovered.insert("status".to_string(), json!(if native_runtime_tools { "executing" } else { "planning" }));
        recovered.insert(
            "recoveryReason".to_string(),
            json!(if mode == "resume" { "provider_session_resume" } else { "main_agent_replaced" }),
        );
        let mut previous_members: Vec<Value> = project_run
            .get("previousMainMemberIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(current) = project_run.get("mainMemberId").cloned() {
            previous_members.push(current);
        }
        recovered.insert("previousMainMemberIds".to_string(), Value::Array(previous_members));
        let recovered = self.save_project_run(&Value::Object(recovered))?;
        self.messages().system(
            &main_session,
            &recovered,
            if native_runtime_tools && mode == "resume" {
                "已恢复原主 Agent 会话，将继续未完成目标。"
            } else if native_runtime_tools {
                "主 Agent 已切换，将继续未完成目标。"
            } else if mode == "resume" {
                "已恢复原主 Agent 会话，将重新规划未完成目标。"
            } else {
                "主 Agent 已切换，将重新规划未完成目标。"
            },
            "recovery",
        )?;
        let service = self.clone_arc();
        let id = project_run_id.to_string();
        self.schedule(project_run_id, async move {
            if native_runtime_tools { service.execute_main_turn(&id).await }
            else { service.plan(&id).await }
        });
        Ok(recovered)
    }

    /// Invoked by provider-native runtime tools; never asks for routing first.
    pub async fn invoke_runtime_tool(self: &Arc<Self>, session_id: &str, tool_name: &str, input: Value) -> anyhow::Result<Value> {
        let result: CoreResult<Value> = async {
            let main_session = Repositories::new(&self.db.lock().unwrap().raw)
                .sessions()
                .get(session_id)?
                .ok_or_else(|| not_found("session", session_id))?;
            let valid_scope = main_session.get("projectRunId").is_some()
                && main_session.get("teamId").is_some()
                && main_session.get("parentSessionId").is_none();
            if !valid_scope {
                let mut details = Map::new();
                details.insert("sessionId".to_string(), json!(session_id));
                details.insert("reason".to_string(), json!("not_main_team_session"));
                return Err(CoreError::details(ErrorCode::PlanDelegationNotAllowed, details));
            }
            let project_run_id = main_session.get("projectRunId").and_then(Value::as_str).unwrap_or("");
            let project_run = self.require_project_run(project_run_id)?;
            if project_run.get("mainSessionId").and_then(Value::as_str) != main_session.get("id").and_then(Value::as_str)
                || project_run.get("teamId").and_then(Value::as_str) != main_session.get("teamId").and_then(Value::as_str)
            {
                let mut details = Map::new();
                details.insert("sessionId".to_string(), json!(session_id));
                details.insert("reason".to_string(), json!("session_scope_mismatch"));
                return Err(CoreError::details(ErrorCode::PlanDelegationNotAllowed, details));
            }
            let team = self.require_team(main_session.get("teamId").and_then(Value::as_str).unwrap_or(""))?;
            let decisions = self.decisions();
            let decision = RuntimeToolDecisionBuilder::new(&decisions).build(tool_name, &input, &team)?;
            let mode = decision.get("mode").and_then(Value::as_str).unwrap_or("");
            let planned: Vec<Value> = if mode == "delegate" {
                vec![decision.get("task").cloned().unwrap_or(Value::Null)]
            } else {
                decision.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default()
            };
            let approval_required = team.get("delegationPolicy").and_then(Value::as_str) == Some("ask_before_delegate");
            let tasks = self.graph().create(project_run_id, &planned, approval_required)?;
            for task in &tasks {
                self.emit_task(&main_session, task);
            }
            let mut current_run = project_run.clone();
            let status = current_run.get("status").and_then(Value::as_str).unwrap_or("");
            if !["executing", "waiting_user"].contains(&status) {
                let mut updated = current_run.as_object().cloned().unwrap_or_default();
                updated.insert("status".to_string(), json!("executing"));
                current_run = self.save_project_run(&Value::Object(updated))?;
            }

            if approval_required {
                let approval_id = Uuid::new_v4().to_string();
                self.approvals.request(&json!({
                    "id": approval_id,
                    "category": "delegate",
                    "operation": "orchestration.delegate",
                    "summary": format!("Delegate {} runtime tool task{}", tasks.len(), if tasks.len() == 1 { "" } else { "s" }),
                    "projectId": project_run.get("projectId").cloned().unwrap_or(Value::Null),
                    "projectRunId": project_run_id,
                    "sessionId": main_session.get("id").cloned().unwrap_or(Value::Null),
                    "requestedBy": project_run.get("mainMemberId").cloned().unwrap_or(Value::Null)
                }))?;
                let mut updated = current_run.as_object().cloned().unwrap_or_default();
                updated.insert("plannerDecision".to_string(), decision.clone());
                updated.insert("pendingApprovalId".to_string(), json!(approval_id));
                updated.insert("status".to_string(), json!("waiting_user"));
                self.save_project_run(&Value::Object(updated))?;
                let _ = self.events.append_for_session(
                    &main_session,
                    &json!({ "projectRunId": project_run_id }),
                    "approval.requested",
                    json!({
                        "approvalId": approval_id,
                        "category": "delegate",
                        "summary": format!("{} delegated runtime tool task{}", tasks.len(), if tasks.len() == 1 { "" } else { "s" })
                    }),
                );
                return Ok(json!({
                    "success": true,
                    "content": json!({
                        "accepted": false,
                        "approvalRequired": true,
                        "approvalId": approval_id,
                        "tasks": tasks.iter().map(|task| json!({
                            "taskId": task.get("id").cloned().unwrap_or(Value::Null),
                            "memberId": task.get("assignedMemberId").cloned().unwrap_or(Value::Null)
                        })).collect::<Vec<_>>()
                    }).to_string()
                }));
            }

            let mut updated = current_run.as_object().cloned().unwrap_or_default();
            updated.insert("plannerDecision".to_string(), decision.clone());
            self.save_project_run(&Value::Object(updated))?;

            let task_ids: Vec<String> = tasks.iter().filter_map(|t| t.get("id").and_then(Value::as_str).map(str::to_string)).collect();
            let service = self.clone_arc();
            let run_id = project_run_id.to_string();
            let finalize = team.get("mainMemberId").is_none()
                && project_run.get("status").and_then(Value::as_str) == Some("executing");
            let tasks_snapshot = tasks.clone();
            tokio::spawn(async move {
                if let Err(error) = service.execute_tasks(&run_id, Some(task_ids), Some(false), Some(finalize)).await {
                    let message = match error.downcast_ref::<CoreError>() {
                        Some(core) => format!("{}: {}", core.0.code, core.0.message),
                        None => error.to_string(),
                    };
                    let _ = service.messages().system(&main_session, &project_run, &message, "recovery");
                }
                let _ = tasks_snapshot;
            });

            Ok(json!({
                "success": true,
                "content": json!({
                    "accepted": true,
                    "mode": mode,
                    "tasks": tasks.iter().map(|task| json!({
                        "taskId": task.get("id").cloned().unwrap_or(Value::Null),
                        "memberId": task.get("assignedMemberId").cloned().unwrap_or(Value::Null),
                        "status": task.get("status").cloned().unwrap_or(Value::Null)
                    })).collect::<Vec<_>>()
                }).to_string()
            }))
        }
        .await;
        match result {
            Ok(value) => Ok(value),
            Err(error) => Ok(json!({
                "success": false,
                "content": json!({
                    "accepted": false,
                    "code": error.0.code,
                    "message": error.0.message
                }).to_string()
            })),
        }
    }

    fn clone_arc(self: &Arc<Self>) -> Arc<Self> {
        Arc::clone(self)
    }


    // ------------------------------------------------------------ pipeline

    async fn notify_runtime_delegation_rejected(self: &Arc<Self>, project_run_id: &str) -> anyhow::Result<()> {
        let project_run = self.require_project_run(project_run_id)?;
        let team = self.require_team(project_run.get("teamId").and_then(Value::as_str).unwrap_or(""))?;
        let main = self.members().session_main(&team, project_run.get("mainAgentInstanceId").and_then(Value::as_str))?;
        let main_session = self.require_main_session(&project_run)?;
        let run_id = self
            .runs
            .start(
                &main_session,
                &main.agent,
                "[AGENTHUB_DELEGATION_REJECTED]\nThe user rejected the requested child-Agent delegation. Do not retry, reassign, or take over automatically. Continue only if the user has already asked for other independent work; otherwise acknowledge the rejection briefly and end this turn.",
                RunContext {
                    project_run_id: Some(project_run_id.to_string()),
                    member_id: main.member.get("id").and_then(Value::as_str).map(str::to_string),
                    working_directory: self.working_directory(&project_run, None),
                    ..Default::default()
                },
            )
            .await?;
        self.runs.wait_completion(&run_id).await;
        Ok(())
    }

    async fn execute_main_turn(self: &Arc<Self>, project_run_id: &str) -> anyhow::Result<()> {
        let project_run = self.require_project_run(project_run_id)?;
        let team = self.require_team(project_run.get("teamId").and_then(Value::as_str).unwrap_or(""))?;
        let main_session = self.require_main_session(&project_run)?;
        let main = self.members().session_main(&team, project_run.get("mainAgentInstanceId").and_then(Value::as_str))?;
        let child_sessions: Vec<Value> = Repositories::new(&self.db.lock().unwrap().raw)
            .sessions()
            .list(project_run.get("projectId").and_then(Value::as_str).unwrap_or(""), None)?
            .into_iter()
            .filter(|session| session.get("parentSessionId").and_then(Value::as_str) == main_session.get("id").and_then(Value::as_str))
            .collect();
        // Read both collections under one short-lived guard. Borrowing two
        // repository results from temporary guards in the same build(...) call
        // keeps the first mutex locked while the second tries to acquire it.
        let (messages, artifacts) = {
            let db = self.db.lock().unwrap();
            let repos = Repositories::new(&db.raw);
            (
                repos.sessions().messages(main_session.get("id").and_then(Value::as_str).unwrap_or(""))?,
                repos.artifacts().list(Some(project_run_id), None, None)?,
            )
        };
        let continuity = ConversationContinuityBuilder::build(ContinuityInput {
            current_project_run_id: project_run_id,
            current_text: project_run.get("goal").and_then(Value::as_str).unwrap_or(""),
            messages: &messages,
            artifacts: &artifacts,
            recover_provider_context: main_session.get("providerSessionId").is_none()
                || main_session.get("providerContextSyncedAt").is_none(),
        });
        let run_id = self
            .runs
            .start(
                &main_session,
                &main.agent,
                &OrchestrationPromptBuilder::main_turn(
                    project_run.get("goal").and_then(Value::as_str).unwrap_or(""),
                    &team,
                    &child_sessions,
                    continuity.prompt.as_deref(),
                ),
                RunContext {
                    project_run_id: Some(project_run_id.to_string()),
                    member_id: main.member.get("id").and_then(Value::as_str).map(str::to_string),
                    working_directory: self.working_directory(&project_run, None),
                    local_image_paths: if continuity.local_image_paths.is_empty() { None } else { Some(continuity.local_image_paths) },
                    ..Default::default()
                },
            )
            .await?;
        let completion = self.runs.wait_completion(&run_id).await;
        self.assert_completed(completion.as_ref(), "main Agent turn")?;
        let task_count = Repositories::new(&self.db.lock().unwrap().raw).tasks().list(project_run_id)?.len();
        if task_count == 0 {
            self.finish_run(project_run_id, &main_session).await?;
        }
        Ok(())
    }

    async fn plan(self: &Arc<Self>, project_run_id: &str) -> anyhow::Result<()> {
        let project_run = self.require_project_run(project_run_id)?;
        let team = self.require_team(project_run.get("teamId").and_then(Value::as_str).unwrap_or(""))?;
        let main = self.members().session_main(&team, project_run.get("mainAgentInstanceId").and_then(Value::as_str))?;
        let main_session = self.require_main_session(&project_run)?;
        let child_sessions: Vec<Value> = Repositories::new(&self.db.lock().unwrap().raw)
            .sessions()
            .list(project_run.get("projectId").and_then(Value::as_str).unwrap_or(""), None)?
            .into_iter()
            .filter(|session| session.get("parentSessionId").and_then(Value::as_str) == main_session.get("id").and_then(Value::as_str))
            .filter(|session| {
                team.get("members").and_then(Value::as_array).is_some_and(|members| {
                    members.iter().any(|member| {
                        member.get("enabled").and_then(Value::as_bool) == Some(true)
                            && member.get("id").and_then(Value::as_str) == session.get("memberId").and_then(Value::as_str)
                    })
                })
            })
            .collect();
        let (previous_artifacts, current_artifacts, messages) = {
            let db = self.db.lock().unwrap();
            let repos = Repositories::new(&db.raw);
            let mut previous_runs: Vec<Value> = repos
                .project_runs()
                .list(project_run.get("projectId").and_then(Value::as_str).unwrap_or(""))?
                .into_iter()
                .filter(|run| run.get("id").and_then(Value::as_str) != Some(project_run_id))
                .collect();
            previous_runs.reverse();
            let mut previous = vec![];
            for run in &previous_runs {
                if let Some(id) = run.get("id").and_then(Value::as_str) {
                    previous.extend(repos.artifacts().list(Some(id), None, None)?);
                }
            }
            let current = repos.artifacts().list(Some(project_run_id), None, None)?;
            let messages = repos.sessions().messages(main_session.get("id").and_then(Value::as_str).unwrap_or(""))?;
            (previous, current, messages)
        };
        let continuity = ConversationContinuityBuilder::build(ContinuityInput {
            current_project_run_id: project_run_id,
            current_text: project_run.get("goal").and_then(Value::as_str).unwrap_or(""),
            messages: &messages,
            artifacts: &previous_artifacts.into_iter().chain(current_artifacts).collect::<Vec<_>>(),
            recover_provider_context: main_session.get("providerSessionId").is_none()
                || main_session.get("providerContextSyncedAt").is_none(),
        });
        let run_id = self
            .runs
            .start(
                &main_session,
                &main.agent,
                &OrchestrationPromptBuilder::planning(
                    project_run.get("goal").and_then(Value::as_str).unwrap_or(""),
                    &team,
                    &child_sessions,
                    continuity.prompt.as_deref(),
                ),
                RunContext {
                    project_run_id: Some(project_run_id.to_string()),
                    member_id: main.member.get("id").and_then(Value::as_str).map(str::to_string),
                    message_kind: Some("planner_decision".to_string()),
                    working_directory: self.working_directory(&project_run, None),
                    local_image_paths: if continuity.local_image_paths.is_empty() { None } else { Some(continuity.local_image_paths) },
                    ..Default::default()
                },
            )
            .await?;
        let completion = self.runs.wait_completion(&run_id).await;
        self.assert_completed(completion.as_ref(), "main Agent planning")?;
        let final_message = completion.as_ref().and_then(|c| c.final_message.clone()).unwrap_or_default();
        let decision = self.decisions().planner(&extract_json_object(&final_message)?, &team)?;
        let mode = decision.get("mode").and_then(Value::as_str).unwrap_or("");
        let task_ids: Value = match mode {
            "direct" => Value::Null,
            "delegate" => json!(vec![decision.get("task").and_then(|t| t.get("id")).cloned().unwrap_or(Value::Null)]),
            _ => json!(decision
                .get("tasks")
                .and_then(Value::as_array)
                .map(|tasks| tasks.iter().filter_map(|t| t.get("id").cloned()).collect::<Vec<_>>())
                .unwrap_or_default()),
        };
        let completion_run = completion.as_ref().map(|c| c.run.clone()).unwrap_or(Value::Null);
        let _ = self.events.append(&completion_run, &main_session, "planner.decision", json!({
            "mode": mode,
            "rationale": decision.get("rationale").cloned().unwrap_or(Value::Null),
            "taskIds": task_ids
        }));
        let mut updated = project_run.as_object().cloned().unwrap_or_default();
        updated.insert("plannerDecision".to_string(), decision.clone());
        updated.insert("updatedAt".to_string(), json!(now_iso()));
        self.save_project_run(&Value::Object(updated))?;

        if mode == "direct" {
            return self.execute_direct(project_run_id, false).await;
        }

        let planned: Vec<Value> = if mode == "delegate" {
            vec![decision.get("task").cloned().unwrap_or(Value::Null)]
        } else {
            decision.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default()
        };
        let approval_required = team.get("delegationPolicy").and_then(Value::as_str) == Some("ask_before_delegate");
        self.graph().create(project_run_id, &planned, approval_required)?;
        let tasks = Repositories::new(&self.db.lock().unwrap().raw).tasks().list(project_run_id)?;
        for task in &tasks {
            self.emit_task(&main_session, task);
        }

        if approval_required {
            let approval_id = Uuid::new_v4().to_string();
            self.approvals.request(&json!({
                "id": approval_id,
                "category": "delegate",
                "operation": "orchestration.delegate",
                "summary": format!("Delegate planned tasks for {}", project_run.get("goal").and_then(Value::as_str).unwrap_or("")),
                "projectId": project_run.get("projectId").cloned().unwrap_or(Value::Null),
                "projectRunId": project_run_id,
                "sessionId": main_session.get("id").cloned().unwrap_or(Value::Null),
                "requestedBy": project_run.get("mainMemberId").cloned().unwrap_or(Value::Null)
            }))?;
            let mut waiting = self.require_project_run(project_run_id)?.as_object().cloned().unwrap_or_default();
            waiting.insert("status".to_string(), json!("waiting_user"));
            waiting.insert("pendingApprovalId".to_string(), json!(approval_id));
            self.save_project_run(&Value::Object(waiting))?;
            let run_id_value = completion_run.get("id").cloned().unwrap_or(Value::Null);
            let _ = self.events.append_for_session(
                &main_session,
                &json!({ "projectRunId": project_run_id, "runId": run_id_value }),
                "approval.requested",
                json!({
                    "approvalId": approval_id,
                    "category": "delegate",
                    "summary": format!("{} delegated task{}: {}", planned.len(), if planned.len() == 1 { "" } else { "s" }, decision.get("rationale").and_then(Value::as_str).unwrap_or(""))
                }),
            );
            let _ = self.events.append_for_session(
                &main_session,
                &json!({ "projectRunId": project_run_id, "runId": run_id_value }),
                "run.waiting",
                json!({ "reason": "approval" }),
            );
            return Ok(());
        }

        let mut executing = self.require_project_run(project_run_id)?.as_object().cloned().unwrap_or_default();
        executing.insert("status".to_string(), json!("executing"));
        self.save_project_run(&Value::Object(executing))?;
        self.execute_tasks(project_run_id, None, None, None).await
    }

    async fn execute_direct(self: &Arc<Self>, project_run_id: &str, delegation_rejected: bool) -> anyhow::Result<()> {
        let project_run = self.require_project_run(project_run_id)?;
        let team = self.require_team(project_run.get("teamId").and_then(Value::as_str).unwrap_or(""))?;
        let main = self.members().session_main(&team, project_run.get("mainAgentInstanceId").and_then(Value::as_str))?;
        let main_session = self.require_main_session(&project_run)?;
        let mut executing = project_run.as_object().cloned().unwrap_or_default();
        executing.insert("status".to_string(), json!("executing"));
        self.save_project_run(&Value::Object(executing))?;
        let goal = project_run.get("goal").and_then(Value::as_str).unwrap_or("");
        let prompt = if delegation_rejected {
            OrchestrationPromptBuilder::delegation_rejected(goal)
        } else {
            OrchestrationPromptBuilder::direct_execution(goal)
        };
        let run_id = self
            .runs
            .start(
                &main_session,
                &main.agent,
                &prompt,
                RunContext {
                    project_run_id: Some(project_run_id.to_string()),
                    member_id: main.member.get("id").and_then(Value::as_str).map(str::to_string),
                    working_directory: self.working_directory(&project_run, None),
                    ..Default::default()
                },
            )
            .await?;
        let completion = self.runs.wait_completion(&run_id).await;
        self.assert_completed(completion.as_ref(), "direct execution")?;
        self.finish_run(project_run_id, &main_session).await
    }

    pub async fn execute_tasks(
        self: &Arc<Self>,
        project_run_id: &str,
        task_ids: Option<Vec<String>>,
        notify_dispatch: Option<bool>,
        finalize_project_run: Option<bool>,
    ) -> anyhow::Result<()> {
        let project_run = self.require_project_run(project_run_id)?;
        let team = self.require_team(project_run.get("teamId").and_then(Value::as_str).unwrap_or(""))?;
        let main_session = self.require_main_session(&project_run)?;

        loop {
            let ready: Vec<Value> = self
                .graph()
                .ready(project_run_id)?
                .into_iter()
                .filter(|task| {
                    task_ids.as_ref().is_none_or(|ids| {
                        task.get("id").and_then(Value::as_str).is_some_and(|id| ids.iter().any(|i| i == id))
                    })
                })
                .collect();
            if ready.is_empty() {
                break;
            }
            let mut member_counts: HashMap<String, usize> = HashMap::new();
            let mut wave: Vec<Value> = vec![];
            for task in &ready {
                let member_id = task.get("assignedMemberId").and_then(Value::as_str).unwrap_or("");
                let limit = configured_task_limit(team
                    .get("members")
                    .and_then(Value::as_array)
                    .and_then(|members| members.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(member_id)))
                    .and_then(|member| member.get("maxConcurrentTasks").and_then(Value::as_u64)));
                let count = member_counts.entry(member_id.to_string()).or_insert(0);
                if *count >= limit {
                    continue;
                }
                *count += 1;
                wave.push(task.clone());
            }
            let launchable = if wave.is_empty() { vec![ready[0].clone()] } else { wave };

            let mut receipts = vec![];
            let mut executions = vec![];
            for task in &launchable {
                let (receipt_rx, execution) = self.launch_task(&project_run, &team, &main_session, task);
                receipts.push(receipt_rx);
                executions.push(execution);
            }

            // Feed dispatch receipts back into the parent provider session
            // before awaiting any child completion.
            let mut child_receipts = vec![];
            let mut receipt_error = None;
            for receipt in receipts {
                match receipt.await {
                    Ok(value) => {
                        if value.get("sessionId").and_then(Value::as_str) != main_session.get("id").and_then(Value::as_str) {
                            child_receipts.push(value);
                        }
                    }
                    Err(error) => receipt_error = Some(error),
                }
            }
            let mut continuation_error = None;
            if receipt_error.is_none() && !child_receipts.is_empty() && notify_dispatch != Some(false) {
                if let Err(error) = self.continue_after_delegation(project_run_id, &child_receipts).await {
                    continuation_error = Some(error);
                }
            }

            let mut first_failure: Option<anyhow::Error> = receipt_error.map(|e| anyhow::anyhow!(e.to_string()));
            for execution in executions {
                match execution.await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        if first_failure.is_none() {
                            first_failure = Some(error);
                        }
                    }
                    Err(join_error) => {
                        if first_failure.is_none() {
                            first_failure = Some(anyhow::anyhow!(join_error.to_string()));
                        }
                    }
                }
            }
            if let Some(error) = continuation_error {
                return Err(error);
            }
            if let Some(error) = first_failure {
                return Err(error);
            }
        }

        // Never finalize while any task anywhere is unresolved.
        let all_tasks = Repositories::new(&self.db.lock().unwrap().raw).tasks().list(project_run_id)?;
        let all_unresolved = all_tasks.iter().filter(|task| {
            !["completed", "failed", "cancelled", "blocked_dependency"]
                .contains(&task.get("status").and_then(Value::as_str).unwrap_or(""))
        }).count();
        let can_finalize = finalize_project_run != Some(false) && all_unresolved == 0;
        let tasks: Vec<Value> = all_tasks
            .iter()
            .filter(|task| {
                task_ids.as_ref().is_none_or(|ids| {
                    task.get("id").and_then(Value::as_str).is_some_and(|id| ids.iter().any(|i| i == id))
                })
            })
            .cloned()
            .collect();
        let unresolved: Vec<&Value> = tasks
            .iter()
            .filter(|task| {
                !["completed", "failed", "cancelled", "blocked_dependency"]
                    .contains(&task.get("status").and_then(Value::as_str).unwrap_or(""))
            })
            .collect();
        if !unresolved.is_empty() {
            let mut details = Map::new();
            details.insert("projectRunId".to_string(), json!(project_run_id));
            details.insert(
                "taskIds".to_string(),
                json!(unresolved.iter().filter_map(|t| t.get("id").cloned()).collect::<Vec<_>>()),
            );
            return Err(CoreError::details(ErrorCode::RecoveryRequired, details).into());
        }

        // A task assigned to the main Agent already produced its user-facing
        // result in that provider turn.
        if tasks.len() == 1
            && tasks[0].get("status").and_then(Value::as_str) == Some("completed")
            && tasks[0].get("completedByMemberId").and_then(Value::as_str)
                == project_run.get("mainMemberId").and_then(Value::as_str)
        {
            if can_finalize {
                self.finish_run(project_run_id, &main_session).await?;
            }
            return Ok(());
        }

        let result_messages: Vec<Value> = Repositories::new(&self.db.lock().unwrap().raw)
            .sessions()
            .messages(main_session.get("id").and_then(Value::as_str).unwrap_or(""))?
            .into_iter()
            .filter(|message| {
                message.get("projectRunId").and_then(Value::as_str) == Some(project_run_id)
                    && message.get("kind").and_then(Value::as_str) == Some("result")
                    && message.get("sender").and_then(Value::as_str) == Some("system")
                    && message.get("taskId").is_some()
            })
            .collect();
        let results: Vec<Value> = tasks
            .iter()
            .map(|task| {
                let task_id = task.get("id").and_then(Value::as_str).unwrap_or("");
                let message = result_messages.iter().rev().find(|candidate| {
                    candidate.get("taskId").and_then(Value::as_str) == Some(task_id)
                });
                let member = team
                    .get("members")
                    .and_then(Value::as_array)
                    .and_then(|members| {
                        members
                            .iter()
                            .find(|m| m.get("id").and_then(Value::as_str) == task.get("assignedMemberId").and_then(Value::as_str))
                            .cloned()
                    });
                json!({
                    "taskId": task_id,
                    "memberName": member.and_then(|m| m.get("displayName").cloned()).unwrap_or(Value::Null),
                    "result": message.and_then(|m| m.get("text").cloned()).unwrap_or(Value::Null)
                })
            })
            .collect();
        let main = self.members().session_main(&team, project_run.get("mainAgentInstanceId").and_then(Value::as_str))?;
        let current_session = self.require_main_session(&self.require_project_run(project_run_id)?)?;
        let current_run = self.require_project_run(project_run_id)?;
        let run_id = self
            .runs
            .start(
                &current_session,
                &main.agent,
                &OrchestrationPromptBuilder::final_synthesis(
                    project_run.get("goal").and_then(Value::as_str).unwrap_or(""),
                    &tasks,
                    &results,
                ),
                RunContext {
                    project_run_id: Some(project_run_id.to_string()),
                    member_id: main.member.get("id").and_then(Value::as_str).map(str::to_string),
                    working_directory: self.working_directory(&current_run, None),
                    ..Default::default()
                },
            )
            .await?;
        let completion = self.runs.wait_completion(&run_id).await;
        self.assert_completed(completion.as_ref(), "final synthesis")?;

        if !can_finalize {
            return Ok(());
        }

        let latest_run = self.require_project_run(project_run_id)?;
        let failed_task_ids: Vec<String> = tasks
            .iter()
            .filter(|task| task.get("status").and_then(Value::as_str) == Some("failed"))
            .filter_map(|task| task.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        if !failed_task_ids.is_empty() {
            let mut failed = latest_run.as_object().cloned().unwrap_or_default();
            failed.insert("status".to_string(), json!("failed"));
            failed.insert("recoveryReason".to_string(), json!(format!("delegated_tasks_failed:{}", failed_task_ids.join(","))));
            self.save_project_run(&Value::Object(failed))?;
            return Ok(());
        }

        self.finish_run(project_run_id, &main_session).await
    }

    fn launch_task(
        self: &Arc<Self>,
        project_run: &Value,
        team: &Value,
        main_session: &Value,
        task: &Value,
    ) -> (tokio::sync::oneshot::Receiver<Value>, tokio::task::JoinHandle<anyhow::Result<()>>) {
        let (receipt_sender, receipt_receiver) = tokio::sync::oneshot::channel::<Value>();
        let service = self.clone_arc();
        let project_run = project_run.clone();
        let team = team.clone();
        let main_session = main_session.clone();
        let task = task.clone();
        let execution = tokio::spawn(async move {
            let mut receipt_sender = Some(receipt_sender);
            let result = service
                .execute_task(&project_run, &team, &main_session, &task, |receipt| {
                    if let Some(sender) = receipt_sender.take() {
                        let _ = sender.send(receipt);
                    }
                })
                .await;
            if result.is_err() {
                if let Some(sender) = receipt_sender.take() {
                    let _ = sender.send(json!({ "error": true }));
                }
            }
            result
        });
        (receipt_receiver, execution)
    }

    async fn execute_task(
        self: &Arc<Self>,
        project_run: &Value,
        team: &Value,
        main_session: &Value,
        task: &Value,
        on_dispatched: impl FnOnce(Value),
    ) -> anyhow::Result<()> {
        let mut task = task.clone();
        if self.git_workflows.is_some() && task.get("workspacePath").is_none() {
            task = self.git_workflows.as_ref().unwrap().initialize_task(project_run, &task).await?;
            Repositories::new(&self.db.lock().unwrap().raw).tasks().save(&task)?;
        }
        let assigned = self.members().resolve(
            team,
            task.get("assignedMemberId").and_then(Value::as_str).unwrap_or(""),
            task.get("taskType").and_then(Value::as_str),
        )?;
        let is_main = assigned.member.get("id").and_then(Value::as_str) == project_run.get("mainMemberId").and_then(Value::as_str);
        let task_session = if is_main {
            main_session.clone()
        } else {
            self.session_router().delegated(
                project_run,
                team,
                &assigned.member,
                main_session,
                task.get("id").and_then(Value::as_str).unwrap_or(""),
                task.get("title").and_then(Value::as_str).unwrap_or(""),
                task.get("targetSessionId").and_then(Value::as_str),
            )?
        };

        if !is_main {
            self.messages().delegation(main_session, &task_session, project_run, &task)?;
            let _ = self.events.append_for_session(
                main_session,
                &json!({ "projectRunId": project_run.get("id").cloned().unwrap_or(Value::Null), "taskId": task.get("id").cloned().unwrap_or(Value::Null) }),
                "handoff.created",
                json!({
                    "fromMemberId": project_run.get("mainMemberId").cloned().unwrap_or(Value::Null),
                    "toMemberId": assigned.member.get("id").cloned().unwrap_or(Value::Null),
                    "summary": task.get("title").cloned().unwrap_or(Value::Null),
                    "artifactIds": [],
                    "taskId": task.get("id").cloned().unwrap_or(Value::Null),
                    "targetSessionId": task_session.get("id").cloned().unwrap_or(Value::Null)
                }),
            );
        }

        let mut current_task = self.update_task(main_session, &task, "queued", None)?;
        current_task = self.update_task(main_session, &current_task, "running", None)?;
        let run_id = self
            .runs
            .start(
                &task_session,
                &assigned.agent,
                &OrchestrationPromptBuilder::delegated_task(
                    &current_task,
                    team,
                    &self.dependency_outcomes(project_run, team, &current_task)?,
                ),
                RunContext {
                    project_run_id: Some(project_run.get("id").and_then(Value::as_str).unwrap_or("").to_string()),
                    task_id: Some(task.get("id").and_then(Value::as_str).unwrap_or("").to_string()),
                    member_id: assigned.member.get("id").and_then(Value::as_str).map(str::to_string),
                    working_directory: self.working_directory(project_run, Some(&current_task)),
                    ..Default::default()
                },
            )
            .await?;
        on_dispatched(json!({
            "taskId": current_task.get("id").cloned().unwrap_or(Value::Null),
            "title": current_task.get("title").cloned().unwrap_or(Value::Null),
            "assignedMemberId": assigned.member.get("id").cloned().unwrap_or(Value::Null),
            "memberName": assigned.member.get("displayName").cloned().unwrap_or(Value::Null),
            "sessionId": task_session.get("id").cloned().unwrap_or(Value::Null),
            "runId": run_id
        }));
        let completion = self.runs.wait_completion(&run_id).await;
        let run_status = completion
            .as_ref()
            .and_then(|c| c.run.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("failed");

        if run_status == "completed" {
            if let Some(git) = &self.git_workflows {
                current_task = self.update_task(main_session, &current_task, "verifying", None)?;
                let finalized = git
                    .finalize_task(&self.require_project_run(project_run.get("id").and_then(Value::as_str).unwrap_or(""))?, &current_task, &task_session, main_session)
                    .await?;
                if finalized.get("ok").and_then(Value::as_bool) != Some(true) {
                    current_task = self.update_task(
                        main_session,
                        &current_task,
                        "failed",
                        finalized.get("task").cloned(),
                    )?;
                    let reason = finalized.get("reason").and_then(Value::as_str).unwrap_or("");
                    let message = finalized.get("message").and_then(Value::as_str).unwrap_or("");
                    if reason == "path" {
                        self.messages().system(main_session, project_run, &format!("PATH_POLICY_VIOLATION: {message}"), "recovery")?;
                    }
                    if reason == "conflict" {
                        self.messages().system(main_session, project_run, &format!("MERGE_CONFLICT: {message}"), "recovery")?;
                    }
                    if !is_main {
                        self.return_result(project_run, main_session, &current_task, message)?;
                    }
                    return Ok(());
                }
                current_task = self.update_task(main_session, &current_task, "merge_ready", finalized.get("task").cloned())?;
            }
            current_task = self.update_task(
                main_session,
                &current_task,
                "completed",
                Some(json!({ "completedByMemberId": assigned.member.get("id").cloned().unwrap_or(Value::Null) })),
            )?;
            if !is_main {
                let result = completion.as_ref().and_then(|c| c.final_message.clone()).unwrap_or_else(|| "Task completed.".to_string());
                self.return_result(project_run, main_session, &current_task, &result)?;
            }
            return Ok(());
        }

        current_task = self.update_task(main_session, &current_task, "failed", None)?;
        let failure = completion
            .as_ref()
            .and_then(|c| c.run.get("failureCode").and_then(Value::as_str).map(str::to_string))
            .or_else(|| completion.as_ref().and_then(|c| c.final_message.clone()))
            .unwrap_or_else(|| format!("Run ended with {run_status}"));
        if !is_main {
            self.return_result(project_run, main_session, &current_task, &failure)?;
        }
        Ok(())
    }

    async fn continue_after_delegation(self: &Arc<Self>, project_run_id: &str, receipts: &[Value]) -> anyhow::Result<()> {
        let project_run = self.require_project_run(project_run_id)?;
        let team = self.require_team(project_run.get("teamId").and_then(Value::as_str).unwrap_or(""))?;
        let main = self.members().session_main(&team, project_run.get("mainAgentInstanceId").and_then(Value::as_str))?;
        let main_session = self.require_main_session(&project_run)?;
        let run_id = self
            .runs
            .start(
                &main_session,
                &main.agent,
                &OrchestrationPromptBuilder::delegation_accepted(
                    project_run.get("goal").and_then(Value::as_str).unwrap_or(""),
                    receipts,
                ),
                RunContext {
                    project_run_id: Some(project_run_id.to_string()),
                    member_id: main.member.get("id").and_then(Value::as_str).map(str::to_string),
                    working_directory: self.working_directory(&project_run, None),
                    ..Default::default()
                },
            )
            .await?;
        let completion = self.runs.wait_completion(&run_id).await;
        self.assert_completed(completion.as_ref(), "delegation acknowledgement")
    }

    fn return_result(&self, project_run: &Value, main_session: &Value, task: &Value, result: &str) -> CoreResult<()> {
        self.messages().result(main_session, project_run, task, result)?;
        let _ = self.events.append_for_session(
            main_session,
            &json!({ "projectRunId": project_run.get("id").cloned().unwrap_or(Value::Null), "taskId": task.get("id").cloned().unwrap_or(Value::Null) }),
            "handoff.created",
            json!({
                "fromMemberId": task.get("assignedMemberId").cloned().unwrap_or(Value::Null),
                "toMemberId": project_run.get("mainMemberId").cloned().unwrap_or(Value::Null),
                "summary": result.chars().take(500).collect::<String>(),
                "artifactIds": [],
                "taskId": task.get("id").cloned().unwrap_or(Value::Null),
                "targetSessionId": main_session.get("id").cloned().unwrap_or(Value::Null)
            }),
        );
        Ok(())
    }

    fn dependency_outcomes(&self, project_run: &Value, team: &Value, task: &Value) -> CoreResult<Vec<Value>> {
        let dependencies = task.get("dependencies").and_then(Value::as_array).cloned().unwrap_or_default();
        if dependencies.is_empty() {
            return Ok(vec![]);
        }
        let project_run_id = project_run.get("id").and_then(Value::as_str).unwrap_or("");
        let main_session = self.require_main_session(project_run)?;
        let result_messages: Vec<Value> = Repositories::new(&self.db.lock().unwrap().raw)
            .sessions()
            .messages(main_session.get("id").and_then(Value::as_str).unwrap_or(""))?
            .into_iter()
            .filter(|message| {
                message.get("projectRunId").and_then(Value::as_str) == Some(project_run_id)
                    && message.get("kind").and_then(Value::as_str) == Some("result")
                    && message.get("sender").and_then(Value::as_str) == Some("system")
                    && message.get("taskId").is_some()
            })
            .collect();
        let mut outcomes = vec![];
        for dependency in dependencies {
            let task_id = dependency.as_str().unwrap_or("");
            let dependency_task = Repositories::new(&self.db.lock().unwrap().raw).tasks().get(task_id)?;
            let result = result_messages
                .iter()
                .rev()
                .find(|message| message.get("taskId").and_then(Value::as_str) == Some(task_id))
                .and_then(|message| message.get("text").and_then(Value::as_str))
                .map(|text| text.chars().take(16_000).collect::<String>());
            let member = team.get("members").and_then(Value::as_array).and_then(|members| {
                members
                    .iter()
                    .find(|m| {
                        Some(m.get("id").and_then(Value::as_str).unwrap_or(""))
                            == dependency_task.as_ref().and_then(|t| t.get("assignedMemberId")).and_then(Value::as_str)
                    })
                    .cloned()
            });
            outcomes.push(json!({
                "taskId": task_id,
                "title": dependency_task.as_ref().and_then(|t| t.get("title").cloned()).unwrap_or_else(|| json!(task_id)),
                "status": dependency_task.as_ref().and_then(|t| t.get("status").cloned()).unwrap_or_else(|| json!("blocked_dependency")),
                "assignedMemberId": dependency_task.as_ref().and_then(|t| t.get("assignedMemberId").cloned()).unwrap_or(Value::Null),
                "memberName": member.and_then(|m| m.get("displayName").cloned()).unwrap_or(Value::Null),
                "result": result.map(Value::String).unwrap_or(Value::Null)
            }));
        }
        Ok(outcomes)
    }

    async fn finish_run(&self, project_run_id: &str, main_session: &Value) -> anyhow::Result<()> {
        let project_run = self.require_project_run(project_run_id)?;
        let Some(git) = &self.git_workflows else {
            let mut updated = project_run.as_object().cloned().unwrap_or_default();
            updated.insert("status".to_string(), json!("completed"));
            self.save_project_run(&Value::Object(updated))?;
            return Ok(());
        };
        let mut verifying = project_run.as_object().cloned().unwrap_or_default();
        verifying.insert("status".to_string(), json!("verifying"));
        let verifying = self.save_project_run(&Value::Object(verifying))?;
        let finalized = git.finalize_run(&verifying, main_session).await?;
        let finalized_run = finalized.get("projectRun").cloned().unwrap_or(Value::Null);
        if finalized.get("needsMergeApproval").and_then(Value::as_bool) != Some(true) {
            let mut completed = finalized_run.as_object().cloned().unwrap_or_default();
            completed.insert("status".to_string(), json!("completed"));
            self.save_project_run(&Value::Object(completed))?;
            return Ok(());
        }
        let approval_id = Uuid::new_v4().to_string();
        self.approvals.request(&json!({
            "id": approval_id,
            "category": "merge",
            "operation": "git.merge.final",
            "summary": format!("Merge {} into {}", finalized_run.get("branchName").and_then(Value::as_str).unwrap_or(""), finalized_run.get("baseBranch").and_then(Value::as_str).unwrap_or("")),
            "projectId": finalized_run.get("projectId").cloned().unwrap_or(Value::Null),
            "projectRunId": project_run_id,
            "sessionId": main_session.get("id").cloned().unwrap_or(Value::Null),
            "requestedBy": finalized_run.get("mainMemberId").cloned().unwrap_or(Value::Null)
        }))?;
        let mut merge_ready = finalized_run.as_object().cloned().unwrap_or_default();
        merge_ready.insert("status".to_string(), json!("merge_ready"));
        merge_ready.insert("mergeApprovalId".to_string(), json!(approval_id));
        let merge_ready = self.save_project_run(&Value::Object(merge_ready))?;
        let _ = self.events.append_for_session(
            main_session,
            &json!({ "projectRunId": project_run_id }),
            "approval.requested",
            json!({
                "approvalId": approval_id,
                "category": "merge",
                "summary": format!("Merge {} into {}. Nautilo will not push.", merge_ready.get("branchName").and_then(Value::as_str).unwrap_or(""), merge_ready.get("baseBranch").and_then(Value::as_str).unwrap_or(""))
            }),
        );
        let _ = self.events.append_for_session(
            main_session,
            &json!({ "projectRunId": project_run_id }),
            "run.waiting",
            json!({ "reason": "approval" }),
        );
        Ok(())
    }

    fn working_directory(&self, project_run: &Value, task: Option<&Value>) -> Option<String> {
        self.git_workflows.as_ref().and_then(|git| git.working_directory(project_run, task))
    }

    fn update_task(&self, main_session: &Value, task: &Value, status: &str, patch: Option<Value>) -> CoreResult<Value> {
        let updated = self.graph().save_status(task, status, patch)?;
        self.emit_task(main_session, &updated);
        Ok(updated)
    }

    fn emit_task(&self, main_session: &Value, task: &Value) {
        let _ = self.events.append_for_session(
            main_session,
            &json!({
                "projectRunId": task.get("projectRunId").cloned().unwrap_or(Value::Null),
                "taskId": task.get("id").cloned().unwrap_or(Value::Null)
            }),
            "task.updated",
            json!({
                "taskId": task.get("id").cloned().unwrap_or(Value::Null),
                "status": task.get("status").cloned().unwrap_or(Value::Null),
                "assignedMemberId": task.get("assignedMemberId").cloned().unwrap_or(Value::Null)
            }),
        );
    }

    fn assert_completed(&self, completion: Option<&crate::runtime::run_service::RunCompletionSnapshot>, operation: &str) -> anyhow::Result<()> {
        let status = completion
            .and_then(|c| c.run.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("failed");
        if status != "completed" {
            let mut details = Map::new();
            details.insert("operation".to_string(), json!(operation));
            details.insert("status".to_string(), json!(status));
            if let Some(run) = completion.map(|c| &c.run) {
                details.insert("runId".to_string(), run.get("id").cloned().unwrap_or(Value::Null));
                details.insert("failureCode".to_string(), run.get("failureCode").cloned().unwrap_or(Value::Null));
            }
            return Err(CoreError::details(ErrorCode::RunStartFailed, details).into());
        }
        Ok(())
    }

    fn schedule(self: &Arc<Self>, project_run_id: &str, operation: impl std::future::Future<Output = anyhow::Result<()>> + Send + 'static) {
        let service = self.clone_arc();
        let id = project_run_id.to_string();
        let handle = tokio::spawn(async move {
            if let Err(error) = operation.await {
                service.fail_project_run(&id, &error);
            }
            service.active.lock().unwrap().remove(&id);
        });
        self.active.lock().unwrap().insert(project_run_id.to_string(), handle);
    }

    fn fail_project_run(&self, project_run_id: &str, error: &anyhow::Error) {
        let Ok(Some(project_run)) = Repositories::new(&self.db.lock().unwrap().raw).project_runs().get(project_run_id) else {
            return;
        };
        if project_run.get("status").and_then(Value::as_str) == Some("cancelled") {
            return;
        }
        let mut failed = project_run.as_object().cloned().unwrap_or_default();
        failed.insert("status".to_string(), json!("failed"));
        let Ok(failed) = self.save_project_run(&Value::Object(failed)) else {
            return;
        };
        let main_session = failed
            .get("mainSessionId")
            .and_then(Value::as_str)
            .and_then(|id| Repositories::new(&self.db.lock().unwrap().raw).sessions().get(id).ok().flatten());
        if let Some(main_session) = main_session {
            let message = match error.downcast_ref::<CoreError>() {
                Some(core) => format!("{}: {}", core.0.code, core.0.message),
                None => error.to_string(),
            };
            let _ = self.messages().system(&main_session, &failed, &message, "recovery");
        }
    }

    fn save_project_run(&self, project_run: &Value) -> CoreResult<Value> {
        let id = project_run.get("id").and_then(Value::as_str).unwrap_or("");
        let current = Repositories::new(&self.db.lock().unwrap().raw).project_runs().get(id)?;
        if let Some(current) = &current {
            let from = current.get("status").and_then(Value::as_str).unwrap_or("");
            let to = project_run.get("status").and_then(Value::as_str).unwrap_or("");
            if from != to && !can_transition_project_run(from, to) {
                return Err(CoreError::reason(
                    ErrorCode::IpcInternalError,
                    format!("Invalid project run transition {from} -> {to} for {id}"),
                ));
            }
        }
        let mut updated = project_run.as_object().cloned().unwrap_or_default();
        updated.insert("updatedAt".to_string(), json!(now_iso()));
        let updated = Value::Object(updated);
        Repositories::new(&self.db.lock().unwrap().raw).project_runs().save(&updated)?;
        Ok(updated)
    }

    fn require_project_run(&self, project_run_id: &str) -> CoreResult<Value> {
        Repositories::new(&self.db.lock().unwrap().raw)
            .project_runs()
            .get(project_run_id)?
            .ok_or_else(|| not_found("projectRun", project_run_id))
    }

    fn require_team(&self, team_id: &str) -> CoreResult<Value> {
        Repositories::new(&self.db.lock().unwrap().raw)
            .teams()
            .get(team_id)?
            .ok_or_else(|| not_found("team", team_id))
    }

    fn require_main_session(&self, project_run: &Value) -> CoreResult<Value> {
        let session = project_run
            .get("mainSessionId")
            .and_then(Value::as_str)
            .and_then(|id| Repositories::new(&self.db.lock().unwrap().raw).sessions().get(id).ok().flatten());
        session.ok_or_else(|| not_found("mainSession", project_run.get("id").and_then(Value::as_str).unwrap_or("")))
    }
}


/// Match the renderer/TS positive safe-integer setting; absent means no cap.
fn configured_task_limit(value: Option<u64>) -> usize {
    value.filter(|limit| *limit > 0 && *limit <= 9_007_199_254_740_991)
        .map(|limit| usize::try_from(limit).unwrap_or(usize::MAX))
        .unwrap_or(usize::MAX)
}

#[cfg(test)]
mod concurrency_limit_tests {
    use super::configured_task_limit;

    #[test]
    fn member_concurrency_is_unlimited_unless_explicitly_configured() {
        assert_eq!(configured_task_limit(None), usize::MAX);
        assert_eq!(configured_task_limit(Some(0)), usize::MAX);
        assert_eq!(configured_task_limit(Some(1)), 1);
        assert_eq!(configured_task_limit(Some(2)), 2);
        assert_eq!(configured_task_limit(Some(8)), 8);
        assert_eq!(configured_task_limit(Some(100)), 100);
    }
}
