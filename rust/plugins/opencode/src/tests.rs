use super::*;
use agenthub_plugin_sdk::DaemonChannel;
use base64::Engine;
use std::sync::atomic::AtomicUsize;
use tokio::sync::oneshot;

#[derive(Default)]
struct Channel {
    events: Mutex<Vec<(String, Value)>>,
    questions: Mutex<Vec<(String, Value)>>,
    leases: Mutex<Vec<(String, bool)>>,
    replies: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    waiting: Arc<AtomicUsize>,
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
        let id = input["nativeRequestId"].as_str().unwrap().to_string();
        self.questions.lock().unwrap().push((binding.into(), input));
        let (sender, receiver) = oneshot::channel();
        self.replies.lock().unwrap().insert(id, sender);
        let count = self.waiting.clone();
        Box::pin(async move {
            struct Waiting(Arc<AtomicUsize>);
            impl Drop for Waiting {
                fn drop(&mut self) {
                    self.0.fetch_sub(1, Ordering::AcqRel);
                }
            }
            count.fetch_add(1, Ordering::AcqRel);
            let _waiting = Waiting(count);
            receiver
                .await
                .unwrap_or_else(|_| json!({"outcome":"cancelled"}))
        })
    }
    fn ask(
        &self,
        _: &str,
        _: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        panic!("session binding must own native requests")
    }
    fn call_tool(
        &self,
        _: &str,
        _: &str,
        _: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        Box::pin(async { Value::Null })
    }
}
impl Channel {
    fn answer(&self, id: &str, value: Value) {
        self.replies
            .lock()
            .unwrap()
            .remove(id)
            .unwrap()
            .send(value)
            .unwrap();
    }
    fn saw(&self, binding: &str, text: &str) -> bool {
        self.events
            .lock()
            .unwrap()
            .iter()
            .any(|(b, e)| b == binding && e["text"] == text)
    }
}
async fn until(condition: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("fixture condition should become true");
}
struct Fixture {
    plugin: OpenCodePlugin,
    channel: Arc<Channel>,
    request: Value,
    directory: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("nautilo-opencode-{}", next_native_id("fixture")));
        std::fs::create_dir_all(&directory).unwrap();
        let node = std::env::var("NAUTILO_TEST_NODE").unwrap_or("node".into());
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../tests/fixtures/opencode-server.mjs")
            .canonicalize()
            .unwrap();
        #[cfg(windows)]
        let executable = {
            let executable = directory.join("opencode.cmd");
            std::fs::write(
                &executable,
                format!("@echo off\r\n\"{node}\" \"{}\" %*\r\n", script.display()),
            )
            .unwrap();
            executable
        };
        #[cfg(not(windows))]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            let executable = directory.join("opencode");
            std::fs::write(
                &executable,
                format!("#!/bin/sh\nexec '{node}' '{}' \"$@\"\n", script.display()),
            )
            .unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
            executable
        };
        let env: HashMap<_, _> = std::env::vars()
            .filter(|(key, _)| {
                [
                    "path",
                    "pathext",
                    "systemroot",
                    "windir",
                    "temp",
                    "tmp",
                    "comspec",
                    "xdg_data_home",
                    "xdg_config_home",
                    "xdg_cache_home",
                    "xdg_state_home",
                ]
                .contains(&key.to_lowercase().as_str())
            })
            .collect();
        let request = json!({"instance":{"id":"fixture-opencode","executable":executable},"env":env,"cwd":directory,"prompt":"hang","timeoutMs":10000});
        let plugin = OpenCodePlugin::new();
        let channel = Arc::new(Channel::default());
        plugin.set_daemon_channel(channel.clone());
        Self {
            plugin,
            channel,
            request,
            directory,
        }
    }
    fn request(&self, run: &str, local: &str) -> Value {
        let mut request = self.request.clone();
        request["localSessionId"] = json!(local);
        request["sessionBindingId"] = json!(run);
        request
    }
    fn server(&self) -> Arc<ManagedServer> {
        self.plugin
            .pool
            .lock()
            .unwrap()
            .servers
            .values()
            .next()
            .unwrap()
            .clone()
    }
    async fn call(&self, path: &str, body: Option<Value>) -> Value {
        let server = self.server();
        api_json(
            &server.base_url,
            &server.cwd,
            path,
            if body.is_some() { "POST" } else { "GET" },
            body,
        )
        .await
        .unwrap()
    }
    async fn emit(&self, frames: Vec<Value>) {
        self.call("/fixture/emit", Some(json!(frames))).await;
    }
    async fn start(&self, run: &str, local: &str, resume: Option<&str>) -> Turn {
        self.start_request(run, self.request(run, local), resume)
            .await
    }
    async fn start_request(&self, run: &str, request: Value, resume: Option<&str>) -> Turn {
        let mut events = self
            .plugin
            .start(run, request, resume.map(str::to_string))
            .await
            .unwrap();
        let mut initial = vec![];
        let session = tokio::time::timeout(Duration::from_secs(8), async {
            while let Some(event) = events.recv().await {
                let session = event["providerSessionId"].as_str().map(str::to_string);
                assert_ne!(event["kind"], "exit", "{event:?}");
                initial.push(event);
                if let Some(session) = session {
                    return session;
                }
            }
            panic!("missing native session")
        })
        .await
        .unwrap();
        // HTTP acknowledgement and the native user-message event have both arrived.
        let user = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let state = self.call("/fixture/state", None).await;
                if let Some(post) = state["posts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .rev()
                    .find(|p| p["session"] == session)
                {
                    return post["body"]["messageID"].as_str().unwrap_or("").to_string();
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        Turn {
            events,
            initial,
            session,
            user,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Ensure failed assertions cannot leave fixture servers on the machine.
        for server in self.plugin.pool.lock().unwrap().servers.values() {
            server.events.close();
            if server.handle.is_alive() {
                if let Some(pid) = server.handle.pid {
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        let _ = std::process::Command::new("taskkill")
                            .args(["/pid", &pid.to_string(), "/t", "/f"])
                            .creation_flags(0x08000000)
                            .output();
                    }
                    #[cfg(not(windows))]
                    {
                        let _ = std::process::Command::new("kill")
                            .args(["-TERM", &pid.to_string()])
                            .output();
                    }
                }
            }
        }
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
struct Turn {
    events: mpsc::UnboundedReceiver<Value>,
    initial: Vec<Value>,
    session: String,
    user: String,
}
impl Turn {
    async fn finish(mut self, code: i32) -> Vec<Value> {
        tokio::time::timeout(Duration::from_secs(6), async move {
            while let Some(event) = self.events.recv().await {
                let exit = event["kind"] == "exit";
                self.initial.push(event);
                if exit {
                    break;
                }
            }
            assert_eq!(
                self.initial.last().unwrap()["exitCode"],
                code,
                "{:?}",
                self.initial
            );
            self.initial
        })
        .await
        .expect("foreground must finish while its child interactions are waiting")
    }
}
fn idle(session: &str) -> Value {
    json!({"type":"session.status","properties":{"sessionID":session,"status":{"type":"idle"}}})
}
fn info(session: &str, message: &str, parent: &str) -> Value {
    json!({"type":"message.updated","properties":{"info":{"id":message,"sessionID":session,"role":"assistant","parentID":parent}}})
}
fn part(session: &str, message: &str, id: &str, text: &str, end: bool) -> Value {
    let mut part =
        json!({"id":id,"messageID":message,"sessionID":session,"type":"text","text":text});
    if end {
        part["time"] = json!({"end":1});
    }
    json!({"type":"message.part.updated","properties":{"part":part}})
}
fn delta(session: &str, message: &str, id: &str, text: &str) -> Value {
    json!({"type":"message.part.delta","properties":{"sessionID":session,"messageID":message,"partID":id,"field":"text","delta":text}})
}
fn task(session: &str, message: &str, call: &str, child: &str) -> Value {
    json!({"type":"message.part.updated","properties":{"part":{"id":format!("prt_{call}"),"messageID":message,"sessionID":session,"type":"tool","tool":"task","callID":call,"state":{"status":"running","input":{"description":"Native task"},"metadata":{"sessionId":child}}}}})
}
fn question(session: &str, id: &str) -> Value {
    json!({"type":"question.asked","properties":{"id":id,"sessionID":session,"questions":[{"question":"Pick one","options":[{"label":"A"},{"label":"B"}]}]}})
}
fn permission(session: &str, id: &str) -> Value {
    json!({"type":"permission.asked","properties":{"id":id,"sessionID":session,"permission":"read","patterns":["README.md"]}})
}
async fn complete(f: &Fixture, turn: &Turn, text: &str) {
    let message = format!("msg_{}", turn.user);
    f.emit(vec![
        info(&turn.session, &message, &turn.user),
        part(
            &turn.session,
            &message,
            &format!("prt_{message}"),
            text,
            true,
        ),
        idle(&turn.session),
    ])
    .await;
}

#[tokio::test]
async fn one_reader_preserves_same_read_tail_utf8_and_old_message_routes_across_turns() {
    let f = Fixture::new();
    let first = f.start("first", "local", None).await;
    let server = f.server();
    let session = first.session.clone();
    let user = first.user.clone();
    f.emit(vec![
        info(&session, "msg_task", &user),
        task(&session, "msg_task", "call_child", "ses_child"),
        info("ses_child", "msg_child", "msg_child_user"),
        part("ses_child", "msg_child", "prt_child", "", false),
        info(&session, "msg_old", &user),
        part(&session, "msg_old", "prt_old", "first", true),
        idle(&session),
    ])
    .await;
    first.finish(0).await;
    let frame = format!(
        "data: {}\r\n\r\n",
        delta("ses_child", "msg_child", "prt_child", "中文尾部")
    );
    let split = frame
        .as_bytes()
        .windows(3)
        .position(|bytes| bytes == "中".as_bytes())
        .unwrap()
        + 1;
    f.call("/fixture/config", Some(json!({"holdEvents":true})))
        .await;
    f.call("/fixture/raw", Some(json!({"base64":base64::engine::general_purpose::STANDARD.encode(&frame.as_bytes()[..split])}))).await;
    let second = f.start("second", "local", Some(&session)).await;
    f.call("/fixture/raw", Some(json!({"base64":base64::engine::general_purpose::STANDARD.encode(&frame.as_bytes()[split..]),"flush":true}))).await;
    f.emit(vec![
        part("ses_child", "msg_child", "prt_child", "中文尾部", true),
        part(&session, "msg_old", "prt_old", "late old root", true),
    ])
    .await;
    complete(&f, &second, "second").await;
    let events = second.finish(0).await;
    until(|| f.channel.saw("first", "中文尾部") && f.channel.saw("first", "late old root")).await;
    assert!(!events
        .iter()
        .any(|event| event["text"] == "中文尾部" || event["text"] == "late old root"));
    assert!(f
        .channel
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|(binding, event)| binding == "first"
            && event["messageId"] == "prt_child"
            && event["subagentDispatchId"] == "call_child"));
    assert_eq!(f.call("/fixture/state", None).await["streamOpens"], 1);
    assert_eq!(f.server().handle.pid, server.handle.pid);
    f.plugin
        .release_session(&json!({"localSessionId":"local"}))
        .await
        .unwrap();
    until(|| {
        f.channel
            .leases
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, active)| !active)
            .count()
            == 2
    })
    .await;
    assert!(!server.handle.is_alive());
    f.plugin.dispose().await;
}

