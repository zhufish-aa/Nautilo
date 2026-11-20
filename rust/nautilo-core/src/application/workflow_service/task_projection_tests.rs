use super::*;
use crate::runtime::orchestration::task_graph::TaskGraph;
use crate::runtime::security::RedactionService;
use crate::runtime::workflow::{Acceptance, TaskAttempt};
use std::collections::BTreeMap;

struct Fixture {
    db: Arc<Mutex<Database>>,
    event_builder: SessionEventBuilder,
    run: WorkflowRun,
    source: TaskProjection,
}

fn definition(chain: bool) -> Definition {
    let agent = |id: &str| json!({"id":id,"kind":"agent","role":"worker","prompt":"Explore","outputs":{"summary":"text"},"exits":[{"id":"done","name":"完成"}]});
    let nodes = if chain {
        vec![
            json!({"id":"main","kind":"main","exits":[{"id":"go","name":"开始"}]}),
            agent("a"),
            agent("b"),
        ]
    } else {
        vec![
            json!({"id":"main","kind":"main","exits":[{"id":"go","name":"开始"}]}),
            agent("b"),
        ]
    };
    let edges = if chain {
        json!([{"from":["main","go"],"to":"a"},{"from":["a","done"],"to":"b"},{"from":["b","done"],"to":"$return"}])
    } else {
        json!([{"from":["main","go"],"to":"b"},{"from":["b","done"],"to":"$return"}])
    };
    serde_json::from_value(
        json!({"schemaVersion":1,"id":"task-plan","entry":"main","nodes":nodes,"edges":edges}),
    )
    .unwrap()
}

fn fixture() -> Fixture {
    let db = Arc::new(Mutex::new(
        Database::open(std::path::Path::new(":memory:")).unwrap(),
    ));
    {
        let db = db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        repos.project_runs().save(&json!({"id":"project-run","projectId":"project","teamId":"team","mainMemberId":"lead","mainSessionId":"main-session","status":"executing"})).unwrap();
        repos.sessions().save(&json!({"id":"main-session","projectId":"project","projectRunId":"project-run","teamId":"team","memberId":"lead","status":"idle"})).unwrap();
        for (id, status, deps) in [
            ("task-a", "ready", vec![]),
            ("task-b", "blocked_dependency", vec!["task-a"]),
        ] {
            repos.tasks().save(&json!({"id":id,"projectRunId":"project-run","assignedMemberId":"worker-member","status":status,"attempt":1,"dependencies":deps,"updatedAt":"initial"})).unwrap();
        }
    }
    let run = WorkflowRun::start(
        "graph".into(),
        "main-session".into(),
        "project".into(),
        "first-request".into(),
        definition(true),
        json!({}),
        json!({"worker":{"memberId":"worker-member"}}),
        1000,
    )
    .unwrap();
    let source = TaskProjection {
        sessions: BTreeMap::new(),
        main_working_directory: None,
        workspaces: BTreeMap::new(),
        task_texts: BTreeMap::new(),
        return_to_main: true,
        project_plan: None,
        project_run_id: "project-run".into(),
        team_id: "team".into(),
        main_member_id: "lead".into(),
        tasks: BTreeMap::from([
            (
                "a".into(),
                TaskAttempt {
                    task_id: "task-a".into(),
                    attempt: 1,
                    member_id: "worker-member".into(),
                },
            ),
            (
                "b".into(),
                TaskAttempt {
                    task_id: "task-b".into(),
                    attempt: 1,
                    member_id: "worker-member".into(),
                },
            ),
        ]),
    };
    let event_builder = EventService::new(
        db.clone(),
        RedactionService::new(Arc::new(|| vec!["private-secret".into()])),
    ).session_event_builder();
    Fixture {
        db,
        event_builder,
        run,
        source,
    }
}

