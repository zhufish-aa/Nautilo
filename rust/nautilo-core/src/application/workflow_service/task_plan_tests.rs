//! Execute compiled legacy task plans through the real workflow/RunService
//! pipeline. Only native model turns are supplied by the controllable Probe.
use super::*;
use crate::application::orchestration_service::workflow_plan::compile;
use crate::runtime::workflow::Limits;
use std::collections::BTreeMap;
use crate::application::orchestration_service::OrchestrationService;
use crate::runtime::orchestration::runtime_tool_provider::MainAgentRuntimeToolProvider;

fn orchestration(fixture: &Fixture) -> Arc<OrchestrationService> {
    let service = OrchestrationService::new(
        fixture.db.clone(), fixture.service.runs.clone(), fixture.service.events.clone(),
        fixture.service.git_workflows.get().cloned(), Arc::new(ApprovalService::new(fixture.db.clone())),
    );
    service.set_workflows(&fixture.service);
    service
}

#[tokio::test]
async fn workflow_runtime_dispatch_replays_native_calls_and_keeps_approval_on_the_original_project() {
    let fixture = Fixture::new(Behavior::Submit, false);
    team_scope(&fixture, "ask_before_delegate", &[]);
    let orchestration = orchestration(&fixture);
    let provider = MainAgentRuntimeToolProvider::new(
        fixture.db.clone(), orchestration.clone(),
        Arc::new(CredentialService::new(fixture.db.clone(), &fixture.root)),
    );
    let main = native_session(&fixture, "main-session");
    let agent = Repositories::new(&fixture.db.lock().unwrap().raw).agents().get("agent").unwrap().unwrap();
    let binding = crate::runtime::runtime_tool_provider::RuntimeToolProvider::for_run(
        &provider, &main, &json!({"runId":"main-native-run"}), &agent,
    ).unwrap();
    let call = json!({"providerId":"workflow-fixture","callId":"first","name":"agenthub_plan","arguments":{"tasks":[{"id":"check","memberId":"worker","task":"Inspect settings"},{"id":"verify","memberId":"worker","task":"Verify settings","dependsOn":["check"]}]}});
    let execute = &binding.execute;
    let result = execute(call.clone()).await.unwrap();
    assert_eq!(result["success"], true, "{result}");
    let receipt: Value = serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
    let id = receipt["workflowRunId"].as_str().unwrap();
    let replayed: Value = serde_json::from_str(execute(call.clone()).await.unwrap()["content"].as_str().unwrap()).unwrap();
    assert_eq!(receipt, replayed);
    let mut changed = call;
    changed["arguments"]["tasks"][0]["task"] = json!("Something else");
    assert_eq!(execute(changed).await.unwrap()["success"], false);
    assert_eq!(receipt["accepted"], false);
    assert_eq!(orchestration.get("team-run").unwrap()["projectRun"]["pendingApprovalId"], receipt["approvalId"]);
    fixture.service.drive(id).await.unwrap();
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 0);
    orchestration.resolve_delegation("team-run", true, Some("run")).unwrap();
    fixture.until(id, |run| run.status == "completed").await;
    assert_eq!(orchestration.get("team-run").unwrap()["projectRun"]["status"], "completed");
    let calls = fixture.probe.calls.lock().unwrap();
    assert_eq!(calls.iter().filter(|call| call.0 == "main-session").count(), 1);
    assert!(calls.last().unwrap().2.contains("[AGENTHUB_FINAL_SYNTHESIS]"));
    assert_eq!(calls.last().unwrap().1.as_deref(), Some("main-native"));
    let tasks = Repositories::new(&fixture.db.lock().unwrap().raw).tasks().list("team-run").unwrap();
    assert_eq!(tasks.len(), 2);
    for task in tasks {
        assert_eq!(task["status"], "completed");
        let expected = receipt["tasks"].as_array().unwrap().iter().find(|entry| entry["taskId"] == task["id"]).unwrap();
        assert_eq!(task["runSessionId"], expected["sessionId"]);
    }
}

#[tokio::test]
async fn workflow_runtime_dispatch_rejects_a_bad_continuation_without_persisting_half_a_plan() {
    let fixture = Fixture::new(Behavior::Submit, false);
    team_scope(&fixture, "ask_before_delegate", &[]);
    let orchestration = orchestration(&fixture);
    let call = json!({"providerId":"workflow-fixture","callId":"bad","name":"agenthub_delegate","arguments":{"memberId":"worker","task":"Inspect","continueSessionId":"missing"}});
    let outcome = orchestration.invoke_runtime_tool("main-session", Some("main-native-run"), &call).await.unwrap();
    assert_eq!(outcome["success"], false, "{outcome}");
    let db = fixture.db.lock().unwrap();
    let repos = Repositories::new(&db.raw);
    assert!(repos.tasks().list("team-run").unwrap().is_empty());
    assert!(repos.approvals().list(None, Some("team-run")).unwrap().is_empty());
    assert!(workflows::project_graphs(&db.raw, "team-run").unwrap().is_empty());
}

