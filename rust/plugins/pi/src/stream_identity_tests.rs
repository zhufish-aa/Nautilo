use super::*;
use std::time::Duration;

fn start(state: &mut PiParseState) {
    parse_pi_rpc_event(&json!({"type":"message_start","message":{"role":"assistant"}}), state);
}

fn delta(state: &mut PiParseState, kind: &str) -> Value {
    parse_pi_rpc_event(&json!({
        "type":"message_update", "assistantMessageEvent":{"type":kind,"delta":"reply"}
    }), state).remove(0)
}

fn stream_id(events: &[Value], kind: &str, phase: &str) -> String {
    events.iter().find(|event| event["kind"] == kind && event["phase"] == phase)
        .and_then(|event| event["messageId"].as_str()).expect("stream identity").to_string()
}

#[test]
fn recreated_worker_cannot_reuse_previous_reply_or_thinking_identity() {
    let mut before = PiParseState::default();
    let mut after = PiParseState::default();
    start(&mut before);
    start(&mut after);
    for kind in ["text_delta", "thinking_delta"] {
        assert_ne!(delta(&mut before, kind)["messageId"], delta(&mut after, kind)["messageId"]);
    }
}

#[test]
fn late_old_worker_events_keep_the_identity_allocated_when_the_stream_started() {
    let old = Arc::new(Mutex::new(PiParseState::default()));
    start(&mut old.lock().unwrap());
    let text = delta(&mut old.lock().unwrap(), "text_delta");
    let thought = delta(&mut old.lock().unwrap(), "thinking_delta");
    let idle = old.clone();

    // A replacement worker can already be producing a new run's response.
    let mut replacement = PiParseState::default();
    start(&mut replacement);
    assert_ne!(text["messageId"], delta(&mut replacement, "text_delta")["messageId"]);
    assert_ne!(thought["messageId"], delta(&mut replacement, "thinking_delta")["messageId"]);
    assert_eq!(text["messageId"], delta(&mut idle.lock().unwrap(), "text_delta")["messageId"]);
    assert_eq!(thought["messageId"], delta(&mut idle.lock().unwrap(), "thinking_delta")["messageId"]);
    let completed = parse_pi_rpc_event(&json!({"type":"message_end","message":{
        "role":"assistant","content":[{"type":"thinking","thinking":"reply"}],"stopReason":"stop"
    }}), &mut idle.lock().unwrap());
    assert_eq!(stream_id(&completed, "message", "completed"), text["messageId"].as_str().unwrap());
    assert_eq!(stream_id(&completed, "thinking", "completed"), thought["messageId"].as_str().unwrap());
}

#[test]
fn complete_only_assistant_messages_also_get_distinct_stream_identities() {
    let mut state = PiParseState::default();
    let complete = json!({"type":"message_end","message":{
        "role":"assistant","content":[{"type":"text","text":"native command output"}]
    }});
    let first = parse_pi_rpc_event(&complete, &mut state);
    let second = parse_pi_rpc_event(&complete, &mut state);
    let first_id = stream_id(&first, "message", "delta");
    let second_id = stream_id(&second, "message", "delta");
    assert_ne!(first_id, second_id);
    assert_eq!(first_id, stream_id(&first, "message", "completed"));
    assert_eq!(second_id, stream_id(&second, "message", "completed"));
}

#[test]
fn unindexed_thinking_starts_and_tool_execution_close_only_the_current_legacy_block() {
    let mut state = PiParseState::default();
    start(&mut state);
    let first = delta(&mut state, "thinking_delta");
    let next_start = parse_pi_rpc_event(&json!({"type":"message_update","assistantMessageEvent": {
        "type":"thinking_start"
    }}), &mut state);
    let dismissed = stream_id(&next_start, "thinking", "completed");
    assert_eq!(dismissed, first["messageId"].as_str().unwrap());
    let second = delta(&mut state, "thinking_delta");
    let tool = parse_pi_rpc_event(&json!({"type":"tool_execution_start","toolName":"read","toolCallId":"read","args":{}}), &mut state);
    assert_eq!(stream_id(&tool, "thinking", "completed"), second["messageId"].as_str().unwrap());
    assert_eq!(tool[1]["kind"], "tool");
    let late_end = parse_pi_rpc_event(&json!({"type":"message_update","assistantMessageEvent": {
        "type":"thinking_end","content":"reply"
    }}), &mut state);
    assert!(late_end.is_empty());
    let third = delta(&mut state, "thinking_delta");
    assert_ne!(first["messageId"], second["messageId"]);
    assert_ne!(second["messageId"], third["messageId"]);
    let end = parse_pi_rpc_event(&json!({"type":"message_end","message":{"role":"assistant","content":[
        {"type":"thinking","thinking":"reply"},{"type":"thinking","thinking":"reply"},{"type":"thinking","thinking":"reply"}
    ]}}), &mut state);
    assert_eq!(stream_id(&end, "thinking", "completed"), third["messageId"].as_str().unwrap());
    assert_eq!(end.iter().filter(|event| event["kind"] == "thinking").count(), 1);
}