fn claim_first(fixture: &mut Fixture) {
    let mut db = fixture.db.lock().unwrap();
    let tx = db
        .raw
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    claim(
        &tx,
        &mut fixture.run,
        fixture.source.clone(),
        &fixture.event_builder,
    )
    .unwrap();
    workflows::save(&tx, &mut fixture.run).unwrap();
    tx.commit().unwrap();
}

fn persist(fixture: &mut Fixture) -> Vec<Value> {
    let mut db = fixture.db.lock().unwrap();
    let tx = db
        .raw
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let events = project(&tx, &fixture.run, &fixture.event_builder).unwrap();
    workflows::save(&tx, &mut fixture.run).unwrap();
    tx.commit().unwrap();
    events
}

fn task(fixture: &Fixture, id: &str) -> Value {
    Repositories::new(&fixture.db.lock().unwrap().raw)
        .tasks()
        .get(id)
        .unwrap()
        .unwrap()
}

fn finish(run: &mut WorkflowRun, node: &str, summary: &str, now: i64) {
    let id = run
        .instances
        .iter()
        .find(|instance| instance.node_id == node)
        .unwrap()
        .id
        .clone();
    run.submit(&id, 1, &["完成".into()], json!({"summary":summary}), now)
        .unwrap();
    run.execution_finished(&id, true, None, now + 1).unwrap();
}

#[test]
fn workflow_task_projection_preserves_receipts_and_excludes_the_legacy_scheduler() {
    let mut fixture = fixture();
    let cached = task(&fixture, "task-a");
    claim_first(&mut fixture);
    assert!(TaskGraph::new(fixture.db.clone())
        .save_status(&cached, "queued", None)
        .is_err());
    assert!(TaskGraph::new(fixture.db.clone())
        .ready("project-run")
        .unwrap()
        .is_empty());
    let first = fixture
        .run
        .instances
        .iter_mut()
        .find(|instance| instance.node_id == "a")
        .unwrap();
    first.status = "running".into();
    first.session_id = Some("original-child".into());
    first.run_id = Some("native-a".into());
    first.acceptance = Some(Acceptance::default());
    let id = first.id.clone();
    fixture
        .run
        .submit(
            &id,
            1,
            &["完成".into()],
            json!({"summary":"Found private-secret"}),
            1010,
        )
        .unwrap();
    persist(&mut fixture);
    assert_eq!(task(&fixture, "task-a")["status"], "running");
    assert_eq!(task(&fixture, "task-a")["runSessionId"], "original-child");
    fixture
        .run
        .execution_finished(&id, true, None, 1020)
        .unwrap();
    persist(&mut fixture);
    assert_eq!(task(&fixture, "task-a")["status"], "verifying");
    assert_eq!(task(&fixture, "task-b")["status"], "blocked_dependency");
    fixture
        .run
        .verification_finished(&id, true, json!({"ok":true}), 1030)
        .unwrap();
    let published = persist(&mut fixture);
    assert!(published
        .iter()
        .any(|event| event["type"] == "handoff.created"));
    assert!(!json!(published).to_string().contains("private-secret"));
    assert_eq!(task(&fixture, "task-a")["status"], "completed");
    assert_eq!(task(&fixture, "task-a")["runId"], "native-a");
    assert_eq!(task(&fixture, "task-b")["status"], "ready");
    assert!(TaskGraph::new(fixture.db.clone())
        .ready("project-run")
        .unwrap()
        .is_empty());
    let db = fixture.db.lock().unwrap();
    let repos = Repositories::new(&db.raw);
    let messages = repos.sessions().messages("main-session").unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["taskId"], "task-a");
    assert_eq!(messages[0]["attempt"], 1);
    assert_eq!(messages[0]["text"], "Found private-secret");
}

