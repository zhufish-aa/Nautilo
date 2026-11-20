use super::*;
use crate::runtime::orchestration::prompt_builder::OrchestrationPromptBuilder;
use crate::runtime::workflow::{Message, NativeWork, ProjectTaskPlan, TaskProjection};

pub(super) fn attach_authored_project(
    repos: &Repositories<'_>, run: &mut WorkflowRun, parent: &Value, invoking_run_id: Option<&str>,
) -> CoreResult<Option<Value>> {
    let Some(id) = parent["projectRunId"].as_str() else { return Ok(None); };
    let Some(mut project) = repos.project_runs().get(id)? else { return Ok(None); };
    if !run.active() || project["mainSessionId"] != run.session_id
        || project["teamId"] != parent["teamId"] || project["projectId"] != run.project_id
        || parent["parentSessionId"].is_string() || !project["teamId"].is_string()
    {
        return Ok(None);
    }
    if matches!(project["status"].as_str(), Some("verifying" | "merge_ready" | "merging" | "paused" | "failed" | "cancelled")) {
        return Err(invalid("projectRun", "Finish or recover this project run before starting another workflow"));
    }
    if let Some(workspace) = &mut run.workspace {
        workspace.context = json!({"adoptedProjectRunId":id,"integrationKey":format!("task-plan:{id}"),"parentWorkspace":project,"workspaceMode":project["workspaceMode"].as_str().unwrap_or("direct")});
    }
    run.acceptance = Some(crate::runtime::workflow::Acceptance::default());
    run.task_projection = Some(TaskProjection {
        project_run_id: id.into(),
        team_id: project["teamId"].as_str().unwrap_or("").into(),
        main_member_id: parent["memberId"].as_str().unwrap_or("").into(),
        tasks: Default::default(), sessions: Default::default(),
        main_working_directory: project["workspacePath"].as_str().map(str::to_owned),
        workspaces: Default::default(), task_texts: Default::default(),
        return_to_main: false,
        project_plan: Some(ProjectTaskPlan {
            mode: "workflow".into(), invoking_run_id: invoking_run_id.map(str::to_owned),
            finalize: true, stage: "tasks".into(), goal: project["goal"].as_str().unwrap_or("").into(),
            from_planner: false, rejected: false, native_work: None,
        }),
    });
    project.as_object_mut().unwrap().remove("workflowFinalizerId");
    if !project["pendingApprovalId"].is_string() {
        project["status"] = json!("executing");
    }
    project["updatedAt"] = json!(now_iso());
    Ok(Some(project))
}

impl WorkflowService {
    pub(super) fn deliver_workflow_result(
        &self,
        run: &WorkflowRun,
        message: &Message,
        session_id: &str,
    ) -> CoreResult<()> {
        let event = self.change_with_db(&run.id, |db, current, event_builder| {
            let message = current.messages.iter_mut().find(|entry| entry.id == message.id)
                .ok_or("Missing workflow result message")?;
            if message.status != "queued" {
                return Ok(None);
            }
            let repos = Repositories::new(db);
            let session = repos.sessions().get(session_id)
                .map_err(|error| error.to_string())?.ok_or("Workflow caller session is missing")?;
            let result = json!({"id":message.id,"sessionId":session_id,"sender":"system","kind":"result","text":message.text,"createdAt":now_iso(),"workflowRunId":current.id});
            repos.sessions().save_message(&result).map_err(|error| error.to_string())?;
            message.status = "delivered".into();
            let mut event = event_builder.prepare_for_session(
                &session, &json!({}), "workflow.message",
                json!({"workflowRunId":current.id,"message":message}),
            );
            repos.events().append_in_transaction(&mut event).map_err(|error| error.to_string())?;
            Ok(Some(event))
        })?;
        if let Some(event) = event {
            self.events.publish_committed(&[event]);
        }
        Ok(())
    }

