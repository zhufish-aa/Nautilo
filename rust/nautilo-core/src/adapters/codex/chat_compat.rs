//! Codex Chat Completions compatibility proxy — port of
//! adapters/codex/chat-compat-proxy.ts. Runs the real Codex app-server behind
//! a local Responses-to-Chat shim, because recent Codex versions reject
//! `wire_api = "chat"` while many relays only expose /chat/completions.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::adapters::codex::app_server::start_codex_app_server_transient;
use crate::adapters::{AdapterEvent, AdapterRun, AdapterStartRequest};
use crate::errors::{CoreError, CoreResult, ErrorCode};

fn as_str(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

fn as_number(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_f64().map(|f| f as i64))
}

/// Starts the proxy, then the app-server run against it. Cancelling the run
/// shuts the proxy down as well.
pub fn start_codex_chat_compat_app_server(request: AdapterStartRequest, resume_session: Option<String>) -> CoreResult<AdapterRun> {
    let remote_base_url = request
        .instance
        .get("providerOptions")
        .and_then(|o| o.get("baseUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let Some(remote_base_url) = remote_base_url else {
        return Err(CoreError::reason(ErrorCode::IpcInvalidRequest, "Chat Completions compatibility mode needs a configured API base URL"));
    };
    let anthropic = super::resolve_codex_wire_api(&request.instance) == "anthropic";
    if anthropic {
        super::anthropic_compat::endpoint(&remote_base_url).map_err(|_| CoreError::reason(ErrorCode::IpcInvalidRequest, "Invalid Anthropic endpoint: use HTTPS without URL credentials or query parameters"))?;
    }
    if !anthropic {
        chat_endpoint(&remote_base_url).map_err(|_| CoreError::reason(ErrorCode::IpcInvalidRequest, "Invalid Chat endpoint: use HTTPS without URL credentials or query parameters"))?;
    }
    let allow_native_web_search = !anthropic && request
        .instance
        .get("providerOptions")
        .and_then(|o| o.get("webSearchMode"))
        .and_then(Value::as_str)
        == Some("native");

    let proxy = ChatCompatProxy::start_protocol(remote_base_url, request.env.clone().unwrap_or_default(), allow_native_web_search, anthropic)
        .map_err(|e| CoreError::reason(ErrorCode::RunStartFailed, e.to_string()))?;

    // Point the inner app-server at the shim over the Responses wire format.
    let mut instance = request.instance.as_object().cloned().unwrap_or_default();
    let mut options = instance
        .get("providerOptions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    options.insert("baseUrl".to_string(), json!(proxy.base_url()));
    options.insert("wireApi".to_string(), json!("responses"));
    if anthropic { options.insert("anthropicCompat".to_string(), json!(true)); }
    options.insert("webSearch".to_string(), json!(allow_native_web_search));
    options.insert("webSearchMode".to_string(), json!(if allow_native_web_search { "native" } else { "off" }));
    instance.insert("providerOptions".to_string(), Value::Object(options));
    let mut inner_request = request;
    inner_request.instance = Value::Object(instance);
    // Only the proxy owns remote credentials; Codex receives a local throwaway key.
    let environment = inner_request.env.get_or_insert_with(HashMap::new);
    environment.retain(|key, _| !matches!(key.to_ascii_uppercase().as_str(), "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN" | "OPENAI_API_KEY" | "OPENAI_AUTH_TOKEN" | "CODEX_API_KEY" | "CODEX_AUTH_TOKEN" | "AGENTHUB_API_KEY" | "AGENTHUB_AUTH_TOKEN"));
    environment.insert("OPENAI_API_KEY".to_string(), Uuid::new_v4().to_string());
    environment.insert("OPENAI_BASE_URL".to_string(), proxy.base_url());
    if anthropic && inner_request.reasoning_effort.as_deref().is_none_or(|s| s.is_empty()) {
        inner_request.reasoning_effort = Some("none".to_string());
    }

    let inner = match start_codex_app_server_transient(inner_request, resume_session) {
        Ok(run) => run,
        Err(error) => {
            proxy.close();
            return Err(error);
        }
    };
    let (mut inner_events, inner_cancel, inner_steer, _inner_write) = inner.into_parts();
    let proxy = Arc::new(proxy);
    let cancel_proxy = proxy.clone();
    let pump_proxy = proxy.clone();
    let (sender, receiver) = mpsc::unbounded_channel::<AdapterEvent>();
    tokio::spawn(async move {
        while let Some(event) = inner_events.recv().await {
            if sender.send(event).is_err() {
                break;
            }
        }
        pump_proxy.close();
    });
    let mut run = AdapterRun::new(
        receiver,
        move || {
            Box::pin(async move {
                inner_cancel().await;
                cancel_proxy.close();
            }) as crate::adapters::BoxFuture<()>
        },
        |_| {},
    );
    if let Some(steer) = inner_steer {
        run = run.with_steer(steer);
    }
    Ok(run)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn anthropic_bridge_rejects_wrong_capability_and_unsupported_requests() {
        let proxy = ChatCompatProxy::start_protocol("http://127.0.0.1:1/v1".into(), HashMap::new(), false, true).unwrap();
        let client = reqwest::Client::new();
        let url = reqwest::Url::parse(&proxy.base_url()).unwrap();
        let wrong = format!("http://127.0.0.1:{}/v1/responses", url.port().unwrap());
        assert_eq!(client.post(wrong).json(&json!({})).send().await.unwrap().status().as_u16(), 404);
        let endpoint = format!("{}/responses", proxy.base_url());
        let response = client.post(&endpoint).json(&json!({"model":"m","input":[{"role":"user","content":[{"type":"input_image","image_url":"https://example.com/image.png"}]}]})).send().await.unwrap();
        assert_eq!(response.status().as_u16(), 400);
        let response = client.post(&endpoint).header("authorization", "Bearer caller-secret").json(&json!({"model":"m","input":"hi"})).send().await.unwrap();
        assert_eq!(response.status().as_u16(), 401, "incoming bearer must not become upstream authentication");
        proxy.close();
    }

    #[tokio::test]
    async fn anthropic_bridge_streams_text_and_sanitizes_errors() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let upstream = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new(); let mut byte = [0u8; 1];
            while !bytes.ends_with(b"\r\n\r\n") { socket.read_exact(&mut byte).await.unwrap(); bytes.push(byte[0]); }
            let headers = String::from_utf8(bytes).unwrap();
            assert!(headers.contains("x-api-key: selected-key"));
            assert!(!headers.contains("caller-secret"));
            let len: usize = headers.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap();
            let mut body = vec![0; len]; socket.read_exact(&mut body).await.unwrap();
            let events = [json!({"type":"message_start","message":{"usage":{"input_tokens":2}}}), json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}), json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}), json!({"type":"content_block_stop","index":0}), json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}), json!({"type":"message_stop"})];
            let body = events.iter().map(|e| format!("data: {e}\n\n")).collect::<String>();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let proxy = ChatCompatProxy::start_protocol(format!("http://127.0.0.1:{port}/v1"), HashMap::from([("ANTHROPIC_API_KEY".into(), "selected-key".into())]), false, true).unwrap();
        let result = reqwest::Client::new().post(format!("{}/responses", proxy.base_url())).header("authorization", "Bearer caller-secret").json(&json!({"model":"m","input":"hi"})).send().await.unwrap().text().await.unwrap();
        assert!(result.contains("response.completed")); assert!(result.contains("你好")); assert!(!result.contains("selected-key"));
        upstream.await.unwrap(); proxy.close();
    }

    #[tokio::test]
    async fn anthropic_bridge_cancels_upstream_on_downstream_disconnect() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let upstream = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new(); let mut byte = [0u8; 1];
            while !bytes.ends_with(b"\r\n\r\n") { socket.read_exact(&mut byte).await.unwrap(); bytes.push(byte[0]); }
            let headers = String::from_utf8(bytes).unwrap();
            let len: usize = headers.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap();
            let mut body = vec![0; len]; socket.read_exact(&mut body).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
            let closed = tokio::time::timeout(std::time::Duration::from_secs(3), socket.read(&mut byte)).await;
            assert!(matches!(closed, Ok(Ok(0)) | Ok(Err(_))), "upstream must close after downstream cancellation");
        });
        let proxy = ChatCompatProxy::start_protocol(format!("http://127.0.0.1:{port}/v1"), HashMap::from([("ANTHROPIC_API_KEY".into(), "selected-key".into())]), false, true).unwrap();
        let response = reqwest::Client::new().post(format!("{}/responses", proxy.base_url())).json(&json!({"model":"m","input":"hi"})).send().await.unwrap();
        drop(response);
        upstream.await.unwrap(); proxy.close();
    }

    #[test]
    fn chat_endpoint_rejects_credential_bearing_or_insecure_urls() {
        for url in ["http://example.com/v1", "http://localhost/v1", "https://user:secret@example.com/v1", "https://example.com/v1?api_key=secret", "https://example.com/v1#secret", "file:///tmp/key"] {
            assert!(chat_endpoint(url).is_err());
        }
        assert_eq!(chat_endpoint("https://example.com/v1").unwrap(), "https://example.com/v1/chat/completions");
        assert_eq!(chat_endpoint("http://127.0.0.1:1234/v1").unwrap(), "http://127.0.0.1:1234/v1/chat/completions");
    }

    #[tokio::test]
    async fn chat_proxy_uses_configured_key_redacts_errors_and_refuses_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let redirect_target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let redirect_port = redirect_target.local_addr().unwrap().port();
        let upstream = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new(); let mut byte = [0u8; 1];
            while !bytes.ends_with(b"\r\n\r\n") { socket.read_exact(&mut byte).await.unwrap(); bytes.push(byte[0]); }
            let headers = String::from_utf8(bytes).unwrap();
            assert!(headers.contains("authorization: Bearer selected-key"));
            assert!(!headers.contains("caller-secret"));
            let len: usize = headers.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap();
            let mut body = vec![0; len]; socket.read_exact(&mut body).await.unwrap();
            let body = "selected-key private-upstream-error";
            socket.write_all(format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{redirect_port}/steal\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let proxy = ChatCompatProxy::start(format!("http://127.0.0.1:{port}/v1"), HashMap::from([("OPENAI_API_KEY".into(), "selected-key".into())]), false).unwrap();
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let response = client.post(format!("{}/responses", proxy.base_url())).header("authorization", "Bearer caller-secret").json(&json!({"model":"m","input":"hi"})).send().await.unwrap();
        assert_eq!(response.status().as_u16(), 302);
        assert!(response.headers().get("location").is_none());
        let body = response.text().await.unwrap();
        assert!(!body.contains("selected-key")); assert!(!body.contains("private-upstream-error"));
        assert!(tokio::time::timeout(std::time::Duration::from_millis(100), redirect_target.accept()).await.is_err());
        upstream.await.unwrap(); proxy.close();
    }

    #[tokio::test]
    async fn proxy_checks_capability_before_waiting_for_declared_body() {
        let proxy = ChatCompatProxy::start("https://example.invalid/v1".into(), HashMap::new(), false).unwrap();
        let url = reqwest::Url::parse(&proxy.base_url()).unwrap();
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", url.port().unwrap())).await.unwrap();
        socket.write_all(b"POST /wrong/v1/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 20971520\r\n\r\n").await.unwrap();
        let mut response = [0u8; 256];
        let read = tokio::time::timeout(std::time::Duration::from_secs(1), socket.read(&mut response)).await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&response[..read]).contains("404"));
        proxy.close();
    }

    fn sample_tools() -> Value {
        json!([
            {
                "type": "function",
                "name": "agenthub_delegate",
                "description": "Dispatch a task.",
                "parameters": { "type": "object", "properties": { "memberId": { "type": "string" } } }
            },
            {
                "type": "namespace",
                "name": "multi_agent_v1",
                "description": "Multi-agent",
                "tools": [
                    {
                        "type": "function",
                        "name": "spawn_agent",
                        "description": "Spawn a sub-agent.",
                        "parameters": { "type": "object", "properties": { "task": { "type": "string" } } }
                    }
                ]
            }
        ])
    }

    /// Namespace tool groups (codex multi_agent_v1 / MCP servers) must be
    /// flattened into plain chat functions, otherwise the chat-wire model never
    /// sees sub-agent dispatch tools like `spawn_agent`.
    #[test]
    fn chat_tools_flattens_namespace_sub_tools() {
        let chat = chat_tools(Some(&sample_tools()));
        let names: Vec<String> = chat
            .iter()
            .filter_map(|t| t.get("function").and_then(|f| f.get("name")).and_then(Value::as_str).map(str::to_string))
            .collect();
        assert!(names.contains(&"agenthub_delegate".to_string()), "regular function must survive");
        assert!(names.contains(&"multi_agent_v1-spawn_agent".to_string()), "namespace sub-tool must be flattened into a chat function");
    }

    /// The response direction must re-map the hyphenated (and dotted) chat name
    /// back to the codex namespace + name pair so the CLI routes the call.
    #[test]
    fn response_tool_types_maps_namespace_and_name() {
        let types = response_tool_types(Some(&sample_tools()));
        assert_eq!(
            types.get("agenthub_delegate"),
            Some(&(String::new(), "agenthub_delegate".to_string(), "function".to_string())),
            "regular function keeps its identity"
        );
        // Both the hyphenated chat name and the dotted codex name route to the
        // same (namespace, name, function) triple: codex's MCP / multi-agent
        // handlers only accept function_call payloads.
        let expected = ("multi_agent_v1".to_string(), "spawn_agent".to_string(), "function".to_string());
        assert_eq!(
            types.get("multi_agent_v1-spawn_agent"),
            Some(&expected),
            "hyphenated chat name maps to namespace + name as a function call"
        );
        assert_eq!(
            types.get("multi_agent_v1.spawn_agent"),
            Some(&expected),
            "dotted codex name also maps to namespace + name as a function call"
        );
        assert_eq!(
            types.get("multi_agent_v1__spawn_agent"),
            Some(&expected),
            "double-underscore form maps to namespace + name"
        );
        assert_eq!(
            types.get("spawn_agent"),
            Some(&expected),
            "bare sub-tool name maps to namespace + name"
        );
    }
}

