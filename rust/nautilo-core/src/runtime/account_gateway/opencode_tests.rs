//! HTTP integration coverage: native account discovery is allowed, but an
//! OpenCode model request must never start/resume an OpenCode Agent.
use super::*;
use crate::adapters::{
    AdapterCapabilities, AdapterDetectionResult, AdapterResumeRequest, AdapterRun, AgentCliAdapter,
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::{io::AsyncReadExt, net::TcpListener};

struct CatalogOnly;
#[async_trait::async_trait]
impl AgentCliAdapter for CatalogOnly {
    fn provider_id(&self) -> &str {
        "opencode"
    }
    fn descriptor(&self) -> Value {
        json!({"providerId":"opencode","defaultExecutable":"fixture"})
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
        AdapterDetectionResult::default()
    }
    async fn list_models(&self, _: &Value, _: Option<&Value>) -> Option<CoreResult<Value>> {
        Some(Ok(
            json!({"models":[{"id":"opencode/fixture-free","reasoningEfforts":["low","high","max"]}]}),
        ))
    }
    fn start(&self, _: AdapterStartRequest) -> CoreResult<AdapterRun> {
        panic!("OpenCode Agent inference is forbidden")
    }
    fn resume(&self, _: AdapterResumeRequest) -> CoreResult<AdapterRun> {
        panic!("OpenCode Agent inference is forbidden")
    }
}

#[derive(Default)]
struct Upstream {
    requests: Mutex<Vec<Value>>,
    configs: AtomicUsize,
    rejected: AtomicUsize,
    refreshed: AtomicUsize,
    hold_refresh: AtomicBool,
    refreshing: tokio::sync::Notify,
    release_refresh: tokio::sync::Notify,
    blocked: tokio::sync::Notify,
    cancelled: tokio::sync::Notify,
}
async fn read_request(socket: &mut TcpStream) -> (String, HashMap<String, String>, Value) {
    let mut bytes = vec![];
    let mut byte = [0];
    while !bytes.ends_with(b"\r\n\r\n") {
        socket.read_exact(&mut byte).await.unwrap();
        bytes.push(byte[0]);
    }
    let header = String::from_utf8(bytes).unwrap();
    let headers = header
        .lines()
        .filter_map(|line| {
            line.split_once(':')
                .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect::<HashMap<_, _>>();
    let size = headers
        .get("content-length")
        .and_then(|size| size.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0; size];
    socket.read_exact(&mut body).await.unwrap();
    (
        header
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .into(),
        headers,
        if body.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&body).unwrap()
        },
    )
}
async fn mock(mut socket: TcpStream, base: String, state: Arc<Upstream>) {
    let (path, headers, body) = read_request(&mut socket).await;
    if path == "/console/auth/device/token" {
        assert_eq!(
            body,
            json!({"grant_type":"refresh_token","refresh_token":"refresh-original","client_id":"opencode-cli"})
        );
        state.refreshed.fetch_add(1, Ordering::SeqCst);
        state.refreshing.notify_one();
        if state.hold_refresh.load(Ordering::SeqCst) {
            state.release_refresh.notified().await;
        }
        let _=response(&mut socket,200,&json!({"access_token":"console-token","refresh_token":"refresh-rotated","expires_in":3600})).await;
        return;
    }
    if path == "/console/api/config" {
        assert_eq!(headers["authorization"], "Bearer console-token");
        assert_eq!(headers["x-org-id"], "selected-org");
        state.configs.fetch_add(1, Ordering::SeqCst);
        let _=response(&mut socket,200,&json!({"config":{"provider":{"opencode":{"api":format!("{base}/inference/openai/v1"),"options":{"apiKey":"{env:OPENCODE_CONSOLE_TOKEN}","headers":{"x-opencode-org-id":"selected-org"}},"models":{"fixture-free":{"cost":{"input":0,"output":0}}}}}}})).await;
        return;
    }
    assert_eq!(path, "/inference/openai/v1/chat/completions");
    assert_eq!(headers["authorization"], "Bearer console-token");
    assert_eq!(headers["x-opencode-org-id"], "selected-org");
    assert_eq!(headers["x-opencode-client"], "cli");
    assert!(headers["user-agent"].starts_with("opencode/latest/"));
    assert_eq!(headers["x-opencode-session"], headers["x-session-affinity"]);
    assert_eq!(headers["x-opencode-session"].len(), 30);
    assert_eq!(headers["x-opencode-project"].len(), 40);
    state.requests.lock().unwrap().push(body.clone());
    // A rotated inference credential reloads the Console exactly once.
    if state.rejected.fetch_add(1, Ordering::SeqCst) == 0 {
        let _ = response(
            &mut socket,
            401,
            &json!({"error":{"message":"rotated inference credential"}}),
        )
        .await;
        return;
    }
    let text = body["messages"].to_string();
    if text.contains("QUOTA") {
        let _ = response(
            &mut socket,
            429,
            &json!({"error":{"message":"Fixture quota exhausted"}}),
        )
        .await;
        return;
    }
    if text.contains("BLOCK_REQUEST") {
        state.blocked.notify_one();
        let mut byte = [0];
        let _ = socket.read(&mut byte).await;
        state.cancelled.notify_one();
        return;
    }
    if text.contains("SLOW_REQUEST") {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    let mut packets = vec![];
    if text.contains("MAIN") && !text.contains("ACTUAL_TOOL_RESULT") {
        packets.push(json!({"id":"fixture","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"real-call","type":"function","function":{"name":"read","arguments":"{\"path\":"}},{"index":1,"id":"stub-call","type":"function","function":{"name":"shell","arguments":"{}"}}]}}]}));
        packets.push(json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"你好\"}"}}]},"finish_reason":"tool_calls"}]}));
    } else {
        packets.push(json!({"id":"fixture","choices":[{"index":0,"delta":{"content":"你好 DONE"},"finish_reason":"stop"}]}));
    }
    packets.push(
        json!({"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}),
    );
    let mut stream = packets
        .into_iter()
        .map(|packet| format!("data: {packet}\r\n\r\n"))
        .collect::<String>();
    stream.push_str("data: [DONE]\r\n\r\n");
    let _ = socket
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        )
        .await;
    // Split every UTF-8 codepoint and SSE boundary on the transport.
    for bytes in stream.as_bytes().chunks(7) {
        if socket.write_all(bytes).await.is_err() {
            return;
        }
    }
}