#[tokio::test]
async fn child_questions_and_permissions_before_metadata_wait_without_blocking_and_keep_origin() {
    let f = Fixture::new();
    let first = f.start("first", "local", None).await;
    f.emit(vec![json!({"type":"session.created","properties":{"info":{"id":"ses_child","parentID":first.session}}}),
        question("ses_child", "question_child"), permission("ses_child", "permission_child"),
        info(&first.session, "msg_task", &first.user), task(&first.session, "msg_task", "call_child", "ses_child")]).await;
    until(|| f.channel.waiting.load(Ordering::Acquire) == 2).await;
    complete(&f, &first, "first reply while child is waiting").await;
    let session = first.session.clone();
    first.finish(0).await;
    let second = f.start("second", "local", Some(&session)).await;
    assert!(f
        .channel
        .questions
        .lock()
        .unwrap()
        .iter()
        .all(|(binding, _)| binding == "first"));
    f.channel.answer(
        "question_child",
        json!({"outcome":"selected","answers":{"question-1":["A"]}}),
    );
    f.channel.answer(
        "permission_child",
        json!({"outcome":"selected","optionId":"once"}),
    );
    until(|| f.channel.waiting.load(Ordering::Acquire) == 0).await;
    let replies = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let s = f.call("/fixture/state", None).await;
            if s["replies"].as_array().unwrap().len() == 2 {
                break s["replies"].clone();
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(replies
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["path"] == "/question/question_child/reply"
            && r["body"]["answers"] == json!([["A"]])));
    assert!(
        replies
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["path"] == "/permission/permission_child/reply"
                && r["body"]["reply"] == "once")
    );
    complete(&f, &second, "second").await;
    second.finish(0).await;
    f.plugin.dispose().await;
}