// ---------------------------------------------------------------- proxy server

pub struct ChatCompatProxy {
    base_url: String,
    connections: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    accept_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl ChatCompatProxy {
    pub fn base_url(&self) -> String {
        self.base_url.clone()
    }

    pub fn start(remote_base_url: String, environment: HashMap<String, String>, allow_native_web_search: bool) -> std::io::Result<Self> {
        Self::start_protocol(remote_base_url, environment, allow_native_web_search, false)
    }

    pub(crate) fn start_protocol(remote_base_url: String, environment: HashMap<String, String>, allow_native_web_search: bool, anthropic: bool) -> std::io::Result<Self> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let token = Uuid::new_v4().to_string();
        let base_url = format!("http://127.0.0.1:{port}/{token}/v1");
        let connections: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> = Arc::new(Mutex::new(vec![]));
        let accept_connections = connections.clone();
        let accept_task = tokio::spawn(async move {
            let listener = TcpListener::from_std(listener).expect("tokio listener");
            let config = Arc::new(ProxyConfig { remote_base_url, environment, allow_native_web_search, anthropic, token });
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        {
                            let mut connections = accept_connections.lock().unwrap();
                            connections.retain(|task| !task.is_finished());
                            if connections.len() >= 64 { continue; }
                        }
                        let config = config.clone();
                        let task = tokio::spawn(async move {
                            if !matches!(tokio::time::timeout(std::time::Duration::from_secs(630), handle_proxy_request(stream, config)).await, Ok(Ok(()))) {
                                // Never log upstream URLs, credentials or response bodies.
                                eprintln!("[nautilo-core] protocol compatibility request failed");
                            }
                        });
                        let mut connections = accept_connections.lock().unwrap();
                        connections.retain(|task| !task.is_finished());
                        connections.push(task);
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self { base_url, connections, accept_task: Mutex::new(Some(accept_task)) })
    }

    pub fn close(&self) {
        if let Some(task) = self.accept_task.lock().unwrap().take() {
            task.abort();
        }
        for task in self.connections.lock().unwrap().drain(..) {
            task.abort();
        }
    }
}

impl Drop for ChatCompatProxy {
    fn drop(&mut self) {
        self.close();
    }
}

struct ProxyConfig {
    remote_base_url: String,
    environment: HashMap<String, String>,
    allow_native_web_search: bool,
    anthropic: bool,
    token: String,
}

async fn handle_proxy_request(stream: tokio::net::TcpStream, config: Arc<ProxyConfig>) -> anyhow::Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    // Request line + headers + content-length body (loopback, single request).
    let mut header_bytes: Vec<u8> = vec![];
    let mut byte = [0u8; 1];
    let header_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while !header_bytes.ends_with(b"\r\n\r\n") {
        if !matches!(tokio::time::timeout_at(header_deadline, reader.read_exact(&mut byte)).await, Ok(Ok(_))) {
            return Ok(());
        }
        header_bytes.push(byte[0]);
        if header_bytes.len() > 64 * 1024 {
            return Ok(());
        }
    }
    let headers = String::from_utf8_lossy(&header_bytes).to_string();
    let mut lines = headers.lines();
    let request_line = lines.next().unwrap_or("");
    let method = request_line.split_whitespace().next().unwrap_or("");
    let target = request_line.split_whitespace().nth(1).unwrap_or("");
    if method != "POST" || target.trim_end_matches('/') != format!("/{}/v1/responses", config.token) {
        return write_json_error(&mut writer, 404, "Responses compatibility endpoint not found").await;
    }
    let mut content_length = 0usize;
    let mut saw_length = false;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                if saw_length { return write_json_error(&mut writer, 400, "Duplicate Content-Length").await; }
                saw_length = true;
                content_length = match value.trim().parse() {
                    Ok(length) => length,
                    Err(_) => return write_json_error(&mut writer, 400, "Invalid Content-Length").await,
                };
            }
            if name.trim().eq_ignore_ascii_case("transfer-encoding") {
                return write_json_error(&mut writer, 400, "Chunked request bodies are unsupported").await;
            }
        }
    }
    if content_length > 20 * 1024 * 1024 {
        return write_json_error(&mut writer, 413, "Request exceeds size limit").await;
    }
    let mut body = vec![0u8; content_length];
    if !matches!(tokio::time::timeout(std::time::Duration::from_secs(30), reader.read_exact(&mut body)).await, Ok(Ok(_))) {
        return write_json_error(&mut writer, 408, "Request body read timed out or was incomplete").await;
    }

    let input: Value = match serde_json::from_slice(&body) {
        Ok(input) => input,
        Err(_) => return write_json_error(&mut writer, 400, "Invalid JSON request").await,
    };
    if config.anthropic {
        let operation = handle_anthropic_request(&mut writer, &config, &input);
        let mut disconnect_buffer = [0u8; 1];
        // Dropping the request/response futures closes upstream on downstream disconnect.
        tokio::select! {
            result = operation => return result,
            _ = reader.read(&mut disconnect_buffer) => return Ok(()),
        }
    }
    let mut disconnect_buffer = [0u8; 1];
    tokio::select! {
        result = handle_chat_request(&mut writer, &config, &input) => result,
        _ = reader.read(&mut disconnect_buffer) => Ok(()),
    }
}

