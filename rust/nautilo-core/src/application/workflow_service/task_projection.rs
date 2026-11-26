//! Compatibility views for task-based orchestration. The graph owns execution;
//! task rows, result receipts and their runtime events commit with that graph.
use super::*;
use crate::runtime::workflow::TaskProjection;
use rusqlite::Connection;
use std::collections::{BTreeSet, VecDeque};

fn transaction(db: &Connection) -> CoreResult<()> {
    if db.is_autocommit() {
        return Err(invalid(
            "workflow",
            "Task projection requires an active write transaction",
        ));
    }
    Ok(())
}

fn scope(db: &Connection, run: &WorkflowRun, source: &TaskProjection) -> CoreResult<Value> {
    let repos = Repositories::new(db);
    let project = repos
        .project_runs()
        .get(&source.project_run_id)?
        .ok_or_else(|| not_found("projectRun", &source.project_run_id))?;
    let main = repos
        .sessions()
        .get(&run.session_id)?
        .ok_or_else(|| not_found("session", &run.session_id))?;
    if project["projectId"] != run.project_id
        || project["teamId"] != source.team_id
        || main["projectId"] != run.project_id
        || main["projectRunId"] != source.project_run_id
        || main["teamId"] != source.team_id
        || main["memberId"] != source.main_member_id
    {
        return Err(invalid(
            "workflow",
            "The original task plan and main session do not share a scope",
        ));
    }
    Ok(main)
}

