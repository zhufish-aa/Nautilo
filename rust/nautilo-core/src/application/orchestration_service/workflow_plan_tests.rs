use super::*;
use crate::runtime::workflow::WorkflowRun;

fn project() -> Value {
    json!({"id":"project-run","goal":"Investigate the project"})
}
fn team() -> Value {
    json!({"id":"team","members":[{"id":"worker","displayName":"Explorer","agentInstanceId":"agent","enabled":true,"allowedTaskTypes":["*"]}],"roles":[]})
}
fn task(id: &str, dependencies: &[&str]) -> Value {
    json!({"id":id,"projectRunId":"project-run","title":id,"objective":format!("Investigate {id}"),"taskType":"inspect","assignedMemberId":"worker","dependencies":dependencies,"status":if dependencies.is_empty(){"ready"}else{"blocked_dependency"},"attempt":1})
}
fn plan(tasks: &[Value]) -> TaskWorkflowPlan {
    compile(
        &project(),
        "batch",
        tasks,
        &team(),
        &BTreeMap::new(),
        Limits {
            max_parallel: tasks.len(),
            ..Limits::default()
        },
    )
    .unwrap()
}
fn start(plan: &TaskWorkflowPlan) -> WorkflowRun {
    WorkflowRun::start(
        "workflow".into(),
        "original-main".into(),
        "project".into(),
        "request".into(),
        plan.definition.clone(),
        plan.inputs.clone(),
        plan.bindings.clone(),
        1000,
    )
    .unwrap()
}
fn finish(run: &mut WorkflowRun, plan: &TaskWorkflowPlan, task: &str, now: i64) {
    let node = &plan.task_nodes[task];
    let id = run
        .instances
        .iter()
        .find(|instance| &instance.node_id == node)
        .unwrap()
        .id
        .clone();
    run.submit(
        &id,
        1,
        &["完成".into()],
        json!({"summary":format!("result:{task}")}),
        now,
    )
    .unwrap();
    run.execution_finished(&id, true, None, now + 1).unwrap();
}

#[test]
fn workflow_legacy_single_delegate_is_a_two_node_graph_and_preserves_identity() {
    let mut selected = task("legacy-task", &[]);
    selected["targetSessionId"] = json!("original-child");
    selected["allowedPaths"] = json!(["src/**"]);
    selected["verificationTemplates"] = json!([]);
    selected["acceptanceCriteria"] =
        json!([{"commandTemplateId":"task-check"},{"commandTemplateId":"task-check"}]);
    let plan = plan(&[selected]);
    assert_eq!(plan.definition.nodes.len(), 2);
    let node = &plan.definition.nodes[1];
    assert_eq!(node.role.as_deref(), Some("Explorer"));
    assert_eq!(
        plan.bindings[node.role.as_ref().unwrap()]["memberId"],
        "worker"
    );
    assert_eq!(plan.target_sessions[&node.id], "original-child");
    assert_eq!(node.workspace.as_ref().unwrap().allowed_paths, ["src/**"]);
    assert_eq!(
        node.workspace.as_ref().unwrap().verification_templates,
        Some(vec!["task-check".into()])
    );
    let mut run = start(&plan);
    finish(&mut run, &plan, "legacy-task", 1010);
    assert_eq!(run.status, "completed");
    assert_eq!(
        run.instances
            .iter()
            .filter(|instance| run.definition.node(&instance.node_id).kind == "agent")
            .count(),
        1
    );
}