async fn handle_chat_request(writer: &mut tokio::net::tcp::OwnedWriteHalf, config: &ProxyConfig, input: &Value) -> anyhow::Result<()> {
    let endpoint = match chat_endpoint(&config.remote_base_url) {
        Ok(endpoint) => endpoint,
        Err(_) => return write_json_error(writer, 400, "Invalid Chat upstream URL").await,
    };
    let chat_request = responses_to_chat_request(input, config.allow_native_web_search);
    let auth = bearer(&config.environment);
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(600)).build()?;
    let mut upstream = client.post(endpoint).header("content-type", "application/json");
    if !auth.is_empty() { upstream = upstream.header("authorization", auth); }
    let remote = match upstream.json(&chat_request).send().await {
        Ok(remote) => remote,
        Err(_) => return write_json_error(writer, 502, "Chat Completions upstream connection failed").await,
    };
    if !remote.status().is_success() {
        let status = remote.status().as_u16();
        return write_json_error(writer, status, "Chat Completions upstream rejected the request; check endpoint, model and API key").await;
    }
    writer.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n").await?;
    write_responses_stream(remote, writer, input).await?;
    writer.write_all(b"0\r\n\r\n").await?;
    writer.flush().await?;
    Ok(())
}

async fn handle_anthropic_request(writer: &mut tokio::net::tcp::OwnedWriteHalf, config: &ProxyConfig, input: &Value) -> anyhow::Result<()> {
    let body = match super::anthropic_compat::request(input) {
        Ok(body) => body,
        Err(error) => {
            return write_json_error(writer, 400, &error.to_string()).await;
        },
    };
    let endpoint = super::anthropic_compat::endpoint(&config.remote_base_url)?;
    let key = config.environment.get("ANTHROPIC_API_KEY")
        .or_else(|| config.environment.get("OPENAI_API_KEY"))
        .or_else(|| config.environment.get("CODEX_API_KEY"))
        .or_else(|| config.environment.get("AGENTHUB_API_KEY"));
    let Some(key) = key.filter(|key| !key.trim().is_empty()) else {
        return write_json_error(writer, 401, "Anthropic bridge requires an explicitly configured API key").await;
    };
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(600)).build()?;
    let remote = match client.post(endpoint).header("x-api-key", key).header("anthropic-version", "2023-06-01").json(&body).send().await {
        Ok(remote) => remote,
        Err(_) => return write_json_error(writer, 502, "Anthropic upstream connection failed").await,
    };
    if !remote.status().is_success() {
        return write_json_error(writer, remote.status().as_u16(), "Anthropic upstream rejected the request; check endpoint, model and API key").await;
    }
    writer.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n").await?;
    super::anthropic_compat::stream(remote, writer, input).await?;
    writer.write_all(b"0\r\n\r\n").await?;
    writer.flush().await?;
    Ok(())
}

