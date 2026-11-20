//! Trusted bridge from persisted team tasks into the workflow executor.
//! This is deliberately not part of workflow.start's public JSON contract.
use super::*;
use crate::runtime::workflow::{Acceptance, ProjectTaskPlan, TaskAttempt, TaskProjection, Workspace};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone)]
pub(crate) struct TaskPlanStart {
    pub project_run_id: String,
    pub request_id: String,
    pub definition: Definition,
    pub inputs: Value,
    pub bindings: Value,
    /// Original task ID -> graph node ID.
    pub task_nodes: BTreeMap<String, String>,
    pub target_sessions: BTreeMap<String, String>,
    /// A prior orchestration approval may be adopted, never bypassed.
    pub approval_id: Option<String>,
    pub return_to_main: bool,
}

#[derive(Default)]
pub(crate) struct TaskPlanOptions<'a> {
    pub new_tasks: &'a [Value],
    pub decision: Option<&'a Value>,
    pub invocation: Option<&'a Value>,
    pub invoking_run_id: Option<&'a str>,
    pub finalize: bool,
    /// Present only for the explicit task.retry action.
    pub retry_attempt: Option<u64>,
}

pub(super) fn same_account(session: &Value, binding: &Value) -> bool {
    ["agentInstanceId", "connectionId", "connectionRevision"]
        .iter()
        .all(|key| {
            session.get(*key).filter(|value| !value.is_null())
                == binding.get(*key).filter(|value| !value.is_null())
        })
}
pub(super) fn member_at_capacity(
    db: &rusqlite::Connection,
    run: &WorkflowRun,
    binding: &Value,
) -> CoreResult<bool> {
    let Some(source) = &run.task_projection else {
        return Ok(false);
    };
    let Some(limit) = binding["memberSnapshot"]["maxConcurrentTasks"]
        .as_u64()
        .filter(|limit| *limit > 0)
    else {
        return Ok(false);
    };
    Ok(workflows::task_member_active(
        db,
        &source.project_run_id,
        binding["memberId"].as_str().unwrap_or(""),
    )? >= limit as usize)
}

impl WorkflowService {
    pub(crate) fn replay_task_plan(
        &self,
        session_id: &str,
        request_id: &str,
        invocation: &Value,
    ) -> CoreResult<Option<Value>> {
        workflows::by_request(&self.db.lock().unwrap().raw, session_id, request_id)?
            .map(|run| task_launch_receipt(run, &invocation_digest(invocation)))
            .transpose()
    }

    #[cfg(test)]
    pub(crate) fn start_task_plan(&self, input: TaskPlanStart) -> CoreResult<Value> {
        self.start_task_plan_with(input, TaskPlanOptions::default())
    }

