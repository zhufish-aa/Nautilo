use super::*;
use crate::adapters::{AdapterCapabilities, AdapterDetectionResult, AdapterEvent, AdapterResumeRequest, AdapterRun, AgentCliAdapter};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::AsyncReadExt;

#[derive(Default)]
struct NativeProbe {
    requests: Mutex<Vec<Value>>,
    fail_next: AtomicBool,
    missing_resume: AtomicBool,
    cancelled: Arc<tokio::sync::Notify>,
}

impl NativeProbe {
    fn run(&self, request: AdapterStartRequest, resume: Option<String>) -> CoreResult<AdapterRun> {
        let mut snapshot = crate::adapters::start_request_to_json(&request);
        snapshot["resumedNativeId"] = json!(resume);
        let failed = self.fail_next.swap(false, Ordering::SeqCst);
        let missing_resume=self.missing_resume.swap(false,Ordering::SeqCst)&&resume.is_some();
        let (tx, rx) = mpsc::unbounded_channel();
        let (cancel, mut cancelled) = watch::channel(false);
        let native_id = resume.clone().unwrap_or_else(|| format!("native-{}", uuid::Uuid::new_v4()));
        snapshot["startedNativeId"] = json!(native_id);
        let sequence = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(snapshot);
            requests.len()
        };
        let cancelled_request = self.cancelled.clone();
        tokio::spawn(async move {
            let work = async {
                let _ = tx.send(AdapterEvent::Session { provider_session_id: native_id, raw: None });
                if missing_resume {let _=tx.send(AdapterEvent::Error{message:"No conversation found with session ID".into()});return;}
                if failed { let _ = tx.send(AdapterEvent::Error { message: "Fixture native failure".into() }); return; }
                if request.prompt.contains("SLOW_REQUEST") { tokio::time::sleep(std::time::Duration::from_millis(200)).await; }
                if request.prompt.contains("BLOCK_REQUEST") { std::future::pending::<()>().await; }
                if resume.is_none() && request.runtime_tools.as_ref().and_then(Value::as_array).is_some_and(|tools| !tools.is_empty())
                    && !request.prompt.contains("[tool result ")
                {
                    if let Some(execute) = &request.execute_runtime_tool {
                        if execute(json!({"name":"nautilo_relay_0","arguments":{"path":"fixture"}})).await.is_err() { return; }
                    }
                }
                let text = if request.prompt.contains("BRANCH_REPLY") { format!("BRANCH_{sequence}") }
                    else if request.prompt.contains("PARALLEL_A") { "A".into() } else if request.prompt.contains("PARALLEL_B") { "B".into() } else { "DONE".into() };
                let _ = tx.send(AdapterEvent::Message { text, phase:Some("final".into()), message_id:None, subagent_dispatch_id:None, raw:None });
                let _ = tx.send(AdapterEvent::Exit { exit_code:Some(0), signal:None });
            };
            tokio::select! { _ = work => {}, _ = cancelled.changed() => {} }
        });
        Ok(AdapterRun::new(rx, move || Box::pin(async move { let _ = cancel.send(true); cancelled_request.notify_one(); }), |_| {}))
    }
}

#[tokio::test]
async fn unavailable_claude_native_resume_replays_the_full_api_history_in_a_fresh_worker() {
    let f=Fixture::new().await;
    let opening=json!({"role":"user","content":"Original question"});
    assert_eq!(f.post(json!({"messages":[opening]})).await.0,200);
    f.probe.missing_resume.store(true,Ordering::SeqCst);
    let (status,reply)=f.post(json!({"messages":[opening,{"role":"assistant","content":"DONE"},{"role":"user","content":"Continue this conversation"}]})).await;
    assert_eq!(status,200,"{reply}");
    let requests=f.probe.requests.lock().unwrap().clone();assert_eq!(requests.len(),3);
    assert_eq!(requests[1]["resumedNativeId"],requests[0]["startedNativeId"]);assert!(requests[2]["resumedNativeId"].is_null());
    let replay=requests[2]["prompt"].as_str().unwrap();assert!(replay.contains("Original question"));assert!(replay.contains("DONE"));assert!(replay.contains("Continue this conversation"));
    f.close().await;
}