/// Trusted application entry point only. Validate every claim before writing
/// any task, then reserve ownership in the caller's workflow transaction.
pub(super) fn claim(
    db: &Connection,
    run: &mut WorkflowRun,
    source: TaskProjection,
    event_builder: &SessionEventBuilder,
) -> CoreResult<Vec<Value>> {
    transaction(db)?;
    let main = scope(db, run, &source)?;
    let project_run = Repositories::new(db)
        .project_runs()
        .get(&source.project_run_id)?
        .unwrap();
    if project_run["mainSessionId"] != run.session_id
        || source.tasks.is_empty()
        || source.tasks.len() > 50
    {
        return Err(invalid(
            "workflow",
            "Only the owning main session can claim a task plan",
        ));
    }
    if run
        .task_projection
        .as_ref()
        .is_some_and(|prior| json!(prior) != json!(source))
    {
        return Err(invalid(
            "workflow",
            "A running task plan cannot change task ownership",
        ));
    }
    let repos = Repositories::new(db);
    let mut ids = BTreeSet::new();
    let mut claims = Vec::new();
    for (node_id, identity) in &source.tasks {
        let node = run
            .definition
            .nodes
            .iter()
            .find(|node| &node.id == node_id)
            .filter(|node| node.kind == "agent" && node.for_each.is_none())
            .ok_or_else(|| invalid("workflow", "Each legacy task must identify one Agent node"))?;
        if !ids.insert(&identity.task_id)
            || identity.attempt == 0
            || run.bindings[node.role.as_deref().unwrap_or("")]["memberId"] != identity.member_id
        {
            return Err(invalid(
                "workflow",
                "Task ownership is duplicated or selects a different member",
            ));
        }
        let mut task = repos
            .tasks()
            .get(&identity.task_id)?
            .filter(|task| {
                task["projectRunId"] == source.project_run_id
                    && task["assignedMemberId"] == identity.member_id
            })
            .ok_or_else(|| not_found("task", &identity.task_id))?;
        let current_attempt = task["attempt"].as_u64().unwrap_or(1);
        let same =
            task["workflowRunId"] == run.id && current_attempt == u64::from(identity.attempt);
        let stopped = matches!(task["status"].as_str(), Some("failed" | "cancelled"));
        let retry = stopped && current_attempt + 1 == u64::from(identity.attempt);
        let fresh = !task["workflowRunId"].is_string()
            && !task["runId"].is_string()
            && matches!(
                task["status"].as_str(),
                Some("draft" | "ready" | "blocked_dependency" | "waiting_approval")
            )
            && current_attempt == u64::from(identity.attempt);
        if !same && !fresh && !retry {
            return Err(invalid(
                "workflow",
                "A task is already owned, completed or has a different retry attempt",
            ));
        }
        if retry {
            retry_quiet(db, &task)?;
            let receipt = json!({"attempt":current_attempt,"status":task["status"],"workflowRunId":task["workflowRunId"],"runId":task["runId"],"runSessionId":task["runSessionId"],"resultMessageId":task["resultMessageId"],"diffArtifactId":task["diffArtifactId"],"verificationResultIds":task["verificationResultIds"],"resultCommit":task["resultCommit"],"workflowError":task["workflowError"]});
            let mut history = task["previousAttempts"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            history.push(receipt);
            task["previousAttempts"] = json!(history);
            for key in [
                "runId",
                "resultMessageId",
                "workflowResult",
                "workflowReceiptKey",
                "workflowError",
                "workflowInstanceId",
                "workflowAcceptance",
                "diffArtifactId",
                "verificationResultIds",
                "resultCommit",
                "conflicts",
                "pathViolations",
                "completedByMemberId",
            ] {
                task.as_object_mut().unwrap().remove(key);
            }
            task["attempt"] = json!(identity.attempt);
            task["status"] = json!("ready");
        }
        task["workflowRunId"] = json!(run.id);
        task["workflowNodeId"] = json!(node_id);
        task["updatedAt"] = json!(now_iso());
        claims.push(task);
    }
    run.task_projection = Some(source);
    let mut committed = Vec::new();
    for task in claims {
        let old = repos.tasks().get(task["id"].as_str().unwrap())?.unwrap();
        let mut comparable = task.clone();
        comparable["updatedAt"] = old["updatedAt"].clone();
        if comparable == old {
            continue;
        }
        repos.tasks().save(&task)?;
        committed.push(task_event(db, event_builder, &main, run, &task)?);
    }
    committed.extend(project(db, run, event_builder)?);
    Ok(committed)
}

fn retry_quiet(db: &Connection, task: &Value) -> CoreResult<()> {
    if let Some(id) = task["runId"].as_str() {
        let execution = Repositories::new(db).runs().get(id)?;
        if execution
            .as_ref()
            .is_none_or(|execution| !terminal(&execution["status"]))
        {
            return Err(invalid(
                "task",
                "Confirm the previous native execution has stopped before retrying",
            ));
        }
    }
    if let Some(id) = task["workflowRunId"].as_str() {
        let previous = workflows::get(db, id)?.ok_or_else(|| not_found("workflowRun", id))?;
        if let Some(instance) = previous
            .instances
            .iter()
            .find(|instance| instance.node_id == task["workflowNodeId"].as_str().unwrap_or(""))
        {
            let workspace_pending = instance.workspace.as_ref().is_some_and(|workspace| {
                ["preparing", "verifying", "uncertain"].contains(&workspace.stage.as_str())
            });
            if instance.active()
                || instance
                    .native_work
                    .as_ref()
                    .is_some_and(|work| work.pending())
                || workspace_pending
                || !workflows::live_executions(db, id, &instance.id)?.is_empty()
            {
                return Err(invalid(
                    "task",
                    "The previous task still has native work or an unresolved workspace operation",
                ));
            }
        }
    }
    Ok(())
}

fn append(
    db: &Connection,
    event_builder: &SessionEventBuilder,
    main: &Value,
    context: Value,
    kind: &str,
    payload: Value,
) -> CoreResult<Value> {
    let mut event = event_builder.prepare_for_session(
        main,
        &context,
        kind,
        payload,
    );
    Repositories::new(db)
        .events()
        .append_in_transaction(&mut event)?;
    Ok(event)
}

fn task_event(
    db: &Connection,
    event_builder: &SessionEventBuilder,
    main: &Value,
    run: &WorkflowRun,
    task: &Value,
) -> CoreResult<Value> {
    let invoking_run_id = run.task_projection.as_ref()
        .and_then(|source| source.project_plan.as_ref())
        .and_then(|plan| plan.invoking_run_id.as_deref());
    append(
        db,
        event_builder,
        main,
        json!({"projectRunId":task["projectRunId"],"taskId":task["id"],"runId":invoking_run_id}),
        "task.updated",
        json!({"taskId":task["id"],"status":task["status"],"assignedMemberId":task["assignedMemberId"],"workflowRunId":task["workflowRunId"],"workflowNodeId":task["workflowNodeId"],"workflowStatus":task["workflowStatus"],"attempt":task["attempt"]}),
    )
}

fn advance(task: &mut Value, desired: &str) -> CoreResult<()> {
    let current = task["status"].as_str().unwrap_or("");
    if current == desired {
        return Ok(());
    }
    // Use the public domain transitions, including the intermediate queue /
    // running states when a whole fast execution is observed in one poll.
    let states = [
        "draft",
        "ready",
        "blocked_dependency",
        "queued",
        "running",
        "waiting_user",
        "waiting_approval",
        "verifying",
        "review_required",
        "merge_ready",
        "completed",
        "failed",
        "cancelled",
    ];
    let mut queue = VecDeque::from([current]);
    let mut seen = BTreeSet::from([current]);
    while let Some(from) = queue.pop_front() {
        for to in states {
            if !crate::domain::can_transition_task(from, to) || !seen.insert(to) {
                continue;
            }
            if to == desired {
                task["status"] = json!(desired);
                return Ok(());
            }
            // A failed/stopped/completed attempt is never an intermediate
            // route back into live work. Retrying requires claim() above.
            if !["completed", "failed", "cancelled"].contains(&to) {
                queue.push_back(to);
            }
        }
    }
    Err(invalid(
        "task",
        &format!("Task projection cannot advance {current} to {desired}"),
    ))
}

fn desired<'a>(run: &WorkflowRun, instance: Option<&'a Instance>) -> &'a str {
    if run.approval_id.is_some() && instance.is_none_or(|instance| instance.status == "ready") {
        return "waiting_approval";
    }
    if let Some(instance) = instance {
        return match instance.status.as_str() {
            "ready" => "ready",
            "starting" => "queued",
            "running" | "waiting_submission" => "running",
            "verifying" => "verifying",
            "waiting_approval" => "waiting_approval",
            "completed" => "completed",
            "failed" => "failed",
            "cancelled" => "cancelled",
            _ => "blocked_dependency",
        };
    }
    if ["cancelled", "needs_decision", "failed"].contains(&run.status.as_str()) {
        "cancelled"
    } else if run.approval_id.is_some() {
        "waiting_approval"
    } else {
        "blocked_dependency"
    }
}