#[test]
fn workflow_task_projection_rolls_back_receipts_state_and_events_together() {
    let mut fixture = fixture();
    claim_first(&mut fixture);
    let event_count = Repositories::new(&fixture.db.lock().unwrap().raw)
        .events()
        .replay(Some("main-session"), None, None, None)
        .unwrap()
        .len();
    let mut finished = fixture.run.clone();
    finish(&mut finished, "a", "Accepted output", 1020);
    {
        let mut db = fixture.db.lock().unwrap();
        let tx = db
            .raw
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        project(&tx, &finished, &fixture.event_builder).unwrap();
        workflows::save(&tx, &mut finished).unwrap();
        // Drop the uncommitted transaction, as if the process stopped here.
    }
    assert_eq!(task(&fixture, "task-a")["status"], "ready");
    {
        let db = fixture.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        assert!(repos
            .sessions()
            .messages("main-session")
            .unwrap()
            .is_empty());
        assert_eq!(
            repos
                .events()
                .replay(Some("main-session"), None, None, None)
                .unwrap()
                .len(),
            event_count
        );
        fixture.run = workflows::get(&db.raw, "graph").unwrap().unwrap();
    }
    finish(&mut fixture.run, "a", "Accepted output", 1030);
    persist(&mut fixture);
    assert_eq!(task(&fixture, "task-a")["status"], "completed");
    assert!(persist(&mut fixture).is_empty());
    let mut db = fixture.db.lock().unwrap();
    let tx = db
        .raw
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    assert!(claim(
        &tx,
        &mut fixture.run,
        fixture.source.clone(),
        &fixture.event_builder
    )
    .unwrap()
    .is_empty());
    let repos = Repositories::new(&tx);
    assert_eq!(repos.sessions().messages("main-session").unwrap().len(), 1);
    let events = repos
        .events()
        .replay(Some("main-session"), None, None, None)
        .unwrap();
    assert!(events
        .windows(2)
        .all(|pair| pair[1]["sequence"].as_i64().unwrap()
            == pair[0]["sequence"].as_i64().unwrap() + 1));
    assert!(project(&tx, &fixture.run, &fixture.event_builder)
        .unwrap()
        .is_empty());
}

#[test]
fn workflow_task_projection_validates_all_claims_before_claiming_any_task() {
    let mut fixture = fixture();
    fixture.source.tasks.get_mut("b").unwrap().member_id = "different-member".into();
    let mut db = fixture.db.lock().unwrap();
    let tx = db
        .raw
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    assert!(claim(
        &tx,
        &mut fixture.run,
        fixture.source.clone(),
        &fixture.event_builder
    )
    .is_err());
    assert!(fixture.run.task_projection.is_none());
    assert!(Repositories::new(&tx)
        .tasks()
        .get("task-a")
        .unwrap()
        .unwrap()["workflowRunId"]
        .is_null());
    assert!(Repositories::new(&tx)
        .events()
        .replay(Some("main-session"), None, None, None)
        .unwrap()
        .is_empty());
}

