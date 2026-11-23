use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!("nautilo-trae-fixture-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn request(&self, prompt: &str, require_fallback: bool) -> Value {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-trae-acp.cjs");
        let mut args = vec![script.to_string_lossy().into_owned()];
        if require_fallback { args.push("--needs-fallback".into()); }
        let mut env = HashMap::<String, String>::new();
        for name in ["PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot"] {
            if let Ok(value) = std::env::var(name) { env.insert(name.into(), value); }
        }
        env.insert("NAUTILO_TRAE_FIXTURE_LOG".into(), self.0.join("calls").to_string_lossy().into_owned());
        json!({
            "instance":{"id":"fixture-trae","providerId":"trae","executable":"node","baseArgs":args},
            "localSessionId":"fixture-local-session",
            "prompt":prompt,"cwd":self.0,"env":env,"timeoutMs":15_000,"idleTimeoutMs":6_000,
        })
    }
    fn methods(&self) -> Vec<String> {
        std::fs::read_to_string(self.0.join("calls")).unwrap().lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()["method"].as_str().unwrap().to_string())
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

async fn events_until_exit(mut receiver: mpsc::UnboundedReceiver<Value>) -> Vec<Value> {
    let mut events = vec![];
    while let Some(event) = tokio::time::timeout(Duration::from_secs(20), receiver.recv()).await.expect("ACP fixture event deadline") {
        let exit = event["kind"] == "exit";
        events.push(event);
        if exit { break; }
    }
    assert_eq!(events.last().unwrap()["kind"], "exit", "{events:?}");
    events
}

fn runtime_ready(events: &[Value]) -> &Value {
    &events.iter().find(|event| event["phase"] == "runtime_ready").unwrap()["raw"]
}

fn assert_stream(events: &[Value], kind: &str, id: &str, text: &str) {
    let stream = events.iter().filter(|event| event["kind"] == kind).collect::<Vec<_>>();
    assert_eq!(stream.len(), 2, "{events:?}");
    assert_eq!(stream[0]["phase"], "delta");
    assert_eq!(stream[0]["messageId"], id);
    assert_eq!(stream[0]["text"], text);
    assert_eq!(stream[1]["phase"], "completed");
    assert_eq!(stream[1]["messageId"], id);
}

fn assert_thought_segments(events: &[Value], run_id: &str, prompt: &str) {
    let before = format!("trae-thinking:{run_id}:1");
    let after = format!("trae-thinking:{run_id}:2");
    let more = format!("trae-thinking:{run_id}:3");
    let tool = format!("read:{prompt}");
    let reply = format!("trae-message:{run_id}");
    let recorded: Vec<_> = events.iter().filter_map(|event| {
        let kind = event["kind"].as_str()?;
        let phase = event["phase"].as_str()?;
        if kind == "tool" {
            Some((kind, phase, event["callId"].as_str()?, ""))
        } else if kind == "thinking" || (kind == "message" && phase == "delta") {
            Some((kind, phase, event["messageId"].as_str()?, event["text"].as_str()?))
        } else {
            None
        }
    }).collect();
    assert_eq!(recorded, [
        ("thinking", "delta", before.as_str(), format!("before:{prompt}").as_str()),
        ("thinking", "delta", before.as_str(), " one"),
        ("thinking", "completed", before.as_str(), ""),
        ("tool", "started", tool.as_str(), ""),
        ("thinking", "delta", after.as_str(), format!("after:{prompt}").as_str()),
        ("tool", "updated", tool.as_str(), ""),
        ("thinking", "delta", after.as_str(), " two"),
        ("tool", "completed", tool.as_str(), ""),
        ("thinking", "completed", after.as_str(), ""),
        ("message", "delta", reply.as_str(), format!("reply:{prompt}").as_str()),
        ("thinking", "delta", more.as_str(), format!("more:{prompt}").as_str()),
        ("thinking", "delta", more.as_str(), " three"),
        ("thinking", "completed", more.as_str(), ""),
    ], "{events:?}");
}

#[tokio::test]
async fn two_acp_prompts_share_worker_and_split_thoughts_without_replay_or_id_aliasing() {
    let fixture = Fixture::new();
    let plugin = TraePlugin::new();
    let first = events_until_exit(plugin.start("turn-a", fixture.request("first", false), Some("fixture-session".into())).await.unwrap()).await;
    let second = events_until_exit(plugin.start("turn-b", fixture.request("second", false), Some("fixture-session".into())).await.unwrap()).await;
    assert_eq!(first.last().unwrap()["exitCode"], 0, "{first:?}");
    assert_eq!(second.last().unwrap()["exitCode"], 0, "{second:?}");
    assert_eq!(runtime_ready(&first)["reused"], false);
    assert_eq!(runtime_ready(&second)["reused"], true);
    assert_eq!(runtime_ready(&first)["pid"], runtime_ready(&second)["pid"]);
    assert_stream(&first, "message", "trae-message:turn-a", "reply:first");
    assert_stream(&second, "message", "trae-message:turn-b", "reply:second");
    assert_thought_segments(&first, "turn-a", "first");
    assert_thought_segments(&second, "turn-b", "second");
    assert_eq!(fixture.methods(), ["initialize", "session/load", "session/prompt", "session/prompt"]);
    plugin.dispose().await;
}