    pub(crate) fn apply_workflow_approval(
        &self, workflow_id: &str, approval_id: &str, approved: bool,
    ) -> CoreResult<()> {
        self.change_with_db(workflow_id, |db, run, _| {
            if run.approval_id.as_deref() != Some(approval_id) {
                return Ok(());
            }
            let repos = Repositories::new(db);
            let approval = repos.approvals().get(approval_id).map_err(|error| error.to_string())?;
            if approval.as_ref().is_none_or(|record| {
                record["status"] != if approved { "approved" } else { "rejected" }
            }) {
                return Err("Workflow approval is still pending or has a different decision".into());
            }
            run.approval_id = None;
            let managed = run.task_projection.as_mut().and_then(|source| {
                source.project_plan.as_mut().map(|plan| (&source.project_run_id, plan))
            });
            if let Some((project_id, plan)) = managed {
                plan.rejected = !approved;
                release_project_approval(&repos, project_id, approval_id)?;
                if !approved {
                    run.pause(false, now());
                    for instance in run.instances.iter_mut().filter(|instance| instance.active()) {
                        instance.status = "cancelled".into();
                        if let Some(gate) = &mut instance.acceptance {
                            gate.status = "cancelled".into();
                        }
                    }
                    run.result = Some(json!({"delegation":"rejected"}));
                    run.event("workflow.delegation_rejected", None, "Delegation was rejected", json!({"approvalId":approval_id}), now());
                    return run.settle(now());
                }
            }
            if approved {
                run.pause(false, now());
            } else {
                run.cancel(now());
            }
            Ok(())
        })
    }

    pub(crate) fn cancel_project_graphs(&self, project_run_id: &str) -> CoreResult<()> {
        let ids = workflows::project_graphs(&self.db.lock().unwrap().raw, project_run_id)?;
        for id in ids {
            let run = self.get(&id)?;
            if run.active() || run.status == "needs_decision" {
                self.control(&json!({"runId":id,"action":"cancel"}))?;
            }
        }
        Ok(())
    }

    pub(super) fn advance_project_plan(&self, id: &str) -> CoreResult<()> {
        let run = self.get(id)?;
        let Some(plan) = run.task_projection.as_ref().and_then(|source| source.project_plan.as_ref()) else {
            return Ok(());
        };
        if plan.stage == "done" || !matches!(run.status.as_str(), "finalizing" | "completed" | "needs_decision" | "cancelled") {
            return Ok(());
        }
        self.change_with_db(id, |db, run, _| advance(db, run).map_err(|error| error.to_string()))
    }
}

pub(super) fn release_project_approval(
    repos: &Repositories<'_>, project_id: &str, approval_id: &str,
) -> Result<(), String> {
    let mut project = repos.project_runs().get(project_id).map_err(|error| error.to_string())?
        .ok_or("Project run is missing")?;
    if project["pendingApprovalId"] != approval_id {
        return Ok(());
    }
    let next = repos.approvals().list(Some("pending"), Some(project_id)).map_err(|error| error.to_string())?
        .into_iter().find(|record| record["category"] == "delegate" && record["workflowRunId"].is_string());
    if let Some(next) = next {
        project["pendingApprovalId"] = next["id"].clone();
    } else {
        project.as_object_mut().unwrap().remove("pendingApprovalId");
        if project["status"] == "waiting_user" {
            project["status"] = json!("executing");
        }
    }
    save_project(repos, &mut project).map_err(|error| error.to_string())
}

fn save_project(repos: &Repositories<'_>, project: &mut Value) -> CoreResult<()> {
    project["updatedAt"] = json!(now_iso());
    repos.project_runs().save(project)
}