pub(super) fn project(
    db: &Connection,
    run: &WorkflowRun,
    event_builder: &SessionEventBuilder,
) -> CoreResult<Vec<Value>> {
    let Some(source) = &run.task_projection else {
        return Ok(vec![]);
    };
    transaction(db)?;
    let main = scope(db, run, source)?;
    let repos = Repositories::new(db);
    let mut committed = Vec::new();
    for (node_id, identity) in &source.tasks {
        let Some(mut task) = repos.tasks().get(&identity.task_id)? else {
            continue;
        };
        // Old completion callbacks must never overwrite a new retry, member,
        // or graph. That graph owns its own row and receipt.
        if task["workflowRunId"] != run.id
            || task["attempt"] != identity.attempt
            || task["projectRunId"] != source.project_run_id
            || task["assignedMemberId"] != identity.member_id
        {
            continue;
        }
        let mut instances = run
            .instances
            .iter()
            .filter(|instance| &instance.node_id == node_id);
        let instance = instances.next();
        if instances.next().is_some() {
            return Err(invalid(
                "workflow",
                "A legacy task has more than one live graph instance",
            ));
        }
        let before = task.clone();
        if let Some(instance) = instance {
            copy_workspace(&mut task, instance);
        }
        if matches!(
            task["status"].as_str(),
            Some("completed" | "failed" | "cancelled")
        ) {
            // A cancelled prepare may report its actual directory afterward.
            // Retain that evidence without reviving the task or emitting a
            // second result; ownership above still fences off newer retries.
            if task != before {
                task["updatedAt"] = json!(now_iso());
                repos.tasks().save(&task)?;
                committed.push(task_event(db, event_builder, &main, run, &task)?);
            }
            continue;
        }
        let status = desired(run, instance);
        advance(&mut task, status)?;
        task["workflowStatus"] = json!(if run.approval_id.is_some() {
            "waiting_approval"
        } else {
            instance
                .map(|instance| instance.status.as_str())
                .unwrap_or("waiting_dependency")
        });
        if let Some(instance) = instance {
            task["workflowInstanceId"] = json!(instance.id);
            if let Some(id) = &instance.session_id {
                task["runSessionId"] = json!(id);
            }
            if let Some(id) = &instance.run_id {
                task["runId"] = json!(id);
            }
            if let Some(error) = &instance.error {
                task["workflowError"] = json!(error);
            }
            if let Some(result) = &instance.result {
                task["workflowResult"] = result.clone();
            }
        }
        if status == "completed" && identity.member_id == source.main_member_id {
            task["completedByMemberId"] = json!(identity.member_id);
        } else if ["completed", "failed", "cancelled"].contains(&status) {
            let key = format!(
                "workflow-task:{}:{}:{}",
                run.id, identity.task_id, identity.attempt
            );
            let accepted = instance
                .and_then(|instance| instance.result.as_ref())
                .and_then(|result| result["summary"].as_str())
                .map(str::to_owned);
            let summary = if status == "completed" {
                accepted.unwrap_or_else(|| "Task ended without a summary".into())
            } else {
                let reason = instance
                    .and_then(|instance| instance.error.clone())
                    .unwrap_or_else(|| {
                        "Task stopped before an accepted result was delivered".into()
                    });
                accepted
                    .map(|output| format!("{reason}\n\nSubmitted output (not accepted):\n{output}"))
                    .unwrap_or(reason)
            };
            let message_id = format!("workflow-result-{:x}", Sha256::digest(key.as_bytes()));
            if repos
                .sessions()
                .message(&run.session_id, &message_id)?
                .is_none()
            {
                repos.sessions().save_message(&json!({"id":message_id,"sessionId":run.session_id,"sender":"system","kind":"result","projectRunId":source.project_run_id,"taskId":identity.task_id,"fromMemberId":identity.member_id,"toMemberId":source.main_member_id,"attempt":identity.attempt,"workflowRunId":run.id,"text":summary,"createdAt":now_iso()}))?;
                committed.push(append(db, event_builder, &main,
                    json!({"projectRunId":task["projectRunId"],"taskId":task["id"]}),
                    "handoff.created",
                    json!({"fromMemberId":identity.member_id,"toMemberId":source.main_member_id,"summary":summary.chars().take(500).collect::<String>(),"artifactIds":[],"taskId":identity.task_id,"targetSessionId":run.session_id,"workflowRunId":run.id,"attempt":identity.attempt}),
                )?);
            }
            task["resultMessageId"] = json!(message_id);
            task["workflowReceiptKey"] = json!(key);
        }
        if task != before {
            task["updatedAt"] = json!(now_iso());
            repos.tasks().save(&task)?;
            committed.push(task_event(db, event_builder, &main, run, &task)?);
        }
    }
    Ok(committed)
}