struct Fixture {
    gateway: AccountGateways,
    url: String,
    key: String,
    root: std::path::PathBuf,
    state: Arc<Upstream>,
    server: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn new(expired: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Upstream::default());
        let serving = state.clone();
        let server_base = base.clone();
        let server = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(mock(socket, server_base.clone(), serving.clone()));
            }
        });
        let root =
            std::env::temp_dir().join(format!("nautilo-opencode-http-{}", uuid::Uuid::new_v4()));
        let native = root.join("account/data/opencode");
        std::fs::create_dir_all(&native).unwrap();
        {
            let db = rusqlite::Connection::open(native.join("opencode.db")).unwrap();
            db.execute_batch("CREATE TABLE account(id TEXT,email TEXT,url TEXT,access_token TEXT,refresh_token TEXT,token_expiry INTEGER,time_updated INTEGER); CREATE TABLE account_state(id TEXT,active_account_id TEXT,active_org_id TEXT);").unwrap();
            db.execute("INSERT INTO account VALUES('chosen','fixture',?1,'console-token','refresh-original',?2,0)",rusqlite::params![format!("{base}/console"),if expired{0}else{chrono::Utc::now().timestamp_millis()+3_600_000}]).unwrap();
            db.execute(
                "INSERT INTO account_state VALUES('state','chosen','selected-org')",
                [],
            )
            .unwrap();
        }
        let db = Arc::new(Mutex::new(
            Database::open(&root.join("core.sqlite")).unwrap(),
        ));
        let connection = json!({"id":"chosen","kind":"login","harness":"opencode","nativeLogin":true,"loginProfileDirectory":root.join("account"),"enabled":true,"revision":1,"models":[]});
        {
            let db = db.lock().unwrap();
            let records = Repositories::new(&db.raw);
            records
                .runtime_connections()
                .save(&connection, "now")
                .unwrap();
            records.integration_settings().save(&json!({"id":"integration-settings","gateway":{"enabled":true,"connectionIds":["chosen"]}}),"now").unwrap();
        }
        let registry = AdapterRegistry::default();
        registry.register(Arc::new(CatalogOnly));
        let gateway = AccountGateways::new(
            db.clone(),
            Arc::new(CredentialService::new(db, &root)),
            registry,
        );
        let mut outer = AdapterStartRequest {
            instance: json!({"providerId":"deepseek","providerOptions":{}}),
            cwd: root.to_string_lossy().into(),
            model: Some("opencode/fixture-free".into()),
            ..Default::default()
        };
        gateway
            .bind("caller", &connection, &mut outer)
            .await
            .unwrap();
        Self {
            gateway,
            url: outer.instance["providerOptions"]["baseUrl"]
                .as_str()
                .unwrap()
                .into(),
            key: outer.env.unwrap()["OPENAI_API_KEY"].clone(),
            root,
            state,
            server,
        }
    }
    async fn post(&self, mut body: Value) -> reqwest::Response {
        body["model"] = json!("opencode/fixture-free");
        reqwest::Client::new()
            .post(format!("{}/chat/completions", self.url))
            .bearer_auth(&self.key)
            .json(&body)
            .send()
            .await
            .unwrap()
    }
    async fn close(self) {
        self.gateway.cancel_session("caller").await;
        self.server.abort();
        let root = self.root.clone();
        drop(self);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[tokio::test]
async fn assistant_steps_use_the_selected_login_and_discover_its_models() {
    let f = Fixture::new(false).await;
    let daemon = crate::application::core_daemon::Daemon::new(f.root.join("assistant")).await.unwrap();
    daemon.adapters.register(Arc::new(CatalogOnly));
    let account = json!({"id":"assistant-chosen","name":"Selected account","kind":"login","harness":"opencode",
        "nativeLogin":true,"loginProfileDirectory":f.root.join("account"),"enabled":true,"models":[]});
    daemon.connections.upsert(&json!({"connection":account})).unwrap();
    let mut input = json!({"connectionId":"assistant-chosen","model":"opencode/fixture-free","instructions":"Route the assistant request",
        "context":["MAIN"],"tools":[{"name":"Read","description":"Inspect a fixture","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}]});
    assert!(crate::runtime::assistant_model::step(&daemon, &input).await.is_err());
    daemon.integrations.set_account_route("assistant-chosen", true).unwrap();
    input["streamId"] = json!(uuid::Uuid::new_v4().to_string());
    let call = crate::runtime::assistant_model::step(&daemon, &input).await.unwrap();
    assert_eq!(call["call"]["name"], "Read");
    assert_eq!(call["call"]["arguments"]["path"], "你好");
    input["context"] = json!(["ACTUAL_TOOL_RESULT"]);
    let reply = crate::runtime::assistant_model::step(&daemon, &input).await.unwrap();
    assert_eq!(reply["text"], "你好 DONE");
    assert_eq!(reply["inputTokens"], 9);
    daemon.integrations.set_account_route("assistant-chosen", false).unwrap();
    assert!(crate::runtime::assistant_model::step(&daemon, &input).await.is_err());
    drop(daemon);
    f.close().await;
}

#[tokio::test]
async fn opencode_uses_selected_console_credentials_and_supports_independent_api_calls() {
    let f = Fixture::new(true).await;
    let title = f
        .post(json!({"stream":true,"messages":[{"role":"user","content":"Title"}]}))
        .await;
    assert_eq!(title.status(), 200);
    assert!(title.text().await.unwrap().contains("你好 DONE"));
    assert_eq!(f.state.refreshed.load(Ordering::SeqCst), 1);
    assert_eq!(f.state.configs.load(Ordering::SeqCst), 2);
    let request = json!({"messages":[{"role":"user","content":"MAIN"}],"tools":[{"type":"function","function":{"name":"Read","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}]});
    let reply: Value = f.post(request.clone()).await.json().await.unwrap();
    let call = &reply["choices"][0]["message"]["tool_calls"][0];
    assert_eq!(call["function"]["name"], "Read");
    assert_eq!(call["function"]["arguments"], "{\"path\":\"你好\"}");
    assert_eq!(
        reply["choices"][0]["message"]["tool_calls"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(reply["usage"]["total_tokens"], 12);
    let result:Value=f.post(json!({"messages":[request["messages"][0],{"role":"assistant","tool_calls":[call]},{"role":"tool","tool_call_id":call["id"],"content":"ACTUAL_TOOL_RESULT"}],"tools":request["tools"]})).await.json().await.unwrap();
    assert_eq!(result["choices"][0]["message"]["content"], "你好 DONE");
    let (a,b)=tokio::join!(f.post(json!({"messages":[{"role":"system","content":"rewritten history"},{"role":"user","content":"SLOW_REQUEST"}]})),f.post(json!({"messages":[{"role":"user","content":"Independent branch"}],"tools":[]})));
    assert_eq!(a.status(), 200);
    assert_eq!(b.status(), 200);
    let quota = f
        .post(json!({"messages":[{"role":"user","content":"QUOTA"}]}))
        .await;
    assert_eq!(quota.status(), 429);
    let records = f.state.requests.lock().unwrap().clone();
    let tool_request = records
        .iter()
        .find(|request| {
            request["messages"]
                .to_string()
                .contains("ACTUAL_TOOL_RESULT")
        })
        .unwrap();
    let assistant = tool_request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "assistant")
        .unwrap();
    assert_eq!(assistant["tool_calls"][0]["function"]["name"], "read");
    assert_eq!(tool_request["tools"].as_array().unwrap().len(), 5);
    assert_eq!(tool_request["tools"][0]["function"]["strict"], false);
    f.close().await;
}

#[tokio::test]
async fn opencode_disconnect_cancels_upstream_before_first_token_and_keeps_other_calls_usable() {
    let f = Fixture::new(false).await;
    let url = reqwest::Url::parse(&f.url).unwrap();
    let mut socket = TcpStream::connect(("127.0.0.1", url.port().unwrap()))
        .await
        .unwrap();
    let body=json!({"model":"opencode/fixture-free","messages":[{"role":"user","content":"BLOCK_REQUEST"}],"stream":true}).to_string();
    socket.write_all(format!("POST {}/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n{body}",url.path(),f.key,body.len()).as_bytes()).await.unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        f.state.blocked.notified(),
    )
    .await
    .unwrap();
    drop(socket);
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        f.state.cancelled.notified(),
    )
    .await
    .unwrap();
    assert_eq!(
        f.post(json!({"messages":[{"role":"user","content":"still usable"}]}))
            .await
            .status(),
        200
    );
    f.close().await;
}

#[tokio::test]
async fn opencode_oauth_rotation_is_persisted_even_when_the_model_caller_disconnects() {
    let f = Fixture::new(true).await;
    f.state.hold_refresh.store(true, Ordering::SeqCst);
    let url = reqwest::Url::parse(&f.url).unwrap();
    let mut socket = TcpStream::connect(("127.0.0.1", url.port().unwrap()))
        .await
        .unwrap();
    let body=json!({"model":"opencode/fixture-free","messages":[{"role":"user","content":"Cancelled during token rotation"}]}).to_string();
    socket.write_all(format!("POST {}/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n{body}",url.path(),f.key,body.len()).as_bytes()).await.unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        f.state.refreshing.notified(),
    )
    .await
    .unwrap();
    drop(socket);
    f.state.release_refresh.notify_one();
    let path = f.root.join("account/data/opencode/opencode.db");
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let token: String = rusqlite::Connection::open(&path)
                .unwrap()
                .query_row(
                    "SELECT refresh_token FROM account WHERE id='chosen'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            if token == "refresh-rotated" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("refresh rotation must outlive the cancelled model call");
    assert_eq!(
        f.post(json!({"messages":[{"role":"user","content":"next turn"}]}))
            .await
            .status(),
        200
    );
    assert_eq!(f.state.refreshed.load(Ordering::SeqCst), 1);
    f.close().await;
}