async fn write_json_error(writer: &mut tokio::net::tcp::OwnedWriteHalf, status: u16, message: &str) -> anyhow::Result<()> {
    let reason = if status == 404 { "Not Found" } else { "Bad Gateway" };
    let body = json!({ "error": { "message": message, "type": "invalid_request_error" } }).to_string();
    writer
        .write_all(
            format!("HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body)
                .as_bytes(),
        )
        .await?;
    writer.flush().await?;
    Ok(())
}

pub(super) async fn write_sse(writer: &mut tokio::net::tcp::OwnedWriteHalf, event: &str, value: &Value) -> anyhow::Result<()> {
    let payload = format!("event: {event}\ndata: {}\n\n", value);
    writer.write_all(format!("{:x}\r\n", payload.len()).as_bytes()).await?;
    writer.write_all(payload.as_bytes()).await?;
    writer.write_all(b"\r\n").await?;
    Ok(())
}

fn chat_endpoint(base_url: &str) -> anyhow::Result<String> {
    // Share URL security policy, but retain Chat Completions endpoint semantics.
    super::anthropic_compat::endpoint(base_url)?;
    let normalized = base_url.trim_end_matches('/');
    Ok(if normalized.to_lowercase().ends_with("/chat/completions") {
        normalized.to_string()
    } else {
        format!("{normalized}/chat/completions")
    })
}

fn bearer(environment: &HashMap<String, String>) -> String {
    let key = environment
        .get("OPENAI_API_KEY")
        .or_else(|| environment.get("CODEX_API_KEY"))
        .or_else(|| environment.get("AGENTHUB_API_KEY"));
    key.map(|k| format!("Bearer {k}")).unwrap_or_default()
}

// ---------------------------------------------------------------- Responses -> Chat

fn responses_to_chat_request(input: &Value, allow_native_web_search: bool) -> Value {
    let mut messages: Vec<Value> = vec![];
    if let Some(instructions) = input.get("instructions").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        messages.push(json!({ "role": "system", "content": instructions }));
    }
    match input.get("input") {
        Some(Value::String(text)) => messages.push(json!({ "role": "user", "content": text })),
        Some(Value::Array(items)) => append_input_messages(&mut messages, items),
        _ => {}
    }
    let mut request = Map::new();
    if let Some(model) = input.get("model").and_then(Value::as_str) {
        request.insert("model".to_string(), json!(model));
    }
    request.insert("messages".to_string(), Value::Array(messages));
    request.insert("stream".to_string(), json!(true));
    for (from, to) in [("temperature", "temperature"), ("top_p", "top_p")] {
        if let Some(value) = input.get(from).filter(|v| v.is_number()) {
            request.insert(to.to_string(), value.clone());
        }
    }
    if let Some(value) = input.get("max_output_tokens").filter(|v| v.is_number()) {
        request.insert("max_tokens".to_string(), value.clone());
    }
    let reasoning_effort = input
        .get("reasoning")
        .and_then(|r| r.get("effort"))
        .and_then(Value::as_str)
        .or_else(|| input.get("reasoning_effort").and_then(Value::as_str));
    if let Some(effort) = reasoning_effort {
        request.insert("reasoning_effort".to_string(), json!(effort));
    }
    if let Some(tier) = input.get("service_tier").and_then(Value::as_str) {
        request.insert("service_tier".to_string(), json!(tier));
    }
    if let Some(value) = input.get("parallel_tool_calls") {
        if !value.is_null() {
            request.insert("parallel_tool_calls".to_string(), value.clone());
        }
    }
    let format = input.get("text").and_then(|t| t.get("format"));
    match format.and_then(|f| f.get("type")).and_then(Value::as_str) {
        Some("json_object") => {
            request.insert("response_format".to_string(), json!({ "type": "json_object" }));
        }
        Some("json_schema") => {
            request.insert("response_format".to_string(), json!({ "type": "json_schema", "json_schema": format }));
        }
        _ => {}
    }
    let tools = chat_tools(input.get("tools"));
    if !tools.is_empty() {
        request.insert("tools".to_string(), Value::Array(tools));
    }
    if allow_native_web_search && has_web_search_tool(input.get("tools")) {
        request.insert("web_search_options".to_string(), json!({ "search_context_size": "high" }));
    }
    if let Some(choice) = input.get("tool_choice") {
        if !choice.is_null() {
            request.insert("tool_choice".to_string(), chat_tool_choice(choice));
        }
    }
    Value::Object(request)
}

fn append_input_messages(messages: &mut Vec<Value>, items: &[Value]) {
    let mut pending_text = String::new();
    let mut pending_reasoning = String::new();
    let mut pending_assistant_content: Option<Value> = None;
    let mut pending_tool_calls: Vec<Value> = vec![];

    let flush_text = |messages: &mut Vec<Value>, pending_text: &mut String| {
        if !pending_text.is_empty() {
            messages.push(json!({ "role": "user", "content": pending_text.clone() }));
            pending_text.clear();
        }
    };
    let mut flush_assistant = |messages: &mut Vec<Value>,
                               pending_reasoning: &mut String,
                               pending_assistant_content: &mut Option<Value>,
                               pending_tool_calls: &mut Vec<Value>| {
        if pending_reasoning.is_empty() && pending_assistant_content.is_none() && pending_tool_calls.is_empty() {
            return;
        }
        let mut message = Map::new();
        message.insert("role".to_string(), json!("assistant"));
        message.insert(
            "content".to_string(),
            pending_assistant_content.clone().unwrap_or(if pending_tool_calls.is_empty() { json!("") } else { Value::Null }),
        );
        if !pending_reasoning.is_empty() {
            message.insert("reasoning_content".to_string(), json!(pending_reasoning.clone()));
        }
        if !pending_tool_calls.is_empty() {
            message.insert("tool_calls".to_string(), Value::Array(std::mem::take(pending_tool_calls)));
        }
        pending_reasoning.clear();
        *pending_assistant_content = None;
        messages.push(Value::Object(message));
    };

    for raw in items {
        if let Value::String(text) = raw {
            flush_assistant(messages, &mut pending_reasoning, &mut pending_assistant_content, &mut pending_tool_calls);
            pending_text.push_str(text);
            continue;
        }
        let Some(item) = raw.as_object() else { continue };
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
        match item_type {
            "input_text" | "text" => {
                flush_assistant(messages, &mut pending_reasoning, &mut pending_assistant_content, &mut pending_tool_calls);
                pending_text.push_str(item.get("text").and_then(Value::as_str).unwrap_or(""));
            }
            "reasoning" => {
                flush_text(messages, &mut pending_text);
                pending_reasoning.push_str(&reasoning_summary(raw));
            }
            "function_call_output" | "custom_tool_call_output" => {
                flush_text(messages, &mut pending_text);
                flush_assistant(messages, &mut pending_reasoning, &mut pending_assistant_content, &mut pending_tool_calls);
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": item.get("call_id").and_then(Value::as_str)
                        .or_else(|| item.get("id").and_then(Value::as_str))
                        .map(str::to_string)
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    "content": item.get("output").and_then(Value::as_str).map(str::to_string)
                        .unwrap_or_else(|| item.get("output").cloned().unwrap_or(Value::Null).to_string())
                }));
            }
            "function_call" => {
                flush_text(messages, &mut pending_text);
                pending_tool_calls.push(json!({
                    "id": item.get("call_id").and_then(Value::as_str)
                        .or_else(|| item.get("id").and_then(Value::as_str))
                        .map(str::to_string)
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    "type": "function",
                    "function": {
                        "name": item.get("name").and_then(Value::as_str).unwrap_or("function"),
                        "arguments": item.get("arguments").and_then(Value::as_str).unwrap_or("{}")
                    }
                }));
            }
            "custom_tool_call" => {
                flush_text(messages, &mut pending_text);
                pending_tool_calls.push(json!({
                    "id": item.get("call_id").and_then(Value::as_str)
                        .or_else(|| item.get("id").and_then(Value::as_str))
                        .map(str::to_string)
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    "type": "function",
                    "function": {
                        "name": item.get("name").and_then(Value::as_str).unwrap_or("function"),
                        "arguments": json!({ "input": item.get("input").and_then(Value::as_str).unwrap_or("") }).to_string()
                    }
                }));
            }
            _ if item_type == "message" || item.get("role").is_some() => {
                flush_text(messages, &mut pending_text);
                let role = match item.get("role").and_then(Value::as_str) {
                    Some("assistant") => "assistant",
                    Some("system") => "system",
                    _ => "user",
                };
                let content = chat_content(item.get("content").or_else(|| item.get("text")).unwrap_or(&Value::Null));
                let reasoning_content = if role == "assistant" {
                    item.get("reasoning_content").and_then(Value::as_str).map(str::to_string)
                } else {
                    None
                };
                if role == "assistant" && (!pending_reasoning.is_empty() || !pending_tool_calls.is_empty()) {
                    if let Some(content) = content {
                        pending_assistant_content = Some(merge_chat_content(pending_assistant_content.take(), content));
                    }
                    if let Some(reasoning) = reasoning_content {
                        pending_reasoning.push_str(&reasoning);
                    }
                    continue;
                }
                flush_assistant(messages, &mut pending_reasoning, &mut pending_assistant_content, &mut pending_tool_calls);
                let keep = content.as_ref().is_some_and(|c| {
                    role != "assistant" || reasoning_content.is_some() || !(c.is_string() && c.as_str() == Some(""))
                });
                if let (true, Some(content)) = (keep, content) {
                    let mut message = Map::new();
                    message.insert("role".to_string(), json!(role));
                    message.insert("content".to_string(), content);
                    if let Some(reasoning) = reasoning_content {
                        message.insert("reasoning_content".to_string(), json!(reasoning));
                    }
                    messages.push(Value::Object(message));
                }
            }
            _ => {}
        }
    }
    flush_text(messages, &mut pending_text);
    flush_assistant(messages, &mut pending_reasoning, &mut pending_assistant_content, &mut pending_tool_calls);
}