    pub(crate) fn start_task_plan_with(
        &self,
        input: TaskPlanStart,
        options: TaskPlanOptions<'_>,
    ) -> CoreResult<Value> {
        if input.request_id.trim().is_empty() {
            return Err(invalid(
                "requestId",
                "Task launches require a stable request identity",
            ));
        }
        input
            .definition
            .validate()
            .map_err(|error| invalid("definition", &error))?;
        if input
            .definition
            .nodes
            .iter()
            .any(|node| node.reference.is_some() || node.for_each.is_some())
        {
            return Err(invalid("definition","Each persisted legacy task represents one Agent execution; use workflow.start for subgraphs and per-item instances"));
        }
        let fingerprint = options.invocation.map(invocation_digest).unwrap_or_else(|| {
            invocation_digest(&json!({"projectRunId":input.project_run_id,"definition":input.definition,"inputs":input.inputs,"bindings":input.bindings,"taskNodes":input.task_nodes,"targetSessions":input.target_sessions,"approvalId":input.approval_id,"returnToMain":input.return_to_main,"retryAttempt":options.retry_attempt}))
        });
        let project_run = Repositories::new(&self.db.lock().unwrap().raw)
            .project_runs()
            .get(&input.project_run_id)?
            .ok_or_else(|| not_found("projectRun", &input.project_run_id))?;
        let main_id = project_run["mainSessionId"]
            .as_str()
            .ok_or_else(|| invalid("session", "The task plan has no owning main session"))?;
        if let Some(existing) =
            workflows::by_request(&self.db.lock().unwrap().raw, main_id, &input.request_id)?
        {
            return task_launch_receipt(existing, &fingerprint);
        }
        if project_run["status"] == "cancelled" {
            return Err(invalid("projectRun", "This project run was stopped"));
        }
        let parent = Repositories::new(&self.db.lock().unwrap().raw)
            .sessions()
            .get(main_id)?
            .ok_or_else(|| not_found("session", main_id))?;
        let team = Repositories::new(&self.db.lock().unwrap().raw)
            .teams()
            .get(project_run["teamId"].as_str().unwrap_or(""))?
            .ok_or_else(|| invalid("team", "The task plan has no team"))?;
        if team["delegationPolicy"] == "direct_only" {
            return Err(invalid(
                "delegationPolicy",
                "This team permits direct work only",
            ));
        }
        let bindings = self.bindings(&parent, &input.definition, &input.bindings)?;
        let mut run = WorkflowRun::start(
            Uuid::new_v4().to_string(),
            main_id.into(),
            parent["projectId"].as_str().unwrap_or("").into(),
            input.request_id,
            input.definition,
            input.inputs,
            bindings,
            now(),
        )
        .map_err(|error| invalid("definition", &error))?;
        let event_builder = self.events.session_event_builder();
        let mut db = self.db.lock().unwrap();
        let tx = db
            .raw
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(crate::database::connection::db_fail)?;
        if let Some(existing) = workflows::by_request(&tx, main_id, &run.request_id)? {
            return task_launch_receipt(existing, &fingerprint);
        }
        let repos = Repositories::new(&tx);
        let mut current = repos
            .project_runs()
            .get(&input.project_run_id)?
            .ok_or_else(|| not_found("projectRun", &input.project_run_id))?;
        if repos
            .teams()
            .get(team["id"].as_str().unwrap_or(""))?
            .as_ref()
            != Some(&team)
            || repos
                .sessions()
                .get(main_id)?
                .as_ref()
                .is_none_or(|session| !same_account(session, &parent))
        {
            return Err(invalid(
                "team",
                "The team or main account changed while the task plan was being prepared",
            ));
        }
        if current["mainSessionId"] != parent["id"]
            || current["teamId"] != parent["teamId"]
            || current["projectId"] != parent["projectId"]
            || current["status"] == "cancelled"
        {
            return Err(invalid(
                "projectRun",
                "The original task plan changed ownership while it was being prepared",
            ));
        }
        if options.decision.is_some() && matches!(current["status"].as_str(), Some("verifying" | "merge_ready" | "merging" | "paused" | "failed")) {
            return Err(invalid("projectRun", "Finish or recover the current project run before making another delegation"));
        }
        for task in options.new_tasks {
            let task_id = task["id"].as_str().unwrap_or("");
            if task["projectRunId"] != input.project_run_id
                || !input.task_nodes.contains_key(task_id)
                || repos.tasks().get(task_id)?.is_some()
            {
                return Err(invalid("taskId", "The proposed task identity already exists or belongs to another plan"));
            }
            repos.tasks().save(task)?;
        }
        let mut source = TaskProjection {
            project_run_id: input.project_run_id.clone(),
            team_id: team["id"].as_str().unwrap_or("").into(),
            main_member_id: parent["memberId"].as_str().unwrap_or("").into(),
            tasks: BTreeMap::new(),
            sessions: BTreeMap::new(),
            main_working_directory: current["workspacePath"].as_str().map(str::to_owned),
            workspaces: BTreeMap::new(),
            task_texts: BTreeMap::new(),
            return_to_main: input.return_to_main,
            project_plan: options.decision.map(|decision| ProjectTaskPlan {
                mode: decision["mode"].as_str().unwrap_or("plan").into(),
                invoking_run_id: options.invoking_run_id.map(str::to_owned),
                finalize: options.finalize,
                stage: "tasks".into(),
                goal: current["goal"].as_str().unwrap_or("").into(),
                from_planner: options.invocation.is_none(),
                rejected: false,
                native_work: None,
            }),
        };
        let mut nodes = BTreeSet::new();
        for (task_id, node_id) in &input.task_nodes {
            let node = run
                .definition
                .nodes
                .iter()
                .find(|node| &node.id == node_id && node.kind == "agent")
                .ok_or_else(|| invalid("taskId", "A task must map to an Agent node"))?;
            if !nodes.insert(node_id.clone()) {
                return Err(invalid("taskId", "Two tasks cannot share a graph node"));
            }
            let task = repos
                .tasks()
                .get(task_id)?
                .filter(|task| task["projectRunId"] == input.project_run_id)
                .ok_or_else(|| not_found("task", task_id))?;
            if let Some(expected) = options.retry_attempt {
                if input.task_nodes.len() != 1
                    || task["attempt"].as_u64().unwrap_or(1) != expected
                    || !matches!(task["status"].as_str(), Some("failed" | "cancelled"))
                {
                    return Err(invalid("taskId", "This task already has a new attempt"));
                }
                for dependency in task["dependencies"].as_array().into_iter().flatten() {
                    if !repos.tasks().get(dependency.as_str().unwrap_or(""))?.is_some_and(|other| {
                        other["projectRunId"] == task["projectRunId"] && other["status"] == "completed"
                    }) {
                        return Err(invalid("taskId", "Finish the failed dependencies before retrying this task"));
                    }
                }
            }
            let attempt = task["attempt"].as_u64().unwrap_or(1)
                + u64::from(matches!(
                    task["status"].as_str(),
                    Some("failed" | "cancelled")
                ));
            let attempt = u32::try_from(attempt)
                .map_err(|_| invalid("attempt", "Task retry counter exhausted"))?;
            let binding = &run.bindings[node.role.as_deref().unwrap_or("")];
            source.task_texts.insert(
                node_id.clone(),
                task["objective"]
                    .as_str()
                    .ok_or_else(|| invalid("objective", "The task objective is missing"))?
                    .to_owned(),
            );
            if binding["memberId"] != task["assignedMemberId"] {
                return Err(invalid(
                    "memberId",
                    "The graph selected a different task member",
                ));
            }
            if binding["memberSnapshot"]["allowedTaskTypes"]
                .as_array()
                .filter(|types| !types.is_empty())
                .is_some_and(|types| {
                    !types
                        .iter()
                        .any(|kind| kind == "*" || *kind == task["taskType"])
                })
            {
                return Err(invalid(
                    "taskType",
                    "The selected member does not permit this task type",
                ));
            }
            let planned = prepare_session(
                &tx,
                &parent,
                &team,
                &task,
                binding,
                input.target_sessions.get(node_id).map(String::as_str),
            )?;
            source.sessions.insert(node_id.clone(), planned);
            if task["workspacePath"].is_string() {
                source.workspaces.insert(node_id.clone(),json!({"workspacePath":task["workspacePath"],"branchName":task["branchName"],"baseCommit":task["baseCommit"],"workspaceRoot":task["workspaceRoot"]}));
            }
            source.tasks.insert(
                node_id.clone(),
                TaskAttempt {
                    task_id: task_id.clone(),
                    attempt,
                    member_id: task["assignedMemberId"].as_str().unwrap_or("").into(),
                },
            );
        }
        if nodes.len()
            != run
                .definition
                .nodes
                .iter()
                .filter(|node| node.kind == "agent")
                .count()
            || input
                .target_sessions
                .keys()
                .any(|node| !nodes.contains(node))
        {
            return Err(invalid(
                "taskId",
                "Every Agent in a task plan must have one persisted task identity",
            ));
        }
        if self.git_workflows.get().is_some() {
            let project = repos
                .projects()
                .get(&run.project_id)?
                .ok_or_else(|| not_found("project", &run.project_id))?;
            self.workspace_requirements(&run.definition, &project)?;
            run.workspace = Some(Workspace {
                owner_run_id: run.id.clone(),
                stage: "unplanned".into(),
                project,
                context: json!({"adoptedProjectRunId":input.project_run_id,"integrationKey":format!("task-plan:{}",input.project_run_id),"parentWorkspace":current,"workspaceMode":current["workspaceMode"].as_str().unwrap_or("direct")}),
                approval_id: None,
                outcome: None,
                error: None,
            });
            for instance in &mut run.instances {
                if run.definition.node(&instance.node_id).kind == "agent" {
                    instance.acceptance = Some(Acceptance::default());
                }
            }
        }
        if options.finalize {
            run.acceptance = Some(Acceptance::default());
        }
        let mut approval = input.approval_id;
        if let Some(id) = &approval {
            let record = repos
                .approvals()
                .get(id)?
                .filter(|record| {
                    record["category"] == "delegate"
                        && record["sessionId"] == parent["id"]
                        && record["projectRunId"] == input.project_run_id
                        && approval_has_tasks(
                            record,
                            &current,
                            &input.task_nodes.keys().cloned().collect(),
                        )
                })
                .ok_or_else(|| {
                    invalid(
                        "approvalId",
                        "This delegation approval belongs to a different task plan",
                    )
                })?;
            match record["status"].as_str() {
                Some("pending") => {}
                Some("approved") => approval = None,
                _ => {
                    return Err(invalid(
                        "approvalId",
                        "The delegation approval was rejected",
                    ))
                }
            }
        } else if team["delegationPolicy"] == "ask_before_delegate" && options.retry_attempt.is_none() {
            let id = Uuid::new_v4().to_string();
            repos.approvals().save(&json!({"id":id,"category":"delegate","operation":"workflow.start","workflowRunId":run.id,"projectRunId":input.project_run_id,"sessionId":parent["id"],"projectId":run.project_id,"taskIds":input.task_nodes.keys().collect::<Vec<_>>(),"requestedBy":parent["memberId"],"summary":format!("Delegate {} tasks",source.tasks.len()),"status":"pending","createdAt":now_iso()}))?;
            approval = Some(id);
        }
        run.approval_id = approval;
        if run.approval_id.is_some() {
            run.pause(true, now());
        }
        run.launch_fingerprint = Some(fingerprint);
        let mut committed = task_projection::claim(&tx, &mut run, source, &event_builder)?;
        if let Some(decision) = options.decision {
            // A new tool call during main synthesis creates more work. The
            // prior batch must no longer schedule final verification.
            current.as_object_mut().unwrap().remove("workflowFinalizerId");
            current["plannerDecision"] = decision.clone();
            if let Some(approval) = &run.approval_id {
                if !current["pendingApprovalId"].is_string() {
                    current["pendingApprovalId"] = json!(approval);
                }
                current["status"] = json!("waiting_user");
                let mut event = event_builder.prepare_for_session(
                    &parent,
                    &json!({"projectRunId":input.project_run_id,"runId":options.invoking_run_id}),
                    "approval.requested",
                    json!({"approvalId":approval,"category":"delegate","summary":format!("Delegate {} tasks",input.task_nodes.len())}),
                );
                repos.events().append_in_transaction(&mut event)?;
                committed.push(event);
            } else if !current["pendingApprovalId"].is_string() {
                current["status"] = json!("executing");
            }
            current["updatedAt"] = json!(now_iso());
            repos.project_runs().save(&current)?;
        }
        prepare_task_texts(&mut run, 0);
        workflows::save(&tx, &mut run)?;
        tx.commit().map_err(crate::database::connection::db_fail)?;
        drop(db);
        self.events.publish_committed(&committed);
        self.wake.notify_one();
        Ok(public_view(&run))
    }
}