#[tokio::test]
async fn native_reply_or_rejection_withdraws_waiting_dialog_without_sending_a_late_reply() {
    let f = Fixture::new();
    let turn = f.start("first", "local", None).await;
    f.emit(vec![
        question(&turn.session, "q"),
        permission(&turn.session, "p"),
    ])
    .await;
    until(|| f.channel.waiting.load(Ordering::Acquire) == 2).await;
    f.emit(vec![json!({"type":"question.rejected","properties":{"sessionID":turn.session,"requestID":"q"}}),
        json!({"type":"permission.replied","properties":{"sessionID":turn.session,"requestID":"p"}})]).await;
    until(|| f.channel.waiting.load(Ordering::Acquire) == 0).await;
    complete(&f, &turn, "still reading").await;
    turn.finish(0).await;
    assert!(f.call("/fixture/state", None).await["replies"]
        .as_array()
        .unwrap()
        .is_empty());
    f.plugin.dispose().await;
}

#[tokio::test]
async fn cancel_aborts_only_the_target_root_and_its_children_and_reuses_the_server() {
    let f = Fixture::new();
    let a = f.start("a", "local-a", None).await;
    let b = f.start("b", "local-b", None).await;
    let server = f.server();
    let session = a.session.clone();
    f.emit(vec![
        info(&a.session, "msg_task", &a.user),
        task(&a.session, "msg_task", "call_child", "ses_child"),
        question("ses_child", "q"),
        permission(&a.session, "p"),
    ])
    .await;
    until(|| f.channel.waiting.load(Ordering::Acquire) == 2).await;
    f.plugin.cancel("a").await;
    a.finish(130).await;
    until(|| f.channel.waiting.load(Ordering::Acquire) == 0).await;
    let state = f.call("/fixture/state", None).await;
    let aborts = state["aborts"].as_array().unwrap();
    assert!(aborts.contains(&json!(session)) && aborts.contains(&json!("ses_child")));
    assert!(!aborts.contains(&json!(b.session)));
    complete(&f, &b, "unaffected").await;
    b.finish(0).await;
    let next = f.start("next", "local-a", Some(&session)).await;
    complete(&f, &next, "resumed").await;
    next.finish(0).await;
    assert_eq!(server.handle.pid, f.server().handle.pid);
    assert_eq!(f.call("/fixture/state", None).await["streamOpens"], 1);
    f.plugin.dispose().await;
}

