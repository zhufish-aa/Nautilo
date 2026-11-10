use super::*;
use crate::adapters::{
    AdapterCapabilities, AdapterDetectionResult, AdapterResumeRequest, AgentCliAdapter,
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn message(id: &str, role: &str, text: &str) -> Value {
    json!({"id":id,"messageId":id,"role":role,"text":text,"nativeTurnId":"turn","timestampMs":1000,"completed":true,"files":[]})
}
fn snapshot(messages: Vec<Value>) -> Value {
    json!({"schemaVersion":1,"providerSessionId":"native","settled":true,"messages":messages,"activities":[]})
}
fn checkpoint(baseline: &Value) -> Value {
    json!({"id":"handoff","sessionId":"s","providerId":"fixture","providerSessionId":"native","phase":"syncing","baseline":agenthub_plugin_sdk::history::fingerprints(baseline),"startedAt":"2026-11-07T00:00:00Z"})
}
fn session() -> Value {
    json!({"id":"s","projectId":"p","agentInstanceId":"a","memberId":"a","providerSessionId":"native","mode":"chat","status":"idle","createdAt":now_iso(),"updatedAt":now_iso()})
}

#[test]
fn redundant_path_blocks_do_not_change_native_identity_but_account_and_resolution_order_still_do() {
    let separator = path_separator().to_string();
    let mut request = AdapterStartRequest {
        cwd: "D:/project".into(),
        env: Some(HashMap::from([(
            "PATH".into(),
            ["D:/bin", "D:/tools"].join(&separator),
        )])),
        ..Default::default()
    };
    let original = legacy_identity(&session(), &request);
    request.env.as_mut().unwrap().insert(
        "PATH".into(),
        ["D:/bin", "D:/tools", "D:/bin", "D:/tools"].join(&separator),
    );
    assert!(legacy_identity_matches(&original, &session(), &request));
    assert_eq!(identity(&session(), &request), original);
    let mut changed = session();
    changed["connectionId"] = json!("another-account");
    assert!(!legacy_identity_matches(&original, &changed, &request));
    request.env.as_mut().unwrap().insert(
        "PATH".into(),
        ["D:/bin", "D:/tools", "D:/bin"].join(&separator),
    );
    let mut reordered = request.clone();
    reordered
        .env
        .as_mut()
        .unwrap()
        .insert("PATH".into(), ["D:/tools", "D:/bin"].join(&separator));
    assert!(!legacy_identity_matches(
        &legacy_identity(&session(), &reordered),
        &session(),
        &request
    ));
}

#[test]
fn incomplete_native_output_is_retained_without_a_successful_run_status() {
    let mut incomplete = message("partial", "assistant", "retained prefix");
    incomplete["completed"] = json!(false);
    let history = snapshot(vec![incomplete]);
    let record = checkpoint(&snapshot(vec![]));
    let batch = plan_import(
        &session(),
        &record,
        &history,
        &agenthub_plugin_sdk::history::fingerprints(&history),
        &HashMap::new(),
        &[],
        &[],
        &RedactionService::default(),
    )
    .unwrap();
    assert_eq!(batch.messages[0]["text"], "retained prefix");
    assert_eq!(batch.runs[0]["status"], "failed");
    assert_eq!(batch.activities.last().unwrap()["type"], "run.failed");
}

#[tokio::test]
async fn providers_without_history_contract_keep_distinct_local_rows_for_reused_output_keys() {
    let f = Fixture::new();
    f.adapter.claims_history.store(false, Ordering::SeqCst);
    for (run, text) in [("first", "first reply"), ("second", "second reply")] {
        f.runs.persist(
            &json!({"id":run,"agentInstanceId":"a","sessionId":"s"}),
            &session(),
            &AdapterEvent::Message {
                text: text.into(),
                phase: Some("completed".into()),
                message_id: Some("reused-key".into()),
                subagent_dispatch_id: None,
                raw: None,
            },
            &RunContext::default(),
        );
    }
    let messages = f.messages();
    assert_eq!(messages.len(), 2);
    assert_ne!(messages[0]["id"], messages[1]["id"]);
    assert!(messages
        .iter()
        .all(|message| message.get("nativeIdentity").is_none()));
}

#[test]
fn native_history_uses_identity_for_repeated_text_edits_and_retries() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    crate::database::migrations::migrate(&db).unwrap();
    let session = session();
    let native_repo = NativeHistoryRepository::new(&db);
    Repositories::new(&db).sessions().save(&session).unwrap();
    let initial = snapshot(vec![message("old", "user", "old")]);
    let record = checkpoint(&initial);
    native_repo.save(&record).unwrap();
    let old = json!({"id":"local-old","sessionId":"s","sender":"user","text":"old","createdAt":"2026-11-06T00:00:00Z"});
    Repositories::new(&db)
        .sessions()
        .save_message(&old)
        .unwrap();
    native_repo
        .bind("s", "native", "messages", "old", Some("local-old"), "")
        .unwrap();
    let changed = snapshot(vec![
        message("old", "user", "edited"),
        message("first", "user", "same"),
        message("second", "user", "same"),
        message("reply", "assistant", "answer"),
    ]);
    let prints = agenthub_plugin_sdk::history::fingerprints(&changed);
    let bindings = HashMap::from([(
        "messages:old".into(),
        native_repo
            .binding("s", "native", "messages", "old")
            .unwrap()
            .unwrap(),
    )]);
    let batch = plan_import(
        &session,
        &record,
        &changed,
        &prints,
        &bindings,
        &[old],
        &[],
        &RedactionService::default(),
    )
    .unwrap();
    assert_eq!(batch.messages.len(), 4);
    assert_eq!(batch.messages[0]["id"], "local-old");
    assert_ne!(batch.messages[1]["id"], batch.messages[2]["id"]);
    assert_eq!(batch.messages[0]["createdAt"], "2026-11-06T00:00:00Z");
    let mut next = record.clone();
    next["phase"] = json!("synced");
    next["baseline"] = json!(prints);
    let events = native_repo
        .commit(&session, "handoff", &next, batch)
        .unwrap();
    assert_eq!(
        events.last().unwrap()["type"],
        "session.native_history_synced"
    );
    let existing = Repositories::new(&db).sessions().messages("s").unwrap();
    let bindings = changed["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            let id = m["id"].as_str().unwrap();
            (
                format!("messages:{id}"),
                native_repo
                    .binding("s", "native", "messages", id)
                    .unwrap()
                    .unwrap(),
            )
        })
        .collect();
    let retry = plan_import(
        &session,
        &record,
        &changed,
        &prints,
        &bindings,
        &existing,
        &[],
        &RedactionService::default(),
    )
    .unwrap();
    assert!(retry.messages.is_empty());
    assert!(retry.runs.is_empty());
    assert_eq!(
        Repositories::new(&db)
            .sessions()
            .messages("s")
            .unwrap()
            .len(),
        4
    );
    assert_eq!(
        Repositories::new(&db)
            .runs()
            .list_for_session("s")
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn reading_native_history_does_not_make_synthetic_stream_ids_safe_to_merge() {
    let f = Fixture::new();
    f.adapter.stable_ids.store(false, Ordering::SeqCst);
    for (id, text) in [("one", "first"), ("two", "second")] {
        f.runs.persist(
            &json!({"id":id,"agentInstanceId":"a","sessionId":"s"}),
            &session(),
            &AdapterEvent::Message {
                text: text.into(),
                phase: Some("completed".into()),
                message_id: Some("synthetic-1".into()),
                subagent_dispatch_id: None,
                raw: None,
            },
            &RunContext::default(),
        );
    }
    let messages = f.messages();
    assert_eq!(messages.len(), 2);
    assert_ne!(messages[0]["id"], messages[1]["id"]);
}

#[test]
fn legacy_edit_without_an_exact_id_binding_fails_without_text_matching() {
    let initial = snapshot(vec![message("old", "user", "same")]);
    let changed = snapshot(vec![message("old", "user", "edited")]);
    let old = json!({"id":"local","sender":"user","text":"same"});
    assert!(plan_import(
        &session(),
        &checkpoint(&initial),
        &changed,
        &agenthub_plugin_sdk::history::fingerprints(&changed),
        &HashMap::new(),
        &[old],
        &[],
        &RedactionService::default()
    )
    .is_err());
}

#[test]
fn native_attachment_versions_are_durable_and_missing_files_remain_visible() {
    let root = std::env::temp_dir().join(format!("nautilo-native-attachments-{}", Uuid::new_v4()));
    let record = checkpoint(&snapshot(vec![]));
    let mut entry = message("user", "user", "");
    entry["files"] = json!([{"id":"inline","url":"data:image/png;base64,aGVsbG8=","mime":"image/png","filename":"image.png"},{"id":"missing","url":"file:///nautilo-fixture-missing/file.txt","filename":"missing.txt"}]);
    let (first, missing) = prepare_files(&root, &session(), &record, &entry).unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(missing[0]["name"], "missing.txt");
    entry["files"][0]["url"] = json!("data:image/png;base64,b3RoZXI=");
    let (second, _) = prepare_files(&root, &session(), &record, &entry).unwrap();
    assert_eq!(first[0]["id"], second[0]["id"]);
    assert_ne!(first[0]["path"], second[0]["path"]);
    assert_eq!(
        std::fs::read(first[0]["path"].as_str().unwrap()).unwrap(),
        b"hello"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn adding_turn_state_to_an_older_snapshot_is_not_treated_as_a_native_text_edit() {
    let initial = snapshot(vec![message("old", "user", "same")]);
    let mut entry = initial["messages"][0].clone();
    entry["turnStatus"] = json!("completed");
    let updated = snapshot(vec![entry]);
    let batch = plan_import(
        &session(),
        &checkpoint(&initial),
        &updated,
        &agenthub_plugin_sdk::history::fingerprints(&updated),
        &HashMap::new(),
        &[],
        &[],
        &RedactionService::default(),
    )
    .unwrap();
    assert!(batch.messages.is_empty());
    assert!(batch.runs.is_empty());
}

#[test]
fn native_history_commit_rolls_back_rows_bindings_and_checkpoint_together() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    crate::database::migrations::migrate(&db).unwrap();
    let session = session();
    let repo = NativeHistoryRepository::new(&db);
    let record = checkpoint(&snapshot(vec![]));
    Repositories::new(&db).sessions().save(&session).unwrap();
    repo.save(&record).unwrap();
    let batch = ImportBatch {
        messages: vec![
            json!({"id":"valid","sessionId":"s"}),
            json!({"sessionId":"s"}),
        ],
        runs: vec![json!({"id":"run","sessionId":"s"})],
        ..Default::default()
    };
    let mut next = record.clone();
    next["phase"] = json!("synced");
    assert!(repo.commit(&session, "handoff", &next, batch).is_err());
    assert!(Repositories::new(&db)
        .sessions()
        .messages("s")
        .unwrap()
        .is_empty());
    assert!(Repositories::new(&db).runs().list().unwrap().is_empty());
    assert_eq!(repo.get("s").unwrap().unwrap(), record);
    assert!(repo
        .commit(&session, "stale-handoff", &next, ImportBatch::default())
        .is_err());
    repo.bind(
        "s",
        "native",
        "messages",
        "id",
        Some("local"),
        "fingerprint",
    )
    .unwrap();
    Repositories::new(&db).sessions().delete_tree("s").unwrap();
    assert!(repo.get("s").unwrap().is_none());
    assert!(repo
        .binding("s", "native", "messages", "id")
        .unwrap()
        .is_none());
}

#[test]
fn live_message_versions_cannot_be_overwritten_by_an_older_import_snapshot() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    crate::database::migrations::migrate(&db).unwrap();
    let session = session();
    let repos = Repositories::new(&db);
    repos.sessions().save(&session).unwrap();
    let repo = NativeHistoryRepository::new(&db);
    let record = checkpoint(&snapshot(vec![]));
    repo.save(&record).unwrap();
    let previous =
        json!({"id":"m","sessionId":"s","sender":"agent","text":"prefix","createdAt":now_iso()});
    repos.sessions().save_message(&previous).unwrap();
    let mut live = previous.clone();
    live["text"] = json!("newer native prefix");
    repos.sessions().save_message(&live).unwrap();
    let mut batch = ImportBatch::default();
    batch.messages.push(previous.clone());
    batch.expected_messages.push(("m".into(), Some(previous)));
    assert!(repo.commit(&session, "handoff", &record, batch).is_err());
    assert_eq!(
        repos.sessions().message("s", "m").unwrap().unwrap()["text"],
        "newer native prefix"
    );
    assert_eq!(repo.get("s").unwrap().unwrap(), record);
}

struct NativeAdapter {
    history: Mutex<Value>,
    fail: AtomicBool,
    opens: AtomicUsize,
    claims_history: AtomicBool,
    stable_ids: AtomicBool,
    resumes: Mutex<Vec<(String, String)>>,
    callback: Mutex<Option<Arc<dyn Fn(AdapterEvent) + Send + Sync>>>,
}
#[async_trait::async_trait]
impl AgentCliAdapter for NativeAdapter {
    fn native_history_supported(&self, _: &Value) -> bool {
        self.claims_history.load(Ordering::SeqCst)
    }
    fn native_message_ids_supported(&self, _: &Value) -> bool {
        self.stable_ids.load(Ordering::SeqCst) && self.claims_history.load(Ordering::SeqCst)
    }
    fn provider_id(&self) -> &str {
        "fixture"
    }
    fn descriptor(&self) -> Value {
        json!({"id":"fixture","environmentPassthrough":["XDG_DATA_HOME","XDG_CONFIG_HOME","XDG_CACHE_HOME","XDG_STATE_HOME"]})
    }
    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            structured_output: true,
            text_output: true,
            interactive_stdin: false,
            native_resume: true,
            pty: false,
        }
    }
    async fn detect(&self, _: &Value) -> AdapterDetectionResult {
        panic!("No CLI discovery or model call is needed")
    }
    fn start(&self, _: AdapterStartRequest) -> CoreResult<AdapterRun> {
        panic!("Native handoff must resume its original session")
    }
    fn resume(&self, request: AdapterResumeRequest) -> CoreResult<AdapterRun> {
        self.resumes
            .lock()
            .unwrap()
            .push((request.provider_session_id.clone(), request.start.prompt));
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tx.send(AdapterEvent::Session {
            provider_session_id: request.provider_session_id,
            raw: Some(json!({"providerUserMessageId":"continued-user"})),
        })
        .unwrap();
        tx.send(AdapterEvent::Message {
            text: "continued".into(),
            phase: Some("completed".into()),
            message_id: Some("continued-answer".into()),
            subagent_dispatch_id: None,
            raw: None,
        })
        .unwrap();
        tx.send(AdapterEvent::Exit {
            exit_code: Some(0),
            signal: None,
        })
        .unwrap();
        drop(tx);
        Ok(AdapterRun::new(rx, || Box::pin(async {}), |_| {}))
    }
    async fn read_session_history(
        &self,
        _: &AdapterStartRequest,
        session: &str,
    ) -> CoreResult<Option<Value>> {
        assert_eq!(session, "native");
        if self.fail.load(Ordering::SeqCst) {
            return Err(invalid("nativeHistory", "fixture read failed"));
        }
        Ok(Some(self.history.lock().unwrap().clone()))
    }
    async fn native_terminal(
        &self,
        request: AdapterStartRequest,
        resume: Option<String>,
    ) -> CoreResult<crate::runtime::terminal_service::TerminalPlan> {
        assert_eq!(resume.as_deref(), Some("native"));
        self.opens.fetch_add(1, Ordering::SeqCst);
        *self.callback.lock().unwrap() = request.session_events.clone();
        Ok(crate::runtime::terminal_service::TerminalPlan {
            command: std::env::var("NAUTILO_TEST_NODE").unwrap_or_else(|_| "node".into()),
            args: vec!["-e".into(), "setInterval(()=>{},1000)".into()],
            env: request.env,
            cwd: request.cwd,
            resources: vec![],
            provider_session_id: resume,
        })
    }
}
struct Fixture {
    root: std::path::PathBuf,
    db: Arc<Mutex<Database>>,
    runs: Arc<RunService>,
    terminals: Arc<crate::runtime::terminal_service::TerminalService>,
    adapter: Arc<NativeAdapter>,
    sessions: crate::application::session_service::SessionService,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("nautilo-native-history-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let db = Arc::new(Mutex::new(
            Database::open(&root.join("fixture.sqlite")).unwrap(),
        ));
        let adapter = Arc::new(NativeAdapter {
            history: Mutex::new(snapshot(vec![])),
            fail: AtomicBool::new(false),
            opens: AtomicUsize::new(0),
            claims_history: AtomicBool::new(true),
            stable_ids: AtomicBool::new(true),
            resumes: Mutex::new(vec![]),
            callback: Mutex::new(None),
        });
        let registry = AdapterRegistry::default();
        registry.register(adapter.clone());
        let redaction = RedactionService::default();
        let events = Arc::new(EventService::new(db.clone(), redaction.clone()));
        let credentials = Arc::new(CredentialService::new(db.clone(), &root));
        let policies = Arc::new(CommandPolicyService::new(db.clone()).unwrap());
        policies.save(&json!({"id":"fixture-policy","defaultCommandAction":"safe","commandRules":[{"id":"fixture-node","executable":"node","action":"safe"}]})).unwrap();
        let runs = RunService::new(
            db.clone(),
            registry,
            events.clone(),
            credentials,
            policies,
            Arc::new(ApprovalService::new(db.clone())),
            redaction.clone(),
            AuditService::new(db.clone(), redaction),
        );
        let terminals = Arc::new(crate::runtime::terminal_service::TerminalService::default());
        runs.set_terminal_service(terminals.clone());
        let sessions = crate::application::session_service::SessionService::new(db.clone());
        sessions.set_run_pipeline(runs.clone(), events);
        {
            let db = db.lock().unwrap();
            let repos = Repositories::new(&db.raw);
            repos
                .projects()
                .save(
                    &json!({"id":"p","name":"fixture","rootPath":root,"policyId":"fixture-policy"}),
                    &now_iso(),
                )
                .unwrap();
            repos.agents().save(&json!({"id":"a","providerId":"fixture","displayName":"Fixture","executable":std::env::var("NAUTILO_TEST_NODE").unwrap_or_else(|_|"node".into()),"baseArgs":[],"enabled":true}),&now_iso()).unwrap();
            repos.sessions().save(&session()).unwrap();
        }
        Self {
            root,
            db,
            runs,
            terminals,
            adapter,
            sessions,
        }
    }
    fn messages(&self) -> Vec<Value> {
        Repositories::new(&self.db.lock().unwrap().raw)
            .sessions()
            .messages("s")
            .unwrap()
    }
    async fn open(&self) -> Value {
        let _guard = self.terminals.lock_session("s").await;
        self.runs
            .open_native_terminal_locked("s", 80, 24)
            .await
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.terminals.close_all();
    }
}

