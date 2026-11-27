use super::*;
use crate::adapters::registry::AdapterRegistry;
use crate::application::session_service::SessionService;
use crate::adapters::{
    AdapterCapabilities, AdapterDetectionResult, AdapterEvent, AdapterResumeRequest, AdapterRun,
    AdapterStartRequest, AgentCliAdapter,
};
use crate::runtime::observability::AuditService;
use crate::runtime::runtime_tool_provider::{
    RuntimeToolBinding, RuntimeToolProvider, RUNTIME_TOOL_SCHEMA_VERSION,
};
use crate::runtime::security::{
    ApprovalService, CommandPolicyService, CredentialService, RedactionService,
};
use std::sync::atomic::{AtomicUsize, Ordering};

#[path = "workspace_tests.rs"]
mod workspace_tests;
#[path = "task_plan_tests.rs"]
mod task_plan_tests;

struct NoOtherTools;
impl RuntimeToolProvider for NoOtherTools {
    fn for_run(&self, _: &Value, _: &Value, _: &Value) -> Option<RuntimeToolBinding> {
        None
    }
}

#[derive(Clone, Copy)]
enum Behavior {
    Submit,
    HoldAfterSubmit,
    FailAfterSubmit,
    OmitFirst,
    Block,
    Structured,
    Background,
}
struct Probe {
    child_turns: AtomicUsize,
    cancellations: Arc<AtomicUsize>,
    calls: Mutex<Vec<(String, Option<String>, String)>>,
    mcp_names: Mutex<Vec<Vec<String>>>,
    background: Mutex<Vec<Arc<dyn Fn(AdapterEvent) + Send + Sync>>>,
    releases: AtomicUsize,
    directories: Mutex<Vec<String>>,
    observations: Arc<Mutex<Vec<String>>>,
}
impl Probe {
    fn turn(&self, request: AdapterStartRequest, native: Option<String>) -> CoreResult<AdapterRun> {
        self.calls.lock().unwrap().push((
            request.local_session_id.clone().unwrap(),
            native.clone(),
            request.prompt.clone(),
        ));
        self.mcp_names.lock().unwrap().push(request.mcp_servers.iter().flatten()
            .filter_map(|server| server["name"].as_str().map(str::to_owned)).collect());
        let child = request
            .runtime_tools
            .as_ref()
            .and_then(Value::as_array)
            .is_some_and(|tools| {
                tools
                    .iter()
                    .any(|t| t["name"] == "agenthub_workflow_submit")
            });
        let turn = if child {
            self.directories.lock().unwrap().push(request.cwd.clone());
            self.child_turns.fetch_add(1, Ordering::SeqCst)
        } else {
            usize::MAX
        };
        let native_background =
            child && request.instance["providerOptions"]["nativeBackground"] == true;
        if native_background {
            self.background.lock().unwrap().push(
                request
                    .session_events
                    .clone()
                    .expect("Resident event callback missing"),
            );
        }
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let cancellations = self.cancellations.clone();
        let observations = self.observations.clone();
        tokio::spawn(async move {
            let _ = tx.send(AdapterEvent::Session {
                provider_session_id: native.unwrap_or_else(|| {
                    format!("native-{}", request.local_session_id.as_deref().unwrap())
                }),
                raw: None,
            });
            if request.prompt.contains("[NAUTILO_WORKFLOW_REFERENCE]") {
                let execute = request.session_tool.as_ref().expect("Resident planning callback missing");
                let context = execute(json!({"name":"agenthub_workflow_plan_context","arguments":{}})).await.unwrap();
                let context: Value = serde_json::from_str(context["content"].as_str().unwrap()).unwrap();
                let member = &context["roster"]["members"][0]["memberId"];
                let nodes = context["nodes"].as_array().unwrap().iter().map(|node| {
                    let key = node["key"].as_str().unwrap();
                    (key.to_owned(), json!({"memberId":member,"task":format!("Evidence for {key}")}))
                }).collect::<serde_json::Map<_, _>>();
                assert!(execute(json!({"name":"agenthub_workflow_run","arguments":{}})).await.is_err());
                let proposal = execute(json!({"name":"agenthub_workflow_propose","arguments":{
                    "summary":"Investigate and cross-check evidence fixture-vault-credential", "inputs":{"question":"Investigate latency"}, "nodes":nodes
                }})).await.unwrap();
                let proposal: Value = serde_json::from_str(proposal["content"].as_str().unwrap()).unwrap();
                assert_eq!(proposal["status"], "pending");
            }
            if child && matches!(request.prompt.as_str(), "") {
                panic!("Node prompt was lost");
            }
            if child && request.instance["providerOptions"]["writeFiles"] == true {
                let instruction = request.prompt.lines().find(|line|line.starts_with("write:") || line.starts_with("read:")).unwrap_or("");
                if let Some(path) = instruction.strip_prefix("write:") {
                    let target = std::path::Path::new(&request.cwd).join(path);
                    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                    std::fs::write(&target, format!("written {path}\n")).unwrap();
                    if request.instance["providerOptions"]["commitFiles"] == true {
                        use crate::runtime::git::git_command::run_git;
                        run_git(&request.cwd, &["add", "-A"], false).await.unwrap();
                        run_git(&request.cwd, &["-c","user.name=Workflow fixture","-c","user.email=workflow@local","commit","-m","Agent's own commit"],false).await.unwrap();
                    }
                } else if let Some(path) = instruction.strip_prefix("read:") {
                    observations.lock().unwrap().push(std::fs::read_to_string(std::path::Path::new(&request.cwd).join(path)).unwrap());
                }
            }
            if child && request.instance["providerOptions"]["block"] == true {
                // Hold this real Run open until RunService invokes cancellation.
                let _ = cancel_rx.await;
                let _ = tx.send(AdapterEvent::Exit {
                    exit_code: None,
                    signal: Some("cancelled".into()),
                });
                return;
            }
            let structured =
                child && request.instance["providerOptions"]["structuredFinal"] == true;
            if child
                && !structured
                && !(request.instance["providerOptions"]["omitFirst"] == true && turn == 0)
            {
                let execute = request
                    .execute_runtime_tool
                    .expect("Workflow tool callback missing");
                let session_execute = request.session_tool.unwrap_or_else(|| execute.clone());
                let scope: Value = serde_json::from_str(
                    request
                        .prompt
                        .rsplit_once("[NAUTILO_WORKFLOW_NODE]\n")
                        .expect("Authoritative workflow scope missing")
                        .1
                        .lines()
                        .next()
                        .unwrap(),
                )
                .unwrap();
                let args = json!({"name":"agenthub_workflow_submit","arguments":{"instanceId":scope["instanceId"],"attempt":scope["attempt"],"branch":"完成","result":{"summary":"verified evidence"}}});
                let receipt = execute(args.clone()).await.unwrap();
                assert_eq!(receipt["success"], true);
                assert_eq!(
                    serde_json::from_str::<Value>(receipt["content"].as_str().unwrap()).unwrap()
                        ["accepted"],
                    true
                );
                let duplicate = session_execute(args).await.unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(duplicate["content"].as_str().unwrap()).unwrap()
                        ["duplicate"],
                    true
                );
            }
            if native_background {
                let _ = tx.send(native_child_event("running"));
            }
            let after_submit = request.instance["providerOptions"]["afterSubmit"].as_str();
            if child && matches!(after_submit, Some("cancel" | "error")) {
                let message = if after_submit == Some("cancel") {
                    cancel_rx.await.unwrap();
                    r#"502: {"code":"NATIVE_ACCOUNT_ERROR","message":"Codex account request cancelled"}"#
                } else {
                    "Fixture upstream model request failed"
                };
                let _ = tx.send(AdapterEvent::Error { message: message.into() });
                let _ = tx.send(AdapterEvent::Exit {
                    exit_code: Some(1),
                    signal: None,
                });
                return;
            }
            let _ = tx.send(AdapterEvent::Message {
                text: if structured {
                    json!({"branch":"完成","result":{"summary":"structured evidence"}}).to_string()
                } else {
                    "done".into()
                },
                phase: Some("completed".into()),
                message_id: None,
                subagent_dispatch_id: None,
                raw: None,
            });
            let _ = tx.send(AdapterEvent::Exit {
                exit_code: Some(0),
                signal: None,
            });
        });
        Ok(AdapterRun::new(
            rx,
            move || {
                Box::pin(async move {
                    cancellations.fetch_add(1, Ordering::SeqCst);
                    let _ = cancel_tx.send(());
                })
            },
            |_| {},
        ))
    }
}
#[async_trait::async_trait]
impl AgentCliAdapter for Probe {
    async fn native_resources(&self, _instance: &Value, _cwd: &str, _session: &Value) -> CoreResult<Vec<Value>> {
        Ok(vec![json!({"id":"native:skill:ledger","kind":"skill","name":"Ledger guide","enabled":true,
            "skill":{"instructions":"Check native ledger currency."}})])
    }
    fn provider_id(&self) -> &str {
        "workflow-fixture"
    }
    fn descriptor(&self) -> Value {
        json!({"id":self.provider_id()})
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
        panic!("No external CLI is used by this integration fixture")
    }
    fn start(&self, request: AdapterStartRequest) -> CoreResult<AdapterRun> {
        self.turn(request, None)
    }
    fn resume(&self, request: AdapterResumeRequest) -> CoreResult<AdapterRun> {
        self.turn(request.start, Some(request.provider_session_id))
    }
    async fn release_session(&self, _: &AdapterStartRequest) -> CoreResult<()> {
        self.releases.fetch_add(1, Ordering::SeqCst);
        for callback in self.background.lock().unwrap().drain(..) {
            callback(AdapterEvent::Exit {
                exit_code: Some(0),
                signal: None,
            });
        }
        Ok(())
    }
}