#[async_trait::async_trait]
impl AgentCliAdapter for NativeProbe {
    fn provider_id(&self) -> &str { "claude-code" }
    fn descriptor(&self) -> Value { json!({"providerId":"claude-code","defaultExecutable":"fixture-claude"}) }
    fn capabilities(&self) -> AdapterCapabilities {
        AdapterCapabilities { structured_output:true, text_output:true, interactive_stdin:false, native_resume:true, pty:false }
    }
    async fn detect(&self, _: &Value) -> AdapterDetectionResult { AdapterDetectionResult::default() }
    async fn list_models(&self, _: &Value, _: Option<&Value>) -> Option<CoreResult<Value>> {
        Some(Ok(json!({"models":[{"id":"opencode/fixture-free","reasoningEfforts":["low","high","max"]}]})))
    }
    fn start(&self, request: AdapterStartRequest) -> CoreResult<AdapterRun> { self.run(request, None) }
    fn resume(&self, request: AdapterResumeRequest) -> CoreResult<AdapterRun> { self.run(request.start, Some(request.provider_session_id)) }
}

struct Fixture {
    gateways: AccountGateways,
    probe: Arc<NativeProbe>,
    url: String,
    key: String,
    root: std::path::PathBuf,
}
impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("nautilo-account-api-{}", uuid::Uuid::new_v4()));
        let db = Arc::new(Mutex::new(Database::open(&root.join("test.sqlite")).unwrap()));
        let account = json!({"id":"selected","name":"Selected","harness":"claude-code","kind":"login","loginProfileDirectory":root,"enabled":true,"revision":1,"models":[]});
        {
            let guard = db.lock().unwrap(); let records = Repositories::new(&guard.raw);
            records.runtime_connections().save(&account,"now").unwrap();
            records.integration_settings().save(&json!({"id":"integration-settings","gateway":{"enabled":true,"connectionIds":["selected"]}}),"now").unwrap();
        }
        let registry = AdapterRegistry::default();
        let probe = Arc::new(NativeProbe::default());
        registry.register(probe.clone());
        let gateways = AccountGateways::new(db.clone(), Arc::new(CredentialService::new(db, &root)), registry);
        let mut request = AdapterStartRequest { instance:json!({"providerId":"deepseek","providerOptions":{}}), cwd:root.to_string_lossy().into(), model:Some("opencode/fixture-free".into()), ..Default::default() };
        // Exercise the Claude CLI/MCP conversation pool separately from the
        // native login command. OpenCode inference uses HTTP and never enters it.
        let identity="caller-session:selected:1";
        let route=gateways.open_route("claude-code",identity,&account,&request).await.unwrap();
        gateways.configure_outer(&route,"caller-session",&account,&mut request);
        gateways.routes.lock().await.insert(identity.into(),route);
        Self { gateways, probe, url:request.instance["providerOptions"]["baseUrl"].as_str().unwrap().into(), key:request.env.unwrap()["OPENAI_API_KEY"].clone(), root }
    }
    async fn post(&self, body: Value) -> (u16, Value) {
        let mut body = body; body["model"] = json!("opencode/fixture-free");
        let response = reqwest::Client::new().post(format!("{}/chat/completions",self.url)).bearer_auth(&self.key).json(&body).send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        let value = if body["stream"] == true {
            json!({"stream":text})
        } else { serde_json::from_str(&text).unwrap() };
        (status,value)
    }
    async fn close(self) {
        self.gateways.cancel_session("caller-session").await;
        let root = self.root.clone(); drop(self);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[tokio::test]
async fn accounts_share_one_endpoint_and_keep_their_own_request_binding() {
    let f = Fixture::new().await;
    let second_home = f.root.join("other-login");
    std::fs::create_dir_all(&second_home).unwrap();
    let second = json!({"id":"other","kind":"login","harness":"claude-code","enabled":true,
        "revision":1,"loginProfileDirectory":second_home,"models":[]});
    {
        let db = f.gateways.db.lock().unwrap();
        let records = Repositories::new(&db.raw);
        records.runtime_connections().save(&second, "now").unwrap();
        records.integration_settings().save(&json!({"id":"integration-settings",
            "gateway":{"enabled":true,"connectionIds":["selected","other"]}}), "now").unwrap();
    }
    let original = f.post(json!({"messages":[{"role":"user","content":"SLOW_REQUEST PARALLEL_A"}]}));
    let replacement = async {
        let mut request = AdapterStartRequest {
            instance: json!({"providerId":"deepseek","providerOptions":{}}),
            cwd: f.root.to_string_lossy().into(),
            ..Default::default()
        };
        let route_id = "caller-session:other:1";
        let route = f.gateways.open_route("claude-code", route_id, &second, &request).await.unwrap();
        f.gateways.configure_outer(&route, "caller-session", &second, &mut request);
        f.gateways.routes.lock().await.insert(route_id.into(), route);
        let url = request.instance["providerOptions"]["baseUrl"].as_str().unwrap();
        let key = request.env.as_ref().unwrap()["OPENAI_API_KEY"].as_str();
        assert_eq!(url, f.url);
        assert_ne!(key, f.key);
        let client = reqwest::Client::new();
        let unauthenticated = client.get(format!("{url}/models")).send().await.unwrap();
        assert_eq!(unauthenticated.status(), 401);
        let reply = client.post(format!("{url}/chat/completions")).bearer_auth(key).json(&json!({
            "model":"opencode/fixture-free","messages":[{"role":"user","content":"PARALLEL_B"}]
        })).send().await.unwrap();
        assert_eq!(reply.status(), 200);
        let body: Value = reply.json().await.unwrap();
        assert_eq!(body["choices"][0]["message"]["content"], "B");
    };
    let ((status, reply), ()) = tokio::join!(original, replacement);
    assert_eq!(status, 200);
    assert_eq!(reply["choices"][0]["message"]["content"], "A");
    {
        let requests = f.probe.requests.lock().unwrap();
        let home = |text: &str| requests.iter().find(|request| request["prompt"].as_str().unwrap().contains(text))
            .and_then(|request| request.pointer("/instance/providerOptions/loginProfileDirectory")).cloned();
        assert_eq!(home("PARALLEL_A"), Some(json!(f.root)));
        assert_eq!(home("PARALLEL_B"), Some(json!(second_home)));
    }
    f.close().await;
}

#[tokio::test]
async fn account_api_accepts_streaming_titles_rewritten_context_and_changed_tools() {
    let f = Fixture::new().await;
    let title = json!({"messages":[{"role":"system","content":"Generate a title"},{"role":"user","content":"hello"}],"stream":true});
    let (status,_) = f.post(title).await; assert_eq!(status,200);
    let original = json!({"messages":[{"role":"user","content":"MAIN"}],"tools":[{"type":"function","function":{"name":"read_file","parameters":{"type":"object"}}}]});
    let (status, tool) = f.post(original.clone()).await; assert_eq!(status,200,"{tool}");
    let call = &tool["choices"][0]["message"]["tool_calls"][0]; assert_eq!(call["function"]["name"],"read_file");
    let history = json!([{"role":"user","content":"MAIN"},{"role":"assistant","content":"","tool_calls":[call]},{"role":"tool","tool_call_id":call["id"],"content":"actual result"}]);
    let (status,reply) = f.post(json!({"messages":history,"tools":original["tools"]})).await;
    assert_eq!(status,200,"{reply}"); assert_eq!(reply["choices"][0]["message"]["content"],"DONE");
    let rewritten = json!({"messages":[{"role":"system","content":"Compacted context"},{"role":"assistant","tool_calls":[{"id":"historical","type":"function","function":{"name":"old_tool","arguments":"{}"}}]},{"role":"tool","tool_call_id":"historical","content":"HISTORICAL_RESULT"},{"role":"user","content":"Continue"}],"tools":[{"type":"function","function":{"name":"new_tool"}}]});
    for _ in 0..2 {
        let (status,reply) = f.post(rewritten.clone()).await; assert_eq!(status,200,"{reply}");
        assert_eq!(reply["choices"][0]["message"]["content"],"DONE");
        let requests = f.probe.requests.lock().unwrap();
        assert!(requests.last().unwrap()["resumedNativeId"].is_null());
        assert!(requests.last().unwrap()["prompt"].as_str().unwrap().contains("HISTORICAL_RESULT"));
    }
    f.close().await;
}

#[tokio::test]
async fn account_api_runs_independent_calls_concurrently_and_retries_failed_workers() {
    let f = Fixture::new().await;
    let (a,b) = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        tokio::join!(f.post(json!({"messages":[{"role":"user","content":"SLOW_REQUEST PARALLEL_A"}]})),f.post(json!({"messages":[{"role":"user","content":"PARALLEL_B"}]})))
    }).await.unwrap();
    assert_eq!(a.0,200); assert_eq!(b.0,200);
    assert_eq!(a.1["choices"][0]["message"]["content"],"A");
    assert_eq!(b.1["choices"][0]["message"]["content"],"B");
    {
        let calls = f.probe.requests.lock().unwrap();
        assert_ne!(calls[0]["localSessionId"],calls[1]["localSessionId"]);
    }
    f.probe.fail_next.store(true,Ordering::SeqCst);
    let request = json!({"messages":[{"role":"user","content":"Retry model request"}]});
    assert_eq!(f.post(request.clone()).await.0,502);
    let (status,reply)=f.post(request).await; assert_eq!(status,200,"{reply}");
    assert_eq!(reply["choices"][0]["message"]["content"],"DONE");
    assert!(f.probe.requests.lock().unwrap().last().unwrap()["resumedNativeId"].is_null());
    f.close().await;
}