#[test]
fn workflow_task_projection_retry_ignores_old_completions_and_keeps_prior_receipts() {
    let mut fixture = fixture();
    claim_first(&mut fixture);
    finish(&mut fixture.run, "a", "A stays completed", 1020);
    persist(&mut fixture);
    let second = fixture
        .run
        .instances
        .iter()
        .find(|instance| instance.node_id == "b")
        .unwrap()
        .id
        .clone();
    {
        let node = fixture
            .run
            .instances
            .iter_mut()
            .find(|instance| instance.id == second)
            .unwrap();
        node.acceptance = Some(Acceptance::default());
        node.workspace = Some(crate::runtime::workflow::NodeWorkspace {
            stage: "ready".into(),
            context: json!({"workspaceMode":"direct","workspacePath":"task-b-workspace"}),
            outcome: None,
            error: None,
        });
    }
    finish(
        &mut fixture.run,
        "b",
        "B output still requires acceptance",
        1030,
    );
    let checks = json!({"ok":false,"sourceCommit":"source-b","diffArtifactId":"diff-b","verificationResults":[{"id":"check-b","status":"failed"}]});
    let node = fixture
        .run
        .instances
        .iter_mut()
        .find(|instance| instance.id == second)
        .unwrap();
    node.workspace.as_mut().unwrap().stage = "failed".into();
    node.workspace.as_mut().unwrap().outcome = Some(checks.clone());
    fixture
        .run
        .verification_finished(&second, false, checks, 1032)
        .unwrap();
    persist(&mut fixture);
    let first = task(&fixture, "task-a");
    let prior = task(&fixture, "task-b");
    assert_eq!(prior["status"], "failed");
    assert_eq!(prior["diffArtifactId"], "diff-b");
    assert_eq!(prior["resultCommit"], "source-b");
    assert_eq!(prior["verificationResultIds"], json!(["check-b"]));
    let mut retry = WorkflowRun::start(
        "retry-graph".into(),
        "main-session".into(),
        "project".into(),
        "retry-request".into(),
        definition(false),
        json!({}),
        fixture.run.bindings.clone(),
        1040,
    )
    .unwrap();
    let source = TaskProjection {
        tasks: BTreeMap::from([(
            "b".into(),
            TaskAttempt {
                task_id: "task-b".into(),
                attempt: 2,
                member_id: "worker-member".into(),
            },
        )]),
        ..fixture.source.clone()
    };
    {
        let mut db = fixture.db.lock().unwrap();
        let tx = db
            .raw
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        claim(&tx, &mut retry, source, &fixture.event_builder).unwrap();
        workflows::save(&tx, &mut retry).unwrap();
        tx.commit().unwrap();
    }
    let selected = task(&fixture, "task-b");
    assert_eq!(selected["attempt"], 2);
    assert_eq!(selected["status"], "ready");
    assert_eq!(
        selected["previousAttempts"][0]["resultMessageId"],
        prior["resultMessageId"]
    );
    assert!(selected["resultMessageId"].is_null());
    assert!(selected["workflowAcceptance"].is_null());
    assert!(selected["diffArtifactId"].is_null());
    assert!(selected["verificationResultIds"].is_null());
    assert_eq!(
        selected["previousAttempts"][0]["verificationResultIds"],
        json!(["check-b"])
    );
    fixture
        .run
        .instances
        .iter_mut()
        .find(|instance| instance.id == second)
        .unwrap()
        .status = "completed".into();
    assert!(persist(&mut fixture).is_empty());
    assert_eq!(task(&fixture, "task-b"), selected);
    assert_eq!(task(&fixture, "task-a"), first);
    finish(&mut retry, "b", "Retry B accepted", 1050);
    fixture.run = retry;
    persist(&mut fixture);
    assert_eq!(task(&fixture, "task-b")["status"], "completed");
    let messages = Repositories::new(&fixture.db.lock().unwrap().raw)
        .sessions()
        .messages("main-session")
        .unwrap();
    assert_eq!(
        messages
            .iter()
            .filter(|message| message["taskId"] == "task-b")
            .count(),
        2
    );
    assert_eq!(
        messages
            .iter()
            .filter(|message| message["taskId"] == "task-a")
            .count(),
        1
    );
}

#[test]
fn workflow_task_projection_stopping_acceptance_never_reports_a_successful_task() {
    let mut fixture = fixture();
    claim_first(&mut fixture);
    let first = fixture
        .run
        .instances
        .iter_mut()
        .find(|instance| instance.node_id == "a")
        .unwrap();
    first.acceptance = Some(Acceptance::default());
    finish(&mut fixture.run, "a", "Model says done", 1020);
    persist(&mut fixture);
    assert_eq!(task(&fixture, "task-a")["status"], "verifying");
    fixture.run.cancel(1030);
    persist(&mut fixture);
    assert_eq!(task(&fixture, "task-a")["status"], "cancelled");
    assert_eq!(task(&fixture, "task-b")["status"], "cancelled");
    let messages = Repositories::new(&fixture.db.lock().unwrap().raw)
        .sessions()
        .messages("main-session")
        .unwrap();
    let receipt = messages
        .iter()
        .find(|message| message["taskId"] == "task-a")
        .unwrap();
    assert!(receipt["text"].as_str().unwrap().contains("not accepted"));
    let first = fixture
        .run
        .instances
        .iter()
        .find(|instance| instance.node_id == "a")
        .unwrap();
    assert_eq!(first.acceptance.as_ref().unwrap().status, "cancelled");
}