struct AlternateProbe(Arc<Probe>);

#[async_trait::async_trait]
impl AgentCliAdapter for AlternateProbe {
    fn provider_id(&self) -> &str { "workflow-fixture-alt" }
    fn descriptor(&self) -> Value { json!({"id":self.provider_id()}) }
    fn capabilities(&self) -> AdapterCapabilities { self.0.capabilities() }
    async fn detect(&self, instance: &Value) -> AdapterDetectionResult { self.0.detect(instance).await }
    fn start(&self, request: AdapterStartRequest) -> CoreResult<AdapterRun> { self.0.start(request) }
    fn resume(&self, request: AdapterResumeRequest) -> CoreResult<AdapterRun> { self.0.resume(request) }
}
fn native_child_event(status: &str) -> AdapterEvent {
    AdapterEvent::Tool {
        call_id: Some("native-dispatch".into()),
        name: "spawn_agent".into(),
        phase: Some("completed".into()),
        input: Some(
            json!({"description":"Native nested task","receiverThreadIds":["native-child"],"agentsStates":{"native-child":{"status":status}}}),
        ),
        output: None,
        success: Some(true),
        file_diff: None,
        subagent_dispatch_id: None,
        raw: None,
    }
}

struct Fixture {
    root: std::path::PathBuf,
    db: Arc<Mutex<Database>>,
    service: Arc<WorkflowService>,
    probe: Arc<Probe>,
    git_test_slot: Mutex<Option<tokio::sync::OwnedSemaphorePermit>>,
}
impl Fixture {
    fn new(behavior: Behavior, approval: bool) -> Self {
        let root = std::env::var_os("NAUTILO_WORKFLOW_TEST_ROOT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("nautilo-workflow-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let db = Arc::new(Mutex::new(
            Database::open(&root.join("core.sqlite")).unwrap(),
        ));
        let probe = Arc::new(Probe {
            child_turns: AtomicUsize::new(0),
            cancellations: Arc::new(AtomicUsize::new(0)),
            calls: Mutex::new(Vec::new()),
            mcp_names: Mutex::new(Vec::new()),
            background: Mutex::new(Vec::new()),
            releases: AtomicUsize::new(0),
            directories: Mutex::new(Vec::new()),
            observations: Arc::new(Mutex::new(Vec::new())),
        });
        let registry = AdapterRegistry::default();
        registry.register(probe.clone());
        registry.register(Arc::new(AlternateProbe(probe.clone())));
        let credentials = Arc::new(CredentialService::new(db.clone(), &root));
        let redaction_credentials = credentials.clone();
        let redaction = RedactionService::new(Arc::new(move || redaction_credentials.secret_values()));
        let events = Arc::new(EventService::new(db.clone(), redaction.clone()));
        let policies = Arc::new(CommandPolicyService::new(db.clone()).unwrap());
        policies.save(&json!({"id":"workflow-test","defaultCommandAction":"safe","commandRules":[{"id":"fixture","executable":"node","action":"safe"}]})).unwrap();
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
        let service = WorkflowService::new(db.clone(), runs.clone(), events);
        runs.set_runtime_tool_provider(Arc::new(tools::WorkflowToolProvider {
            workflows: Arc::downgrade(&service),
            fallback: Arc::new(NoOtherTools),
        }));
        {
            let db = db.lock().unwrap();
            let repos = Repositories::new(&db.raw);
            repos
                .projects()
                .save(
                    &json!({"id":"project","rootPath":root,"policyId":"workflow-test"}),
                    &now_iso(),
                )
                .unwrap();
            let after_submit = match behavior {
                Behavior::HoldAfterSubmit => Some("cancel"),
                Behavior::FailAfterSubmit => Some("error"),
                _ => None,
            };
            repos.agents().save(&json!({"id":"agent","providerId":"workflow-fixture","displayName":"Test Agent","enabled":true,"executable":"node","baseArgs":[],"env":{"API_KEY":"fixture-secret"},"providerOptions":{"omitFirst":matches!(behavior,Behavior::OmitFirst),"block":matches!(behavior,Behavior::Block),"structuredFinal":matches!(behavior,Behavior::Structured),"nativeBackground":matches!(behavior,Behavior::Background),"afterSubmit":after_submit}}), &now_iso()).unwrap();
            if approval {
                repos.teams().save(&json!({"id":"team","delegationPolicy":"ask_before_delegate","members":[],"roles":[]}), &now_iso()).unwrap();
            }
            repos.sessions().save(&json!({"id":"main-session","projectId":"project","memberId":"main","agentInstanceId":"agent","teamId":if approval{json!("team")}else{Value::Null},"status":"idle","providerSessionId":"main-native","runtimeToolVersion":RUNTIME_TOOL_SCHEMA_VERSION,"createdAt":now_iso(),"updatedAt":now_iso()})).unwrap();
        }
        Self {
            root,
            db,
            service,
            probe,
            git_test_slot: Mutex::new(None),
        }
    }
    fn start(&self) -> WorkflowRun {
        let input = json!({"sessionId":"main-session","requestId":"launch-1","definition":simple_definition(),"inputs":{"question":"investigate"},"bindings":{"Explorer":{"agentInstanceId":"agent"}}});
        let first = self.service.start(&input).unwrap();
        assert_eq!(first["id"], self.service.start(&input).unwrap()["id"]);
        assert!(first["bindings"]["Explorer"].get("agentSnapshot").is_none());
        assert!(!first.to_string().contains("fixture-secret"));
        self.service.get(first["id"].as_str().unwrap()).unwrap()
    }
    async fn until(&self, id: &str, predicate: impl Fn(&WorkflowRun) -> bool) -> WorkflowRun {
        for _ in 0..500 {
            self.service.drive(id).await.unwrap();
            let run = self.service.get(id).unwrap();
            for child in run
                .instances
                .iter()
                .filter_map(|i| i.child_run_id.as_deref())
            {
                self.service.drive(child).await.unwrap();
            }
            if predicate(&run) {
                return run;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!(
            "Workflow did not reach the expected state: {}",
            json!(self.service.get(id).unwrap())
        );
    }
}

#[tokio::test]
async fn composer_references_reach_the_harness_only_on_the_selected_turn() {
    let fixture = Fixture::new(Behavior::Submit, false);
    {
        let db = fixture.db.lock().unwrap();
        let capabilities = Repositories::new(&db.raw).capabilities();
        capabilities.save(&json!({"id":"pdf","kind":"skill","name":"PDF","enabled":false,
            "providerIds":[],"skill":{"instructions":"Check ledger subtotals before totaling."}}), &now_iso()).unwrap();
        capabilities.save(&json!({"id":"ledger","kind":"mcp","name":"Ledger","enabled":true,
            "providerIds":["workflow-fixture"],"mcp":{"transport":"http","url":"http://127.0.0.1:43121/mcp"}}), &now_iso()).unwrap();
        capabilities.save(&json!({"id":"other","kind":"mcp","name":"Another Harness","enabled":true,
            "providerIds":["workflow-fixture-alt"],"mcp":{"transport":"http","url":"http://127.0.0.1:43121/mcp"}}), &now_iso()).unwrap();
    }
    let sessions = SessionService::new(fixture.db.clone());
    sessions.set_run_pipeline(fixture.service.runs.clone(), fixture.service.events.clone());
    let catalog = fixture.service.runs.composer_catalog(&json!({"sessionId":"main-session"})).await.unwrap();
    assert_eq!(catalog.iter().map(|item|item["id"].as_str().unwrap()).collect::<Vec<_>>(), ["ledger", "native:skill:ledger"]);
    let error = sessions.send(&json!({"sessionId":"main-session","messageId":"rejected","text":"Check the invoice",
        "references":[{"kind":"skill","id":"pdf"}]})).await.unwrap_err();
    assert!(error.to_string().contains("no longer available"));
    for (id, references) in [("attached", json!([
        {"kind":"skill","id":"native:skill:ledger","name":"Untrusted renderer label"},
        {"kind":"mcp","id":"ledger","tool":"read_invoice"},
        {"kind":"mcp","id":"ledger","tool":"read_invoice"}
    ])), ("plain", Value::Null)] {
        sessions.send(&json!({"sessionId":"main-session","messageId":id,"text":"Check the invoice","references":references})).await.unwrap();
        for _ in 0..200 {
            if !fixture.service.runs.session_busy("main-session") { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
    let calls = fixture.probe.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert!(calls[0].2.contains("Check native ledger currency."));
    assert!(calls[0].2.contains("read_invoice"));
    assert!(!calls[1].2.contains("NAUTILO_COMPOSER_REFERENCES"));
    let names = fixture.probe.mcp_names.lock().unwrap();
    assert!(names[0].iter().any(|name| name.eq_ignore_ascii_case("ledger")));
    assert_eq!(names[0], names[1], "referencing an enabled service never changes the startup configuration");
    let db = fixture.db.lock().unwrap();
    let repos = Repositories::new(&db.raw);
    let message = repos.sessions().message("main-session", "attached").unwrap().unwrap();
    assert_eq!(message["references"], json!([
        {"kind":"skill","id":"native:skill:ledger","name":"Ledger guide"},
        {"kind":"mcp","id":"ledger","name":"Ledger","tool":"read_invoice"}
    ]));
    assert_eq!(repos.capabilities().get("pdf").unwrap().unwrap()["enabled"], false);
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // This test owns its UUID directory. The runtime drops open SQLite
        // handles afterward, so a failed removal on Windows is harmless.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn simple_definition() -> Value {
    json!({"schemaVersion":1,"id":"simple","entry":"main","inputs":{"question":"text"},"nodes":[{"id":"main","kind":"main","exits":[{"id":"go","name":"开始"}]},{"id":"explore","kind":"agent","role":"Explorer","prompt":"调查 {{input.question}}","outputs":{"summary":"text"},"submissionPolicy":{"graceMs":0,"reminderIntervalMs":100,"timeoutMs":2000,"maxReminders":1},"exits":[{"id":"done","name":"完成"}]}],"edges":[{"from":["main","go"],"to":"explore"},{"from":["explore","done"],"to":"$return"}]})
}

#[tokio::test]
async fn workflow_conversation_plan_waits_for_review_and_executes_the_edited_nested_assignment() {
    use crate::application::session_service::SessionService;
    use crate::database::workflow_plans;

    let fixture = Fixture::new(Behavior::Submit, true);
    CredentialService::new(fixture.db.clone(), &fixture.root)
        .set("agent", &json!({"apiKey":"fixture-vault-credential"}))
        .unwrap();
    {
        let db = fixture.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        repos.teams().save(&json!({
            "id":"team","delegationPolicy":"ask_before_delegate",
            "members":[{"id":"worker","displayName":"Explorer","agentInstanceId":"agent","enabled":true,"roleId":"explorer"}],
            "roles":[{"id":"explorer","name":"Explorer"}]
        }), &now_iso()).unwrap();
        repos.agents().save(&json!({
            "id":"alternate","providerId":"workflow-fixture-alt","displayName":"Alternate Harness",
            "enabled":true,"executable":"node","models":[{"id":"review-model","enabled":true}]
        }), &now_iso()).unwrap();
    }
    fixture.service.save_template(&json!({
        "id":"nested","name":"Independent review","revision":0,
        "definition":simple_definition(),"layout":{"nodes":{}}
    })).unwrap();
    let mut definition = simple_definition();
    definition["nodes"].as_array_mut().unwrap().push(json!({
        "id":"review","kind":"call","name":"Independent review","ref":{"id":"nested","revision":1},
        "input":{"question":"{{input.question}}"},"exitMap":{"完成":"done"},
        "exits":[{"id":"done","name":"完成"}]
    }));
    definition["edges"][1]["to"] = json!("review");
    definition["edges"].as_array_mut().unwrap().push(json!({"from":["review","done"],"to":"$return"}));
    fixture.service.save_template(&json!({
        "id":"saved","name":"Latency investigation","revision":0,"definition":definition,"layout":{"nodes":{}}
    })).unwrap();

    let sessions = SessionService::new(fixture.db.clone());
    sessions.set_run_pipeline(fixture.service.runs.clone(), fixture.service.events.clone());
    let make_plan = |message_id: &str| {
        let request = json!({
            "sessionId":"main-session","text":"Investigate latency","messageId":message_id,
            "workflowRef":{"id":"saved","revision":1}
        });
        let sessions = &sessions;
        let fixture = &fixture;
        async move {
            let launched = sessions.send(&request).await.unwrap();
            let id = launched["runId"].as_str().unwrap();
            for _ in 0..300 {
                let plan = workflow_plans::get(&fixture.db.lock().unwrap().raw, "main-session", id).unwrap();
                if let Some(plan) = plan.filter(|_| !fixture.service.runs.session_busy("main-session")) {
                    return plan;
                }
                tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            }
            panic!("No durable plan from the main Agent");
        }
    };
    let plan_card = |id: &Value| {
        let timeline = fixture.service.events.timeline_open("main-session").unwrap();
        let mut matching = timeline["blocks"].as_array().unwrap().iter()
            .filter(|block| block["content"]["payload"]["plan"]["id"] == *id);
        let card = matching.next().expect("The plan has a timeline block");
        assert!(matching.next().is_none(), "A plan has one timeline block");
        card.clone()
    };
    let rejected = make_plan("first").await;
    assert_eq!(rejected["status"], "pending");
    let event = fixture.service.events.replay(Some("main-session"), None, None, None).unwrap()
        .into_iter().find(|event| event["type"] == "workflow.plan" && event["payload"]["plan"]["id"] == rejected["id"])
        .expect("The plan and its event must both be committed");
    assert_eq!(event["payload"]["plan"]["summary"], "Investigate and cross-check evidence [REDACTED]");
    assert_eq!(rejected["nodes"][1]["key"], "review/explore");
    assert_eq!(rejected["nodes"][1]["memberName"], "Explorer");
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 0);
    assert!(workflows::list(&fixture.db.lock().unwrap().raw, Some("main-session"), false).unwrap().is_empty());
    let pending_rejection = plan_card(&rejected["id"]);
    assert_eq!(fixture.service.decide_plan(&json!({
        "sessionId":"main-session","planId":rejected["id"],"action":"reject"
    })).unwrap()["status"], "rejected");
    let rejected_card = plan_card(&rejected["id"]);
    assert_eq!(rejected_card["blockId"], pending_rejection["blockId"]);
    assert_eq!(rejected_card["result"]["payload"]["plan"]["status"], "rejected");
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 0);

    let pending = make_plan("second").await;
    fixture.service.save_template(&json!({
        "id":"saved","name":"Edited template","revision":1,"definition":simple_definition(),"layout":{"nodes":{}}
    })).unwrap();
    let approval = json!({
        "sessionId":"main-session","planId":pending["id"],"action":"approve",
        "assignments":{"review/explore":{"agentInstanceId":"alternate","model":"review-model","connectionId":null}}
    });
    let pending_card = plan_card(&pending["id"]);
    let revision = fixture.service.events.timeline_open("main-session").unwrap()["revision"].as_i64().unwrap();
    let confirmed = fixture.service.decide_plan(&approval).unwrap();
    assert_eq!(confirmed["status"], "approved");
    let approved_card = plan_card(&pending["id"]);
    assert_eq!(approved_card["blockId"], pending_card["blockId"]);
    assert_eq!(approved_card["seq"], pending_card["seq"]);
    assert_eq!(approved_card["result"]["payload"]["plan"]["runId"], confirmed["runId"]);
    let changes = crate::database::timeline::changes(&fixture.db.lock().unwrap().raw, "main-session", revision).unwrap();
    assert!(changes["changes"].as_array().unwrap().iter().any(|batch| {
        batch["operations"].as_array().unwrap().iter().any(|operation| {
            operation["type"] == "block_updated" && operation["blockId"] == pending_card["blockId"]
                && operation["status"] == "approved"
        })
    }));
    let events = fixture.service.events.replay(Some("main-session"), None, None, None).unwrap();
    assert_eq!(events.iter().filter(|event| event["type"] == "workflow.plan" && event["payload"]["plan"]["id"] == pending["id"]).count(), 1);
    assert_eq!(confirmed["template"]["revision"], 1);
    assert_eq!(confirmed["nodes"][0]["assignment"]["agentInstanceId"], "agent");
    assert_eq!(confirmed["nodes"][1]["assignment"]["agentInstanceId"], "alternate");
    assert_eq!(confirmed["runId"], fixture.service.decide_plan(&approval).unwrap()["runId"]);
    let run_id = confirmed["runId"].as_str().unwrap();
    assert!(fixture.service.get(run_id).unwrap().approval_id.is_none());
    let finished = fixture.until(run_id, |run| run.status == "completed").await;
    let child = finished.instances.iter().find_map(|node| node.child_run_id.as_ref()).unwrap();
    let child = fixture.service.get(child).unwrap();
    let execution = child.instances.iter().find(|node| node.node_id == "explore").unwrap();
    let db = fixture.db.lock().unwrap();
    let repos = Repositories::new(&db.raw);
    let session = repos.sessions().get(execution.session_id.as_deref().unwrap()).unwrap().unwrap();
    assert_eq!(session["memberId"], "worker");
    assert_eq!(session["agentInstanceId"], "alternate");
    assert_eq!(session["model"], "review-model");
    assert!(execution.prompt.as_deref().unwrap().contains("Evidence for review/explore"));
    assert_eq!(repos.sessions().message("main-session", "second").unwrap().unwrap()["workflowRef"]["revision"], 1);
    assert_eq!(workflows::list(&db.raw, Some("main-session"), false).unwrap().len(), 2);
}

#[tokio::test]
async fn workflow_service_resumes_the_original_main_once_with_completed_results() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let run = fixture.start();
    let done = fixture
        .until(&run.id, |r| {
            r.status == "completed" && r.messages.iter().all(|m| m.status == "delivered")
                && !fixture.service.runs.session_busy("main-session")
        })
        .await;
    assert_eq!(
        done.instances
            .iter()
            .filter(|i| i.node_id == "explore")
            .count(),
        1
    );
    assert_eq!(
        done.events
            .iter()
            .filter(|e| e.r#type == "node.completed")
            .count(),
        1
    );
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 1);
    let calls = fixture.probe.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    let (session, native, prompt) = calls.iter().find(|call| call.0 == "main-session").unwrap();
    assert_eq!(session, "main-session");
    assert_eq!(native.as_deref(), Some("main-native"));
    assert!(prompt.contains("answer the original user request") && prompt.contains("verified evidence"));
    drop(calls);
    fixture.service.drive(&run.id).await.unwrap();
    assert_eq!(fixture.probe.calls.lock().unwrap().len(), 2, "the handoff is delivered once");
    let db = fixture.db.lock().unwrap();
    let receipts = Repositories::new(&db.raw).sessions().messages("main-session").unwrap();
    assert_eq!(receipts.iter().filter(|message| {
        message["kind"] == "result" && message["text"].as_str().unwrap_or("").contains("verified evidence")
    }).count(), 1);
    let return_run = done.messages[0].run_id.as_deref().unwrap();
    assert!(receipts.iter().any(|message| message["sender"] == "agent" && message["runId"] == return_run));
}

#[tokio::test]
async fn workflow_stops_the_provider_after_acceptance_and_returns_the_result() {
    let fixture = Fixture::new(Behavior::HoldAfterSubmit, false);
    let run = fixture.start();
    let done = fixture.until(&run.id, |run| {
        (run.status == "completed" && run.messages.iter().all(|message| message.status == "delivered")
            && !fixture.service.runs.session_busy("main-session"))
            || run.instances.iter().any(|instance| matches!(instance.status.as_str(), "failed" | "waiting_retry"))
    }).await;
    let child = done.instances.iter().find(|instance| instance.node_id == "explore").unwrap();
    assert_eq!(done.status, "completed", "{:?}", child.error);
    assert_eq!(fixture.probe.cancellations.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.probe.releases.load(Ordering::SeqCst), 0);
    assert_eq!(child.result.as_ref().unwrap()["summary"], "verified evidence");
    let db = fixture.db.lock().unwrap();
    let repos = Repositories::new(&db.raw);
    let child_run = repos.runs().get(child.run_id.as_deref().unwrap()).unwrap().unwrap();
    assert_eq!(child_run["status"], "completed");
    let events = repos.events().replay(None, None, child.run_id.as_deref(), None).unwrap();
    assert!(events.iter().all(|event| event["type"] != "run.failed"));
    let child_session = child.session_id.as_deref().unwrap();
    let session = repos.sessions().get(child_session).unwrap().unwrap();
    assert_eq!(session["providerSessionId"], format!("native-{child_session}"));
    assert!(fixture.probe.calls.lock().unwrap().iter().any(|call| {
        call.0 == "main-session" && call.1.as_deref() == Some("main-native") && call.2.contains("verified evidence")
    }));
}

#[tokio::test]
async fn workflow_reports_provider_failure_before_intentional_stop_even_with_a_submission() {
    let fixture = Fixture::new(Behavior::FailAfterSubmit, false);
    let run = fixture.start();
    let failed = fixture.until(&run.id, |run| run.status == "needs_decision").await;
    let child = failed.instances.iter().find(|instance| instance.node_id == "explore").unwrap();
    assert_eq!(child.result.as_ref().unwrap()["summary"], "verified evidence");
    assert_eq!(child.status, "failed");
    assert_eq!(fixture.probe.cancellations.load(Ordering::SeqCst), 0);

    let db = fixture.db.lock().unwrap();
    let events = Repositories::new(&db.raw).events().replay(None, None, child.run_id.as_deref(), None).unwrap();
    assert!(events.iter().any(|event| event["type"] == "run.failed"
        && event["payload"]["message"] == "Fixture upstream model request failed"));
}

#[tokio::test]
async fn workflow_service_proactively_resumes_original_child_for_a_missing_submission() {
    let fixture = Fixture::new(Behavior::OmitFirst, false);
    let run = fixture.start();
    let done = fixture
        .until(&run.id, |r| {
            r.status == "completed"
                && r.messages
                    .iter()
                    .all(|m| ["delivered", "resolved"].contains(&m.status.as_str()))
        })
        .await;
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 2);
    let child = done
        .instances
        .iter()
        .find(|i| i.node_id == "explore")
        .unwrap();
    let message = done
        .messages
        .iter()
        .find(|m| m.recipient == "child")
        .unwrap();
    assert_eq!(message.status, "resolved");
    assert_eq!(message.session_id, child.session_id);
    let calls = fixture.probe.calls.lock().unwrap();
    let child_calls: Vec<_> = calls
        .iter()
        .filter(|c| Some(&c.0) == child.session_id.as_ref())
        .collect();
    assert_eq!(child_calls.len(), 2);
    assert_eq!(
        child_calls[1].1.as_deref(),
        Some(format!("native-{}", child_calls[0].0).as_str())
    );
}

#[tokio::test]
async fn workflow_service_cancellation_is_reconciled_after_terminal_projection_is_saved() {
    let fixture = Fixture::new(Behavior::Block, false);
    let run = fixture.start();
    fixture
        .until(&run.id, |r| {
            r.instances
                .iter()
                .any(|i| i.status == "running" && i.run_id.is_some())
        })
        .await;
    fixture
        .service
        .control(&json!({"runId":run.id,"action":"cancel"}))
        .unwrap();
    assert!(workflows::pending(&fixture.db.lock().unwrap().raw)
        .unwrap()
        .contains(&run.id));
    fixture
        .until(&run.id, |_| {
            fixture.probe.cancellations.load(Ordering::SeqCst) == 1
        })
        .await;
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.service.get(&run.id).unwrap().status, "cancelled");
}

#[tokio::test]
async fn workflow_service_honors_delegation_approval_before_starting_any_agent() {
    let fixture = Fixture::new(Behavior::Submit, true);
    let run = fixture.start();
    assert_eq!(run.status, "paused");
    assert!(run.approval_id.is_some());
    fixture.service.drive(&run.id).await.unwrap();
    assert!(fixture.probe.calls.lock().unwrap().is_empty());
    assert!(fixture
        .service
        .control(&json!({"runId":run.id,"action":"resume"}))
        .is_err());
    fixture
        .service
        .control(&json!({"runId":run.id,"action":"approve"}))
        .unwrap();
    fixture.until(&run.id, |r| r.status == "completed").await;
}

#[tokio::test]
async fn workflow_service_restart_reconciles_saved_execution_without_dispatching_again() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let run = fixture.start();
    let instance = run
        .instances
        .iter()
        .find(|i| i.node_id == "explore")
        .unwrap()
        .id
        .clone();
    fixture
        .service
        .change(&run.id, |r| {
            let i = r.instances.iter_mut().find(|i| i.id == instance).unwrap();
            i.status = "starting".into();
            i.session_id = Some("saved-child".into());
            r.submit(
                &instance,
                1,
                &["完成".into()],
                json!({"summary":"before restart"}),
                now(),
            )
            .map(|_| ())
        })
        .unwrap();
    Repositories::new(&fixture.db.lock().unwrap().raw).runs().save(&json!({"id":"saved-run","sessionId":"saved-child","status":"completed","workflow":{"runId":run.id,"instanceId":instance,"attempt":1},"updatedAt":now_iso()})).unwrap();
    let recovered = WorkflowService::new(
        fixture.db.clone(),
        fixture.service.runs.clone(),
        fixture.service.events.clone(),
    );
    recovered.drive(&run.id).await.unwrap();
    assert_eq!(recovered.get(&run.id).unwrap().status, "completed");
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn workflow_service_keeps_launch_approval_pending_and_reuses_its_original_session() {
    let fixture = Fixture::new(Behavior::Submit, false);
    CommandPolicyService::new(fixture.db.clone()).unwrap().save(&json!({"id":"workflow-test","defaultCommandAction":"approval","commandRules":[{"id":"fixture","executable":"node","action":"approval"}]})).unwrap();
    let run = fixture.start();
    let waiting = fixture
        .until(&run.id, |r| {
            r.instances.iter().any(|i| i.status == "waiting_approval")
        })
        .await;
    assert!(fixture.probe.calls.lock().unwrap().is_empty());
    let instance = waiting
        .instances
        .iter()
        .find(|i| i.status == "waiting_approval")
        .unwrap();
    let original_session = instance.session_id.clone();
    ApprovalService::new(fixture.db.clone())
        .resolve(
            instance.approval_id.as_deref().unwrap(),
            "approved",
            &json!("once"),
        )
        .unwrap();
    let completed = fixture.until(&run.id, |r| r.status == "completed").await;
    assert_eq!(
        completed
            .instances
            .iter()
            .find(|i| i.node_id == "explore")
            .unwrap()
            .session_id,
        original_session
    );
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn workflow_service_launches_a_pinned_template_and_keeps_its_layout_snapshot() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let layout = json!({"nodes":{"main":{"x":10,"y":20},"explore":{"x":300,"y":20}}});
    fixture.service.save_template(&json!({"id":"template","revision":0,"name":"Reusable exploration","definition":simple_definition(),"layout":layout})).unwrap();
    let input = json!({"sessionId":"main-session","requestId":"pinned-template","ref":{"id":"template","revision":1},"inputs":{"question":"investigate"},"bindings":{"Explorer":{"agentInstanceId":"agent"}}});
    let launched = fixture.service.start(&input).unwrap();
    assert_eq!(launched["layout"], layout);
    fixture
        .until(launched["id"].as_str().unwrap(), |r| {
            r.status == "completed"
        })
        .await;
    let mut conflict = input;
    conflict["inputs"]["question"] = json!("different task");
    assert!(fixture.service.start(&conflict).is_err());
}

#[tokio::test]
async fn workflow_service_nested_template_obeys_parent_pause_and_the_final_depth_level() {
    let fixture = Fixture::new(Behavior::Submit, false);
    fixture.service.save_template(&json!({"id":"child","revision":0,"name":"Child","definition":simple_definition(),"layout":{"nodes":{}}})).unwrap();
    let definition = json!({"schemaVersion":1,"id":"parent","entry":"main","inputs":{"question":"text"},"limits":{"maxDepth":1},"nodes":[{"id":"main","kind":"main","exits":[{"id":"go","name":"开始"}]},{"id":"child-call","kind":"call","ref":{"id":"child","revision":1},"input":{"question":"{{input.question}}"},"exitMap":{"完成":"done"},"exits":[{"id":"done","name":"完成"}]}],"edges":[{"from":["main","go"],"to":"child-call"},{"from":["child-call","done"],"to":"$return"}]});
    let launched=fixture.service.start(&json!({"sessionId":"main-session","requestId":"parent-launch","definition":definition,"inputs":{"question":"nested investigation"},"bindings":{"Explorer":{"agentInstanceId":"agent"}}})).unwrap();
    let id = launched["id"].as_str().unwrap();
    fixture.service.drive(id).await.unwrap();
    let parent = fixture.service.get(id).unwrap();
    let child = parent
        .instances
        .iter()
        .find_map(|i| i.child_run_id.as_ref())
        .unwrap();
    assert_eq!(
        fixture
            .service
            .get(child)
            .unwrap()
            .definition
            .limits
            .max_depth,
        0
    );
    fixture
        .service
        .control(&json!({"runId":id,"action":"pause"}))
        .unwrap();
    assert_eq!(fixture.service.get(child).unwrap().status, "paused");
    fixture.service.drive(child).await.unwrap();
    assert!(fixture.probe.calls.lock().unwrap().is_empty());
    fixture
        .service
        .control(&json!({"runId":id,"action":"resume"}))
        .unwrap();
    fixture.until(id, |r| r.status == "completed").await;
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn workflow_service_parallel_subworkflows_share_the_parent_concurrency_budget() {
    let fixture = Fixture::new(Behavior::Block, false);
    let mut child = simple_definition();
    child["nodes"][0]["exits"] = json!([{"id":"a","name":"第一路"},{"id":"b","name":"第二路"}]);
    let mut sibling = child["nodes"][1].clone();
    sibling["id"] = json!("other");
    child["nodes"].as_array_mut().unwrap().push(sibling);
    child["edges"] = json!([{"from":["main","a"],"to":"explore"},{"from":["main","b"],"to":"other"},{"from":["explore","done"],"to":"$return"},{"from":["other","done"],"to":"$return"}]);
    fixture.service.save_template(&json!({"id":"parallel-child","revision":0,"name":"Parallel child","definition":child,"layout":{"nodes":{}}})).unwrap();
    let call = |id: &str| json!({"id":id,"kind":"call","ref":{"id":"parallel-child","revision":1},"input":{"question":"{{input.question}}"},"exitMap":{"完成":"done"},"exits":[{"id":"done","name":"完成"}]});
    let definition = json!({"schemaVersion":1,"id":"family","entry":"main","limits":{"maxParallel":2},"inputs":{"question":"text"},"nodes":[{"id":"main","kind":"main","exits":[{"id":"a","name":"子图一"},{"id":"b","name":"子图二"}]},call("a"),call("b")],"edges":[{"from":["main","a"],"to":"a"},{"from":["main","b"],"to":"b"},{"from":["a","done"],"to":"$return"},{"from":["b","done"],"to":"$return"}]});
    let launched=fixture.service.start(&json!({"sessionId":"main-session","requestId":"parallel-family","definition":definition,"inputs":{"question":"shared budget"},"bindings":{"Explorer":{"agentInstanceId":"agent"}}})).unwrap();
    let id = launched["id"].as_str().unwrap();
    let run = fixture
        .until(id, |_| {
            fixture.probe.child_turns.load(Ordering::SeqCst) == 2
        })
        .await;
    for _ in 0..4 {
        fixture.service.drive(id).await.unwrap();
        for child in run
            .instances
            .iter()
            .filter_map(|i| i.child_run_id.as_deref())
        {
            fixture.service.drive(child).await.unwrap();
        }
    }
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 2);
    assert_eq!(
        workflows::family_budget(&fixture.db.lock().unwrap().raw, id)
            .unwrap()
            .active,
        2
    );
    fixture
        .service
        .control(&json!({"runId":id,"action":"cancel"}))
        .unwrap();
    fixture
        .until(id, |_| {
            fixture.probe.cancellations.load(Ordering::SeqCst) == 2
        })
        .await;
}

#[tokio::test]
async fn workflow_service_accepts_an_explicit_structured_final_through_the_real_pipeline() {
    let fixture = Fixture::new(Behavior::Structured, false);
    let mut definition = simple_definition();
    definition["nodes"][1]["completion"] = json!("structured_final");
    let launched=fixture.service.start(&json!({"sessionId":"main-session","requestId":"structured-final","definition":definition,"inputs":{"question":"use final JSON"},"bindings":{"Explorer":{"agentInstanceId":"agent"}}})).unwrap();
    let run = fixture
        .until(launched["id"].as_str().unwrap(), |r| {
            r.status == "completed"
        })
        .await;
    let instance = run
        .instances
        .iter()
        .find(|i| i.node_id == "explore")
        .unwrap();
    assert_eq!(
        instance.result.as_ref().unwrap()["summary"],
        "structured evidence"
    );
    assert!(instance.last_output.as_ref().unwrap().contains("branch"));
    assert!(fixture.probe.calls.lock().unwrap()[0]
        .2
        .contains("exactly one JSON object"));
}

#[tokio::test]
async fn workflow_tools_publish_real_binding_ids_and_hide_credentials_and_other_conversations() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let provider = tools::WorkflowToolProvider {
        workflows: Arc::downgrade(&fixture.service),
        fallback: Arc::new(NoOtherTools),
    };
    let binding = provider
        .for_run(&json!({"id":"main-session"}), &json!({}), &json!({}))
        .unwrap();
    let response = (binding.execute)(json!({"name":"agenthub_workflow_agents","arguments":{}}))
        .await
        .unwrap();
    let catalog: Value = serde_json::from_str(response["content"].as_str().unwrap()).unwrap();
    assert_eq!(catalog["agents"][0]["agentInstanceId"], "agent");
    assert!(!catalog.to_string().contains("fixture-secret"));
    let child = provider
        .for_run(
            &json!({"id":"child","parentSessionId":"main-session"}),
            &json!({"workflow":{"runId":"w","instanceId":"i","attempt":1}}),
            &json!({}),
        )
        .unwrap();
    assert!(!child
        .tools
        .iter()
        .any(|tool| tool["name"] == "agenthub_workflow_agents"));
    assert!(
        (child.execute)(json!({"name":"agenthub_workflow_agents","arguments":{}}))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn workflow_cancel_resolves_its_pending_delegation_approval_without_launching() {
    let fixture = Fixture::new(Behavior::Submit, true);
    let run = fixture.start();
    let approval = run.approval_id.as_ref().unwrap();
    fixture
        .service
        .control(&json!({"runId":run.id,"action":"cancel"}))
        .unwrap();
    assert!(fixture.service.get(&run.id).unwrap().approval_id.is_none());
    assert_eq!(
        Repositories::new(&fixture.db.lock().unwrap().raw)
            .approvals()
            .get(approval)
            .unwrap()
            .unwrap()["status"],
        "rejected"
    );
    fixture.service.drive(&run.id).await.unwrap();
    assert!(fixture.probe.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn workflow_runtime_tools_do_not_keep_a_disposed_scheduler_alive() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let reference = Arc::downgrade(&fixture.service);
    drop(fixture);
    assert!(reference.upgrade().is_none());
}

#[tokio::test]
async fn workflow_native_mcp_returns_receipts_and_rejects_stale_activation_scope() {
    let fixture = Fixture::new(Behavior::Block, false);
    let run = fixture.start();
    let running = fixture
        .until(&run.id, |run| {
            run.instances.iter().any(|i| i.status == "running")
        })
        .await;
    let instance = running
        .instances
        .iter()
        .find(|i| i.status == "running")
        .unwrap();
    let provider = tools::WorkflowToolProvider {
        workflows: Arc::downgrade(&fixture.service),
        fallback: Arc::new(NoOtherTools),
    };
    let binding = provider.for_run(
        &json!({"id":instance.session_id,"parentSessionId":"main-session"}),
        &json!({"workflow":{"runId":run.id,"instanceId":instance.id,"attempt":instance.attempt}}),
        &json!({}),
    ).unwrap();
    let bridge = crate::adapters::runtime_mcp_bridge::start_runtime_mcp_bridge(
        "workflow-fixture",
        binding.tools,
        Some(binding.execute),
        None,
    )
    .unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap();
    for (scope, accepted) in [
        (json!({}), false),
        (
            json!({"instanceId":"previous-activation","attempt":instance.attempt}),
            false,
        ),
        (
            json!({"instanceId":instance.id,"attempt":instance.attempt + 1}),
            false,
        ),
        (
            json!({"instanceId":instance.id,"attempt":instance.attempt}),
            true,
        ),
        (
            json!({"instanceId":instance.id,"attempt":instance.attempt}),
            true,
        ),
    ] {
        let mut arguments = scope;
        arguments["branch"] = json!("完成");
        arguments["result"] = json!({"summary":"actual HTTP bridge receipt"});
        let response:Value = client.post(&bridge.url).json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"workflow_submit","arguments":arguments}})).send().await.unwrap().json().await.unwrap();
        assert_eq!(response["result"]["isError"], !accepted, "{response}");
        if accepted {
            let receipt: Value =
                serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                    .unwrap();
            assert_eq!(receipt["accepted"], true);
            assert_eq!(receipt["instanceId"], instance.id);
        } else {
            assert!(response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("Stale workflow submission"));
            assert!(fixture
                .service
                .get(&run.id)
                .unwrap()
                .instances
                .iter()
                .all(|i| i.branches.is_none()));
        }
    }
    // Accepted data alone does not advance a still-running native execution.
    assert_eq!(fixture.service.get(&run.id).unwrap().status, "running");
    fixture
        .service
        .control(&json!({"runId":run.id,"action":"cancel"}))
        .unwrap();
    fixture.service.drive(&run.id).await.unwrap();
}