fn copy_workspace(task: &mut Value, instance: &Instance) {
    let Some(workspace) = &instance.workspace else {
        return;
    };
    // The planned path of an isolated node initially points at the shared
    // integration directory. It becomes a reusable task directory only after
    // a real branch/worktree identity has been established.
    if workspace.context["workspaceMode"] != "git_isolated"
        || workspace.context["branchName"].is_string()
    {
        for key in [
            "workspacePath",
            "workspaceRoot",
            "branchName",
            "baseCommit",
            "verificationTemplates",
        ] {
            if let Some(value) = workspace.context.get(key) {
                task[key] = value.clone();
            }
        }
    }
    if let Some(outcome) = &workspace.outcome {
        task["workflowAcceptance"] = outcome.clone();
        let checkpoint = &outcome["taskCheckpoint"];
        for (target, field) in [
            ("diffArtifactId", "diffArtifactId"),
            ("resultCommit", "sourceCommit"),
        ] {
            if let Some(value) = outcome
                .get(field)
                .or_else(|| checkpoint.get(field))
                .filter(|value| value.is_string())
            {
                task[target] = value.clone();
            }
        }
        let mut ids = Vec::new();
        for results in [
            &checkpoint["verificationResults"],
            &outcome["verificationResults"],
            &outcome["mergeVerificationResults"],
        ] {
            for result in results.as_array().into_iter().flatten() {
                if let Some(id) = result["id"].as_str() {
                    if !ids.iter().any(|value| value == id) {
                        ids.push(json!(id));
                    }
                }
            }
        }
        task["verificationResultIds"] = json!(ids);
        for field in ["conflicts", "pathViolations"] {
            if outcome[field].is_array() {
                task[field] = outcome[field].clone();
            }
        }
    }
}

#[cfg(test)]
#[path = "task_projection_tests.rs"]
mod tests;