#[test]
fn indexed_thought_blocks_can_interleave_without_stealing_each_others_ids() {
    let mut state = PiParseState::default();
    start(&mut state);
    let thinking_delta = |state: &mut PiParseState, index: u32| parse_pi_rpc_event(&json!({
        "type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"part","contentIndex":index}
    }), state).remove(0);
    let first = thinking_delta(&mut state, 0);
    let second = thinking_delta(&mut state, 2);
    assert_ne!(first["messageId"], second["messageId"]);
    assert_eq!(thinking_delta(&mut state, 0)["messageId"], first["messageId"]);
    assert_eq!(thinking_delta(&mut state, 2)["messageId"], second["messageId"]);
}

#[derive(Default)]
struct BackgroundChannel {
    events: Mutex<Vec<(String, Value)>>,
}

impl DaemonChannel for BackgroundChannel {
    fn publish_session(&self, binding: &str, event: Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        self.events.lock().unwrap().push((binding.to_string(), event));
        Box::pin(async {})
    }
    fn ask(&self, _: &str, _: Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        Box::pin(async { json!({"outcome":"cancelled"}) })
    }
    fn call_tool(&self, _: &str, _: &str, _: Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        Box::pin(async { json!({"success":false}) })
    }
}

fn request(prompt: &str) -> Value {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stream-identity.mjs");
    let env: HashMap<String, String> = std::env::vars().filter(|(key, _)| {
        ["path", "systemroot", "windir", "temp", "tmp", "comspec"].contains(&key.to_lowercase().as_str())
    }).collect();
    json!({"instance":{"executable":"node","baseArgs":[fixture]},"env":env,
        "cwd":std::env::temp_dir(),"localSessionId":Uuid::new_v4().to_string(),
        "sessionBindingId":"first-binding","prompt":prompt,"timeoutMs":4000})
}

async fn collect(plugin: &PiPlugin, run: &str, request: Value, resume: bool) -> Vec<Value> {
    let mut receiver = plugin.start(run, request, resume.then(|| "stream-identity-session".to_string())).await.unwrap();
    tokio::time::timeout(Duration::from_secs(8), async move {
        let mut events = vec![];
        while let Some(event) = receiver.recv().await {
            let finished = event["kind"] == "exit";
            events.push(event);
            if finished { return events; }
        }
        events
    }).await.expect("mock Pi turn must finish")
}

fn assert_success(events: &[Value]) {
    assert!(events.iter().any(|event| event["kind"] == "exit" && event["exitCode"] == 0), "{events:?}");
}

#[tokio::test]
async fn mock_workflow_stop_after_received_submission_is_not_a_provider_error() {
    let plugin = PiPlugin::new();
    let run = "submitted-run";
    let mut receiver = plugin.start(run, request("hold-after-workflow-submit"), None).await.unwrap();
    let events = tokio::time::timeout(Duration::from_secs(8), async {
        let mut events = Vec::new();
        while let Some(event) = receiver.recv().await {
            if event["callId"] == "submit" && event["success"] == true {
                plugin.cancel(run).await;
            }
            events.push(event);
        }
        events
    }).await.expect("the cancelled Pi turn must close");
    assert!(events.iter().any(|event| event["callId"] == "submit" && event["success"] == true));
    assert!(events.iter().all(|event| event["kind"] != "error" && event["phase"] != "turn_failed"), "{events:?}");
    assert_eq!(events.last().unwrap()["exitCode"], 130);
}

#[tokio::test]
async fn mock_exit_without_native_completion_remains_a_failure() {
    let plugin = PiPlugin::new();
    let events = collect(&plugin, "unexpected-exit", request("exit-before-settled"), false).await;
    assert!(events.iter().any(|event| event["phase"] == "turn_failed"), "{events:?}");
    assert!(events.iter().any(|event| event["kind"] == "error"), "{events:?}");
    assert_eq!(events.last().unwrap()["exitCode"], 1);
}