#[tokio::test]
async fn timeouts_and_output_limits_interrupt_natively_without_restarting_other_sessions() {
    let f = Fixture::new();
    let keep = f.start("keep", "keep", None).await;
    let server = f.server();
    for (field, value, reason) in [
        ("timeoutMs", 80, "overall_timeout"),
        ("idleTimeoutMs", 80, "idle_timeout"),
        ("maxOutputBytes", 1, "max_output_bytes"),
    ] {
        let mut request = f.request(field, field);
        request[field] = json!(value);
        let events = f.plugin.start(field, request, None).await.unwrap();
        let all = Turn {
            events,
            initial: vec![],
            session: String::new(),
            user: String::new(),
        }
        .finish(1)
        .await;
        assert!(
            all.iter()
                .any(|e| e["kind"] == "timeout" && e["reason"] == reason),
            "{all:?}"
        );
    }
    complete(&f, &keep, "kept").await;
    keep.finish(0).await;
    assert_eq!(f.server().handle.pid, server.handle.pid);
    f.plugin.dispose().await;
}

#[tokio::test]
async fn releasing_one_session_preserves_the_shared_server_and_releasing_the_last_closes_it() {
    let f = Fixture::new();
    let a = f.start("a", "local-a", None).await;
    complete(&f, &a, "a").await;
    a.finish(0).await;
    let b = f.start("b", "local-b", None).await;
    let server = f.server();
    f.plugin
        .release_session(&json!({"localSessionId":"local-a"}))
        .await
        .unwrap();
    assert!(server.handle.is_alive());
    complete(&f, &b, "b").await;
    b.finish(0).await;
    assert_eq!(f.call("/fixture/state", None).await["deletes"], 0);
    f.plugin
        .release_session(&json!({"localSessionId":"local-b"}))
        .await
        .unwrap();
    assert!(!server.handle.is_alive());
    until(|| {
        f.channel
            .leases
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, active)| !active)
            .count()
            == 2
    })
    .await;
    f.plugin.dispose().await;
}

#[tokio::test]
async fn failed_abort_and_unknown_native_activity_never_authorize_shared_server_retirement() {
    let f = Fixture::new();
    let a = f.start("a", "local", None).await;
    let server = f.server();
    f.call("/fixture/config", Some(json!({"abortFailure":true})))
        .await;
    assert!(f
        .plugin
        .release_session(&json!({"localSessionId":"local"}))
        .await
        .is_err());
    a.finish(130).await;
    assert!(server.handle.is_alive());
    f.call(
        "/fixture/config",
        Some(json!({"abortFailure":false,"unsafePty":true})),
    )
    .await;
    f.plugin
        .release_session(&json!({"localSessionId":"local"}))
        .await
        .unwrap();
    assert!(server.handle.is_alive());
    f.call(
        "/fixture/config",
        Some(json!({"unsafePty":false,"unknownStatus":true})),
    )
    .await;
    f.plugin
        .release_session(&json!({"localSessionId":"local"}))
        .await
        .unwrap();
    assert!(server.handle.is_alive());
    f.plugin.dispose().await;
    assert!(!server.handle.is_alive());
}

#[tokio::test]
async fn native_terminal_lease_and_untracked_native_jobs_keep_the_server_until_unload() {
    let f = Fixture::new();
    let turn = f.start("a", "local", None).await;
    let session = turn.session.clone();
    complete(&f, &turn, "a").await;
    turn.finish(0).await;
    let server = f.server();
    let plan = f
        .plugin
        .terminal_plan(&f.request("terminal", "local"), Some(session.clone()))
        .await
        .unwrap();
    assert_eq!(plan["args"][0], "attach");
    assert_eq!(plan["args"][3], session);
    f.plugin
        .release_session(&json!({"localSessionId":"local"}))
        .await
        .unwrap();
    assert!(server.handle.is_alive());
    f.plugin
        .close_terminal(plan["token"].as_str().unwrap())
        .await;
    assert!(server.handle.is_alive());
    assert_eq!(server.terminals.load(Ordering::Acquire), 0);
    f.plugin.dispose().await;
    assert!(!server.handle.is_alive());
}