fn advance(db: &rusqlite::Connection, run: &mut WorkflowRun) -> CoreResult<()> {
    let source = run.task_projection.as_ref().unwrap();
    let mut plan = source.project_plan.clone().unwrap();
    let project_id = source.project_run_id.clone();
    let repos = Repositories::new(db);
    let mut project = repos.project_runs().get(&project_id)?.ok_or_else(|| not_found("projectRun", &project_id))?;
    let owner = project["workflowFinalizerId"] == run.id;
    let same_session = project["mainSessionId"] == run.session_id;
    if plan.stage == "done" {
        return Ok(());
    }
    if !same_session || project["status"] == "cancelled" || run.status == "cancelled" {
        if run.active() {
            run.cancel(now());
        }
        if same_session && project["status"] != "cancelled" && owner {
            project["status"] = json!("review_required");
            project.as_object_mut().unwrap().remove("mergeApprovalId");
            save_project(&repos, &mut project)?;
        }
        plan.stage = "done".into();
    } else if plan.stage == "acceptance" {
        let stage = run.workspace.as_ref().map(|workspace| workspace.stage.as_str());
        if matches!(run.status.as_str(), "completed" | "needs_decision") {
            if owner {
                project["status"] = json!(match (run.status.as_str(), stage) {
                    ("completed", Some("retained")) => "review_required",
                    ("completed", _) => "completed",
                    ("needs_decision", _) => "review_required",
                    _ => unreachable!(),
                });
                if let Some(outcome) = run.workspace.as_ref().and_then(|workspace| workspace.outcome.as_ref()) {
                    project["diffArtifactId"] = outcome["diffArtifactId"].clone();
                    project["finalVerificationResults"] = outcome["verificationResults"].clone();
                    if outcome["merge"]["merged"] == true {
                        project["resultCommit"] = outcome["sourceCommit"].clone();
                        // The verified commit is now on both branches. Further
                        // turns must compare against this accepted base.
                        if outcome["merge"]["commit"] == outcome["sourceCommit"] {
                            project["baseCommit"] = outcome["sourceCommit"].clone();
                        }
                    }
                }
                project.as_object_mut().unwrap().remove("mergeApprovalId");
                save_project(&repos, &mut project)?;
            }
            plan.stage = "done".into();
        } else if owner {
            if let Some(workspace) = &run.workspace {
                let status = match stage {
                    Some("waiting_merge") => "merge_ready",
                    Some("merging") => "merging",
                    _ => "verifying",
                };
                if project["status"] != status {
                    project["status"] = json!(status);
                    if matches!(stage, Some("waiting_merge" | "merging")) {
                        project["mergeApprovalId"] = json!(workspace.approval_id);
                    }
                    save_project(&repos, &mut project)?;
                }
            }
        }
    } else if plan.stage == "summary" {
        let key = summary_key(run);
        if let Some(message) = run.messages.iter().find(|message| message.id == key) {
            if !owner && message.status == "queued" {
                run.messages.iter_mut().find(|message| message.id == key).unwrap().status = "resolved".into();
                release_gate(run)?;
                plan.stage = "done".into();
            } else if message.status == "uncertain" {
                if owner {
                    fail_summary(&repos, &mut project, run, "Main Agent delivery could not be confirmed")?;
                } else {
                    release_gate(run)?;
                }
                plan.stage = "done".into();
            } else if message.status == "delivered" {
                let saved = message.run_id.as_deref().map(|id| repos.runs().get(id)).transpose()?.flatten();
                if let Some(saved) = saved.filter(|saved| terminal(&saved["status"])) {
                    let run_id = saved["id"].as_str().unwrap_or("");
                    let (work, waiting) = native_finished(db, &saved, plan.native_work.take())?;
                    let failure = work.failure();
                    plan.native_work = Some(work);
                    if failure.is_none() && waiting && now() - run.created_at < run.definition.limits.timeout_ms {
                        // The foreground response is saved, but a native
                        // background task can still be changing the worktree.
                    } else if !owner {
                        release_gate(run)?;
                        plan.stage = "done".into();
                    } else if saved["status"] != "completed" || failure.is_some() || waiting {
                        let reason = failure.unwrap_or_else(|| format!("Main Agent run {run_id} did not complete successfully"));
                        fail_summary(&repos, &mut project, run, &reason)?;
                        plan.stage = "done".into();
                    } else {
                        begin_acceptance(&repos, &mut project, run, &mut plan)?;
                    }
                }
            }
        }
    } else if plan.stage == "tasks" {
        let owning_other = project["workflowFinalizerId"].is_string() && !owner;
        if owning_other || !plan.finalize {
            release_gate(run)?;
            plan.stage = "done".into();
        } else if project["status"] != "waiting_user"
            && !workflows::project_has_foreground_work(db, &project_id)?
        {
            let mut pending = false;
            for sibling_id in workflows::project_graphs(db, &project_id)? {
                if sibling_id == run.id {
                    continue;
                }
                let sibling = workflows::get(db, &sibling_id)?.ok_or_else(|| not_found("workflowRun", &sibling_id))?;
                if matches!(sibling.status.as_str(), "running" | "paused")
                    || sibling.instances.iter().any(|instance| instance.native_work.as_ref().is_some_and(|work| work.pending()))
                {
                    pending = true;
                    break;
                }
            }
            let tasks = repos.tasks().list(&project_id)?;
            if !pending && !tasks.iter().any(|task| {
                ["ready","blocked_dependency","waiting_approval","queued","running","verifying"].contains(&task["status"].as_str().unwrap_or(""))
            }) {
                let invoker = plan.invoking_run_id.as_deref().map(|id| repos.runs().get(id)).transpose()?.flatten();
                let mut native_failure = None;
                if let Some(saved) = invoker {
                    let (work, waiting) = native_finished(db, &saved, plan.native_work.take())?;
                    native_failure = work.failure();
                    plan.native_work = Some(work);
                    if waiting && native_failure.is_none() && now() - run.created_at < run.definition.limits.timeout_ms {
                        run.task_projection.as_mut().unwrap().project_plan = Some(plan);
                        return Ok(());
                    }
                    if waiting && native_failure.is_none() {
                        native_failure = Some("The main Agent's native background tasks did not finish before the workflow deadline".into());
                    }
                }
                project["workflowFinalizerId"] = json!(run.id);
                if let Some(reason) = native_failure {
                    fail_summary(&repos, &mut project, run, &reason)?;
                    plan.stage = "done".into();
                } else if run.status == "needs_decision" || tasks.iter().any(|task| task["status"] == "failed") {
                    project["status"] = json!("failed");
                    project["recoveryReason"] = json!(run.error.as_deref().unwrap_or("A delegated task needs recovery"));
                    save_project(&repos, &mut project)?;
                    release_gate(run)?;
                    plan.stage = "done".into();
                } else {
                    let prompt = if plan.rejected {
                        if plan.mode == "workflow" {
                            None
                        } else if plan.from_planner {
                            Some(OrchestrationPromptBuilder::delegation_rejected(&plan.goal))
                        } else {
                            Some("The user rejected the requested delegation. Acknowledge the decision and end the turn. Do not retry, reassign, or take over the rejected tasks.".into())
                        }
                    } else if tasks.iter().any(|task| task["status"] == "completed" && task["assignedMemberId"] != source.main_member_id) {
                        let messages = repos.sessions().messages(&run.session_id)?;
                        let results: Vec<Value> = tasks.iter().filter_map(|task| {
                            let receipt = messages.iter().rev().find(|message| message["taskId"] == task["id"] && message["kind"] == "result")?;
                            Some(json!({"taskId":task["id"],"result":receipt["text"]}))
                        }).collect();
                        Some(OrchestrationPromptBuilder::final_synthesis(&plan.goal, &tasks, &results))
                    } else {
                        None
                    };
                    if let Some(prompt) = prompt {
                        run.queue_main_message(summary_key(run), &prompt, false, now());
                        plan.stage = "summary".into();
                        plan.native_work = None;
                        save_project(&repos, &mut project)?;
                    } else {
                        begin_acceptance(&repos, &mut project, run, &mut plan)?;
                    }
                }
            }
        }
    }
    run.task_projection.as_mut().unwrap().project_plan = Some(plan);
    Ok(())
}