fn task(id: &str, dependencies: &[&str], member: &str) -> Value {
    json!({"id":id,"projectRunId":"team-run","title":id,"objective":format!("Investigate {id}"),"taskType":"inspect","assignedMemberId":member,"dependencies":dependencies,"allowedPaths":[],"status":if dependencies.is_empty(){"ready"}else{"blocked_dependency"},"attempt":1,"createdAt":now_iso(),"updatedAt":now_iso()})
}

fn team_scope(fixture: &Fixture, policy: &str, tasks: &[Value]) {
    let db = fixture.db.lock().unwrap();
    let repos = Repositories::new(&db.raw);
    repos.teams().save(&json!({"id":"team","mainMemberId":"main","delegationPolicy":policy,"roles":[],"members":[{"id":"main","displayName":"Lead","agentInstanceId":"agent","enabled":true,"allowedTaskTypes":["*"]},{"id":"worker","displayName":"Explorer","agentInstanceId":"agent","enabled":true,"allowedTaskTypes":["*"]}]}),&now_iso()).unwrap();
    let mut parent = repos.sessions().get("main-session").unwrap().unwrap();
    parent["projectRunId"] = json!("team-run");
    parent["teamId"] = json!("team");
    repos.sessions().save(&parent).unwrap();
    let project = repos.projects().get("project").unwrap().unwrap();
    repos.project_runs().save(&json!({"id":"team-run","projectId":"project","teamId":"team","mainMemberId":"main","mainAgentInstanceId":"agent","mainSessionId":"main-session","goal":"Investigate the repository","status":"executing","workspaceMode":project["workspaceMode"].as_str().unwrap_or("direct"),"workspacePath":project["rootPath"],"createdAt":now_iso(),"updatedAt":now_iso()})).unwrap();
    for task in tasks {
        repos.tasks().save(task).unwrap();
    }
}

fn input(fixture: &Fixture, tasks: &[Value], request: &str) -> TaskPlanStart {
    let db = fixture.db.lock().unwrap();
    let repos = Repositories::new(&db.raw);
    let project = repos.project_runs().get("team-run").unwrap().unwrap();
    let team = repos.teams().get("team").unwrap().unwrap();
    let mut completed = BTreeMap::new();
    for dependency in repos
        .tasks()
        .list("team-run")
        .unwrap()
        .into_iter()
        .filter(|task| task["status"] == "completed")
    {
        let message = dependency["resultMessageId"]
            .as_str()
            .and_then(|id| repos.sessions().message("main-session", id).unwrap());
        completed.insert(dependency["id"].as_str().unwrap().into(),json!({"projectRunId":"team-run","taskId":dependency["id"],"status":"completed","result":dependency.get("workflowResult").cloned().unwrap_or(json!({"summary":message.as_ref().map(|message|&message["text"])})),"runId":dependency["runId"],"resultMessageId":dependency["resultMessageId"]}));
    }
    let mut plan = compile(
        &project,
        request,
        tasks,
        &team,
        &completed,
        Limits {
            max_parallel: tasks.len(),
            ..Limits::default()
        },
    )
    .unwrap();
    for node in plan
        .definition
        .nodes
        .iter_mut()
        .filter(|node| node.kind == "agent")
    {
        node.submission_policy.grace_ms = 0;
        node.submission_policy.reminder_interval_ms = 100;
        node.submission_policy.timeout_ms = 120_000;
        node.submission_policy.max_reminders = 1;
        if let Some(task) = tasks
            .iter()
            .find(|task| plan.task_nodes[task["id"].as_str().unwrap()] == node.id)
        {
            if let Some(instruction) = task["fixtureInstruction"].as_str() {
                node.prompt = Some(format!(
                    "{instruction}\n{}",
                    node.prompt.as_deref().unwrap()
                ));
            }
        }
    }
    TaskPlanStart {
        project_run_id: "team-run".into(),
        request_id: request.into(),
        definition: plan.definition,
        inputs: plan.inputs,
        bindings: plan.bindings,
        task_nodes: plan.task_nodes,
        target_sessions: plan.target_sessions,
        approval_id: None,
        return_to_main: true,
    }
}