#[tokio::test]
async fn terminal_handoff_keeps_native_events_and_restores_unanswered_root_and_child_interactions()
{
    let f = Fixture::new();
    let first = f.start("first", "local", None).await;
    let session = first.session.clone();
    f.emit(vec![
        info(&session, "task-message", &first.user),
        task(&session, "task-message", "old-child-call", "old-child"),
    ])
    .await;
    complete(&f, &first, "first reply").await;
    first.finish(0).await;
    let request = f.request("terminal-binding", "local");
    let plan = f
        .plugin
        .terminal_plan(&request, Some(session.clone()))
        .await
        .unwrap();
    f.emit(vec![
        json!({"type":"message.updated","properties":{"info":{"id":"native-user","sessionID":session,"role":"user"}}}),
        json!({"type":"message.part.updated","properties":{"part":{"id":"native-input","messageID":"native-user","sessionID":session,"type":"text","text":"from native TUI"}}}),
        info(&session,"native-assistant","native-user"),part(&session,"native-assistant","native-part","native reply",true),
        question("old-child","native-child-question"),permission(&session,"native-permission")
    ]).await;
    until(|| f.channel.saw("terminal-binding", "native reply")).await;
    assert!(
        f.channel.questions.lock().unwrap().is_empty(),
        "The TUI exclusively owns interaction while it is open"
    );
    assert!(f
        .channel
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|(binding, event)| binding == "terminal-binding"
            && event["messageId"] == "native-part"
            && event["raw"]["nativeTurnId"] == "native-user"));
    let snapshot = f
        .plugin
        .read_session_history(&request, &session)
        .await
        .unwrap()
        .unwrap();
    f.plugin
        .resume_terminal_events(&request, &session, &snapshot)
        .await
        .unwrap();
    until(|| f.channel.waiting.load(Ordering::Acquire) == 2).await;
    assert!(f
        .channel
        .questions
        .lock()
        .unwrap()
        .iter()
        .any(|(binding, input)| binding == "first"
            && input["nativeRequestId"] == "native-child-question"));
    f.channel.answer(
        "native-child-question",
        json!({"outcome":"selected","answers":{"question-1":["A"]}}),
    );
    f.channel.answer(
        "native-permission",
        json!({"outcome":"selected","optionId":"once"}),
    );
    until(|| f.channel.waiting.load(Ordering::Acquire) == 0).await;
    let next = f.start("next", "local", Some(&session)).await;
    f.emit(vec![
        part(
            &session,
            "native-assistant",
            "native-part",
            "late native edit",
            true,
        ),
        info("old-child", "child-message", "child-user"),
        part(
            "old-child",
            "child-message",
            "child-part",
            "child still alive",
            true,
        ),
    ])
    .await;
    until(|| {
        f.channel.saw("terminal-binding", "late native edit")
            && f.channel.saw("first", "child still alive")
    })
    .await;
    complete(&f, &next, "next reply").await;
    next.finish(0).await;
    assert!(
        f.call("/fixture/state", None).await["aborts"]
            .as_array()
            .unwrap()
            .is_empty(),
        "Handing off and returning must not abort native jobs"
    );
    f.plugin
        .close_terminal(plan["token"].as_str().unwrap())
        .await;
    f.plugin.dispose().await;
}

#[tokio::test]
async fn disconnected_reader_fails_foreground_withdraws_dialogs_and_can_resume() {
    let f = Fixture::new();
    let turn = f.start("a", "local", None).await;
    let session = turn.session.clone();
    let server = f.server();
    f.emit(vec![question(&session, "q")]).await;
    until(|| f.channel.waiting.load(Ordering::Acquire) == 1).await;
    f.call("/fixture/close-events", Some(json!({}))).await;
    turn.finish(1).await;
    until(|| f.channel.waiting.load(Ordering::Acquire) == 0).await;
    let next = f.start("next", "local", Some(&session)).await;
    complete(&f, &next, "recovered").await;
    next.finish(0).await;
    assert_ne!(f.server().handle.pid, server.handle.pid);
    f.plugin.dispose().await;
}

