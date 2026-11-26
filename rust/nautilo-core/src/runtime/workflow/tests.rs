use super::*;
use serde_json::{json, Value};

fn definition() -> Definition {
    serde_json::from_value(json!({
        "schemaVersion":1,"id":"investigate","entry":"main",
        "inputs":{"question":"text"},
        "nodes":[
            {"id":"main","kind":"main","dispatch":"all","exits":[{"id":"a","name":"查代码"},{"id":"b","name":"查时序"}]},
            {"id":"a","kind":"agent","role":"Explorer","prompt":"调查 {{input.question}}，提交 {{exit.done}}","outputs":{"summary":"text"},"exits":[{"id":"done","name":"代码证据"}]},
            {"id":"b","kind":"agent","role":"Explorer","prompt":"调查时序","outputs":{"summary":"text"},"submissionPolicy":{"graceMs":10,"timeoutMs":100,"reminderIntervalMs":100,"maxReminders":1},"exits":[{"id":"done","name":"时序证据"}]},
            {"id":"join","kind":"join","scope":"main","exits":[{"id":"done","name":"收齐"}]},
            {"id":"judge","kind":"agent","role":"Analyst","prompt":"综合 {{incoming}}","outputs":{"summary":"text"},"exits":[{"id":"done","name":"已定位"},{"id":"recheck","name":"需要复核"}]},
            {"id":"verify","kind":"agent","role":"Verifier","prompt":"核对 {{incoming.result.summary}}","outputs":{"summary":"text"},"exits":[{"id":"done","name":"已复核"}]}
        ],
        "edges":[
            {"from":["main","a"],"to":"a"},{"from":["main","b"],"to":"b"},
            {"from":["a","done"],"to":"join"},{"from":["b","done"],"to":"join"},
            {"from":["join","done"],"to":"judge"},{"from":["judge","done"],"to":"$return"},
            {"from":["judge","recheck"],"to":"verify"},{"from":["verify","done"],"to":"judge","maxTraversals":2,"onLimit":"$return_needs_decision"}
        ]
    })).unwrap()
}
fn run() -> WorkflowRun {
    WorkflowRun::start(
        "w".into(),
        "s".into(),
        "p".into(),
        "request".into(),
        definition(),
        json!({"question":"首轮为什么慢"}),
        json!({}),
        1000,
    )
    .unwrap()
}
fn latest(run: &WorkflowRun, node: &str) -> String {
    run.instances
        .iter()
        .rev()
        .find(|i| i.node_id == node)
        .unwrap()
        .id
        .clone()
}
fn complete(run: &mut WorkflowRun, node: &str, branch: &str, summary: &str, now: i64) {
    let id = latest(run, node);
    run.submit(&id, 1, &[branch.into()], json!({"summary":summary}), now)
        .unwrap();
    run.execution_finished(&id, true, None, now + 1).unwrap();
}
#[test]
fn workflow_bypass_forwards_input_without_creating_a_native_run() {
    let mut def = definition();
    let skipped = def.nodes.iter_mut().find(|node| node.id == "a").unwrap();
    skipped.bypass = true;
    skipped.prompt = Some("{{incoming.previous.missing}}".into());
    let mut run = WorkflowRun::start("skip".into(), "s".into(), "p".into(), "req".into(), def,
        json!({"question":"actual input"}), json!({}), 1000).unwrap();
    let skipped = run.instances.iter().find(|instance| instance.node_id == "a").unwrap();
    assert_eq!(skipped.status, "completed");
    assert_eq!(skipped.completed_at, Some(1000));
    assert!(skipped.prompt.is_none() && skipped.run_id.is_none() && skipped.session_id.is_none());
    assert!(run.events.iter().any(|event| event.r#type == "node.skipped"));
    complete(&mut run, "b", "时序证据", "trace", 1010);
    let judge = run.instances.iter().find(|instance| instance.node_id == "judge").unwrap();
    assert!(judge.prompt.as_deref().unwrap().contains("actual input"));
}
#[test]
fn workflow_output_descriptions_follow_the_field_schema_into_the_agent_instructions() {
    let mut def = definition();
    let node = def.nodes.iter_mut().find(|node| node.id == "a").unwrap();
    node.output_descriptions.insert("summary".into(), "一句话写明发现。".into());
    let instruction = node.submission_instruction();
    assert!(instruction.contains(r#"Result fields: {"summary":"text"}"#));
    assert!(instruction.contains(r#"Result field descriptions: {"summary":"一句话写明发现。"}"#));
    def.validate().unwrap();
    let round_trip: Definition = serde_json::from_value(serde_json::to_value(&def).unwrap()).unwrap();
    assert_eq!(round_trip.node("a").output_descriptions["summary"], "一句话写明发现。");
    assert!(round_trip.node("b").output_descriptions.is_empty());
    def.nodes.iter_mut().find(|node| node.id == "a").unwrap().outputs.clear();
    assert!(def.validate().unwrap_err().contains("undeclared result field: summary"));
}
#[test]
fn workflow_parallel_join_waits_for_each_execution_and_submission_in_either_order() {
    let mut run = run();
    assert_eq!(
        run.instances.iter().filter(|i| i.status == "ready").count(),
        2
    );
    let a = latest(&run, "a");
    let b = latest(&run, "b");
    run.submit(
        &b,
        1,
        &["时序证据".into()],
        json!({"summary":"trace"}),
        1010,
    )
    .unwrap();
    assert!(!run.instances.iter().any(|i| i.node_id == "judge"));
    run.execution_finished(&b, true, None, 1011).unwrap();
    assert!(!run.instances.iter().any(|i| i.node_id == "judge"));
    run.execution_finished(&a, true, None, 1012).unwrap();
    run.submit(&a, 1, &["代码证据".into()], json!({"summary":"code"}), 1013)
        .unwrap();
    assert_eq!(
        run.instances
            .iter()
            .filter(|i| i.node_id == "judge")
            .count(),
        1
    );
    complete(&mut run, "judge", "已定位", "answer", 1020);
    assert_eq!(run.status, "completed");
    assert_eq!(
        run.messages
            .iter()
            .filter(|m| m.recipient == "main")
            .count(),
        1
    );
}

#[test]
fn workflow_acceptance_blocks_routes_and_the_final_return_until_required_checks_pass() {
    let mut run = run();
    run.acceptance=Some(Acceptance::default());
    let a=latest(&run,"a");
    run.instances.iter_mut().find(|i|i.id == a).unwrap().acceptance=Some(Acceptance::default());
    complete(&mut run,"a","代码证据","accepted data",1010);
    assert_eq!(run.instances.iter().find(|i|i.id == a).unwrap().status,"verifying");
    assert!(run.instances.iter().find(|i|i.id == a).unwrap().branches.is_some());
    complete(&mut run,"b","时序证据","B",1020);
    assert!(!run.instances.iter().any(|i|i.node_id == "judge"));
    assert!(run.verification_started(&a,1030).unwrap());
    assert!(!run.verification_started(&a,1031).unwrap());
    run=serde_json::from_value(json!(run)).unwrap();
    run.verification_finished(&a,true,json!({"checks":["task-test"],"commit":"verified-commit"}),1040).unwrap();
    assert_eq!(run.instances.iter().filter(|i|i.node_id == "judge").count(),1);
    complete(&mut run,"judge","已定位","final result",1050);
    assert_eq!(run.status,"finalizing");
    assert!(run.messages.iter().all(|message|message.recipient != "main"));
    run.final_verification_finished(true,json!({"merge":"approved"}),1060).unwrap();
    assert_eq!(run.status,"completed");
    assert_eq!(run.messages.iter().filter(|message|message.recipient == "main").count(),1);
    let events=run.events.len();
    run.final_verification_finished(true,json!({}),1070).unwrap();
    assert_eq!(run.events.len(),events);
}

#[test]
fn workflow_failed_or_cancelled_acceptance_preserves_evidence_and_never_starts_dependents() {
    for cancel in [false,true] {
        let mut run = run();
        let a=latest(&run,"a");
        run.instances.iter_mut().find(|i|i.id == a).unwrap().acceptance=Some(Acceptance::default());
        complete(&mut run,"a","代码证据","original evidence",1010);
        run.verification_started(&a,1020).unwrap();
        if cancel { run.cancel(1021); }
        run.verification_finished(&a,false,json!({"message":"Required command failed","verificationId":"receipt-1"}),1030).unwrap();
        assert_eq!(run.status,if cancel {"cancelled"}else{"needs_decision"});
        assert_eq!(run.instances.iter().find(|i|i.id == a).unwrap().result,json!({"summary":"original evidence"}).into());
        assert!(!run.instances.iter().any(|i|i.node_id == "judge"));
        run.verification_finished(&a,true,json!({}),1040).unwrap();
        assert!(!run.instances.iter().any(|i|i.node_id == "judge"));
    }
}

fn overlapping_definition() -> Definition {
    serde_json::from_value(json!({"schemaVersion":1,"id":"overlapping","entry":"main","nodes":[
        {"id":"main","kind":"main","dispatch":"all","exits":[{"id":"a","name":"A"},{"id":"b","name":"B"}]},
        {"id":"a","kind":"agent","role":"Explorer","prompt":"Collect A","exitMode":"some","outputs":{"summary":"text"},"exits":[{"id":"c","name":"For C"},{"id":"d","name":"For D"}]},
        {"id":"b","kind":"agent","role":"Explorer","prompt":"Collect B","outputs":{"summary":"text"},"exits":[{"id":"done","name":"Done"}]},
        {"id":"c","kind":"agent","role":"Explorer","prompt":"Use {{incoming.result.summary}}","outputs":{"summary":"text"},"exits":[{"id":"done","name":"Done"}]},
        {"id":"d-input","kind":"join","scope":"main","sources":["a","b"],"exits":[{"id":"done","name":"Collected A+B"}]},
        {"id":"d","kind":"agent","role":"Explorer","prompt":"Use {{incoming.result.a.result.summary}} and {{incoming.result.b.result.summary}}","outputs":{"summary":"text"},"exits":[{"id":"done","name":"Done"}]},
        {"id":"final","kind":"join","scope":"main","sources":["c","d"],"exits":[{"id":"done","name":"Collected C+D"}]}
    ],"edges":[
        {"from":["main","a"],"to":"a"},{"from":["main","b"],"to":"b"},
        {"from":["a","c"],"to":"c"},{"from":["a","d"],"to":"d-input"},{"from":["b","done"],"to":"d-input"},
        {"from":["d-input","done"],"to":"d"},{"from":["c","done"],"to":"final"},{"from":["d","done"],"to":"final"},
        {"from":["final","done"],"to":"$return"}
    ]})).unwrap()
}
fn start_definition(definition: Definition) -> WorkflowRun {
    WorkflowRun::start(
        "w".into(),
        "s".into(),
        "p".into(),
        "request".into(),
        definition,
        json!({}),
        json!({}),
        1000,
    )
    .unwrap()
}
fn complete_a(run: &mut WorkflowRun, now: i64) {
    let id = latest(run, "a");
    run.submit(
        &id,
        1,
        &["For C".into(), "For D".into()],
        json!({"summary":"evidence A"}),
        now,
    )
    .unwrap();
    run.execution_finished(&id, true, None, now + 1).unwrap();
}

#[test]
fn workflow_overlapping_joins_keep_independent_arrivals_for_both_completion_orders() {
    for c_first in [true, false] {
        let mut run = start_definition(overlapping_definition());
        complete_a(&mut run, 1010);
        if c_first {
            complete(&mut run, "c", "Done", "evidence C", 1020);
        }
        complete(&mut run, "b", "Done", "evidence B", 1030);
        assert_eq!(run.status, "running");
        assert!(run
            .instances
            .iter()
            .find(|i| i.node_id == "d")
            .unwrap()
            .prompt
            .as_ref()
            .unwrap()
            .contains("evidence A and evidence B"));
        // Persist/reload halfway through: joins and correlation frames survive.
        run = serde_json::from_value(json!(run)).unwrap();
        complete(&mut run, "d", "Done", "evidence D", 1040);
        if !c_first {
            complete(&mut run, "c", "Done", "evidence C", 1050);
        }
        assert_eq!(run.status, "completed");
        assert_eq!(
            run.instances
                .iter()
                .filter(|i| i.node_id == "d-input")
                .count(),
            1
        );
        assert_eq!(
            run.instances
                .iter()
                .filter(|i| i.node_id == "final")
                .count(),
            1
        );
        let final_instance = run.instances.iter().find(|i| i.node_id == "final").unwrap();
        assert_eq!(
            final_instance.incoming["c"]["result"]["summary"],
            "evidence C"
        );
        assert_eq!(
            final_instance.incoming["d"]["result"]["summary"],
            "evidence D"
        );
    }
}

#[test]
fn workflow_source_join_loops_start_fresh_batches_without_consuming_old_results() {
    let mut value = json!(overlapping_definition());
    value["nodes"].as_array_mut().unwrap().push(json!({"id":"review","kind":"agent","role":"Reviewer","prompt":"Review the batch","outputs":{"summary":"text"},"exits":[{"id":"repeat","name":"Repeat"},{"id":"done","name":"Done"}]}));
    value["edges"].as_array_mut().unwrap().last_mut().unwrap()["to"] = json!("review");
    value["edges"].as_array_mut().unwrap().extend([
        json!({"from":["review","repeat"],"to":"main","maxTraversals":1,"onLimit":"$return_needs_decision"}),
        json!({"from":["review","done"],"to":"$return"})
    ]);
    let mut run = start_definition(serde_json::from_value(value.clone()).unwrap());
    for round in 0..2 {
        complete_a(&mut run, 1010 + round * 100);
        complete(&mut run, "b", "Done", "B", 1020 + round * 100);
        complete(&mut run, "c", "Done", "C", 1030 + round * 100);
        complete(&mut run, "d", "Done", "D", 1040 + round * 100);
        complete(
            &mut run,
            "review",
            if round == 0 { "Repeat" } else { "Done" },
            "reviewed",
            1050 + round * 100,
        );
    }
    assert_eq!(run.status, "completed");
    assert_eq!(
        run.instances
            .iter()
            .filter(|i| i.node_id == "d-input")
            .count(),
        2
    );
    assert_eq!(
        run.instances
            .iter()
            .filter(|i| i.node_id == "final")
            .count(),
        2
    );
    // Re-entering a source join in the same batch would mix loop activations.
    value["edges"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["from"][0] == "review" && e["from"][1] == "repeat")
        .unwrap()["to"] = json!("a");
    assert!(serde_json::from_value::<Definition>(value)
        .unwrap()
        .validate()
        .unwrap_err()
        .contains("re-enter"));
}

#[test]
fn workflow_source_join_cancels_unstarted_sources_without_cancelling_unrelated_work() {
    let definition:Definition = serde_json::from_value(json!({"schemaVersion":1,"id":"cancel-late-source","entry":"main","nodes":[
        {"id":"main","kind":"main","dispatch":"all","exits":[{"id":"a","name":"A"},{"id":"b","name":"B"},{"id":"other","name":"Other"}]},
        {"id":"a","kind":"condition","otherwise":"done","exits":[{"id":"done","name":"Done"}]},
        {"id":"b","kind":"agent","role":"Explorer","prompt":"Should be skipped","outputs":{"summary":"text"},"exits":[{"id":"done","name":"Done"}]},
        {"id":"other","kind":"agent","role":"Explorer","prompt":"Independent work","outputs":{"summary":"text"},"exits":[{"id":"done","name":"Done"}]},
        {"id":"race","kind":"join","scope":"main","sources":["a","b"],"wait":"firstValid","remaining":"cancel","exits":[{"id":"done","name":"Winner"}]}
    ],"edges":[{"from":["main","a"],"to":"a"},{"from":["main","b"],"to":"b"},{"from":["main","other"],"to":"other"},{"from":["a","done"],"to":"race"},{"from":["b","done"],"to":"race"},{"from":["other","done"],"to":"$return"},{"from":["race","done"],"to":"$return"}]})).unwrap();
    let mut run = start_definition(definition);
    assert!(!run.instances.iter().any(|i| i.node_id == "b"));
    assert_eq!(
        run.instances
            .iter()
            .find(|i| i.node_id == "other")
            .unwrap()
            .status,
        "ready"
    );
    assert_eq!(run.status, "running");
    complete(&mut run, "other", "Done", "other result", 1020);
    assert_eq!(run.status, "completed");
}

#[test]
fn workflow_source_join_detects_a_failed_required_predecessor_while_other_work_is_live() {
    let mut run = start_definition(overlapping_definition());
    complete_a(&mut run, 1010);
    let b = latest(&run, "b");
    run.fail(&b, "source failed", 1020).unwrap();
    assert_eq!(run.status, "needs_decision");
    assert!(run.error.as_ref().unwrap().contains("join"));
    assert!(!run.instances.iter().any(|i| i.node_id == "d"));
}
#[test]
fn workflow_submission_rejects_wrong_ports_missing_fields_conflicts_and_late_attempts() {
    let mut run = run();
    let id = latest(&run, "a");
    for (attempt, port, result) in [
        (1, "不存在", json!({"summary":"a"})),
        (1, "代码证据", json!({})),
        (2, "代码证据", json!({"summary":"a"})),
    ] {
        assert!(run
            .submit(&id, attempt, &[port.into()], result, 1010)
            .is_err());
    }
    let payload = json!({"summary":"a"});
    run.submit(&id, 1, &["代码证据".into()], payload.clone(), 1011)
        .unwrap();
    assert_eq!(
        run.submit(&id, 1, &["代码证据".into()], payload, 1012)
            .unwrap()["duplicate"],
        true
    );
    assert!(run
        .submit(
            &id,
            1,
            &["代码证据".into()],
            json!({"summary":"changed"}),
            1013
        )
        .is_err());
}
#[test]
fn workflow_loop_creates_new_instances_and_only_repeats_the_affected_nodes() {
    let mut run = run();
    complete(&mut run, "a", "代码证据", "a", 1010);
    complete(&mut run, "b", "时序证据", "b", 1020);
    for iteration in 0..3 {
        complete(
            &mut run,
            "judge",
            "需要复核",
            "inspect",
            1030 + iteration * 10,
        );
        complete(
            &mut run,
            "verify",
            "已复核",
            "new evidence",
            1033 + iteration * 10,
        );
    }
    assert_eq!(run.status, "needs_decision");
    assert_eq!(run.instances.iter().filter(|i| i.node_id == "a").count(), 1);
    assert_eq!(
        run.instances
            .iter()
            .filter(|i| i.node_id == "judge")
            .count(),
        3
    );
    assert_eq!(
        run.messages
            .iter()
            .filter(|m| m.recipient == "main")
            .count(),
        1
    );
}
#[test]
fn workflow_missing_submission_queues_a_durable_original_session_reminder_then_escalates() {
    let mut run = run();
    let id = latest(&run, "b");
    run.instances
        .iter_mut()
        .find(|i| i.id == id)
        .unwrap()
        .session_id = Some("original-child".into());
    run.execution_finished(&id, true, None, 1010).unwrap();
    run.tick(1019).unwrap();
    assert!(run.messages.is_empty());
    run.tick(1020).unwrap();
    run.tick(1021).unwrap();
    assert_eq!(run.messages.len(), 1);
    assert_eq!(
        run.messages[0].session_id.as_deref(),
        Some("original-child")
    );
    let saved = serde_json::to_string(&run).unwrap();
    let mut recovered: WorkflowRun = serde_json::from_str(&saved).unwrap();
    recovered.tick(1121).unwrap();
    assert_eq!(recovered.status, "needs_decision");
    assert_eq!(
        recovered
            .messages
            .iter()
            .filter(|m| m.recipient == "main")
            .count(),
        1
    );
    recovered.tick(1150).unwrap();
    assert_eq!(
        recovered
            .messages
            .iter()
            .filter(|m| m.recipient == "main")
            .count(),
        1
    );
}
#[test]
fn workflow_valid_supplement_cancels_pending_reminders_and_advances_once() {
    let mut run = run();
    complete(&mut run, "a", "代码证据", "a", 1010);
    let id = latest(&run, "b");
    run.execution_finished(&id, true, None, 1020).unwrap();
    run.tick(1030).unwrap();
    run.submit(&id, 1, &["时序证据".into()], json!({"summary":"b"}), 1040)
        .unwrap();
    run.tick(2000).unwrap();
    assert_eq!(run.messages[0].status, "resolved");
    assert_eq!(
        run.instances
            .iter()
            .filter(|i| i.node_id == "judge")
            .count(),
        1
    );
}
#[test]
fn workflow_cancel_and_pause_do_not_start_reminders_or_accept_new_results() {
    let mut run = run();
    let id = latest(&run, "b");
    run.execution_finished(&id, true, None, 1010).unwrap();
    run.pause(true, 1012);
    run.tick(5000).unwrap();
    assert!(run.messages.is_empty());
    run.pause(false, 5012);
    run.tick(5019).unwrap();
    assert!(run.messages.is_empty());
    run.tick(5020).unwrap();
    assert_eq!(run.messages.len(), 1);
    run.cancel(5021);
    run.tick(8000).unwrap();
    assert_eq!(run.status, "cancelled");
    assert!(run
        .submit(
            &id,
            1,
            &["时序证据".into()],
            json!({"summary":"late"}),
            5030
        )
        .is_err());
}
#[test]
fn workflow_validates_unbounded_cycles_and_renders_output_names() {
    let mut def = definition();
    def.edges[7].max_traversals = None;
    def.edges[7].on_limit = None;
    assert!(def.validate().unwrap_err().contains("Cycle"));
    let run = run();
    assert!(run
        .instances
        .iter()
        .find(|i| i.node_id == "a")
        .unwrap()
        .prompt
        .as_ref()
        .unwrap()
        .contains("代码证据"));
    assert!(render("{{input.missing}}", &json!({"input":{}})).is_err());
}
#[test]
fn workflow_foreach_preserves_item_identity_and_handles_the_real_join_batch() {
    let mut def = definition();
    def.nodes
        .retain(|n| !["a", "verify"].contains(&n.id.as_str()));
    def.nodes
        .iter_mut()
        .find(|n| n.id == "main")
        .unwrap()
        .exits
        .retain(|e| e.id == "b");
    let b = def.nodes.iter_mut().find(|n| n.id == "b").unwrap();
    b.for_each = Some(ForEach {
        source: "input.items".into(),
        key: "key".into(),
        max_items: 5,
        max_parallel: 2,
        empty_exit: None,
    });
    b.prompt = Some("调查 {{item.key}}".into());
    def.inputs.insert("items".into(), json!("list<json>"));
    def.nodes.iter_mut().find(|n| n.id == "join").unwrap().scope = Some("b".into());
    def.nodes
        .iter_mut()
        .find(|n| n.id == "judge")
        .unwrap()
        .exits
        .retain(|p| p.id == "done");
    def.edges.retain(|e| {
        !["a", "verify"].contains(&e.from[0].as_str()) && e.to != "a" && e.to != "verify"
    });
    let mut r = WorkflowRun::start(
        "w".into(),
        "s".into(),
        "p".into(),
        "q".into(),
        def,
        json!({"question":"q","items":[{"key":"one"},{"key":"two"}]}),
        json!({}),
        1000,
    )
    .unwrap();
    let ids = r
        .instances
        .iter()
        .filter(|i| i.node_id == "b")
        .map(|i| i.id.clone())
        .collect::<Vec<_>>();
    assert_eq!(ids.len(), 2);
    for id in ids {
        r.submit(&id, 1, &["时序证据".into()], json!({"summary":"ok"}), 1010)
            .unwrap();
        r.execution_finished(&id, true, None, 1011).unwrap();
    }
    assert_eq!(
        r.instances.iter().filter(|i| i.node_id == "judge").count(),
        1
    );
}

#[test]
fn workflow_first_valid_keeps_other_producers_alive_after_a_failure() {
    let mut def = definition();
    def.nodes.iter_mut().find(|n| n.id == "join").unwrap().wait = "firstValid".into();
    let mut r = WorkflowRun::start(
        "w".into(),
        "s".into(),
        "p".into(),
        "q".into(),
        def,
        json!({"question":"q"}),
        json!({}),
        1000,
    )
    .unwrap();
    let a = latest(&r, "a");
    r.fail(&a, "provider failed", 1010).unwrap();
    assert_eq!(r.status, "running");
    complete(&mut r, "b", "时序证据", "available", 1020);
    complete(&mut r, "judge", "已定位", "answer", 1030);
    assert_eq!(r.status, "completed");
    let events = r.events.len();
    r.fail(&a, "duplicate failure", 1040).unwrap();
    assert_eq!(r.events.len(), events);
}

#[test]
fn workflow_valid_submission_survives_an_unbound_downstream_prompt() {
    let mut r = run();
    r.definition
        .nodes
        .iter_mut()
        .find(|n| n.id == "judge")
        .unwrap()
        .prompt = Some("{{incoming.missing}}".into());
    complete(&mut r, "a", "代码证据", "a", 1010);
    complete(&mut r, "b", "时序证据", "b", 1020);
    assert_eq!(r.status, "needs_decision");
    assert!(r
        .instances
        .iter()
        .find(|i| i.node_id == "b")
        .unwrap()
        .result
        .is_some());
    assert_eq!(
        r.submit(
            &latest(&r, "b"),
            1,
            &["时序证据".into()],
            json!({"summary":"b"}),
            1030
        )
        .unwrap()["duplicate"],
        true
    );
}

#[test]
fn workflow_renderer_fixture_preserves_parallel_review_and_missing_submission_events() {
    let Some(path) = std::env::var_os("NAUTILO_WORKFLOW_QA_STATE") else {
        return;
    };
    let mut r = run();
    r.bindings = json!({
        "Explorer":{"agentSnapshot":{"providerId":"codex"},"model":"qa-explorer"},
        "Analyst":{"agentSnapshot":{"providerId":"claude-code"},"model":"qa-analyst"},
        "Verifier":{"agentSnapshot":{"providerId":"codex"},"model":"qa-verifier"}
    });
    r.definition.name = Some("并行定位与交叉验证".into());
    for (id, name) in [
        ("main", "主 Agent"),
        ("a", "代码探索"),
        ("b", "时序探索"),
        ("join", "证据汇合"),
        ("judge", "综合判断"),
        ("verify", "独立复核"),
    ] {
        r.definition
            .nodes
            .iter_mut()
            .find(|n| n.id == id)
            .unwrap()
            .name = Some(name.into());
    }
    r.layout = Some(
        json!({"nodes":{"main":{"x":20,"y":180},"a":{"x":245,"y":80},"b":{"x":245,"y":280},"join":{"x":485,"y":185},"judge":{"x":620,"y":175},"verify":{"x":890,"y":285},"$return":{"x":890,"y":70},"$return_needs_decision":{"x":1130,"y":290}}}),
    );
    let dispatch = |r: &mut WorkflowRun, node: &str, time: i64| {
        let id = latest(r, node);
        let i = r.instances.iter_mut().find(|i| i.id == id).unwrap();
        i.status = "running".into();
        i.session_id = Some(format!("qa-{node}"));
        i.run_id = Some(format!("run-{node}"));
        r.event(
            "node.dispatched",
            Some(&id),
            "正在执行节点",
            json!({"sessionId":format!("qa-{node}"),"runId":format!("run-{node}")}),
            time,
        );
    };
    dispatch(&mut r, "a", 1010);
    dispatch(&mut r, "b", 1011);
    let parallel = r.clone();
    complete(&mut r, "a", "代码证据", "已核对静态调用链", 2000);
    complete(&mut r, "b", "时序证据", "已还原消息交付时序", 2010);
    dispatch(&mut r, "judge", 2020);
    complete(
        &mut r,
        "judge",
        "需要复核",
        "独立复核两份证据中的分歧",
        2030,
    );
    dispatch(&mut r, "verify", 2040);
    let review = r.clone();
    let id = latest(&r, "verify");
    r.execution_finished(&id, true, None, 3000).unwrap();
    r.tick(6001).unwrap();
    let reminder = r.clone();
    assert_eq!(
        parallel
            .instances
            .iter()
            .filter(|i| i.status == "running")
            .count(),
        2
    );
    assert_eq!(
        reminder
            .messages
            .iter()
            .filter(|m| m.recipient == "child")
            .count(),
        1
    );
    let mut overlapping = start_definition(overlapping_definition());
    complete_a(&mut overlapping,1010);
    complete(&mut overlapping,"c","Done","C",1020);
    let overlapping_pending = overlapping.clone();
    complete(&mut overlapping,"b","Done","B",1030);
    complete(&mut overlapping,"d","Done","D",1040);
    std::fs::write(
        path,
        serde_json::to_string_pretty(
            &json!({"parallel":parallel,"review":review,"reminder":reminder,"overlapping":overlapping,"overlappingPending":overlapping_pending}),
        )
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn workflow_feedback_keeps_original_evidence_through_explicit_step_references() {
    let mut def = definition();
    def.nodes.iter_mut().find(|n|n.id=="judge").unwrap().prompt=Some("原始证据 {{steps.a.latest.result.summary}} / {{steps.b.latest.result.summary}}；本轮 {{incoming}}".into());
    def.nodes.reverse();
    def.edges[7].max_traversals = Some(20);
    def.validate().unwrap();
    let mut r = WorkflowRun::start(
        "w".into(),
        "s".into(),
        "p".into(),
        "q".into(),
        def,
        json!({"question":"q"}),
        json!({}),
        1000,
    )
    .unwrap();
    complete(&mut r, "a", "代码证据", "original-code", 1010);
    complete(&mut r, "b", "时序证据", "original-trace", 1020);
    for n in 0..10 {
        complete(&mut r, "judge", "需要复核", "inspect", 1030 + n * 10);
        complete(&mut r, "verify", "已复核", "feedback", 1035 + n * 10);
    }
    for instance in r.instances.iter().filter(|i| i.node_id == "judge") {
        assert!(instance
            .prompt
            .as_deref()
            .unwrap()
            .contains("original-code / original-trace"));
    }
    complete(&mut r, "judge", "已定位", "finished", 2000);
    assert_eq!(r.status, "completed");
}

#[test]
fn workflow_empty_foreach_joins_without_fabricating_an_agent_or_rendering_item_prompt() {
    let def=serde_json::from_value(json!({"schemaVersion":1,"id":"empty","entry":"main","inputs":{"items":"list<json>"},"nodes":[{"id":"main","kind":"main","exits":[{"id":"go","name":"开始"}]},{"id":"each","kind":"agent","role":"Explorer","prompt":"调查 {{item.key}}","forEach":{"source":"input.items","key":"key","maxItems":10,"maxParallel":2,"emptyExit":"empty"},"outputs":{"summary":"text"},"exits":[{"id":"done","name":"完成"},{"id":"empty","name":"无待办"}]},{"id":"join","kind":"join","scope":"each","wait":"all","exits":[{"id":"done","name":"收齐"}]}],"edges":[{"from":["main","go"],"to":"each"},{"from":["each","done"],"to":"join"},{"from":["each","empty"],"to":"join"},{"from":["join","done"],"to":"$return"}]})).unwrap();
    let r = WorkflowRun::start(
        "w".into(),
        "s".into(),
        "p".into(),
        "q".into(),
        def,
        json!({"items":[]}),
        json!({}),
        1000,
    )
    .unwrap();
    assert_eq!(r.status, "completed");
    assert!(!r.instances.iter().any(|i| i.status == "ready"));
    assert!(r
        .instances
        .iter()
        .find(|i| i.node_id == "each")
        .unwrap()
        .prompt
        .is_none());
}

#[test]
fn workflow_language_reference_contains_a_valid_executable_minimal_definition() {
    let reference = language_reference();
    let definition: Definition =
        serde_json::from_value(reference["minimalExample"].clone()).unwrap();
    definition.validate().unwrap();
}

#[test]
fn workflow_prompt_literals_are_escaped_without_reinterpreting_injected_code() {
    let prompt = r"任务 {{input.question}}；模板示例 \{{unknown.field}}；另一个 \{{unfinished";
    let value = r"code with \{{input.keep}}";
    assert_eq!(
        render(prompt, &json!({"input":{"question":value}})).unwrap(),
        format!("任务 {value}；模板示例 {{{{unknown.field}}}}；另一个 {{{{unfinished")
    );
    let mut def = definition();
    def.nodes.iter_mut().find(|n| n.id == "a").unwrap().prompt = Some(prompt.into());
    def.validate().unwrap();
    assert!(render("{{input.question", &json!({})).is_err());
}

#[test]
fn workflow_structured_finals_use_the_same_outlet_and_result_validation_as_tools() {
    let mut r = run();
    r.definition
        .nodes
        .iter_mut()
        .find(|n| n.id == "a")
        .unwrap()
        .completion = "structured_final".into();
    let id = latest(&r, "a");
    r.execution_result(
        &id,
        1,
        true,
        None,
        Some("{\"branch\":\"missing\",\"result\":{\"summary\":\"evidence\"}}".into()),
        1010,
    )
    .unwrap();
    assert_eq!(
        r.instances.iter().find(|i| i.id == id).unwrap().status,
        "waiting_submission"
    );
    assert!(r
        .instances
        .iter()
        .find(|i| i.id == id)
        .unwrap()
        .submission_error
        .is_some());
    r.execution_result(
        &id,
        1,
        true,
        None,
        Some(
            "```json\n{\"branch\":\"代码证据\",\"result\":{\"summary\":\"evidence\"}}\n```".into(),
        ),
        1020,
    )
    .unwrap();
    assert_eq!(
        r.instances.iter().find(|i| i.id == id).unwrap().status,
        "completed"
    );
    assert_eq!(
        r.events
            .iter()
            .filter(|e| e.r#type == "node.completed" && e.instance_id.as_deref() == Some(&id))
            .count(),
        1
    );
}