fn current_task(fixture: &Fixture, id: &str) -> Value {
    Repositories::new(&fixture.db.lock().unwrap().raw)
        .tasks()
        .get(id)
        .unwrap()
        .unwrap()
}
fn native_session(fixture: &Fixture, id: &str) -> Value {
    Repositories::new(&fixture.db.lock().unwrap().raw)
        .sessions()
        .get(id)
        .unwrap()
        .unwrap()
}
fn continued(fixture: &Fixture) -> String {
    let id = "continued-worker";
    Repositories::new(&fixture.db.lock().unwrap().raw).sessions().save(&json!({"id":id,"projectId":"project","teamId":"team","projectRunId":"earlier-run","taskId":"earlier-task","memberId":"worker","parentSessionId":"main-session","agentInstanceId":"agent","providerSessionId":"original-worker-native","runtimeToolVersion":RUNTIME_TOOL_SCHEMA_VERSION,"status":"idle","createdAt":now_iso(),"updatedAt":now_iso()})).unwrap();
    id.into()
}

#[tokio::test]
async fn workflow_task_plan_executes_original_task_ids_and_native_main_once() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let tasks = vec![
        task("first", &[], "worker"),
        task("second", &["first"], "worker"),
    ];
    team_scope(&fixture, "autonomous", &tasks);
    let args = input(&fixture, &tasks, "task-request");
    let started = fixture.service.start_task_plan(args.clone()).unwrap();
    assert!(started.get("taskProjection").is_none());
    assert!(!started.to_string().contains("fixture-secret"));
    assert_eq!(
        started["id"],
        fixture.service.start_task_plan(args).unwrap()["id"]
    );
    let activation = started["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| {
            event["type"] == "node.activated" && event["data"]["taskText"] == "Investigate first"
        })
        .unwrap()
        .clone();
    {
        let db = fixture.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let mut changed = repos.tasks().get("second").unwrap().unwrap();
        changed["objective"] = json!("A later task edit must not rewrite the launched plan");
        repos.tasks().save(&changed).unwrap();
    }
    let id = started["id"].as_str().unwrap();
    let done = fixture
        .until(id, |run| {
            run.status == "completed"
                && run
                    .messages
                    .iter()
                    .all(|message| message.status == "delivered")
        })
        .await;
    assert_eq!(
        json!(done
            .events
            .iter()
            .find(|event| event.sequence == activation["sequence"].as_u64().unwrap() as usize)
            .unwrap()),
        activation
    );
    assert_eq!(
        done.instances
            .iter()
            .find(|instance| instance.node_id
                == done
                    .task_projection
                    .as_ref()
                    .unwrap()
                    .tasks
                    .iter()
                    .find(|(_, task)| task.task_id == "second")
                    .unwrap()
                    .0
                    .as_str())
            .unwrap()
            .task_text
            .as_deref(),
        Some("Investigate second")
    );
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 2);
    for id in ["first", "second"] {
        let task = current_task(&fixture, id);
        assert_eq!(task["status"], "completed");
        assert_eq!(task["workflowRunId"], started["id"]);
        let session = native_session(&fixture, task["runSessionId"].as_str().unwrap());
        assert_eq!(session["taskId"], id);
        assert_eq!(session["projectRunId"], "team-run");
        assert_eq!(session["parentSessionId"], "main-session");
        let native = Repositories::new(&fixture.db.lock().unwrap().raw)
            .runs()
            .get(task["runId"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(native["taskId"], id);
        assert_eq!(native["projectRunId"], "team-run");
        assert_eq!(native["memberId"], "worker");
    }
    let calls = fixture.probe.calls.lock().unwrap();
    assert_eq!(calls.len(), 3);
    assert!(calls[1].2.contains("Investigate second"));
    assert!(!calls[1].2.contains("A later task edit"));
    assert_eq!(calls.last().unwrap().0, "main-session");
    assert_eq!(calls.last().unwrap().1.as_deref(), Some("main-native"));
}

#[tokio::test]
async fn workflow_task_plan_continues_the_exact_native_child_and_rejects_foreign_targets_atomically(
) {
    let fixture = Fixture::new(Behavior::Submit, false);
    let mut selected = task("continued", &[], "worker");
    let extra = task("independent", &[], "worker");
    team_scope(&fixture, "autonomous", &[selected.clone(), extra.clone()]);
    let sid = continued(&fixture);
    selected["targetSessionId"] = json!(sid);
    Repositories::new(&fixture.db.lock().unwrap().raw)
        .tasks()
        .save(&selected)
        .unwrap();
    let mut invalid = input(
        &fixture,
        &[selected.clone(), extra.clone()],
        "invalid-target",
    );
    invalid.target_sessions.insert(
        invalid.task_nodes["independent"].clone(),
        "main-session".into(),
    );
    assert!(fixture.service.start_task_plan(invalid).is_err());
    assert!(current_task(&fixture, "continued")["workflowRunId"].is_null());
    assert!(current_task(&fixture, "independent")["workflowRunId"].is_null());
    let started = fixture
        .service
        .start_task_plan(input(&fixture, &[selected], "continue"))
        .unwrap();
    let id = started["id"].as_str().unwrap();
    fixture
        .until(id, |run| {
            run.status == "completed"
                && run
                    .messages
                    .iter()
                    .all(|message| message.status == "delivered")
        })
        .await;
    assert_eq!(current_task(&fixture, "continued")["runSessionId"], sid);
    let session = native_session(&fixture, &sid);
    assert_eq!(session["providerSessionId"], "original-worker-native");
    assert_eq!(session["taskId"], "continued");
    assert_eq!(session["projectRunId"], "team-run");
    let calls = fixture.probe.calls.lock().unwrap();
    assert_eq!(calls[0].1.as_deref(), Some("original-worker-native"));
}

#[tokio::test]
async fn workflow_task_plan_honors_existing_delegation_approval_without_duplicate_approval_or_sessions(
) {
    let fixture = Fixture::new(Behavior::Submit, false);
    let selected = task("approved", &[], "worker");
    let independent = task("unapproved", &[], "worker");
    team_scope(
        &fixture,
        "ask_before_delegate",
        &[selected.clone(), independent.clone()],
    );
    Repositories::new(&fixture.db.lock().unwrap().raw).approvals().save(&json!({"id":"old-approval","category":"delegate","operation":"orchestration.delegate","projectRunId":"team-run","sessionId":"main-session","status":"pending","createdAt":now_iso()})).unwrap();
    {
        let db = fixture.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let mut project = repos.project_runs().get("team-run").unwrap().unwrap();
        project["pendingApprovalId"] = json!("old-approval");
        project["plannerDecision"] = json!({"mode":"delegate","task":selected});
        repos.project_runs().save(&project).unwrap();
    }
    let mut unrelated = input(&fixture, &[independent], "wrong-approval");
    unrelated.approval_id = Some("old-approval".into());
    assert!(fixture.service.start_task_plan(unrelated).is_err());
    assert!(current_task(&fixture, "unapproved")["workflowRunId"].is_null());
    let mut args = input(&fixture, &[selected], "approved");
    args.approval_id = Some("old-approval".into());
    let started = fixture.service.start_task_plan(args).unwrap();
    let id = started["id"].as_str().unwrap();
    for _ in 0..3 {
        fixture.service.drive(id).await.unwrap();
    }
    assert_eq!(
        current_task(&fixture, "approved")["status"],
        "waiting_approval"
    );
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 0);
    {
        let db = fixture.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        assert_eq!(repos.sessions().list("project", None).unwrap().len(), 1);
        assert_eq!(repos.approvals().list(None, None).unwrap().len(), 1);
    }
    fixture
        .service
        .control(&json!({"runId":id,"action":"approve"}))
        .unwrap();
    fixture
        .until(id, |run| {
            run.status == "completed"
                && run
                    .messages
                    .iter()
                    .all(|message| message.status == "delivered")
        })
        .await;
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn workflow_task_plan_main_assignment_preserves_its_native_session_without_a_second_main_turn(
) {
    let fixture = Fixture::new(Behavior::Submit, false);
    let selected = task("main-task", &[], "main");
    team_scope(&fixture, "autonomous", &[selected.clone()]);
    let started = fixture
        .service
        .start_task_plan(input(&fixture, &[selected], "main-task"))
        .unwrap();
    let id = started["id"].as_str().unwrap();
    fixture.until(id, |run| run.status == "completed").await;
    for _ in 0..3 {
        fixture.service.drive(id).await.unwrap();
    }
    let task = current_task(&fixture, "main-task");
    assert_eq!(task["status"], "completed");
    assert_eq!(task["runSessionId"], "main-session");
    assert_eq!(task["completedByMemberId"], "main");
    let calls = fixture.probe.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].1.as_deref(), Some("main-native"));
    let sessions = Repositories::new(&fixture.db.lock().unwrap().raw)
        .sessions()
        .list("project", None)
        .unwrap();
    assert_eq!(sessions.len(), 1);
}

