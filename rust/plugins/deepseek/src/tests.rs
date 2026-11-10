use super::*;
use std::sync::atomic::AtomicUsize;

#[derive(Default)]
struct Channel {
    events: Mutex<Vec<(String, Value)>>,
    questions: Mutex<Vec<(String, Value)>>,
    leases: Mutex<Vec<(String, bool)>>,
    tools: Mutex<Vec<(String, String)>>,
    pending: Arc<AtomicUsize>,
    block: AtomicBool,
}
impl DaemonChannel for Channel {
    fn hold_session(
        &self,
        binding: &str,
        active: bool,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        self.leases.lock().unwrap().push((binding.into(), active));
        Box::pin(async {})
    }
    fn publish_session(
        &self,
        binding: &str,
        event: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        self.events.lock().unwrap().push((binding.into(), event));
        Box::pin(async {})
    }
    fn ask_session(
        &self,
        binding: &str,
        input: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        self.questions.lock().unwrap().push((binding.into(), input));
        let blocked = self.block.load(Ordering::Acquire);
        let count = self.pending.clone();
        Box::pin(async move {
            struct Pending(Arc<AtomicUsize>);
            impl Drop for Pending {
                fn drop(&mut self) {
                    self.0.fetch_sub(1, Ordering::AcqRel);
                }
            }
            count.fetch_add(1, Ordering::AcqRel);
            let _pending = Pending(count);
            if blocked {
                std::future::pending::<()>().await;
            }
            json!({"outcome":"selected","optionId":"once"})
        })
    }
    fn call_session_tool(
        &self,
        binding: &str,
        name: &str,
        _args: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        self.tools
            .lock()
            .unwrap()
            .push((binding.into(), name.into()));
        Box::pin(async { json!({"success":true,"content":"background-host-result"}) })
    }
    fn ask(
        &self,
        _run: &str,
        _input: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        panic!("native child requests must be session scoped")
    }
    fn call_tool(
        &self,
        _run: &str,
        _name: &str,
        _args: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        panic!("native child host tools must be session scoped")
    }
}

fn request(prompt: &str, local: &str, binding: &str) -> Value {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tests/fixtures/deepseek-session.mjs");
    json!({"instance":{"executable":std::env::var("NAUTILO_TEST_NODE").unwrap_or("node".into()),"baseArgs":[fixture]},
        "cwd":std::env::temp_dir(),"localSessionId":local,"sessionBindingId":binding,"prompt":prompt,"timeoutMs":4000,
        "runtimeTools":[{"name":"nautilo_fixture","description":"Fixture tool","inputSchema":{"type":"object"}}]})
}
async fn collect(mut events: mpsc::UnboundedReceiver<Value>) -> Vec<Value> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut all = vec![];
        while let Some(event) = events.recv().await {
            let exit = event["kind"] == "exit";
            all.push(event);
            if exit {
                break;
            }
        }
        assert_eq!(all.last().unwrap()["exitCode"], 0, "{all:?}");
        all
    })
    .await
    .expect("turn should finish independently of its native background requests")
}
async fn until(condition: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn late_native_events_and_interactions_keep_origin_and_reuse_process() {
    let plugin = DeepSeek::default();
    let channel = Arc::new(Channel::default());
    plugin.set_daemon_channel(channel.clone());
    let local = format!("dsh-background-{}", uuid::Uuid::new_v4().simple());
    let first = collect(
        plugin
            .start(
                "first",
                request("background", &local, "first-binding"),
                None,
            )
            .await
            .unwrap(),
    )
    .await;
    let session = first.iter().find(|e| e["kind"] == "session").unwrap()["providerSessionId"]
        .as_str()
        .unwrap()
        .to_string();
    until(|| {
        channel
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, e)| e["text"] == "background-approved")
    })
    .await;
    assert_eq!(channel.questions.lock().unwrap()[0].0, "first-binding");
    assert!(!channel.questions.lock().unwrap()[0].1["nativeRequestId"]
        .as_str()
        .unwrap()
        .is_empty());
    assert_eq!(
        *channel.tools.lock().unwrap(),
        vec![("first-binding".into(), "nautilo_fixture".into())]
    );
    let second = collect(
        plugin
            .start(
                "second",
                request("second", &local, "second-binding"),
                Some(session),
            )
            .await
            .unwrap(),
    )
    .await;
    let pid = |events: &[Value]| {
        events
            .iter()
            .find(|e| e["phase"] == "runtime_ready")
            .unwrap()["raw"]["pid"]
            .clone()
    };
    assert_eq!(pid(&first), pid(&second));
    assert!(second
        .iter()
        .any(|e| e["kind"] == "message"
            && e["text"].as_str().is_some_and(|s| s.contains(":2:second"))));
    assert!(!second
        .iter()
        .any(|e| e["text"] == "old-child-during-next-turn"));
    until(|| {
        channel
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(b, e)| b == "first-binding" && e["text"] == "old-child-during-next-turn")
    })
    .await;
    let events = channel.events.lock().unwrap().clone();
    let tool = events
        .iter()
        .find(|(_, e)| e["kind"] == "tool" && e["phase"] == "completed")
        .unwrap();
    assert_eq!(tool.1["name"], "read");
    assert_eq!(tool.1["output"], "background-host-result");
    assert!(tool.1["subagentDispatchId"]
        .as_str()
        .unwrap()
        .starts_with("dsh-child-"));
    assert_eq!(plugin.capabilities()["sessionBackgroundEvents"], true);
    plugin
        .release_session(&json!({"localSessionId":local}))
        .await
        .unwrap();
    until(|| {
        channel
            .leases
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, active)| !*active)
            .count()
            == 2
    })
    .await;
    plugin.dispose().await;
}

#[tokio::test]
async fn native_abort_and_session_release_cancel_pending_background_question() {
    let plugin = DeepSeek::default();
    let channel = Arc::new(Channel::default());
    channel.block.store(true, Ordering::Release);
    plugin.set_daemon_channel(channel.clone());
    for (prompt, abort) in [("pending", true), ("background", false)] {
        let local = format!("dsh-cancel-{}", uuid::Uuid::new_v4().simple());
        collect(
            plugin
                .start(&local, request(prompt, &local, &local), None)
                .await
                .unwrap(),
        )
        .await;
        until(|| channel.pending.load(Ordering::Acquire) == 1).await;
        if abort {
            until(|| channel.pending.load(Ordering::Acquire) == 0).await;
        }
        plugin
            .release_session(&json!({"localSessionId":local}))
            .await
            .unwrap();
        until(|| channel.pending.load(Ordering::Acquire) == 0).await;
    }
    plugin.dispose().await;
}

#[tokio::test]
async fn multiple_idle_sessions_are_not_closed_by_cache_capacity() {
    let plugin = DeepSeek::default();
    let mut sessions = vec![];
    for index in 0..4 {
        let local = format!("dsh-cache-{}-{index}", uuid::Uuid::new_v4().simple());
        collect(
            plugin
                .start(&local, request("first", &local, &local), None)
                .await
                .unwrap(),
        )
        .await;
        sessions.push(local);
    }
    for local in &sessions {
        let entry = plugin
            .pool
            .lock()
            .unwrap()
            .take(local)
            .expect("a fourth session must not evict native work");
        assert!(entry.native.alive.load(Ordering::Acquire));
        entry.native.close().await;
    }
    plugin.dispose().await;
}