#[tokio::test]
async fn account_api_retries_keep_their_own_assistant_branch() {
    let f = Fixture::new().await;
    let original = json!({"role":"user","content":"BRANCH_REPLY"});
    for expected in ["BRANCH_1", "BRANCH_2"] {
        let (status, reply) = f.post(json!({"messages":[original]})).await;
        assert_eq!(status, 200);
        assert_eq!(reply["choices"][0]["message"]["content"], expected);
    }
    let (status, _) = f.post(json!({"messages":[original,{"role":"assistant","content":"BRANCH_1"},{"role":"user","content":"Continue this branch"}]})).await;
    assert_eq!(status, 200);
    {
        let calls = f.probe.requests.lock().unwrap();
        assert_eq!(calls[2]["resumedNativeId"], calls[0]["startedNativeId"]);
        assert_ne!(calls[2]["resumedNativeId"], calls[1]["startedNativeId"]);
    }
    f.close().await;
}

#[tokio::test]
async fn account_api_disconnect_before_first_token_cancels_only_that_request() {
    let f = Fixture::new().await;
    let url = reqwest::Url::parse(&f.url).unwrap();
    let mut socket = TcpStream::connect(("127.0.0.1", url.port().unwrap())).await.unwrap();
    let body = json!({"model":"opencode/fixture-free","messages":[{"role":"user","content":"BLOCK_REQUEST"}],"stream":true}).to_string();
    socket.write_all(format!("POST {}/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n{}",url.path(),f.key,body.len(),body).as_bytes()).await.unwrap();
    let mut byte = [0; 1];
    tokio::time::timeout(std::time::Duration::from_secs(2), socket.read_exact(&mut byte)).await.unwrap().unwrap();
    drop(socket);
    tokio::time::timeout(std::time::Duration::from_secs(2), f.probe.cancelled.notified()).await.unwrap();
    let (status, reply) = f.post(json!({"messages":[{"role":"user","content":"KEEP_RUNNING"}]})).await;
    assert_eq!(status, 200, "{reply}");
    assert_eq!(reply["choices"][0]["message"]["content"], "DONE");
    f.close().await;
}