#[tokio::test]
async fn workflow_task_plan_shared_continuation_waits_for_submission_before_reusing_the_native_session(
) {
    let fixture = Fixture::new(Behavior::OmitFirst, false);
    let mut first = task("a", &[], "worker");
    let mut second = task("b", &[], "worker");
    team_scope(&fixture, "autonomous", &[first.clone(), second.clone()]);
    let sid = continued(&fixture);
    first["targetSessionId"] = json!(sid);
    second["targetSessionId"] = json!(sid);
    for task in [&first, &second] {
        Repositories::new(&fixture.db.lock().unwrap().raw)
            .tasks()
            .save(task)
            .unwrap();
    }
    let args = input(&fixture, &[first, second], "shared-native");
    let started = fixture.service.start_task_plan(args).unwrap();
    let id = started["id"].as_str().unwrap();
    fixture
        .until(id, |run| {
            run.status == "completed"
                && run
                    .messages
                    .iter()
                    .all(|message| ["delivered", "resolved"].contains(&message.status.as_str()))
        })
        .await;
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 3);
    let calls = fixture.probe.calls.lock().unwrap();
    let child: Vec<_> = calls.iter().filter(|call| call.0 == sid).collect();
    assert_eq!(child.len(), 3);
    assert!(child
        .iter()
        .all(|call| call.1.as_deref() == Some("original-worker-native")));
    assert_eq!(current_task(&fixture, "a")["status"], "completed");
    assert_eq!(current_task(&fixture, "b")["status"], "completed");
}