#[tokio::test]
async fn native_process_exit_closes_foreground_and_background_bindings() {
    let f = Fixture::new();
    let old = f.start("old", "local-old", None).await;
    complete(&f, &old, "old").await;
    old.finish(0).await;
    let current = f.start("current", "local", None).await;
    f.emit(vec![permission(&current.session, "p")]).await;
    until(|| f.channel.waiting.load(Ordering::Acquire) == 1).await;
    f.call("/fixture/exit", Some(json!({}))).await;
    current.finish(1).await;
    until(|| {
        f.channel.waiting.load(Ordering::Acquire) == 0
            && f.channel
                .leases
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, active)| !active)
                .count()
                == 2
    })
    .await;
    assert!(f
        .channel
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|(binding, event)| binding == "old" && event["kind"] == "exit"));
    f.plugin.dispose().await;
}

#[tokio::test]
async fn compaction_keeps_the_reader_running_and_finishes_on_native_completion() {
    let f = Fixture::new();
    let a = f.start("a", "local", None).await;
    let session = a.session.clone();
    complete(&f, &a, "a").await;
    a.finish(0).await;
    let mut request = f.request("compact", "local");
    request["providerCommand"] = json!("compact");
    request["model"] = json!("fixture/model");
    let events = f
        .plugin
        .start("compact", request, Some(session))
        .await
        .unwrap();
    Turn {
        events,
        initial: vec![],
        session: String::new(),
        user: String::new(),
    }
    .finish(0)
    .await;
    assert_eq!(f.call("/fixture/state", None).await["streamOpens"], 1);
    f.plugin.dispose().await;
}

#[tokio::test]
async fn cancellation_while_server_is_starting_cannot_send_a_prompt_or_leak_the_server() {
    let f = Fixture::new();
    let mut request = f.request("starting", "local");
    request["env"]["NAUTILO_FIXTURE_START_DELAY"] = json!("200");
    let events = f.plugin.start("starting", request, None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(40)).await;
    f.plugin.cancel("starting").await;
    Turn {
        events,
        initial: vec![],
        session: String::new(),
        user: String::new(),
    }
    .finish(130)
    .await;
    assert!(f.plugin.pool.lock().unwrap().servers.is_empty());
    f.plugin.dispose().await;
}

#[tokio::test]
async fn dispose_while_transport_is_starting_interrupts_launch_and_releases_the_binding() {
    let f = Fixture::new();
    let mut request = f.request("starting", "local");
    request["env"]["NAUTILO_FIXTURE_START_DELAY"] = json!("5000");
    let events = f.plugin.start("starting", request, None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    tokio::time::timeout(Duration::from_secs(2), f.plugin.dispose())
        .await
        .expect("unload must interrupt startup instead of waiting for its HTTP deadline");
    Turn {
        events,
        initial: vec![],
        session: String::new(),
        user: String::new(),
    }
    .finish(130)
    .await;
    until(|| {
        f.channel
            .leases
            .lock()
            .unwrap()
            .iter()
            .any(|(_, active)| !active)
    })
    .await;
    assert!(f.plugin.pool.lock().unwrap().servers.is_empty());
}

#[tokio::test]
async fn custom_single_process_path_still_has_real_process_cancellation() {
    let f = Fixture::new();
    let mut request = f.request("cli", "local");
    request["instance"]["baseArgs"] = json!(["fixture-cli"]);
    let mut events = f.plugin.start("cli", request, None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let e = events.recv().await.unwrap();
            if e["text"] == "cli prefix" {
                break;
            }
        }
    })
    .await
    .unwrap();
    f.plugin.cancel("cli").await;
    Turn {
        events,
        initial: vec![],
        session: String::new(),
        user: String::new(),
    }
    .finish(130)
    .await;
    f.plugin.dispose().await;
}

#[tokio::test]
async fn parallel_and_nested_children_use_exact_task_metadata_instead_of_arrival_order() {
    let f = Fixture::new();
    let turn = f.start("root", "local", None).await;
    f.emit(vec![info(&turn.session,"msg_tasks",&turn.user), task(&turn.session,"msg_tasks","call_a","ses_a"), task(&turn.session,"msg_tasks","call_b","ses_b"),
        info("ses_b","msg_b","msg_b_user"), part("ses_b","msg_b","prt_b","B",true),
        info("ses_a","msg_a","msg_a_user"), task("ses_a","msg_a","call_grand","ses_grand"),
        info("ses_grand","msg_grand","msg_grand_user"), part("ses_grand","msg_grand","prt_grand","grandchild",true),
        part("ses_a","msg_a","prt_a","A",true), question("ses_grand","q_grand"),
        json!({"type":"session.status","properties":{"sessionID":"ses_b","status":{"type":"idle"}}}),
        json!({"type":"session.error","properties":{"sessionID":"ses_a","error":{"data":{"message":"child only"}}}})]).await;
    until(|| f.channel.waiting.load(Ordering::Acquire) == 1).await;
    complete(&f, &turn, "root").await;
    let events = turn.finish(0).await;
    for (text, dispatch) in [
        ("A", "call_a"),
        ("B", "call_b"),
        ("grandchild", "call_grand"),
    ] {
        assert!(
            events
                .iter()
                .any(|event| event["text"] == text && event["subagentDispatchId"] == dispatch),
            "{events:?}"
        );
    }
    assert!(!events.iter().any(|event| event["kind"] == "session"
        && event["providerSessionId"]
            .as_str()
            .unwrap_or("")
            .contains("grand")));
    f.plugin
        .release_session(&json!({"localSessionId":"local"}))
        .await
        .unwrap();
    until(|| f.channel.waiting.load(Ordering::Acquire) == 0).await;
    f.plugin.dispose().await;
}