fn invocation_digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
pub(super) fn prepare_task_texts(run: &mut WorkflowRun, first_new_event: usize) {
    let Some(source) = &run.task_projection else {
        return;
    };
    for instance in &mut run.instances {
        if instance.task_text.is_none() {
            instance.task_text = source.task_texts.get(&instance.node_id).cloned();
        }
    }
    // Only enrich events that have not been journaled yet. Existing activation
    // events remain immutable when a later task is activated or completed.
    for event in run
        .events
        .iter_mut()
        .skip(first_new_event)
        .filter(|event| event.r#type == "node.activated")
    {
        if let Some(text) = event
            .node_id
            .as_ref()
            .and_then(|node| source.task_texts.get(node))
        {
            event.data["taskText"] = json!(text);
        }
    }
}
fn approval_has_tasks(record: &Value, project: &Value, wanted: &BTreeSet<String>) -> bool {
    if let Some(ids) = record["taskIds"].as_array() {
        return ids
            .iter()
            .map(|id| id.as_str().map(str::to_owned))
            .collect::<Option<BTreeSet<_>>>()
            .as_ref()
            == Some(wanted);
    }
    // Older delegation cards pin their tasks through the persisted planner
    // decision. Preserve those cards only when that exact batch still matches.
    if record["operation"] != "orchestration.delegate"
        || (record["status"] == "pending" && project["pendingApprovalId"] != record["id"])
    {
        return false;
    }
    let decision = &project["plannerDecision"];
    let ids = match decision["mode"].as_str() {
        Some("delegate") => decision["task"]["id"]
            .as_str()
            .map(|id| BTreeSet::from([id.to_owned()])),
        Some("plan") => decision["tasks"].as_array().and_then(|tasks| {
            tasks
                .iter()
                .map(|task| task["id"].as_str().map(str::to_owned))
                .collect::<Option<BTreeSet<_>>>()
        }),
        _ => None,
    };
    ids.as_ref() == Some(wanted)
}

pub(super) fn prepare_return(run: &mut WorkflowRun) {
    let Some(source) = &run.task_projection else {
        return;
    };
    if source.tasks.is_empty() { return; }
    if run.status == "completed"
        && (!source.return_to_main
            || source
                .tasks
                .values()
                .all(|task| task.member_id == source.main_member_id))
    {
        for message in &mut run.messages {
            if message.recipient == "main" && message.status == "queued" {
                if message.data_only {
                    message.status = "resolved".into();
                }
            }
        }
    } else if run.status == "completed" && source.return_to_main && source.project_plan.is_none() {
        // Internal callers that explicitly request a main turn retain it.
        if let Some(message) = run.messages.iter_mut().find(|message| {
            message.id == format!("{}:main:completed", run.id)
        }) {
            message.data_only = false;
        }
    }
}

fn task_launch_receipt(run: WorkflowRun, fingerprint: &str) -> CoreResult<Value> {
    if run.task_projection.is_none() || run.launch_fingerprint.as_deref() != Some(fingerprint) {
        return Err(invalid(
            "requestId",
            "This task launch identity was already used for a different plan",
        ));
    }
    Ok(public_view(&run))
}

fn prepare_session(
    db: &rusqlite::Connection,
    parent: &Value,
    team: &Value,
    task: &Value,
    binding: &Value,
    target: Option<&str>,
) -> CoreResult<Value> {
    if task["assignedMemberId"] == parent["memberId"] {
        if target.is_some_and(|id| parent["id"] != id) || !same_account(parent, binding) {
            return Err(invalid(
                "session",
                "A main-Agent task must preserve its original account and native session",
            ));
        }
        return Ok(json!({"mode":"main","session":parent}));
    }
    let repos = Repositories::new(db);
    let prior = target.or_else(|| task["runSessionId"].as_str());
    let existing = if let Some(id) = prior {
        Some(
            repos
                .sessions()
                .get(id)?
                .ok_or_else(|| not_found("session", id))?,
        )
    } else {
        repos
            .sessions()
            .list(
                parent["projectId"].as_str().unwrap_or(""),
                binding["memberId"].as_str(),
            )?
            .into_iter()
            .find(|session| {
                session["taskId"] == task["id"] && session["projectRunId"] == task["projectRunId"]
            })
    };
    if let Some(session) = existing {
        if session["id"] == parent["id"]
            || session["projectId"] != parent["projectId"]
            || session["teamId"] != team["id"]
            || session["memberId"] != binding["memberId"]
            || session["parentSessionId"] != parent["id"]
            || !same_account(&session, binding)
        {
            return Err(invalid(
                "targetSessionId",
                "The continued task session has a different member, parent, Harness or account",
            ));
        }
        return Ok(json!({"mode":"continue","session":session}));
    }
    let mut session = binding.clone();
    for key in [
        "agentSnapshot",
        "roleSnapshot",
        "memberSnapshot",
        "capabilities",
        "maxParallel",
    ] {
        session.as_object_mut().unwrap().remove(key);
    }
    for (key, value) in [
        ("id", json!(Uuid::new_v4().to_string())),
        ("projectId", parent["projectId"].clone()),
        ("projectRunId", task["projectRunId"].clone()),
        ("teamId", team["id"].clone()),
        ("taskId", task["id"].clone()),
        ("parentSessionId", parent["id"].clone()),
        ("title", task["title"].clone()),
        ("status", json!("idle")),
        ("unreadCount", json!(0)),
        ("createdAt", json!(now_iso())),
        ("updatedAt", json!(now_iso())),
    ] {
        session[key] = value;
    }
    Ok(json!({"mode":"new","session":session}))
}

pub(super) fn launch_session(
    db: &rusqlite::Connection,
    run: &WorkflowRun,
    node_id: &str,
    binding: &Value,
) -> CoreResult<Option<Value>> {
    let Some(source) = &run.task_projection else {
        return Ok(None);
    };
    if source.tasks.is_empty() { return Ok(None); }
    let plan = source
        .sessions
        .get(node_id)
        .ok_or_else(|| invalid("session", "The original task session plan is missing"))?;
    let original = &plan["session"];
    let id = original["id"]
        .as_str()
        .ok_or_else(|| invalid("session", "Task session identity missing"))?;
    let current = Repositories::new(db).sessions().get(id)?;
    let mut session = match plan["mode"].as_str() {
        Some("new") => match current {
            Some(current)
                if current["parentSessionId"] == run.session_id
                    && current["taskId"] == source.tasks[node_id].task_id =>
            {
                current
            }
            None => original.clone(),
            _ => {
                return Err(invalid(
                    "session",
                    "The reserved task session was claimed by different work",
                ))
            }
        },
        Some("continue" | "main") => current.ok_or_else(|| not_found("session", id))?,
        _ => return Err(invalid("session", "Unknown task session plan")),
    };
    if !same_account(&session, binding)
        || session["projectId"] != run.project_id
        || session["memberId"] != binding["memberId"]
        || session["teamId"] != source.team_id
        || (plan["mode"] != "main" && session["parentSessionId"] != run.session_id)
    {
        return Err(invalid(
            "session",
            "The original task session identity changed before dispatch",
        ));
    }
    if plan["mode"] != "main" {
        session["taskId"] = json!(source.tasks[node_id].task_id);
        session["projectRunId"] = json!(source.project_run_id);
    }
    session["updatedAt"] = json!(now_iso());
    Ok(Some(session))
}