#[tokio::test]
async fn workflow_task_plan_retry_reuses_the_failed_child_without_restarting_the_main() {
    let fixture = Fixture::new(Behavior::Block, false);
    let selected = task("retry", &[], "worker");
    team_scope(&fixture, "autonomous", &[selected.clone()]);
    let started = fixture
        .service
        .start_task_plan(input(&fixture, &[selected], "first-attempt"))
        .unwrap();
    let id = started["id"].as_str().unwrap();
    fixture
        .until(id, |run| {
            run.instances
                .iter()
                .any(|instance| instance.run_id.is_some())
        })
        .await;
    fixture
        .service
        .control(&json!({"runId":id,"action":"cancel"}))
        .unwrap();
    fixture
        .until(id, |_| {
            fixture.probe.cancellations.load(Ordering::SeqCst) == 1
        })
        .await;
    let prior = current_task(&fixture, "retry");
    fixture
        .until(id, |_| {
            Repositories::new(&fixture.db.lock().unwrap().raw)
                .runs()
                .get(prior["runId"].as_str().unwrap())
                .unwrap()
                .is_some_and(|run| {
                    matches!(
                        run["status"].as_str(),
                        Some("cancelled" | "failed" | "completed")
                    )
                })
        })
        .await;
    {
        let db = fixture.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let mut agent = repos.agents().get("agent").unwrap().unwrap();
        agent["providerOptions"]["block"] = json!(false);
        repos.agents().save(&agent, &now_iso()).unwrap();
    }
    let mut args = input(&fixture, &[prior.clone()], "second-attempt");
    args.return_to_main = false;
    let retried = fixture.service.start_task_plan(args).unwrap();
    let retry_id = retried["id"].as_str().unwrap();
    fixture
        .until(retry_id, |run| run.status == "completed")
        .await;
    let task = current_task(&fixture, "retry");
    assert_eq!(task["attempt"], 2);
    assert_eq!(task["runSessionId"], prior["runSessionId"]);
    assert_eq!(task["status"], "completed");
    let calls = fixture.probe.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].0, calls[1].0);
    assert_eq!(
        calls[1].1.as_deref(),
        Some(format!("native-{}", calls[0].0).as_str())
    );
    assert!(!calls.iter().any(|call| call.0 == "main-session"));
}