#[tokio::test]
async fn native_part_reordering_keeps_reasoning_and_usage_resets_for_each_turn() {
    let f = Fixture::new();
    let first = f.start("one", "local", None).await;
    let session = first.session.clone();
    f.emit(vec![delta(&session,"msg_one","prt_reason","thinking before type"), info(&session,"msg_one",&first.user),
        json!({"type":"message.part.updated","properties":{"part":{"id":"prt_reason","messageID":"msg_one","sessionID":session,"type":"reasoning"}}}),
        json!({"type":"message.part.updated","properties":{"part":{"id":"prt_usage_one","messageID":"msg_one","sessionID":session,"type":"step-finish","tokens":{"input":10,"output":1,"cache":{"read":0,"write":0}}}}}), idle(&session)]).await;
    let events = first.finish(0).await;
    assert!(events.iter().any(|event| event["kind"] == "thinking"
        && event["text"] == "thinking before type"
        && event["messageId"] == "prt_reason"));
    assert_eq!(
        events.iter().find(|e| e["usageScope"] == "turn").unwrap()["inputTokens"],
        10
    );
    let second = f.start("two", "local", Some(&session)).await;
    f.emit(vec![info(&session,"msg_two",&second.user),
        json!({"type":"message.part.updated","properties":{"part":{"id":"prt_usage_two","messageID":"msg_two","sessionID":session,"type":"step-finish","tokens":{"input":20,"output":2,"cache":{"read":0,"write":0}}}}}), idle(&session)]).await;
    let events = second.finish(0).await;
    assert_eq!(
        events.iter().find(|e| e["usageScope"] == "turn").unwrap()["inputTokens"],
        20
    );
    f.plugin.dispose().await;
}

#[tokio::test]
async fn native_session_deletion_cancels_its_dialogs_and_releases_binding_without_a_failing_abort()
{
    let f = Fixture::new();
    let turn = f.start("root", "local", None).await;
    f.emit(vec![question(&turn.session, "q")]).await;
    until(|| f.channel.waiting.load(Ordering::Acquire) == 1).await;
    f.emit(vec![
        json!({"type":"session.deleted","properties":{"info":{"id":turn.session}}}),
    ])
    .await;
    turn.finish(130).await;
    until(|| {
        f.channel.waiting.load(Ordering::Acquire) == 0
            && f.channel
                .leases
                .lock()
                .unwrap()
                .iter()
                .any(|(_, active)| !active)
    })
    .await;
    assert!(!f.server().events.has_local("local"));
    f.plugin.dispose().await;
}

#[tokio::test]
async fn reused_child_session_keeps_old_message_dispatch_and_old_root_dialog_origin() {
    let f = Fixture::new();
    let first = f.start("first", "local", None).await;
    let session = first.session.clone();
    f.emit(vec![info(&session,"msg_task_one",&first.user),task(&session,"msg_task_one","call_one","ses_child"),
        json!({"type":"message.updated","properties":{"info":{"id":"msg_child_user_one","sessionID":"ses_child","role":"user"}}}),
        info("ses_child","msg_child_one","msg_child_user_one"),part("ses_child","msg_child_one","prt_child_one","",false)]).await;
    complete(&f, &first, "first").await;
    first.finish(0).await;
    let second = f.start("second", "local", Some(&session)).await;
    let mut old_question = question(&session, "old_root_question");
    old_question["properties"]["tool"] = json!({"messageID":"msg_task_one","callID":"call_one"});
    f.emit(vec![info(&session,"msg_task_two",&second.user),task(&session,"msg_task_two","call_two","ses_child"),
        part("ses_child","msg_child_one","prt_child_one","old child",true),
        info("ses_child","msg_late_old","msg_child_user_one"),part("ses_child","msg_late_old","prt_late_old","late old child",true),
        json!({"type":"message.updated","properties":{"info":{"id":"msg_child_user_two","sessionID":"ses_child","role":"user"}}}),
        info("ses_child","msg_child_two","msg_child_user_two"),part("ses_child","msg_child_two","prt_child_two","new child",true),old_question]).await;
    until(|| f.channel.waiting.load(Ordering::Acquire) == 1).await;
    assert_eq!(
        f.channel.questions.lock().unwrap().last().unwrap().0,
        "first"
    );
    complete(&f, &second, "second").await;
    let second = second.finish(0).await;
    until(|| f.channel.saw("first", "late old child")).await;
    assert!(f
        .channel
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|(binding, event)| binding == "first"
            && event["text"] == "late old child"
            && event["subagentDispatchId"] == "call_one"));
    assert!(second
        .iter()
        .any(|event| event["text"] == "new child" && event["subagentDispatchId"] == "call_two"));
    f.plugin.dispose().await;
}

