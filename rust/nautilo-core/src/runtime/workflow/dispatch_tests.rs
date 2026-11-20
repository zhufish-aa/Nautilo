use super::*;
use serde_json::{json, Value};

fn start(definition: Value) -> WorkflowRun {
    let definition: Definition = serde_json::from_value(definition).unwrap();
    definition.validate().unwrap();
    WorkflowRun::start(
        "dispatch-run".into(),
        "main-session".into(),
        "project".into(),
        "request".into(),
        definition,
        json!({"question":"source"}),
        json!({}),
        1000,
    )
    .unwrap()
}
fn done(run: &mut WorkflowRun, node: &str, now: i64) {
    let id = run
        .instances
        .iter()
        .find(|instance| instance.node_id == node)
        .unwrap()
        .id
        .clone();
    run.submit(&id, 1, &["完成".into()], json!({"summary":"source"}), now)
        .unwrap();
    run.execution_finished(&id, true, None, now + 1).unwrap();
}
fn agent(id: &str, prompt: &str) -> Value {
    json!({"id":id,"kind":"agent","role":"Explorer","prompt":prompt,"outputs":{"summary":"text"},"exits":[{"id":"done","name":"完成"}]})
}

#[test]
fn workflow_dispatch_preserves_payload_and_completed_evidence_across_a_restart() {
    let mut run = start(
        json!({"schemaVersion":1,"id":"broadcast","entry":"main","inputs":{"question":"text"},"nodes":[
            {"id":"main","kind":"main","exits":[{"id":"go","name":"开始"}]},agent("source","{{input.question}}"),
            {"id":"split","kind":"dispatch","exits":[{"id":"x","name":"交给 X"},{"id":"y","name":"交给 Y"}]},
            agent("x","{{incoming.result.summary}}"),agent("y","{{steps.split.latest.result.summary}}"),
            {"id":"join","kind":"join","scope":"split","exits":[{"id":"done","name":"汇齐"}]}
        ],"edges":[
            {"from":["main","go"],"to":"source"},{"from":["source","done"],"to":"split"},
            {"from":["split","x"],"to":"x"},{"from":["split","y"],"to":"y"},
            {"from":["x","done"],"to":"join"},{"from":["y","done"],"to":"join"},{"from":["join","done"],"to":"$return"}
        ]}),
    );
    done(&mut run, "source", 1010);
    let split = run
        .instances
        .iter()
        .find(|instance| instance.node_id == "split")
        .unwrap();
    assert_eq!(split.result, Some(json!({"summary":"source"})));
    assert_eq!(split.branches, Some(vec!["x".into(), "y".into()]));
    for node in ["x", "y"] {
        assert_eq!(
            run.instances
                .iter()
                .find(|instance| instance.node_id == node)
                .unwrap()
                .prompt
                .as_deref(),
            Some("source")
        );
    }
    done(&mut run, "x", 1020);
    assert_eq!(run.status, "running");
    let mut restored: WorkflowRun = serde_json::from_value(json!(run)).unwrap();
    done(&mut restored, "y", 1030);
    assert_eq!(restored.status, "completed");
    assert_eq!(
        restored
            .instances
            .iter()
            .filter(|instance| restored.definition.node(&instance.node_id).kind == "agent")
            .count(),
        3
    );
    assert_eq!(
        restored
            .events
            .iter()
            .filter(|event| event.r#type == "node.distributed")
            .count(),
        1
    );
}

#[test]
fn workflow_dispatch_single_exit_establishes_a_real_join_scope() {
    let mut run = start(
        json!({"schemaVersion":1,"id":"single-dispatch","entry":"main","inputs":{"question":"text"},"nodes":[
        {"id":"main","kind":"main","exits":[{"id":"go","name":"开始"}]},
        {"id":"split","kind":"dispatch","exits":[{"id":"one","name":"一个任务"}]},agent("worker","{{incoming.result.question}}"),
        {"id":"join","kind":"join","scope":"split","exits":[{"id":"done","name":"收齐"}]}
    ],"edges":[{"from":["main","go"],"to":"split"},{"from":["split","one"],"to":"worker"},{"from":["worker","done"],"to":"join"},{"from":["join","done"],"to":"$return"}]}),
    );
    assert_eq!(
        run.instances
            .iter()
            .find(|instance| instance.node_id == "worker")
            .unwrap()
            .prompt
            .as_deref(),
        Some("source")
    );
    done(&mut run, "worker", 1010);
    assert_eq!(run.status, "completed");
}