#[tokio::test]
async fn workflow_task_plan_adopts_the_existing_integration_and_records_original_artifact_owners() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let original = fixture.git_project(true, json!([]), true).await;
    let mut selected = task("write", &[], "worker");
    selected["fixtureInstruction"] = json!("write:base.txt");
    selected["allowedPaths"] = json!(["base.txt"]);
    team_scope(&fixture, "autonomous", &[selected.clone()]);
    let git = fixture.service.git_workflows.get().unwrap();
    let parent = Repositories::new(&fixture.db.lock().unwrap().raw)
        .project_runs()
        .get("team-run")
        .unwrap()
        .unwrap();
    let parent = git.initialize_run(&parent).await.unwrap();
    assert!(parent["branchName"].is_string());
    Repositories::new(&fixture.db.lock().unwrap().raw)
        .project_runs()
        .save(&parent)
        .unwrap();
    let args = input(&fixture, &[selected], "adopt-integration");
    let started = fixture.service.start_task_plan(args).unwrap();
    let id = started["id"].as_str().unwrap();
    let done = fixture
        .workspace_until(id, |run| {
            run.status == "completed"
                && run
                    .messages
                    .iter()
                    .all(|message| message.status == "delivered")
        })
        .await;
    let workspace = done.workspace.as_ref().unwrap();
    assert_eq!(workspace.context["workspacePath"], parent["workspacePath"]);
    assert_eq!(workspace.context["branchName"], parent["branchName"]);
    assert_eq!(
        std::fs::read_to_string(
            std::path::Path::new(parent["workspacePath"].as_str().unwrap()).join("base.txt")
        )
        .unwrap(),
        "written base.txt\n"
    );
    assert_eq!(
        std::fs::read_to_string(original.join("base.txt")).unwrap(),
        "original\n"
    );
    let db = fixture.db.lock().unwrap();
    let repos = Repositories::new(&db.raw);
    assert!(!repos
        .artifacts()
        .list(Some("team-run"), Some("write"), None)
        .unwrap()
        .is_empty());
    let task = repos.tasks().get("write").unwrap().unwrap();
    let node = done
        .instances
        .iter()
        .find(|instance| done.definition.node(&instance.node_id).kind == "agent")
        .unwrap();
    assert_eq!(
        task["diffArtifactId"],
        node.workspace.as_ref().unwrap().outcome.as_ref().unwrap()["diffArtifactId"]
    );
    assert!(task["resultCommit"]
        .as_str()
        .is_some_and(|commit| !commit.is_empty()));
    assert!(repos
        .artifacts()
        .list(Some(id), None, None)
        .unwrap()
        .is_empty());
    assert_eq!(
        repos.project_runs().get("team-run").unwrap().unwrap()["status"],
        "executing"
    );
    if let Some(path) = std::env::var_os("NAUTILO_WORKFLOW_QA_STATE") {
        std::fs::write(format!("{}.task-plan.json",std::path::Path::new(&path).display()),json!({"run":public_view(&done),"artifacts":repos.artifacts().list(Some("team-run"),None,None).unwrap(),"approvals":repos.approvals().list(None,None).unwrap()}).to_string()).unwrap();
    }
}

#[tokio::test]
async fn workflow_task_plan_direct_project_keeps_its_mode_and_isolates_a_path_scoped_node() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let original = fixture.git_project(false, json!([]), false).await;
    let mut selected = task("scoped", &[], "worker");
    selected["fixtureInstruction"] = json!("write:base.txt");
    selected["allowedPaths"] = json!(["base.txt"]);
    team_scope(&fixture, "autonomous", &[selected.clone()]);
    let started = fixture
        .service
        .start_task_plan(input(&fixture, &[selected], "direct-scope"))
        .unwrap();
    let id = started["id"].as_str().unwrap();
    let done = fixture
        .workspace_until(id, |run| run.status == "completed")
        .await;
    assert_eq!(
        done.workspace.as_ref().unwrap().context["workspaceMode"],
        "direct"
    );
    let node = done
        .instances
        .iter()
        .find(|instance| done.definition.node(&instance.node_id).kind == "agent")
        .unwrap();
    assert_eq!(
        node.workspace.as_ref().unwrap().context["workspaceMode"],
        "git_isolated"
    );
    assert_ne!(
        node.workspace.as_ref().unwrap().context["workspacePath"],
        json!(original)
    );
    assert_eq!(
        std::fs::read_to_string(original.join("base.txt")).unwrap(),
        "written base.txt\n"
    );
    assert_eq!(
        Repositories::new(&fixture.db.lock().unwrap().raw)
            .projects()
            .get("project")
            .unwrap()
            .unwrap()["workspaceMode"],
        "direct"
    );
}