fn reasoning_summary(item: &Value) -> String {
    item.get("summary")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| {
                    if let Some(text) = part.as_str() {
                        Some(text.to_string())
                    } else {
                        part.get("text").and_then(Value::as_str).map(str::to_string)
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn merge_chat_content(current: Option<Value>, next: Value) -> Value {
    match (current, next) {
        (None, next) => next,
        (Some(Value::String(a)), Value::String(b)) => json!(format!("{a}{b}")),
        (Some(current), next) => {
            let mut parts: Vec<Value> = match current {
                Value::String(text) => vec![json!({ "type": "text", "text": text })],
                Value::Array(items) => items,
                other => vec![other],
            };
            match next {
                Value::String(text) => parts.push(json!({ "type": "text", "text": text })),
                Value::Array(items) => parts.extend(items),
                other => parts.push(other),
            }
            Value::Array(parts)
        }
    }
}

fn chat_content(value: &Value) -> Option<Value> {
    if let Some(text) = value.as_str() {
        return Some(json!(text));
    }
    let parts = value.as_array()?;
    let mut content: Vec<Value> = vec![];
    for part in parts {
        match part.get("type").and_then(Value::as_str).unwrap_or("") {
            "input_text" | "output_text" | "text" => {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    content.push(json!({ "type": "text", "text": text }));
                }
            }
            "input_image" | "image_url" => {
                let url = part
                    .get("image_url")
                    .and_then(|image| image.as_str().map(str::to_string).or_else(|| image.get("url").and_then(Value::as_str).map(str::to_string)));
                if let Some(url) = url {
                    content.push(json!({ "type": "image_url", "image_url": { "url": url } }));
                }
            }
            _ => {}
        }
    }
    if content.is_empty() {
        None
    } else {
        Some(Value::Array(content))
    }
}

pub(super) fn chat_tools(value: Option<&Value>) -> Vec<Value> {
    let Some(tools) = value.and_then(Value::as_array) else {
        return vec![];
    };
    let mut result = vec![];
    for tool in tools {
        match tool.get("type").and_then(Value::as_str).unwrap_or("") {
            "function" if tool.get("name").and_then(Value::as_str).is_some() => {
                result.push(json!({
                    "type": "function",
                    "function": {
                        "name": tool.get("name"),
                        "description": tool.get("description"),
                        "parameters": tool.get("parameters").cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} }))
                    }
                }));
            }
            "custom" if tool.get("name").and_then(Value::as_str).is_some() => {
                let grammar = tool.get("format").and_then(|f| f.get("definition")).and_then(Value::as_str);
                result.push(json!({
                    "type": "function",
                    "function": {
                        "name": tool.get("name"),
                        "description": tool.get("description"),
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "input": {
                                    "type": "string",
                                    "description": grammar
                                        .map(|g| format!("Freeform tool input. It must follow this grammar:\n{g}"))
                                        .unwrap_or_else(|| "Freeform tool input.".to_string())
                                }
                            },
                            "required": ["input"],
                            "additionalProperties": false
                        }
                    }
                }));
            }
            "namespace" if tool.get("name").and_then(Value::as_str).is_some() => {
                // Namespaced tool groups (codex built-ins like multi_agent_v1
                // and MCP servers) must be flattened into plain chat functions;
                // chat tool names reject dots, so use a hyphen join and keep
                // the mapping for the response direction in response_tool_types.
                let namespace = tool.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                let namespace_description = tool.get("description").and_then(Value::as_str).map(str::to_string);
                for sub in tool.get("tools").and_then(Value::as_array).cloned().unwrap_or_default() {
                    let sub_type = sub.get("type").and_then(Value::as_str).unwrap_or("");
                    let Some(sub_name) = sub.get("name").and_then(Value::as_str) else {
                        continue;
                    };
                    let chat_name = format!("{namespace}-{sub_name}");
                    let description = match (&namespace_description, sub.get("description").and_then(Value::as_str)) {
                        (Some(ns), Some(sub_desc)) => format!("[{namespace}] {sub_desc}"),
                        (Some(ns), None) => format!("[{namespace}]"),
                        (None, Some(sub_desc)) => sub_desc.to_string(),
                        (None, None) => String::new(),
                    };
                    // Chat relays reject dotted tool names, so the namespace was
                    // flattened to a hyphenated name. Tell the model the exact
                    // callable name explicitly; models otherwise default to the
                    // codex dotted convention (e.g. mcp__firecrawl.search) and
                    // fail the call.
                    let description = format!("{description}\n\nCall this tool with the exact name `{chat_name}` (hyphen, not dot).");
                    if sub_type == "function" {
                        result.push(json!({
                            "type": "function",
                            "function": {
                                "name": chat_name,
                                "description": description,
                                "parameters": sub.get("parameters").cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} }))
                            }
                        }));
                    } else if sub_type == "custom" {
                        let grammar = sub.get("format").and_then(|f| f.get("definition")).and_then(Value::as_str);
                        result.push(json!({
                            "type": "function",
                            "function": {
                                "name": chat_name,
                                "description": description,
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "input": {
                                            "type": "string",
                                            "description": grammar
                                                .map(|g| format!("Freeform tool input. It must follow this grammar:\n{g}"))
                                                .unwrap_or_else(|| "Freeform tool input.".to_string())
                                        }
                                    },
                                    "required": ["input"],
                                    "additionalProperties": false
                                }
                            }
                        }));
                    }
                }
            }
            _ => {}
        }
    }
    result
}