#[tokio::test]
async fn background_history_watch_keeps_syncing_when_terminal_drawer_is_closed() {
    let f = Fixture::new();
    f.open().await;
    *f.adapter.history.lock().unwrap() = snapshot(vec![
        message("watch-user", "user", "native input"),
        message("watch-answer", "assistant", "native reply"),
    ]);
    tokio::time::timeout(std::time::Duration::from_secs(4), async {
        while f.messages().len() != 2 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(f.terminals.owns("s"));
    assert_eq!(f.adapter.opens.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn upgrading_an_unsupported_handoff_backfills_new_native_messages_without_cloning_old_local_history(
) {
    let f = Fixture::new();
    let terminal = f.open().await;
    let gate = f.terminals.lock_session("s").await;
    let mut missed = message("missed-native", "user", "written in native CLI");
    missed["timestampMs"] = json!(chrono::Utc::now().timestamp_millis());
    *f.adapter.history.lock().unwrap() =
        snapshot(vec![message("old-native", "user", "old input"), missed]);
    {
        let db = f.db.lock().unwrap();
        let repo = NativeHistoryRepository::new(&db.raw);
        let mut record = repo.get("s").unwrap().unwrap();
        record["phase"] = json!("unsupported");
        record["supported"] = json!(false);
        record["baseline"] = json!({});
        record["startedAt"] =
            json!((chrono::Utc::now() - chrono::Duration::seconds(30)).to_rfc3339());
        repo.save(&record).unwrap();
        Repositories::new(&db.raw).sessions().save_message(&json!({"id":"old-local","sessionId":"s","sender":"user","text":"old input","createdAt":now_iso()})).unwrap();
    }
    f.terminals
        .stop_and_wait(terminal["id"].as_str().unwrap())
        .await
        .unwrap();
    drop(gate);
    let state = f.runs.reconcile_native_history("s", true).await.unwrap();
    assert_eq!(state["status"], "synced");
    let messages = f.messages();
    assert_eq!(messages.len(), 2);
    assert!(messages.iter().any(|m| m["id"] == "old-local"));
    assert!(messages
        .iter()
        .any(|m| m["nativeIdentity"]["id"] == "missed-native"));
}

#[tokio::test]
async fn live_history_poll_imports_user_and_partial_reply_without_stopping_the_tui() {
    let f = Fixture::new();
    let terminal = f.open().await;
    let mut user = message("u-live", "user", "from native terminal");
    user["turnStatus"] = json!("running");
    let mut answer = message("a-live", "assistant", "prefix");
    answer["completed"] = json!(false);
    answer["turnStatus"] = json!("running");
    let mut history = snapshot(vec![user.clone(), answer.clone()]);
    history["settled"] = json!(false);
    *f.adapter.history.lock().unwrap() = history;
    assert_eq!(
        f.runs.reconcile_native_history("s", true).await.unwrap()["status"],
        "running"
    );
    assert_eq!(f.messages().len(), 2);
    assert!(f.terminals.owns("s"));
    assert_eq!(
        Repositories::new(&f.db.lock().unwrap().raw)
            .runs()
            .list_for_session("s")
            .unwrap()[0]["status"],
        "running"
    );
    user["turnStatus"] = json!("cancelled");
    answer["turnStatus"] = json!("cancelled");
    answer["text"] = json!("retained prefix");
    *f.adapter.history.lock().unwrap() = snapshot(vec![user, answer]);
    f.runs.reconcile_native_history("s", true).await.unwrap();
    f.runs.reconcile_native_history("s", true).await.unwrap();
    assert_eq!(f.messages().len(), 2);
    assert!(f.messages().iter().any(|m| m["text"] == "retained prefix"));
    assert_eq!(
        Repositories::new(&f.db.lock().unwrap().raw)
            .runs()
            .list_for_session("s")
            .unwrap()[0]["status"],
        "cancelled"
    );
    assert_eq!(f.adapter.opens.load(Ordering::SeqCst), 1);
    f.terminals
        .stop_and_wait(terminal["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        f.runs.reconcile_native_history("s", true).await.unwrap()["status"],
        "synced"
    );
    assert!(!f.terminals.owns("s"));
}

#[tokio::test]
async fn native_terminal_exit_import_retry_and_chat_resume_form_one_identity_preserving_flow() {
    let f = Fixture::new();
    let metadata = f.open().await;
    let terminal = metadata["id"].as_str().unwrap();
    assert!(f
        .sessions
        .send(&json!({"sessionId":"s","text":"blocked"}))
        .await
        .is_err());
    assert!(f.messages().is_empty());
    *f.adapter.history.lock().unwrap() = snapshot(vec![
        message("native-user", "user", "from TUI"),
        message("native-answer", "assistant", "native answer"),
    ]);
    f.adapter.fail.store(true, Ordering::SeqCst);
    f.terminals.stop_and_wait(terminal).await.unwrap();
    let failed = f.runs.reconcile_native_history("s", true).await.unwrap();
    assert_eq!(failed["status"], "failed");
    assert!(f.runs.native_terminal_status("s").unwrap()["nativeActive"] == true);
    assert!(f
        .sessions
        .send(&json!({"sessionId":"s","text":"still blocked"}))
        .await
        .is_err());
    assert!(f.messages().is_empty());
    assert_eq!(
        f.open().await["id"],
        metadata["id"],
        "Reopening a failed handoff attaches the retained PTY without spawning another CLI"
    );
    f.adapter.fail.store(false, Ordering::SeqCst);
    assert_eq!(
        f.runs.reconcile_native_history("s", true).await.unwrap()["status"],
        "synced"
    );
    assert_eq!(f.messages().len(), 2);
    f.runs.reconcile_native_history("s", true).await.unwrap();
    assert_eq!(f.messages().len(), 2);
    let result = f
        .sessions
        .send(&json!({"sessionId":"s","text":"continue"}))
        .await
        .unwrap();
    let id = result["runId"].as_str().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if Repositories::new(&f.db.lock().unwrap().raw)
                .runs()
                .get(id)
                .unwrap()
                .is_some_and(|run| run["status"] == "completed")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        *f.adapter.resumes.lock().unwrap(),
        vec![("native".into(), "continue".into())],
        "No transcript is concatenated into a native resume prompt"
    );
    assert_eq!(f.adapter.opens.load(Ordering::SeqCst), 1);
    assert_eq!(f.messages().len(), 4);
    let db = f.db.lock().unwrap();
    let binding = NativeHistoryRepository::new(&db.raw)
        .binding("s", "native", "messages", "continued-user")
        .unwrap()
        .unwrap();
    assert_eq!(
        Repositories::new(&db.raw)
            .sessions()
            .message("s", binding["localId"].as_str().unwrap())
            .unwrap()
            .unwrap()["text"],
        "continue"
    );
    assert!(f.root.starts_with(std::env::temp_dir()));
}

#[tokio::test]
async fn account_or_directory_changes_block_native_import_until_original_identity_is_restored() {
    let f = Fixture::new();
    let metadata = f.open().await;
    let gate = f.terminals.lock_session("s").await;
    f.terminals
        .stop_and_wait(metadata["id"].as_str().unwrap())
        .await
        .unwrap();
    let original = {
        let db = f.db.lock().unwrap();
        let repo = Repositories::new(&db.raw);
        let original = repo.sessions().get("s").unwrap().unwrap();
        let mut changed = original.clone();
        changed["nativeWorkingDirectory"] = json!(f.root.join("other"));
        repo.sessions().save(&changed).unwrap();
        original
    };
    drop(gate);
    assert_eq!(
        f.runs.reconcile_native_history("s", true).await.unwrap()["status"],
        "failed"
    );
    assert!(f.messages().is_empty());
    Repositories::new(&f.db.lock().unwrap().raw)
        .sessions()
        .save(&original)
        .unwrap();
    assert_eq!(
        f.runs.reconcile_native_history("s", true).await.unwrap()["status"],
        "synced"
    );
}

#[tokio::test]
async fn native_cli_launch_and_history_readback_do_not_request_host_approval() {
    let f = Fixture::new();
    {
        let db = f.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        repos
            .policies()
            .save(
                &json!({"id":"fixture-policy","defaultCommandAction":"approval","commandRules":[]}),
                &now_iso(),
            )
            .unwrap();
    }
    assert!(f.runs.native_request("s").is_ok());
    let metadata = f.open().await;
    f.terminals
        .stop_and_wait(metadata["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        f.runs.reconcile_native_history("s", true).await.unwrap()["status"],
        "synced"
    );
    assert!(Repositories::new(&f.db.lock().unwrap().raw)
        .approvals()
        .list(Some("pending"), None)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn live_native_terminal_events_and_import_share_one_run_and_message_identity() {
    let f = Fixture::new();
    let metadata = f.open().await;
    let callback = f.adapter.callback.lock().unwrap().clone().unwrap();
    callback(crate::adapters::event_from_json(
        &json!({"kind":"tool","name":"task","callId":"child-call","phase":"started","input":{"description":"Native child"},"raw":{"nativeTurnId":"turn"}}),
    ));
    callback(crate::adapters::event_from_json(
        &json!({"kind":"message","phase":"completed","messageId":"answer","text":"live native output","raw":{"nativeTurnId":"turn"}}),
    ));
    assert_eq!(f.messages().len(), 1);
    let local = f.messages().remove(0);
    let run_id = local["runId"].as_str().unwrap().to_string();
    assert_eq!(run_id, native_run_id("s", "native", "turn"));
    callback(crate::adapters::event_from_json(
        &json!({"kind":"message","phase":"completed","messageId":"child-answer","subagentDispatchId":"child-call","text":"child output","raw":{}}),
    ));
    assert_eq!(
        f.messages().len(),
        1,
        "Child output must not be imported into the main conversation"
    );
    let mut history = snapshot(vec![
        message("user", "user", "native input"),
        message("answer", "assistant", "live native output"),
    ]);
    history["activities"] = json!([{"id":"tool-part","messageId":"native-assistant","nativeTurnId":"turn","completed":true,"event":{"kind":"tool","name":"task","callId":"child-call","phase":"completed","input":{"description":"Native child"},"output":"done","success":true}}]);
    *f.adapter.history.lock().unwrap() = history;
    f.terminals
        .stop_and_wait(metadata["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        f.runs.reconcile_native_history("s", true).await.unwrap()["status"],
        "synced"
    );
    let messages = f.messages();
    assert_eq!(messages.len(), 2);
    assert!(messages
        .iter()
        .any(|message| message["id"] == local["id"] && message["runId"] == run_id));
    let db = f.db.lock().unwrap();
    let run = Repositories::new(&db.raw)
        .runs()
        .get(&run_id)
        .unwrap()
        .unwrap();
    assert_eq!(run["status"], "completed");
    let origin:String=db.raw.query_row("SELECT run_id FROM runtime_events WHERE json_extract(data,'$.payload.subagentDispatchId')='child-call' AND json_extract(data,'$.type')='agent.message'",[],|row|row.get(0)).unwrap();
    assert_eq!(origin, run_id);
    assert_eq!(
        Repositories::new(&db.raw)
            .runs()
            .list_for_session("s")
            .unwrap()
            .len(),
        1
    );
}