#[test]
fn thought_boundaries_do_not_emit_duplicate_or_phantom_completions() {
    let mut state = TraeAcpParseState::new("turn");
    let tool = |id, status| json!({"sessionUpdate":"tool_call_update","toolCallId":id,"status":status});
    let thought = |text| json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":text}});
    assert_eq!(parse_trae_acp_update(&tool("early", "in_progress"), &mut state).len(), 1);
    assert!(parse_trae_acp_update(&thought(""), &mut state).is_empty());
    assert!(state.finish_thinking().is_none());
    let delta = parse_trae_acp_update(&thought("thinking"), &mut state);
    let completed_only = parse_trae_acp_update(&tool("no-start", "completed"), &mut state);
    assert_eq!(completed_only.len(), 2);
    assert_eq!(completed_only[0]["kind"], "thinking");
    assert_eq!(completed_only[0]["phase"], "completed");
    assert_eq!(completed_only[0]["messageId"], delta[0]["messageId"]);
    assert_eq!(completed_only[1]["kind"], "tool");
    assert!(parse_trae_acp_update(&tool("no-start", "completed"), &mut state).is_empty());
    assert!(state.finish_thinking().is_none());
}

#[tokio::test]
async fn config_change_and_release_each_retire_the_original_worker() {
    let fixture = Fixture::new();
    let plugin = TraePlugin::new();
    let mut request = fixture.request("a", false);
    let first = events_until_exit(plugin.start("config-a", request.clone(), None).await.unwrap()).await;
    request["env"]["NAUTILO_TRAE_TEST_CONNECTION"] = json!("different");
    let second = events_until_exit(plugin.start("config-b", request.clone(), Some("fixture-session".into())).await.unwrap()).await;
    assert_ne!(runtime_ready(&first)["pid"], runtime_ready(&second)["pid"]);
    assert_eq!(runtime_ready(&second)["reused"], false);
    plugin.release_session(&request).await.unwrap();
    let third = events_until_exit(plugin.start("config-c", request, Some("fixture-session".into())).await.unwrap()).await;
    assert_ne!(runtime_ready(&second)["pid"], runtime_ready(&third)["pid"]);
    assert_eq!(runtime_ready(&third)["reused"], false);
    assert_eq!(fixture.methods().iter().filter(|method| *method == "initialize").count(), 3);
    plugin.dispose().await;
}

#[tokio::test]
async fn init_fallback_works_and_cancelled_worker_is_not_reused() {
    let fixture = Fixture::new();
    let plugin = TraePlugin::new();
    let mut first = plugin.start("cancel-a", fixture.request("hold", true), None).await.unwrap();
    let mut pid = Value::Null;
    while let Some(event) = tokio::time::timeout(Duration::from_secs(20), first.recv()).await.unwrap() {
        if event["phase"] == "runtime_ready" { pid = event["raw"]["pid"].clone(); }
        if event["kind"] == "message" { break; }
        assert_ne!(event["kind"], "exit", "{event:?}");
    }
    assert!(!pid.is_null());
    plugin.cancel("cancel-a").await;
    assert_eq!(events_until_exit(first).await.last().unwrap()["exitCode"], 130);
    let next = events_until_exit(plugin.start("cancel-b", fixture.request("new", true), Some("fixture-session".into())).await.unwrap()).await;
    assert_ne!(runtime_ready(&next)["pid"], pid);
    assert_eq!(runtime_ready(&next)["reused"], false);
    assert_eq!(next.last().unwrap()["exitCode"], 0, "{next:?}");
    let methods = fixture.methods();
    assert!(methods.contains(&"session/cancel".to_string()), "{methods:?}");
    assert_eq!(methods.iter().filter(|method| *method == "initialize").count(), 4);
    plugin.dispose().await;
}

#[tokio::test]
async fn reuse_keeps_turn_deadline_and_bounds_unterminated_native_output() {
    let fixture = Fixture::new();
    let plugin = TraePlugin::new();
    let first = events_until_exit(plugin.start("limits-a", fixture.request("ready", false), None).await.unwrap()).await;
    let mut hold = fixture.request("hold", false);
    hold["timeoutMs"] = json!(250);
    let timeout = events_until_exit(plugin.start("limits-b", hold, Some("fixture-session".into())).await.unwrap()).await;
    assert_eq!(runtime_ready(&timeout)["pid"], runtime_ready(&first)["pid"]);
    assert!(timeout.iter().any(|event| event["kind"] == "timeout" && event["reason"] == "timeout"), "{timeout:?}");
    let mut oversized = fixture.request("oversized", false);
    oversized["maxOutputBytes"] = json!(4096);
    let capped = events_until_exit(plugin.start("limits-c", oversized, Some("fixture-session".into())).await.unwrap()).await;
    assert_eq!(runtime_ready(&capped)["reused"], false);
    assert!(capped.iter().any(|event| event["kind"] == "timeout" && event["reason"] == "max_output"), "{capped:?}");
    plugin.dispose().await;
}