fn chat_tool_choice(value: &Value) -> Value {
    let choice_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    if choice_type != "function" && choice_type != "custom" {
        return value.clone();
    }
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| value.get("function").and_then(|f| f.get("name")).and_then(Value::as_str));
    match name {
        Some(name) => json!({ "type": "function", "function": { "name": name } }),
        None => value.clone(),
    }
}

/// Registry of chat-side tool names -> (codex namespace, codex name, wire type).
///
/// Namespaced tools (multi_agent_v1.*, mcp__*) are exposed to the chat model
/// as `{namespace}-{sub}` functions and come back to codex as `function_call`
/// items carrying the separate `namespace` and `name` fields. Codex routes on
/// the ToolName split (a single flattened name is never found) and its MCP /
/// multi-agent handlers only accept `ToolPayload::Function`, so the call-back
/// must be a function_call (not custom_tool_call). Both the hyphenated chat
/// name and the dotted codex name are registered so whichever the model calls,
/// the call-back routes correctly.
pub(super) fn response_tool_types(value: Option<&Value>) -> HashMap<String, (String, String, String)> {
    let mut result = HashMap::new();
    let Some(tools) = value.and_then(Value::as_array) else {
        return result;
    };
    for tool in tools {
        let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
        let tool_type = tool.get("type").and_then(Value::as_str).unwrap_or("");
        match tool_type {
            "function" | "custom" if !name.is_empty() => {
                result.insert(name.to_string(), (String::new(), name.to_string(), tool_type.to_string()));
            }
            "namespace" if !name.is_empty() => {
                let namespace = name;
                if let Some(subs) = tool.get("tools").and_then(Value::as_array) {
                    for sub in subs {
                        let sub_type = sub.get("type").and_then(Value::as_str).unwrap_or("");
                        let Some(sub_name) = sub.get("name").and_then(Value::as_str) else {
                            continue;
                        };
                        if sub_type == "function" || sub_type == "custom" {
                            let chat_name = format!("{namespace}-{sub_name}");
                            let codex_name = format!("{namespace}.{sub_name}");
                            let double_underscore = format!("{namespace}__{sub_name}");
                            let value = (namespace.to_string(), sub_name.to_string(), "function".to_string());
                            result.insert(chat_name, value.clone());
                            result.insert(codex_name, value.clone());
                            result.insert(double_underscore, value.clone());
                            // Models frequently drop the namespace prefix and call
                            // the bare sub-tool name; register that alias too unless
                            // another tool already owns it (ambiguous otherwise).
                            if !result.contains_key(sub_name) {
                                result.insert(sub_name.to_string(), value);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    result
}

fn has_web_search_tool(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .map(|tools| {
            tools.iter().any(|tool| {
                matches!(tool.get("type").and_then(Value::as_str), Some("web_search_preview" | "web_search"))
            })
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------- Chat -> Responses stream

struct ResponseContext {
    response_id: String,
    message_id: String,
    reasoning_id: String,
    model: String,
    created_at: i64,
    text: String,
    annotations: Vec<Value>,
    reasoning: String,
    reasoning_started: bool,
    message_started: bool,
    usage: Value,
    tool_calls: HashMap<i64, FunctionCallContext>,
    output: Vec<Value>,
}

struct FunctionCallContext {
    index: i64,
    item_id: String,
    call_id: String,
    name: String,
    namespace: String,
    arguments: String,
    output_index: i64,
    started: bool,
    tool_type: String,
}

async fn write_responses_stream(
    mut remote: reqwest::Response,
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    request: &Value,
) -> anyhow::Result<()> {
    let mut context = ResponseContext {
        response_id: format!("resp-{}", Uuid::new_v4()),
        message_id: format!("msg-{}", Uuid::new_v4()),
        reasoning_id: format!("rsn-{}", Uuid::new_v4()),
        model: request.get("model").and_then(Value::as_str).unwrap_or("unknown").to_string(),
        created_at: chrono::Utc::now().timestamp(),
        text: String::new(),
        annotations: vec![],
        reasoning: String::new(),
        reasoning_started: false,
        message_started: false,
        usage: Value::Null,
        tool_calls: HashMap::new(),
        output: vec![],
    };
    let tool_types = response_tool_types(request.get("tools"));
    write_sse(writer, "response.created", &json!({ "type": "response.created", "response": response_object(&context, "in_progress") })).await?;

    let content_type = remote
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    const LIMIT: usize = 20 * 1024 * 1024;
    anyhow::ensure!(remote.content_length().is_none_or(|size| size <= LIMIT as u64), "Upstream response exceeds size limit");
    let mut total = 0usize;
    if !content_type.contains("text/event-stream") {
        let mut bytes = Vec::new();
        while let Some(chunk) = remote.chunk().await? {
            total += chunk.len();
            anyhow::ensure!(total <= LIMIT, "Upstream response exceeds size limit");
            bytes.extend_from_slice(&chunk);
        }
        let body: Value = serde_json::from_slice(&bytes)?;
        anyhow::ensure!(body.get("error").is_none_or(Value::is_null), "Upstream returned an error");
        process_chat_chunk(&body, &mut context, writer, &tool_types).await?;
    } else {
        let mut decoder = super::anthropic_compat::SseDecoder::default();
        let mut finished = false;
        while let Some(chunk) = remote.chunk().await? {
            total += chunk.len();
            anyhow::ensure!(total <= LIMIT, "Upstream response exceeds size limit");
            for payload in decoder.feed(&chunk)? {
                if payload.trim() == "[DONE]" { finished = true; continue; }
                let chunk: Value = serde_json::from_str(&payload)?;
                anyhow::ensure!(chunk.get("error").is_none_or(Value::is_null), "Upstream returned an error");
                if chunk.pointer("/choices/0/finish_reason").is_some_and(|value| !value.is_null()) { finished = true; }
                process_chat_chunk(&chunk, &mut context, writer, &tool_types).await?;
            }
        }
        anyhow::ensure!(finished, "Upstream stream ended without completion");
    }

    finalize_responses_stream(&mut context, writer).await
}

fn response_object(context: &ResponseContext, status: &str) -> Value {
    json!({
        "id": context.response_id,
        "object": "response",
        "created_at": context.created_at,
        "status": status,
        "model": context.model,
        "output": context.output,
        "output_text": context.text,
        "error": null,
        "incomplete_details": null,
        "usage": context.usage,
        "metadata": {}
    })
}

fn message_output_index(context: &ResponseContext) -> i64 {
    (if context.reasoning_started { 1 } else { 0 }) + context.tool_calls.len() as i64
}

async fn process_chat_chunk(
    chunk: &Value,
    context: &mut ResponseContext,
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    tool_types: &HashMap<String, (String, String, String)>,
) -> anyhow::Result<()> {
    let choice = chunk.get("choices").and_then(Value::as_array).and_then(|c| c.first()).cloned().unwrap_or(Value::Null);
    let delta = choice.get("delta").cloned().unwrap_or(Value::Null);
    let completed_message = choice.get("message").cloned().unwrap_or(Value::Null);
    let reasoning = delta
        .get("reasoning_content")
        .and_then(Value::as_str)
        .or_else(|| delta.get("reasoning").and_then(Value::as_str))
        .or_else(|| completed_message.get("reasoning_content").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    if !reasoning.is_empty() {
        ensure_reasoning_started(writer, context).await?;
        context.reasoning.push_str(&reasoning);
        write_sse(writer, "response.reasoning_summary_text.delta", &json!({
            "type": "response.reasoning_summary_text.delta",
            "item_id": context.reasoning_id,
            "output_index": 0,
            "summary_index": 0,
            "delta": reasoning
        }))
        .await?;
    }
    let tool_call_value = delta.get("tool_calls").or_else(|| completed_message.get("tool_calls")).cloned();
    if let Some(Value::Array(calls)) = tool_call_value {
        for call in &calls {
            append_function_call_delta(writer, context, call, tool_types).await?;
        }
    }
    if let Some(annotations) = delta.get("annotations").or_else(|| completed_message.get("annotations")).and_then(Value::as_array) {
        context.annotations.extend(annotations.iter().cloned());
    }
    if let Some(text) = delta.get("content").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        ensure_message_started(writer, context).await?;
        context.text.push_str(text);
        let output_index = message_output_index(context);
        write_sse(writer, "response.output_text.delta", &json!({
            "type": "response.output_text.delta",
            "item_id": context.message_id,
            "output_index": output_index,
            "content_index": 0,
            "delta": text
        }))
        .await?;
    }
    if let Some(usage) = chunk.get("usage").filter(|u| u.is_object()) {
        context.usage = responses_usage(usage);
    }
    Ok(())
}

async fn ensure_reasoning_started(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    context: &mut ResponseContext,
) -> anyhow::Result<()> {
    if context.reasoning_started {
        return Ok(());
    }
    context.reasoning_started = true;
    write_sse(writer, "response.output_item.added", &json!({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": { "id": context.reasoning_id, "type": "reasoning", "status": "in_progress", "summary": [] }
    }))
    .await?;
    write_sse(writer, "response.reasoning_summary_part.added", &json!({
        "type": "response.reasoning_summary_part.added",
        "item_id": context.reasoning_id,
        "output_index": 0,
        "summary_index": 0,
        "part": { "type": "summary_text", "text": "" }
    }))
    .await?;
    Ok(())
}

async fn ensure_message_started(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    context: &mut ResponseContext,
) -> anyhow::Result<()> {
    if context.message_started {
        return Ok(());
    }
    context.message_started = true;
    let output_index = message_output_index(context);
    write_sse(writer, "response.output_item.added", &json!({
        "type": "response.output_item.added",
        "output_index": output_index,
        "item": { "id": context.message_id, "type": "message", "status": "in_progress", "role": "assistant", "content": [] }
    }))
    .await?;
    write_sse(writer, "response.content_part.added", &json!({
        "type": "response.content_part.added",
        "item_id": context.message_id,
        "output_index": output_index,
        "content_index": 0,
        "part": { "type": "output_text", "text": "", "annotations": [] }
    }))
    .await?;
    Ok(())
}

async fn append_function_call_delta(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    context: &mut ResponseContext,
    value: &Value,
    tool_types: &HashMap<String, (String, String, String)>,
) -> anyhow::Result<()> {
    let function = value.get("function").cloned().unwrap_or(Value::Null);
    let index = value.get("index").and_then(as_number).unwrap_or(context.tool_calls.len() as i64);
    let incoming_name = function.get("name").and_then(Value::as_str).map(str::to_string);
    if !context.tool_calls.contains_key(&index) {
        let name = incoming_name.clone().unwrap_or_else(|| "function".to_string());
        // Chat-side name -> (codex namespace, codex name, wire type). Namespaced
        // tools are re-mapped so the codex CLI receives a `custom_tool_call`
        // with the separate `namespace`/`name` fields it routes on.
        let (namespace, codex_name, tool_type) = tool_types
            .get(&name)
            .cloned()
            .unwrap_or_else(|| (String::new(), name.clone(), "function".to_string()));
        let call_id = value
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("call-{}", Uuid::new_v4()));
        let output_index = (if context.reasoning_started { 1 } else { 0 }) + context.tool_calls.len() as i64;
        context.tool_calls.insert(
            index,
            FunctionCallContext {
                index,
                item_id: format!("fc-{}", Uuid::new_v4()),
                call_id,
                name: codex_name,
                namespace,
                arguments: String::new(),
                output_index,
                started: false,
                tool_type,
            },
        );
    }
    let (item_id, call_id, name, namespace, output_index, tool_type, started) = {
        let call = context.tool_calls.get_mut(&index).unwrap();
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            call.call_id = id.to_string();
        }
        if let Some(name) = &incoming_name {
            if let Some((ns, codex_name, mapped)) = tool_types.get(name) {
                call.namespace = ns.clone();
                call.name = codex_name.clone();
                call.tool_type = mapped.clone();
            }
        }
        (
            call.item_id.clone(),
            call.call_id.clone(),
            call.name.clone(),
            call.namespace.clone(),
            call.output_index,
            call.tool_type.clone(),
            call.started,
        )
    };
    if !started {
        context.tool_calls.get_mut(&index).unwrap().started = true;
        let item = if tool_type == "custom" {
            let mut value = json!({ "id": item_id, "type": "custom_tool_call", "status": "in_progress", "call_id": call_id, "name": name, "input": "" });
            if !namespace.is_empty() {
                value.as_object_mut().unwrap().insert("namespace".to_string(), json!(namespace));
            }
            value
        } else {
            let mut value = json!({ "id": item_id, "type": "function_call", "status": "in_progress", "call_id": call_id, "name": name, "arguments": "" });
            if !namespace.is_empty() {
                value.as_object_mut().unwrap().insert("namespace".to_string(), json!(namespace));
            }
            value
        };
        write_sse(writer, "response.output_item.added", &json!({
            "type": "response.output_item.added",
            "output_index": output_index,
            "item": item
        }))
        .await?;
    }
    let Some(argument_delta) = function.get("arguments").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    context.tool_calls.get_mut(&index).unwrap().arguments.push_str(argument_delta);
    if tool_type == "custom" {
        return Ok(());
    }
    write_sse(writer, "response.function_call_arguments.delta", &json!({
        "type": "response.function_call_arguments.delta",
        "item_id": item_id,
        "output_index": output_index,
        "delta": argument_delta
    }))
    .await?;
    Ok(())
}

fn custom_tool_input(arguments: &str) -> String {
    let parsed: Value = serde_json::from_str(arguments).unwrap_or(Value::Null);
    if let Some(text) = parsed.as_str() {
        return text.to_string();
    }
    parsed
        .get("input")
        .and_then(Value::as_str)
        .or_else(|| parsed.get("command").and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or_else(|| arguments.to_string())
}

async fn finalize_responses_stream(
    context: &mut ResponseContext,
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
) -> anyhow::Result<()> {
    if context.reasoning_started {
        write_sse(writer, "response.reasoning_summary_text.done", &json!({
            "type": "response.reasoning_summary_text.done",
            "item_id": context.reasoning_id,
            "output_index": 0,
            "summary_index": 0,
            "text": context.reasoning
        }))
        .await?;
        write_sse(writer, "response.reasoning_summary_part.done", &json!({
            "type": "response.reasoning_summary_part.done",
            "item_id": context.reasoning_id,
            "output_index": 0,
            "summary_index": 0,
            "part": { "type": "summary_text", "text": context.reasoning }
        }))
        .await?;
        write_sse(writer, "response.output_item.done", &json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": { "id": context.reasoning_id, "type": "reasoning", "status": "completed", "summary": [{ "type": "summary_text", "text": context.reasoning }] }
        }))
        .await?;
    }
    let mut calls: Vec<(i64, String, String, String, String, String, i64, String)> = context
        .tool_calls
        .values()
        .map(|call| {
            (
                call.index,
                call.item_id.clone(),
                call.call_id.clone(),
                call.name.clone(),
                call.namespace.clone(),
                call.arguments.clone(),
                call.output_index,
                call.tool_type.clone(),
            )
        })
        .collect();
    calls.sort_by_key(|call| call.0);
    for (_, item_id, call_id, name, namespace, arguments, output_index, tool_type) in &calls {
        if tool_type == "custom" {
            let input = custom_tool_input(arguments);
            write_sse(writer, "response.custom_tool_call_input.delta", &json!({
                "type": "response.custom_tool_call_input.delta",
                "item_id": item_id,
                "output_index": output_index,
                "delta": input
            }))
            .await?;
            write_sse(writer, "response.custom_tool_call_input.done", &json!({
                "type": "response.custom_tool_call_input.done",
                "item_id": item_id,
                "output_index": output_index,
                "input": input
            }))
            .await?;
        } else {
            write_sse(writer, "response.function_call_arguments.done", &json!({
                "type": "response.function_call_arguments.done",
                "item_id": item_id,
                "output_index": output_index,
                "arguments": arguments
            }))
            .await?;
        }
        let mut item = if tool_type == "custom" {
            json!({ "id": item_id, "type": "custom_tool_call", "status": "completed", "call_id": call_id, "name": name, "input": custom_tool_input(arguments) })
        } else {
            json!({ "id": item_id, "type": "function_call", "status": "completed", "call_id": call_id, "name": name, "arguments": arguments })
        };
        if !namespace.is_empty() {
            item.as_object_mut().unwrap().insert("namespace".to_string(), json!(namespace));
        }
        write_sse(writer, "response.output_item.done", &json!({
            "type": "response.output_item.done",
            "output_index": output_index,
            "item": item
        }))
        .await?;
    }
    if context.text.is_empty() && calls.is_empty() {
        context.output = if context.reasoning_started {
            vec![json!({ "id": context.reasoning_id, "type": "reasoning", "status": "completed", "summary": [{ "type": "summary_text", "text": context.reasoning }] })]
        } else {
            vec![]
        };
        let mut failed = response_object(context, "failed");
        failed.as_object_mut().unwrap().insert(
            "error".to_string(),
            json!({
                "code": "empty_upstream_response",
                "message": "Chat Completions upstream returned neither an assistant message nor a tool call."
            }),
        );
        write_sse(writer, "response.failed", &json!({ "type": "response.failed", "response": failed })).await?;
        return Ok(());
    }
    let message = if context.message_started || !context.text.is_empty() {
        Some(json!({
            "id": context.message_id,
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": context.text, "annotations": context.annotations }]
        }))
    } else {
        None
    };
    if let Some(message) = &message {
        if !context.message_started {
            ensure_message_started(writer, context).await?;
        }
        let message_index = message_output_index(context);
        write_sse(writer, "response.output_text.done", &json!({
            "type": "response.output_text.done",
            "item_id": context.message_id,
            "output_index": message_index,
            "content_index": 0,
            "text": context.text
        }))
        .await?;
        write_sse(writer, "response.content_part.done", &json!({
            "type": "response.content_part.done",
            "item_id": context.message_id,
            "output_index": message_index,
            "content_index": 0,
            "part": { "type": "output_text", "text": context.text, "annotations": context.annotations }
        }))
        .await?;
        write_sse(writer, "response.output_item.done", &json!({
            "type": "response.output_item.done",
            "output_index": message_index,
            "item": message
        }))
        .await?;
    }
    let mut output: Vec<Value> = vec![];
    if context.reasoning_started {
        output.push(json!({ "id": context.reasoning_id, "type": "reasoning", "status": "completed", "summary": [{ "type": "summary_text", "text": context.reasoning }] }));
    }
    for (_, item_id, call_id, name, namespace, arguments, _, tool_type) in &calls {
        let mut item = if tool_type == "custom" {
            json!({ "id": item_id, "type": "custom_tool_call", "status": "completed", "call_id": call_id, "name": name, "input": custom_tool_input(arguments) })
        } else {
            json!({ "id": item_id, "type": "function_call", "status": "completed", "call_id": call_id, "name": name, "arguments": arguments })
        };
        if !namespace.is_empty() {
            item.as_object_mut().unwrap().insert("namespace".to_string(), json!(namespace));
        }
        output.push(item);
    }
    if let Some(message) = &message {
        output.push(message.clone());
    }
    context.output = output;
    write_sse(writer, "response.completed", &json!({ "type": "response.completed", "response": response_object(context, "completed") })).await?;
    Ok(())
}

fn responses_usage(usage: &Value) -> Value {
    let prompt_tokens = as_number(usage.get("prompt_tokens").unwrap_or(&Value::Null)).or_else(|| as_number(usage.get("input_tokens").unwrap_or(&Value::Null)));
    let completion_tokens = as_number(usage.get("completion_tokens").unwrap_or(&Value::Null)).or_else(|| as_number(usage.get("output_tokens").unwrap_or(&Value::Null)));
    let total_tokens = as_number(usage.get("total_tokens").unwrap_or(&Value::Null))
        .or_else(|| as_number(usage.get("totalTokens").unwrap_or(&Value::Null)))
        .or_else(|| prompt_tokens.zip(completion_tokens).map(|(a, b)| a + b));
    let prompt_details = usage.get("prompt_tokens_details").or_else(|| usage.get("input_tokens_details"));
    let completion_details = usage.get("completion_tokens_details").or_else(|| usage.get("output_tokens_details"));
    let cached = prompt_details
        .and_then(|d| as_number(d.get("cached_tokens").unwrap_or(&Value::Null)).or_else(|| as_number(d.get("cachedTokens").unwrap_or(&Value::Null))));
    let reasoning = completion_details
        .and_then(|d| as_number(d.get("reasoning_tokens").unwrap_or(&Value::Null)).or_else(|| as_number(d.get("reasoningTokens").unwrap_or(&Value::Null))));
    let mut result = Map::new();
    result.insert("input_tokens".to_string(), prompt_tokens.map(|v| json!(v)).unwrap_or(Value::Null));
    result.insert("output_tokens".to_string(), completion_tokens.map(|v| json!(v)).unwrap_or(Value::Null));
    result.insert("total_tokens".to_string(), total_tokens.map(|v| json!(v)).unwrap_or(Value::Null));
    if let Some(cached) = cached {
        result.insert("input_tokens_details".to_string(), json!({ "cached_tokens": cached }));
    }
    if let Some(reasoning) = reasoning {
        result.insert("output_tokens_details".to_string(), json!({ "reasoning_tokens": reasoning }));
    }
    Value::Object(result)
}