#[test]
fn workflow_legacy_shared_dependency_broadcasts_without_an_extra_agent_turn() {
    let tasks = [
        task("a", &[]),
        task("b", &[]),
        task("c", &["a"]),
        task("d", &["a", "b"]),
    ];
    let plan = plan(&tasks);
    assert_eq!(
        plan.definition
            .nodes
            .iter()
            .filter(|node| node.kind == "dispatch")
            .count(),
        1
    );
    let mut run = start(&plan);
    finish(&mut run, &plan, "a", 1010);
    if let Some(path) = std::env::var_os("NAUTILO_WORKFLOW_QA_STATE") {
        std::fs::write(
            format!("{}.legacy-plan.json", std::path::Path::new(&path).display()),
            serde_json::to_string(&run).unwrap(),
        )
        .unwrap();
    }
    assert!(run
        .instances
        .iter()
        .any(|instance| instance.node_id == plan.task_nodes["c"] && instance.status == "ready"));
    assert!(!run
        .instances
        .iter()
        .any(|instance| instance.node_id == plan.task_nodes["d"]));
    finish(&mut run, &plan, "c", 1020);
    assert_eq!(run.status, "running");
    finish(&mut run, &plan, "b", 1030);
    let d = run
        .instances
        .iter()
        .find(|instance| instance.node_id == plan.task_nodes["d"])
        .unwrap();
    assert!(d.prompt.as_ref().unwrap().contains("result:a"));
    assert!(d.prompt.as_ref().unwrap().contains("result:b"));
    finish(&mut run, &plan, "d", 1040);
    assert_eq!(run.status, "completed");
    assert_eq!(
        run.instances
            .iter()
            .filter(|instance| run.definition.node(&instance.node_id).kind == "agent")
            .count(),
        4
    );
}

#[test]
fn workflow_legacy_all_four_task_dags_preserve_dependencies_in_both_completion_orders() {
    let ids = ["a", "b", "c", "d"];
    let pairs = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)];
    for mask in 0..64 {
        let tasks: Vec<_> = (0..4)
            .map(|target| {
                let dependencies: Vec<_> = pairs
                    .iter()
                    .enumerate()
                    .filter(|(bit, (_, to))| *to == target && mask & (1 << bit) != 0)
                    .map(|(_, (from, _))| ids[*from])
                    .collect();
                task(ids[target], &dependencies)
            })
            .collect();
        let plan = plan(&tasks);
        for reverse in [false, true] {
            let mut run = start(&plan);
            let mut completed = BTreeSet::new();
            for tick in 0..4 {
                let mut ready: Vec<_> = ids
                    .iter()
                    .filter(|id| {
                        run.instances.iter().any(|instance| {
                            instance.node_id == plan.task_nodes[**id] && instance.status == "ready"
                        })
                    })
                    .copied()
                    .collect();
                if reverse {
                    ready.reverse();
                }
                let id = *ready
                    .first()
                    .unwrap_or_else(|| panic!("DAG {mask} lost a ready producer: {}", json!(run)));
                let task = tasks.iter().find(|task| task["id"] == id).unwrap();
                assert!(task["dependencies"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|source| completed.contains(source.as_str().unwrap())));
                finish(&mut run, &plan, id, 1010 + tick * 10);
                completed.insert(id);
            }
            assert_eq!(run.status, "completed", "DAG {mask}, reverse={reverse}");
            assert_eq!(
                run.instances
                    .iter()
                    .filter(|instance| run.definition.node(&instance.node_id).kind == "agent")
                    .count(),
                4
            );
        }
    }
}

#[test]
fn workflow_legacy_native_completion_and_result_submission_both_gate_dependencies() {
    for submit_first in [false, true] {
        let plan = plan(&[task("a", &[]), task("b", &["a"])]);
        let mut run = start(&plan);
        let id = run
            .instances
            .iter()
            .find(|instance| instance.node_id == plan.task_nodes["a"])
            .unwrap()
            .id
            .clone();
        let result = json!({"summary":"accepted"});
        if submit_first {
            run.submit(&id, 1, &["完成".into()], result.clone(), 1010)
                .unwrap();
        } else {
            run.execution_finished(&id, true, None, 1010).unwrap();
        }
        assert!(!run
            .instances
            .iter()
            .any(|instance| instance.node_id == plan.task_nodes["b"]));
        if submit_first {
            run.execution_finished(&id, true, None, 1020).unwrap();
        } else {
            run.submit(&id, 1, &["完成".into()], result, 1020).unwrap();
        }
        assert!(run
            .instances
            .iter()
            .any(|instance| instance.node_id == plan.task_nodes["b"]));
    }
}