#[tokio::test]
async fn a_withdrawn_unidentified_child_question_does_not_reopen_when_metadata_arrives() {
    let f = Fixture::new();
    let turn = f.start("root", "local", None).await;
    f.emit(vec![json!({"type":"session.created","properties":{"info":{"id":"ses_child","parentID":turn.session}}}),question("ses_child","withdrawn"),
        json!({"type":"question.rejected","properties":{"sessionID":"ses_child","requestID":"withdrawn"}}),
        info(&turn.session,"msg_task",&turn.user),task(&turn.session,"msg_task","call_child","ses_child")]).await;
    complete(&f, &turn, "root").await;
    turn.finish(0).await;
    assert!(f.channel.questions.lock().unwrap().is_empty());
    f.plugin.dispose().await;
}

#[tokio::test]
async fn unconfirmed_abort_after_disconnection_preserves_server_and_refuses_unsafe_restart() {
    let f = Fixture::new();
    let turn = f.start("root", "local", None).await;
    let session = turn.session.clone();
    let server = f.server();
    f.call("/fixture/config", Some(json!({"abortFailure":true})))
        .await;
    f.call("/fixture/close-events", Some(json!({}))).await;
    turn.finish(1).await;
    let next = f
        .plugin
        .start("next", f.request("next", "local"), Some(session))
        .await
        .unwrap();
    let events = Turn {
        events: next,
        initial: vec![],
        session: String::new(),
        user: String::new(),
    }
    .finish(1)
    .await;
    assert!(events.iter().any(|event| event["message"]
        .as_str()
        .is_some_and(|message| message.contains("unconfirmed native work"))));
    assert_eq!(server.handle.pid, f.server().handle.pid);
    assert!(server.handle.is_alive());
    f.plugin.dispose().await;
}

#[tokio::test]
#[ignore = "requires NAUTILO_TEST_OPENCODE pointing to an installed native executable"]
async fn installed_opencode_server_accepts_native_message_ids_and_releases_without_a_model_call() {
    let f = Fixture::new();
    let mut request = f.request("native", "native-local");
    request["instance"]["executable"] =
        json!(std::env::var("NAUTILO_TEST_OPENCODE").expect("explicit native CLI path required"));
    for (key, directory) in [
        ("XDG_DATA_HOME", "data"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_STATE_HOME", "state"),
        ("BUN_INSTALL_CACHE_DIR", "bun-cache"),
    ] {
        request["env"][key] = json!(f.directory.join(directory));
    }
    request["env"]["OPENCODE_DISABLE_AUTOUPDATE"] = json!("true");
    let server = {
        let _opening = f.plugin.opening.lock().await;
        f.plugin.server_for(&request).await.unwrap()
    };
    let health = api_json(&server.base_url, &server.cwd, "/global/health", "GET", None)
        .await
        .unwrap();
    assert_eq!(health["healthy"], true);
    let native = api_json(
        &server.base_url,
        &server.cwd,
        "/session",
        "POST",
        Some(json!({"title":"Nautilo native protocol check"})),
    )
    .await
    .unwrap();
    let session = native["id"].as_str().unwrap();
    let user = next_native_id("msg");
    let (output, mut events) = mpsc::unbounded_channel();
    let route = Route::new("native", &request, output, Some(f.channel.clone()), None).await;
    server.events.begin(session, &user, route.clone()).unwrap();
    let posted = api_json(&server.base_url,&server.cwd,&format!("/session/{}/message",urlencoding(session)),"POST",Some(json!({"messageID":user,"noReply":true,"parts":[{"type":"text","text":"Native protocol check, no generation"}]}))).await.unwrap();
    assert_eq!(posted["info"]["id"], user);
    let snapshot = f
        .plugin
        .read_session_history(&request, session)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot["providerSessionId"], session);
    assert_eq!(snapshot["settled"], true);
    assert!(snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["id"] == user
            && entry["role"] == "user"
            && entry["text"] == "Native protocol check, no generation"));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), events.recv())
            .await
            .is_err(),
        "a native user message must not become assistant output"
    );
    route.cancelled.store(true, Ordering::Release);
    assert!(server.events.interrupt(&route, 130, None).await);
    f.plugin
        .release_session(&json!({"localSessionId":"native-local"}))
        .await
        .unwrap();
    assert!(
        !server.handle.is_alive(),
        "native safety endpoints should confirm the isolated server is idle"
    );
    f.plugin.dispose().await;
}