fn native_finished(
    db: &rusqlite::Connection, saved: &Value, previous: Option<NativeWork>,
) -> CoreResult<(NativeWork, bool)> {
    let id = saved["id"].as_str().unwrap_or("");
    let mut work = previous.filter(|work| work.run_id == id).unwrap_or_else(|| NativeWork::new(id));
    for event in workflows::native_work_events(db, id, work.last_sequence)? {
        work.observe(&event);
    }
    let waiting = work.pending();
    Ok((work, waiting))
}

fn summary_key(run: &WorkflowRun) -> String {
    format!("{}:project-summary", run.id)
}

fn release_gate(run: &mut WorkflowRun) -> CoreResult<()> {
    if run.status == "finalizing" {
        run.acceptance = None;
        run.settle(now()).map_err(|error| invalid("workflow", &error))?;
    }
    Ok(())
}

fn fail_summary(
    repos: &Repositories<'_>, project: &mut Value, run: &mut WorkflowRun, reason: &str,
) -> CoreResult<()> {
    project["status"] = json!("failed");
    project["recoveryReason"] = json!(reason);
    save_project(repos, project)?;
    run.escalate(reason, now());
    // The failed continuation is already recorded and must not trigger
    // another model round on the same unconfirmed native context.
    for message in run.messages.iter_mut().filter(|message| message.status == "queued") {
        message.data_only = true;
    }
    Ok(())
}

fn begin_acceptance(
    repos: &Repositories<'_>, project: &mut Value, run: &mut WorkflowRun,
    plan: &mut crate::runtime::workflow::ProjectTaskPlan,
) -> CoreResult<()> {
    if run.workspace.is_some() {
        project["status"] = json!("verifying");
        plan.stage = "acceptance".into();
    } else {
        release_gate(run)?;
        project["status"] = json!("completed");
        plan.stage = "done".into();
    }
    save_project(repos, project)
}