#[test]
fn workflow_task_events_require_a_transaction_and_cannot_replace_prior_events() {
    let fixture = fixture();
    let mut db = fixture.db.lock().unwrap();
    let main = Repositories::new(&db.raw)
        .sessions()
        .get("main-session")
        .unwrap()
        .unwrap();
    let mut event = fixture.event_builder.prepare_for_session(
        &main,
        &json!({}),
        "task.updated",
        json!({"status":"ready"}),
    );
    assert!(Repositories::new(&db.raw)
        .events()
        .append_in_transaction(&mut event)
        .is_err());
    let tx = db
        .raw
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    Repositories::new(&tx)
        .events()
        .append_in_transaction(&mut event)
        .unwrap();
    let mut replacement = event.clone();
    replacement["payload"]["status"] = json!("completed");
    assert!(Repositories::new(&tx)
        .events()
        .append_in_transaction(&mut replacement)
        .is_err());
    let saved = Repositories::new(&tx)
        .events()
        .replay(Some("main-session"), None, None, None)
        .unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0]["payload"]["status"], "ready");
}

#[test]
fn workflow_task_projection_stops_unactivated_dependents_when_the_graph_needs_a_decision() {
    let mut fixture = fixture();
    claim_first(&mut fixture);
    let first = fixture
        .run
        .instances
        .iter()
        .find(|instance| instance.node_id == "a")
        .unwrap()
        .id
        .clone();
    fixture
        .run
        .fail(&first, "Native execution failed", 1020)
        .unwrap();
    persist(&mut fixture);
    assert_eq!(fixture.run.status, "needs_decision");
    assert_eq!(task(&fixture, "task-a")["status"], "failed");
    assert_eq!(task(&fixture, "task-b")["status"], "cancelled");
    assert!(!fixture
        .run
        .instances
        .iter()
        .any(|instance| instance.node_id == "b"));
    assert!(TaskGraph::new(fixture.db.clone())
        .ready("project-run")
        .unwrap()
        .is_empty());
}

#[test]
fn workflow_task_projection_retry_waits_for_the_previous_native_children_to_stop() {
    let mut fixture = fixture();
    claim_first(&mut fixture);
    finish(&mut fixture.run, "a", "A accepted", 1020);
    persist(&mut fixture);
    let second = fixture
        .run
        .instances
        .iter_mut()
        .find(|instance| instance.node_id == "b")
        .unwrap();
    let mut work = crate::runtime::workflow::NativeWork::new("native-b");
    work.children
        .insert("background-child".into(), "running".into());
    second.native_work = Some(work);
    let second_id = second.id.clone();
    fixture
        .run
        .fail(&second_id, "Foreground failed", 1030)
        .unwrap();
    persist(&mut fixture);
    let mut retry = WorkflowRun::start(
        "retry".into(),
        "main-session".into(),
        "project".into(),
        "retry".into(),
        definition(false),
        json!({}),
        fixture.run.bindings.clone(),
        1040,
    )
    .unwrap();
    let source = TaskProjection {
        tasks: BTreeMap::from([(
            "b".into(),
            TaskAttempt {
                task_id: "task-b".into(),
                attempt: 2,
                member_id: "worker-member".into(),
            },
        )]),
        ..fixture.source.clone()
    };
    {
        let mut db = fixture.db.lock().unwrap();
        let tx = db
            .raw
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        assert!(claim(&tx, &mut retry, source.clone(), &fixture.event_builder)
            .unwrap_err()
            .to_string()
            .contains("previous task"));
        assert!(retry.task_projection.is_none());
    }
    assert_eq!(task(&fixture, "task-b")["attempt"], 1);
    fixture
        .run
        .instances
        .iter_mut()
        .find(|instance| instance.id == second_id)
        .unwrap()
        .native_work
        .as_mut()
        .unwrap()
        .released = true;
    persist(&mut fixture);
    let mut db = fixture.db.lock().unwrap();
    let tx = db
        .raw
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    claim(&tx, &mut retry, source, &fixture.event_builder).unwrap();
    workflows::save(&tx, &mut retry).unwrap();
    tx.commit().unwrap();
    drop(db);
    assert_eq!(task(&fixture, "task-b")["attempt"], 2);
}