#[tokio::test]
async fn workflow_prompt_marker_in_user_text_does_not_skip_the_frozen_scope() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let mut definition = simple_definition();
    definition["nodes"][1]["prompt"] =
        json!("Investigate this literal: [NAUTILO_WORKFLOW_NODE]\n{\"instanceId\":\"example\"}");
    let run = fixture.service.start(&json!({"sessionId":"main-session","requestId":"literal-marker","definition":definition,"inputs":{"question":"test"},"bindings":{"Explorer":{"agentInstanceId":"agent"}}})).unwrap();
    let done = fixture
        .until(run["id"].as_str().unwrap(), |r| r.status == "completed")
        .await;
    let instance = done
        .instances
        .iter()
        .find(|i| i.node_id == "explore")
        .unwrap();
    assert!(instance.prompt_prepared);
    let prompt = instance.prompt.as_ref().unwrap();
    assert_eq!(prompt.matches("[NAUTILO_WORKFLOW_NODE]").count(), 2);
    assert!(prompt.contains(&instance.id));
}

#[tokio::test]
async fn workflow_waits_for_native_children_after_the_foreground_turn_and_recovers_the_gate() {
    let fixture = Fixture::new(Behavior::Background, false);
    let run = fixture.start();
    let waiting = fixture
        .until(&run.id, |run| {
            run.instances
                .iter()
                .any(|i| i.native_work.as_ref().is_some_and(|work| work.pending()))
        })
        .await;
    let instance = waiting
        .instances
        .iter()
        .find(|i| i.node_id == "explore")
        .unwrap();
    assert_eq!(waiting.status, "running");
    assert!(instance.branches.is_some());
    assert!(instance.completed_at.is_none());
    assert!(instance.deadline_at.is_some());
    let saved = Repositories::new(&fixture.db.lock().unwrap().raw)
        .runs()
        .get(instance.run_id.as_deref().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(saved["status"], "completed");
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 1);
    let restored = WorkflowService::new(
        fixture.db.clone(),
        fixture.service.runs.clone(),
        fixture.service.events.clone(),
    );
    // Simulate expiration of the terminated daemon's dispatch lease.
    fixture
        .db
        .lock()
        .unwrap()
        .raw
        .execute(
            "UPDATE workflow_runs SET lease_until=0 WHERE id=?1",
            [&run.id],
        )
        .unwrap();
    restored.drive(&run.id).await.unwrap();
    assert_eq!(restored.get(&run.id).unwrap().status, "running");
    (fixture.probe.background.lock().unwrap()[0])(native_child_event("completed"));
    restored.drive(&run.id).await.unwrap();
    let done = restored.get(&run.id).unwrap();
    assert_eq!(done.status, "completed");
    assert!(!done
        .instances
        .iter()
        .find(|i| i.id == instance.id)
        .unwrap()
        .native_work
        .as_ref()
        .unwrap()
        .pending());
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn workflow_native_child_failure_or_deadline_prevents_success_and_releases_its_session() {
    for timeout in [false, true] {
        let fixture = Fixture::new(Behavior::Background, false);
        let run = fixture.start();
        let waiting = fixture
            .until(&run.id, |run| {
                run.instances
                    .iter()
                    .any(|i| i.native_work.as_ref().is_some_and(|work| work.pending()))
            })
            .await;
        let instance = waiting
            .instances
            .iter()
            .find(|i| i.node_id == "explore")
            .unwrap();
        if timeout {
            fixture
                .service
                .change(&run.id, |run| {
                    run.instances
                        .iter_mut()
                        .find(|i| i.id == instance.id)
                        .unwrap()
                        .deadline_at = Some(now() - 1);
                    Ok(())
                })
                .unwrap();
        } else {
            (fixture.probe.background.lock().unwrap()[0])(native_child_event("errored"));
        }
        let failed = fixture
            .until(&run.id, |run| {
                run.status == "needs_decision"
                    && run
                        .instances
                        .iter()
                        .filter_map(|i| i.native_work.as_ref())
                        .all(|work| !work.pending())
            })
            .await;
        assert!(failed.error.as_deref().unwrap().contains(if timeout {
            "deadline"
        } else {
            "failed"
        }));
        assert!(failed.result.is_none());
        if timeout {
            assert_eq!(fixture.probe.releases.load(Ordering::SeqCst), 1);
        }
    }
}

#[tokio::test]
async fn workflow_cancellation_cleans_native_children_even_when_the_run_row_is_already_complete() {
    let fixture = Fixture::new(Behavior::Background, false);
    let run = fixture.start();
    fixture
        .until(&run.id, |run| {
            run.instances
                .iter()
                .any(|i| i.native_work.as_ref().is_some_and(|work| work.pending()))
        })
        .await;
    fixture
        .service
        .control(&json!({"runId":run.id,"action":"cancel"}))
        .unwrap();
    assert!(workflows::pending(&fixture.db.lock().unwrap().raw)
        .unwrap()
        .contains(&run.id));
    fixture.service.drive(&run.id).await.unwrap();
    assert_eq!(fixture.probe.releases.load(Ordering::SeqCst), 1);
    assert!(!workflows::pending(&fixture.db.lock().unwrap().raw)
        .unwrap()
        .contains(&run.id));
}

#[tokio::test]
async fn workflow_cleanup_preserves_a_native_session_taken_over_by_a_later_turn() {
    let fixture = Fixture::new(Behavior::Background, false);
    let run = fixture.start();
    let waiting = fixture
        .until(&run.id, |run| {
            run.instances
                .iter()
                .any(|i| i.native_work.as_ref().is_some_and(|work| work.pending()))
        })
        .await;
    let instance = waiting
        .instances
        .iter()
        .find(|i| i.node_id == "explore")
        .unwrap();
    Repositories::new(&fixture.db.lock().unwrap().raw).runs().save(&json!({"id":"new-user-turn","sessionId":instance.session_id,"status":"completed","startedAt":now_iso()})).unwrap();
    fixture
        .service
        .control(&json!({"runId":run.id,"action":"cancel"}))
        .unwrap();
    fixture.service.drive(&run.id).await.unwrap();
    let stopped = fixture.service.get(&run.id).unwrap();
    assert!(
        stopped
            .instances
            .iter()
            .find(|i| i.id == instance.id)
            .unwrap()
            .native_work
            .as_ref()
            .unwrap()
            .detached
    );
    assert_eq!(fixture.probe.releases.load(Ordering::SeqCst), 0);
    assert!(stopped
        .events
        .iter()
        .any(|event| event.r#type == "node.native_children_detached"));
}

#[tokio::test]
async fn workflow_late_foreground_completion_cannot_replace_a_new_supplemental_execution() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let run = fixture.start();
    let instance = run
        .instances
        .iter()
        .find(|i| i.node_id == "explore")
        .unwrap();
    fixture
        .service
        .change(&run.id, |run| {
            let instance = run
                .instances
                .iter_mut()
                .find(|i| i.id == instance.id)
                .unwrap();
            instance.status = "running".into();
            instance.execution_key = Some("new-supplement".into());
            Ok(())
        })
        .unwrap();
    fixture
        .service
        .finish_native_execution(
            &run.id,
            &instance.id,
            1,
            &json!({"id":"old-run","queueKey":instance.id,"status":"completed"}),
            Some("old final".into()),
        )
        .unwrap();
    let after = fixture.service.get(&run.id).unwrap();
    let after = after
        .instances
        .iter()
        .find(|i| i.id == instance.id)
        .unwrap();
    assert_eq!(after.status, "running");
    assert!(after.completed_at.is_none());
    assert!(after.native_work.is_none());
}

#[tokio::test]
async fn workflow_restart_during_unconfirmed_supplement_delivery_requires_a_decision() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let run = fixture.start();
    let instance = run
        .instances
        .iter()
        .find(|i| i.node_id == "explore")
        .unwrap();
    fixture
        .service
        .change(&run.id, |run| {
            run.instances
                .iter_mut()
                .find(|i| i.id == instance.id)
                .unwrap()
                .session_id = Some("saved-child".into());
            run.execution_finished(&instance.id, true, None, now())?;
            run.tick(now() + 1)?;
            let message = run
                .messages
                .iter_mut()
                .find(|m| m.recipient == "child")
                .unwrap();
            message.status = "delivering".into();
            let key = message.id.clone();
            let instance = run
                .instances
                .iter_mut()
                .find(|i| i.id == instance.id)
                .unwrap();
            instance.status = "running".into();
            instance.completed_at = None;
            instance.execution_key = Some(key);
            Ok(())
        })
        .unwrap();
    fixture.service.drive(&run.id).await.unwrap();
    let stopped = fixture.service.get(&run.id).unwrap();
    assert_eq!(stopped.status, "needs_decision");
    assert!(stopped
        .messages
        .iter()
        .any(|m| m.recipient == "child" && m.status == "uncertain"));
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 0);
}