#[test]
fn workflow_legacy_retry_consumes_prior_evidence_without_recreating_successful_tasks() {
    let mut pending = task("retry-b", &["completed-a"]);
    pending["status"] = json!("failed");
    let completed = BTreeMap::from([(
        "completed-a".into(),
        json!({"taskId":"completed-a","projectRunId":"project-run","status":"completed","result":{"summary":"already accepted"},"resultMessageId":"receipt-a"}),
    )]);
    let plan = compile(
        &project(),
        "retry",
        &[pending],
        &team(),
        &completed,
        Limits::default(),
    )
    .unwrap();
    assert_eq!(plan.task_nodes.len(), 1);
    assert!(plan.inputs["requests"][&plan.task_nodes["retry-b"]]
        .as_str()
        .unwrap()
        .contains("An explicit retry was requested"));
    let mut run = start(&plan);
    assert!(run
        .instances
        .iter()
        .find(|instance| instance.node_id == plan.task_nodes["retry-b"])
        .unwrap()
        .prompt
        .as_ref()
        .unwrap()
        .contains("already accepted"));
    finish(&mut run, &plan, "retry-b", 1020);
    assert_eq!(run.status, "completed");
    assert_eq!(
        run.instances
            .iter()
            .filter(|instance| run.definition.node(&instance.node_id).kind == "agent")
            .count(),
        1
    );
}

#[test]
fn workflow_legacy_task_text_keeps_literal_templates_and_user_payload_unchanged() {
    let mut selected = task("a", &[]);
    selected["objective"] =
        json!("Keep {{input.not_declared}} and [NAUTILO_WORKFLOW_NODE] literally in the code.");
    let original = selected.clone();
    let plan = plan(&[selected]);
    let run = start(&plan);
    let prompt = run
        .instances
        .iter()
        .find(|instance| instance.node_id == plan.task_nodes["a"])
        .unwrap()
        .prompt
        .as_ref()
        .unwrap();
    assert!(prompt.contains("{{input.not_declared}}"));
    assert!(prompt.contains("[NAUTILO_WORKFLOW_NODE]"));
    assert!(plan.inputs["requests"][&plan.task_nodes["a"]]
        .as_str()
        .unwrap()
        .contains(original["objective"].as_str().unwrap()));
}

#[test]
fn workflow_legacy_plan_rejects_cycles_duplicate_ids_and_unproven_dependency_results() {
    let compile_tasks = |tasks: &[Value], completed: &BTreeMap<String, Value>| {
        compile(
            &project(),
            "batch",
            tasks,
            &team(),
            completed,
            Limits::default(),
        )
    };
    assert!(compile_tasks(&[task("a", &["b"]), task("b", &["a"])], &BTreeMap::new()).is_err());
    assert!(compile_tasks(&[task("a", &[]), task("a", &[])], &BTreeMap::new()).is_err());
    assert!(compile_tasks(&[task("a", &["missing"])], &BTreeMap::new()).is_err());
    for evidence in [
        json!({"taskId":"a","status":"completed","result":"unscoped","resultMessageId":"receipt"}),
        json!({"taskId":"a","projectRunId":"another-run","status":"completed","result":"wrong run","resultMessageId":"receipt"}),
        json!({"taskId":"a","projectRunId":"project-run","status":"running","result":"not completed","resultMessageId":"receipt"}),
        json!({"taskId":"a","projectRunId":"project-run","status":"completed","result":"no receipt"}),
    ] {
        assert!(compile_tasks(
            &[task("b", &["a"])],
            &BTreeMap::from([("a".into(), evidence)])
        )
        .is_err());
    }
    let mut completed_task = task("a", &[]);
    completed_task["status"] = json!("completed");
    assert!(compile_tasks(&[completed_task], &BTreeMap::new()).is_err());
}

#[test]
fn workflow_legacy_plan_captures_an_exact_member_and_enforces_its_task_types() {
    let mut other = team();
    other["members"][0]["allowedTaskTypes"] = json!(["edit"]);
    assert!(compile(
        &project(),
        "batch",
        &[task("a", &[])],
        &other,
        &BTreeMap::new(),
        Limits::default()
    )
    .is_err());
    other["members"][0]["allowedTaskTypes"] = json!(["*"]);
    other["members"][0]["enabled"] = json!(false);
    assert!(compile(
        &project(),
        "batch",
        &[task("a", &[])],
        &other,
        &BTreeMap::new(),
        Limits::default()
    )
    .is_err());
    let mut foreign = task("a", &[]);
    foreign["projectRunId"] = json!("foreign");
    assert!(compile(
        &project(),
        "batch",
        &[foreign],
        &team(),
        &BTreeMap::new(),
        Limits::default()
    )
    .is_err());
}