#[test]
fn workflow_task_projection_keeps_approval_and_recovery_owned_by_the_original_graph() {
    let mut fixture = fixture();
    fixture.run.approval_id = Some("delegate-approval".into());
    fixture.run.pause(true, 1010);
    claim_first(&mut fixture);
    let blocked = task(&fixture, "task-b");
    assert_eq!(blocked["status"], "waiting_approval");
    assert_eq!(task(&fixture, "task-a")["status"], "waiting_approval");
    TaskGraph::new(fixture.db.clone())
        .release_approval("project-run")
        .unwrap();
    assert_eq!(task(&fixture, "task-b"), blocked);
    // Recovery may explicitly select a new main. A late receipt still belongs
    // to the main native session and member that launched the original graph.
    {
        let db = fixture.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let mut project = repos.project_runs().get("project-run").unwrap().unwrap();
        project["mainSessionId"] = json!("replacement-main");
        project["mainMemberId"] = json!("replacement-lead");
        repos.project_runs().save(&project).unwrap();
    }
    fixture.run.approval_id = None;
    fixture.run.pause(false, 1020);
    finish(&mut fixture.run, "a", "Original result", 1030);
    persist(&mut fixture);
    let db = fixture.db.lock().unwrap();
    let repos = Repositories::new(&db.raw);
    let original = repos.sessions().messages("main-session").unwrap();
    assert_eq!(original.len(), 1);
    assert_eq!(original[0]["toMemberId"], "lead");
    assert!(repos
        .sessions()
        .messages("replacement-main")
        .unwrap()
        .is_empty());
}

#[test]
fn workflow_task_projection_retains_late_workspace_evidence_without_reviving_a_cancelled_task() {
    let mut fixture = fixture();
    claim_first(&mut fixture);
    let first = fixture
        .run
        .instances
        .iter_mut()
        .find(|instance| instance.node_id == "a")
        .unwrap();
    first.workspace = Some(crate::runtime::workflow::NodeWorkspace {
        stage: "planned".into(),
        context: json!({"workspaceMode":"git_isolated","workspacePath":"integration","baseCommit":"base"}),
        outcome: None,
        error: None,
    });
    persist(&mut fixture);
    assert!(task(&fixture, "task-a")["workspacePath"].is_null());
    fixture.run.cancel(1020);
    persist(&mut fixture);
    let receipt = task(&fixture, "task-a")["resultMessageId"].clone();
    let first = fixture
        .run
        .instances
        .iter_mut()
        .find(|instance| instance.node_id == "a")
        .unwrap();
    first.workspace.as_mut().unwrap().stage = "cancelled".into();
    first.workspace.as_mut().unwrap().context = json!({"workspaceMode":"git_isolated","workspacePath":"actual-task","workspaceRoot":"actual-task","branchName":"actual-task-branch","baseCommit":"base"});
    let events = persist(&mut fixture);
    assert_eq!(task(&fixture, "task-a")["status"], "cancelled");
    assert_eq!(task(&fixture, "task-a")["workspacePath"], "actual-task");
    assert_eq!(task(&fixture, "task-a")["resultMessageId"], receipt);
    assert!(events
        .iter()
        .all(|event| event["type"] != "handoff.created"));
    assert!(persist(&mut fixture).is_empty());
}