#[tokio::test]
async fn workflow_task_plan_parallel_graphs_share_one_verified_integration_branch() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let original = fixture.git_project(true, json!([]), true).await;
    let mut a = task("parallel-a", &[], "worker");
    a["fixtureInstruction"] = json!("write:a.txt");
    a["allowedPaths"] = json!(["a.txt"]);
    let mut b = task("parallel-b", &[], "worker");
    b["fixtureInstruction"] = json!("write:b.txt");
    b["allowedPaths"] = json!(["b.txt"]);
    team_scope(&fixture, "autonomous", &[a.clone(), b.clone()]);
    let parent = Repositories::new(&fixture.db.lock().unwrap().raw)
        .project_runs()
        .get("team-run")
        .unwrap()
        .unwrap();
    let parent = fixture
        .service
        .git_workflows
        .get()
        .unwrap()
        .initialize_run(&parent)
        .await
        .unwrap();
    Repositories::new(&fixture.db.lock().unwrap().raw)
        .project_runs()
        .save(&parent)
        .unwrap();
    let mut args = input(&fixture, &[a], "parallel-a");
    args.return_to_main = false;
    let first = fixture.service.start_task_plan(args).unwrap();
    let mut args = input(&fixture, &[b], "parallel-b");
    args.return_to_main = false;
    let second = fixture.service.start_task_plan(args).unwrap();
    let first = first["id"].as_str().unwrap();
    let second = second["id"].as_str().unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        fixture.service.drive(first).await.unwrap();
        fixture.service.drive(second).await.unwrap();
        let a = fixture.service.get(first).unwrap();
        let b = fixture.service.get(second).unwrap();
        assert!(
            !["failed", "needs_decision"].contains(&a.status.as_str()),
            "{}",
            json!(a)
        );
        assert!(
            !["failed", "needs_decision"].contains(&b.status.as_str()),
            "{}",
            json!(b)
        );
        if a.status == "completed" && b.status == "completed" {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Parallel task graphs did not settle"
        );
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    let integration = std::path::Path::new(parent["workspacePath"].as_str().unwrap());
    for file in ["a.txt", "b.txt"] {
        assert_eq!(
            std::fs::read_to_string(integration.join(file)).unwrap(),
            format!("written {file}\n")
        );
        assert!(!original.join(file).exists());
    }
    assert_eq!(current_task(&fixture, "parallel-a")["status"], "completed");
    assert_eq!(current_task(&fixture, "parallel-b")["status"], "completed");
    let a = fixture.service.get(first).unwrap();
    let b = fixture.service.get(second).unwrap();
    assert_eq!(
        a.workspace.as_ref().unwrap().context["branchName"],
        b.workspace.as_ref().unwrap().context["branchName"]
    );
    assert_ne!(
        a.workspace.as_ref().unwrap().owner_run_id,
        b.workspace.as_ref().unwrap().owner_run_id
    );
}