#[tokio::test]
async fn mock_resident_turns_and_configuration_restart_keep_replies_separate() {
    let plugin = PiPlugin::new();
    let mut input = request("first");
    let first = collect(&plugin, "first-run", input.clone(), false).await;
    input["prompt"] = json!("second");
    input["sessionBindingId"] = json!("second-binding");
    let second = collect(&plugin, "second-run", input.clone(), true).await;
    input["prompt"] = json!("after-restart");
    input["reasoningEffort"] = json!("low");
    input["sessionBindingId"] = json!("third-binding");
    let restarted = collect(&plugin, "third-run", input, true).await;
    plugin.dispose().await;

    for events in [&first, &second, &restarted] {
        assert_success(events);
        for kind in ["message", "thinking"] {
            assert_eq!(stream_id(events, kind, "delta"), stream_id(events, kind, "completed"));
        }
    }
    for kind in ["message", "thinking"] {
        let ids: std::collections::HashSet<String> = [&first, &second, &restarted].into_iter()
            .map(|events| stream_id(events, kind, "delta")).collect();
        assert_eq!(ids.len(), 3, "{kind} IDs must survive both reuse and restart");
    }
    let ready = |events: &[Value]| events.iter().find(|event| event["phase"] == "runtime_ready").unwrap()["raw"].clone();
    assert_eq!(ready(&second)["reused"], true);
    assert_eq!(ready(&first)["pid"], ready(&second)["pid"]);
    assert_eq!(ready(&restarted)["reason"], "configuration_changed");
    assert_ne!(ready(&first)["pid"], ready(&restarted)["pid"]);
}

#[tokio::test]
async fn mock_idle_callbacks_preserve_original_stream_and_session_binding() {
    let plugin = PiPlugin::new();
    let channel = Arc::new(BackgroundChannel::default());
    plugin.set_daemon_channel(channel.clone());
    let mut input = request("late");
    let first = collect(&plugin, "first-run", input.clone(), false).await;
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if channel.events.lock().unwrap().iter().any(|(_, event)| event["kind"] == "message" && event["phase"] == "completed") { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.expect("late native completion must reach the session sink");
    let background = channel.events.lock().unwrap().clone();
    input["prompt"] = json!("next");
    input["sessionBindingId"] = json!("next-binding");
    let next = collect(&plugin, "next-run", input, true).await;
    plugin.dispose().await;

    assert_success(&first);
    assert_success(&next);
    let late: Vec<Value> = background.iter().map(|(_, event)| event.clone()).collect();
    for kind in ["message", "thinking"] {
        let original = stream_id(&first, kind, "delta");
        assert_eq!(original, stream_id(&late, kind, "completed"));
        assert_ne!(original, stream_id(&next, kind, "delta"));
    }
    assert_eq!(stream_id(&first, "message", "delta"), stream_id(&late, "message", "delta"));
    assert!(background.iter().all(|(binding, _)| binding == "first-binding"));
}

#[tokio::test]
async fn mock_repeated_compact_commands_do_not_reuse_receipt_identity() {
    let plugin = PiPlugin::new();
    let mut input = request("/compact");
    input["providerCommand"] = json!("compact");
    let first = collect(&plugin, "compact-first", input.clone(), false).await;
    let second = collect(&plugin, "compact-second", input, true).await;
    plugin.dispose().await;
    assert_success(&first);
    assert_success(&second);
    assert_ne!(stream_id(&first, "message", "completed"), stream_id(&second, "message", "completed"));
}

#[tokio::test]
async fn mock_distinct_thoughts_have_separate_delta_replay_and_empty_completions() {
    let plugin = PiPlugin::new();
    let events = collect(&plugin, "segments-run", request("segments"), false).await;
    plugin.dispose().await;
    assert_success(&events);

    let mut chunks: HashMap<&str, String> = HashMap::new();
    let mut completed = std::collections::HashSet::new();
    for event in events.iter().filter(|event| event["kind"] == "thinking") {
        let id = event["messageId"].as_str().unwrap();
        let text = event["text"].as_str().unwrap();
        if event["phase"] == "delta" {
            assert!(!completed.contains(id), "delta after completion: {event:?}");
            chunks.entry(id).or_default().push_str(text);
        } else {
            assert_eq!(event["phase"], "completed");
            assert!(text.is_empty(), "nonempty summaries lose delta identity on old host replay");
            assert!(chunks.contains_key(id));
            assert!(completed.insert(id), "same block completed twice");
        }
    }
    assert_eq!(completed.len(), 3);
    let mut texts: Vec<_> = chunks.into_values().collect();
    texts.sort();
    assert_eq!(texts, ["first block", "second block", "snapshot only"]);
    assert_eq!(stream_id(&events, "message", "delta"), stream_id(&events, "message", "completed"));
    assert!(events.iter().any(|event| event["kind"] == "message" && event["text"].as_str().is_some_and(|text| text.ends_with(":1:segments"))));
}