#[tokio::test]
async fn workflow_task_plan_retry_keeps_the_original_dirty_task_worktree_and_its_native_identity() {
    let fixture = Fixture::new(Behavior::Block, false);
    let original = fixture.git_project(true, json!([]), false).await;
    let mut selected = task("workspace-retry", &[], "worker");
    selected["fixtureInstruction"] = json!("write:base.txt");
    selected["allowedPaths"] = json!(["base.txt"]);
    team_scope(&fixture, "autonomous", &[selected.clone()]);
    let parent = Repositories::new(&fixture.db.lock().unwrap().raw)
        .project_runs()
        .get("team-run")
        .unwrap()
        .unwrap();
    let parent = fixture
        .service
        .git_workflows
        .get()
        .unwrap()
        .initialize_run(&parent)
        .await
        .unwrap();
    Repositories::new(&fixture.db.lock().unwrap().raw)
        .project_runs()
        .save(&parent)
        .unwrap();
    let mut args = input(&fixture, &[selected], "workspace-first");
    args.return_to_main = false;
    let started = fixture.service.start_task_plan(args).unwrap();
    let first = started["id"].as_str().unwrap();
    fixture
        .workspace_until(first, |run| {
            run.instances
                .iter()
                .any(|instance| instance.run_id.is_some())
        })
        .await;
    fixture
        .service
        .control(&json!({"runId":first,"action":"cancel"}))
        .unwrap();
    fixture
        .until(first, |_| {
            fixture.probe.cancellations.load(Ordering::SeqCst) == 1
                && workflows::task_member_active(
                    &fixture.db.lock().unwrap().raw,
                    "team-run",
                    "worker",
                )
                .unwrap()
                    == 0
        })
        .await;
    let prior = current_task(&fixture, "workspace-retry");
    let cwd = prior["workspacePath"].as_str().unwrap();
    assert_eq!(
        std::fs::read_to_string(std::path::Path::new(cwd).join("base.txt")).unwrap(),
        "written base.txt\n"
    );
    {
        let db = fixture.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let mut agent = repos.agents().get("agent").unwrap().unwrap();
        agent["providerOptions"]["block"] = json!(false);
        agent["providerOptions"]["writeFiles"] = json!(false);
        repos.agents().save(&agent, &now_iso()).unwrap();
    }
    let mut args = input(&fixture, &[prior.clone()], "workspace-second");
    args.return_to_main = false;
    let retried = fixture.service.start_task_plan(args).unwrap();
    let second = retried["id"].as_str().unwrap();
    fixture
        .workspace_until(second, |run| run.status == "completed")
        .await;
    let task = current_task(&fixture, "workspace-retry");
    assert_eq!(task["workspacePath"], prior["workspacePath"]);
    assert_eq!(task["runSessionId"], prior["runSessionId"]);
    assert_eq!(task["attempt"], 2);
    assert_eq!(
        std::fs::read_to_string(
            std::path::Path::new(parent["workspacePath"].as_str().unwrap()).join("base.txt")
        )
        .unwrap(),
        "written base.txt\n"
    );
    assert_eq!(
        std::fs::read_to_string(original.join("base.txt")).unwrap(),
        "original\n"
    );
    assert_eq!(fixture.probe.calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn workflow_task_plan_member_limit_spans_independent_graphs_and_cancelled_native_runs() {
    let fixture = Fixture::new(Behavior::Block, false);
    let a = task("limited-a", &[], "worker");
    let b = task("limited-b", &[], "worker");
    team_scope(&fixture, "autonomous", &[a.clone(), b.clone()]);
    {
        let db = fixture.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let mut team = repos.teams().get("team").unwrap().unwrap();
        team["members"][1]["maxConcurrentTasks"] = json!(1);
        repos.teams().save(&team, &now_iso()).unwrap();
    }
    let first = fixture
        .service
        .start_task_plan(input(&fixture, &[a], "limited-a"))
        .unwrap();
    let first = first["id"].as_str().unwrap();
    let second = fixture
        .service
        .start_task_plan(input(&fixture, &[b], "limited-b"))
        .unwrap();
    let second = second["id"].as_str().unwrap();
    fixture
        .until(first, |run| {
            run.instances
                .iter()
                .any(|instance| instance.run_id.is_some())
        })
        .await;
    for _ in 0..5 {
        fixture.service.drive(second).await.unwrap();
    }
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 1);
    assert_eq!(current_task(&fixture, "limited-b")["status"], "ready");
    fixture
        .service
        .control(&json!({"runId":first,"action":"cancel"}))
        .unwrap();
    fixture
        .until(first, |_| {
            workflows::task_member_active(&fixture.db.lock().unwrap().raw, "team-run", "worker")
                .unwrap()
                == 0
        })
        .await;
    fixture
        .until(second, |run| {
            run.instances
                .iter()
                .any(|instance| instance.run_id.is_some())
        })
        .await;
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 2);
    fixture
        .service
        .control(&json!({"runId":second,"action":"cancel"}))
        .unwrap();
    fixture
        .until(second, |_| {
            workflows::task_member_active(&fixture.db.lock().unwrap().raw, "team-run", "worker")
                .unwrap()
                == 0
        })
        .await;
}

#[tokio::test]
async fn workflow_task_plan_return_honors_an_explicit_main_selection_without_rebinding_its_child() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let selected = task("main-selection", &[], "worker");
    team_scope(&fixture, "autonomous", &[selected.clone()]);
    let started = fixture
        .service
        .start_task_plan(input(&fixture, &[selected], "main-selection"))
        .unwrap();
    let id = started["id"].as_str().unwrap();
    {
        let db = fixture.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let mut agent = repos.agents().get("agent").unwrap().unwrap();
        agent["id"] = json!("new-main-agent");
        repos.agents().save(&agent, &now_iso()).unwrap();
        let mut main = repos.sessions().get("main-session").unwrap().unwrap();
        main["agentInstanceId"] = json!("new-main-agent");
        main["providerSessionId"] = json!("user-selected-native");
        repos.sessions().save(&main).unwrap();
    }
    fixture
        .until(id, |run| {
            run.status == "completed"
                && run
                    .messages
                    .iter()
                    .all(|message| message.status == "delivered")
        })
        .await;
    let task = current_task(&fixture, "main-selection");
    let child = native_session(&fixture, task["runSessionId"].as_str().unwrap());
    assert_eq!(child["agentInstanceId"], "agent");
    let main = Repositories::new(&fixture.db.lock().unwrap().raw)
        .runs()
        .latest_for_session("main-session")
        .unwrap()
        .unwrap();
    assert_eq!(main["agentInstanceId"], "new-main-agent");
    let calls = fixture.probe.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1].1.as_deref(), Some("user-selected-native"));
}
