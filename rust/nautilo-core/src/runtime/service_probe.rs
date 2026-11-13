//! Explicit, bounded service checks. Never call a tool, run inference, or alter native config.
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use agenthub_plugin_sdk::{event_stream::ProcessEvents, process::{self, ProcessEvent, ProcessHandle, ProcessRequest}};
use serde_json::{json, Value};
use crate::errors::now_iso;

const STEP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REPLY: usize = 2 * 1024 * 1024;
const MAX_TOOL_ROWS: usize = 200;

pub fn report(id: &str, version: &str, scope: &str) -> Value {
    json!({"subjectId":id,"configurationVersion":version,"scope":scope,"state":"passed","checkedAt":now_iso(),"elapsedMs":0,"steps":[]})
}
pub fn step(report: &mut Value, id: &str, state: &str, started: Instant, code: Option<&str>, message: Option<&str>) {
    let mut value = json!({"id":id,"state":state,"elapsedMs":started.elapsed().as_millis() as u64});
    if let Some(code) = code { value["code"] = json!(code); }
    if let Some(message) = message { value["message"] = json!(message.chars().take(1600).collect::<String>()); }
    report["steps"].as_array_mut().unwrap().push(value);
    if state == "failed" || state == "warning" && report["state"] != "failed" { report["state"] = json!(state); }
}
pub fn finish(mut report: Value, start: Instant) -> Value {
    report["elapsedMs"] = json!(start.elapsed().as_millis() as u64);
    report
}

#[derive(Debug)]
pub struct ProbeError { pub code: &'static str, pub message: String }
impl ProbeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self { Self { code, message: message.into() } }
}
fn timeout() -> ProbeError { ProbeError::new("TIMEOUT", "The service did not answer this handshake step within 15 seconds.") }

struct StdioRpc { handle: ProcessHandle, events: ProcessEvents, buffer: String, stderr: String }
impl StdioRpc {
    async fn exchange(&mut self, body: Value) -> Result<Value, ProbeError> {
        self.handle.write(&format!("{body}\n"));
        let expected = body["id"].clone();
        tokio::time::timeout(STEP_TIMEOUT, async {
            loop {
                while let Some(end) = self.buffer.find('\n') {
                    let line: String = self.buffer.drain(..=end).collect();
                    let Ok(reply) = serde_json::from_str::<Value>(line.trim()) else { continue };
                    if reply.get("method").is_some() && reply.get("id").is_some() {
                        let result = match reply["method"].as_str() {
                            Some("ping") => json!({"jsonrpc":"2.0","id":reply["id"],"result":{}}),
                            Some("roots/list") => json!({"jsonrpc":"2.0","id":reply["id"],"result":{"roots":[]}}),
                            _ => json!({"jsonrpc":"2.0","id":reply["id"],"error":{"code":-32601,"message":"Unsupported by the diagnostic client"}}),
                        };
                        self.handle.write(&format!("{result}\n"));
                    } else if reply["id"] == expected && (reply.get("result").is_some() || reply.get("error").is_some()) {
                        return rpc_result(reply);
                    }
                }
                match self.events.recv().await {
                    Some(ProcessEvent::Stdout(text)) => {
                        if self.buffer.len() + text.len() > MAX_REPLY { return Err(ProbeError::new("RESPONSE_TOO_LARGE", "The service exceeded the diagnostic response limit.")); }
                        self.buffer.push_str(&text);
                    }
                    Some(ProcessEvent::Stderr(text)) => {
                        self.stderr.push_str(&text);
                        if self.stderr.len() > 4096 { self.stderr = self.stderr.chars().rev().take(2048).collect::<String>().chars().rev().collect(); }
                    }
                    Some(ProcessEvent::Error(error)) => return Err(ProbeError::new("SPAWN_FAILED", error)),
                    Some(ProcessEvent::Timeout { .. }) => return Err(timeout()),
                    Some(ProcessEvent::Exit { exit_code, .. }) => return Err(ProbeError::new("PROCESS_EXITED", format!("MCP exited ({exit_code:?}). {}", self.stderr.trim()))),
                    None => return Err(ProbeError::new("PROCESS_EXITED", "MCP closed its output before answering.")),
                }
            }
        }).await.map_err(|_| timeout())?
    }
}
fn rpc_result(reply: Value) -> Result<Value, ProbeError> {
    if let Some(error) = reply.get("error") {
        return Err(ProbeError::new("PROTOCOL_ERROR", error["message"].as_str().unwrap_or("JSON-RPC returned an error.")));
    }
    reply.get("result").cloned().filter(Value::is_object).ok_or_else(|| ProbeError::new("PROTOCOL_ERROR", "Expected a JSON-RPC result object."))
}

struct HttpRpc { client: reqwest::Client, url: String, headers: HashMap<String, String>, session: Option<String>, protocol: Option<String> }
impl HttpRpc {
    async fn send(&mut self, body: Value) -> Result<Value, ProbeError> {
        let notification = body.get("id").is_none();
        let mut request = self.client.post(&self.url).header("Accept", "application/json, text/event-stream").json(&body);
        for (name, value) in &self.headers { request = request.header(name, value); }
        if let Some(id) = &self.session { request = request.header("Mcp-Session-Id", id); }
        if let Some(version) = &self.protocol { request = request.header("MCP-Protocol-Version", version); }
        let mut response = request.send().await.map_err(|error| ProbeError::new(if error.is_timeout() { "TIMEOUT" } else { "NETWORK_ERROR" }, "Unable to reach the MCP HTTP endpoint."))?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Err(ProbeError::new(if status == 401 || status == 403 { "AUTH_REQUIRED" } else if status == 404 { "ENDPOINT_NOT_FOUND" } else { "HTTP_ERROR" }, format!("The MCP endpoint returned HTTP {status}.")));
        }
        if let Some(id) = response.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) { self.session = Some(id.to_string()); }
        if notification { return Ok(json!({})); }
        let sse = response.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("text/event-stream"));
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ProbeError::new("NETWORK_ERROR", "The MCP response was interrupted."))? {
            if bytes.len() + chunk.len() > MAX_REPLY { return Err(ProbeError::new("RESPONSE_TOO_LARGE", "The service exceeded the diagnostic response limit.")); }
            bytes.extend_from_slice(&chunk);
            if sse {
                while let Some((end, width)) = event_boundary(&bytes) {
                    let event = String::from_utf8_lossy(&bytes[..end]);
                    let data = event.lines().filter_map(|line| line.strip_prefix("data:").map(str::trim_start)).collect::<Vec<_>>().join("\n");
                    if let Ok(reply) = serde_json::from_str::<Value>(&data) {
                        if reply["id"] == body["id"] { return rpc_result(reply); }
                    }
                    bytes.drain(..end + width);
                }
            }
        }
        let reply = serde_json::from_slice::<Value>(&bytes).map_err(|_| ProbeError::new("PROTOCOL_ERROR", "The endpoint did not return a JSON-RPC response."))?;
        if reply["id"] != body["id"] { return Err(ProbeError::new("PROTOCOL_ERROR", "The service returned a different request ID.")); }
        rpc_result(reply)
    }
    async fn close(&self) {
        if let Some(id) = &self.session {
            let mut request = self.client.delete(&self.url).header("Mcp-Session-Id", id);
            for (name, value) in &self.headers { request = request.header(name, value); }
            if let Some(version) = &self.protocol { request = request.header("MCP-Protocol-Version", version); }
            let _ = tokio::time::timeout(Duration::from_secs(2), request.send()).await;
        }
    }
}
fn event_boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    for i in 0..bytes.len() {
        if bytes[i..].starts_with(b"\n\n") { return Some((i, 2)); }
        if bytes[i..].starts_with(b"\r\n\r\n") { return Some((i, 4)); }
    }
    None
}
enum Rpc { Stdio(StdioRpc), Http(HttpRpc) }
impl Rpc {
    async fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, ProbeError> {
        let body = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        match self {
            Self::Stdio(rpc) => rpc.exchange(body).await,
            Self::Http(rpc) => tokio::time::timeout(STEP_TIMEOUT, rpc.send(body)).await.map_err(|_| timeout())?,
        }
    }
    async fn initialized(&mut self, version: &str) -> Result<(), ProbeError> {
        let body = json!({"jsonrpc":"2.0","method":"notifications/initialized"});
        match self {
            Self::Stdio(rpc) => rpc.handle.write(&format!("{body}\n")),
            Self::Http(rpc) => { rpc.protocol = Some(version.to_string()); tokio::time::timeout(STEP_TIMEOUT, rpc.send(body)).await.map_err(|_| timeout())??; }
        }
        Ok(())
    }
    async fn close(&mut self) {
        match self {
            Self::Stdio(rpc) => { rpc.handle.end_stdin(); let _ = tokio::time::timeout(Duration::from_secs(3), rpc.handle.cancel()).await; }
            Self::Http(rpc) => rpc.close().await,
        }
    }
}

pub async fn probe_mcp(server: &Value, mut report: Value) -> Value {
    let started = Instant::now();
    let launch = Instant::now();
    let mut rpc = match open(server) {
        Ok(rpc) => rpc,
        Err(error) => { step(&mut report, "launch", "failed", launch, Some(error.code), Some(&error.message)); return finish(report, started); }
    };
    step(&mut report, "launch", "passed", launch, None, None);
    let mut stage = "initialize";
    let mut stage_started = Instant::now();
    let outcome = tokio::time::timeout(Duration::from_secs(60), async {
        let initialized = rpc.request(1, "initialize", json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"nautilo-diagnostics","version":"1"}})).await?;
        let version = initialized["protocolVersion"].as_str().ok_or_else(|| ProbeError::new("PROTOCOL_ERROR", "The initialize response has no protocol version."))?;
        rpc.initialized(version).await?;
        report["protocolVersion"] = json!(version);
        report["serverName"] = initialized.pointer("/serverInfo/name").cloned().unwrap_or(Value::Null);
        step(&mut report, stage, "passed", stage_started, None, None);
        stage = "tools";
        stage_started = Instant::now();
        if initialized.pointer("/capabilities/tools").is_none() {
            step(&mut report, stage, "warning", stage_started, Some("NO_TOOLS_CAPABILITY"), Some("This MCP server does not advertise tools; it may provide resources or prompts instead."));
            return Ok::<(), ProbeError>(());
        }
        let mut cursor: Option<String> = None;
        let mut seen = HashSet::new();
        let mut names = HashSet::new();
        let mut tools = Vec::new();
        let mut count = 0;
        for page in 0..20 {
            let result = rpc.request(2 + page, "tools/list", cursor.as_ref().map(|c| json!({"cursor":c})).unwrap_or(json!({}))).await?;
            let rows = result["tools"].as_array().ok_or_else(|| ProbeError::new("PROTOCOL_ERROR", "tools/list did not return a tools array."))?;
            for tool in rows {
                let name = tool["name"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| ProbeError::new("PROTOCOL_ERROR", "A listed tool has no name."))?;
                if !names.insert(name.to_string()) { continue; }
                count += 1;
                if tools.len() < MAX_TOOL_ROWS { tools.push(json!({"name":name,"description":tool["description"].as_str().map(|s| s.chars().take(600).collect::<String>())})); }
            }
            cursor = result["nextCursor"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
            if cursor.is_none() { break; }
            if !seen.insert(cursor.clone().unwrap()) { return Err(ProbeError::new("PROTOCOL_ERROR", "tools/list repeated a pagination cursor.")); }
        }
        report["tools"] = json!(tools);
        report["toolCount"] = json!(count);
        report["truncated"] = json!(cursor.is_some() || count > MAX_TOOL_ROWS);
        step(&mut report, stage, if cursor.is_some() { "warning" } else { "passed" }, stage_started, cursor.as_ref().map(|_| "TOOL_LIST_LIMIT"), None);
        Ok(())
    }).await.unwrap_or_else(|_| Err(timeout()));
    if let Err(error) = outcome { step(&mut report, stage, "failed", stage_started, Some(error.code), Some(&error.message)); }
    rpc.close().await;
    finish(report, started)
}
fn open(server: &Value) -> Result<Rpc, ProbeError> {
    let values = |key: &str| server[key].as_object().map(|m| m.iter().filter_map(|(k,v)| v.as_str().map(|s| (k.clone(),s.to_string()))).collect::<HashMap<String,String>>()).unwrap_or_default();
    if server["transport"] == "stdio" {
        let command = server["command"].as_str().filter(|s| !s.trim().is_empty()).ok_or_else(|| ProbeError::new("COMMAND_MISSING", "No MCP executable is configured."))?;
        let cwd = server["cwd"].as_str().map(str::to_string).or_else(|| dirs::home_dir().map(|p|p.to_string_lossy().into_owned()));
        let process = process::start(&ProcessRequest { command: command.to_string(), args: server["args"].as_array().map(|a|a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default(), cwd, env: Some(values("env")), inherit_env:true, timeout_ms:Some(65_000), max_output_bytes:Some(MAX_REPLY), ..Default::default() })
            .map_err(|e| ProbeError::new("SPAWN_FAILED", e.to_string()))?;
        Ok(Rpc::Stdio(StdioRpc { handle:process.handle, events:process.events, buffer:String::new(), stderr:String::new() }))
    } else {
        let url = server["url"].as_str().unwrap_or("");
        let parsed = reqwest::Url::parse(url).map_err(|_|ProbeError::new("INVALID_ENDPOINT", "Use an absolute HTTP(S) MCP URL."))?;
        if !matches!(parsed.scheme(), "http" | "https") || !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() { return Err(ProbeError::new("INVALID_ENDPOINT", "Use an HTTP(S) MCP URL without credentials or a fragment.")); }
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(STEP_TIMEOUT).build().map_err(|_|ProbeError::new("NETWORK_ERROR", "Could not create the HTTP client."))?;
        Ok(Rpc::Http(HttpRpc { client, url:url.to_string(), headers:values("headers"), session:None, protocol:None }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn event_stream_boundaries_accept_crlf_and_lf() {
        assert_eq!(event_boundary(b"data: {}\r\n\r\n"), Some((8,4)));
        assert_eq!(event_boundary(b"data: {}\n\n"), Some((8,2)));
    }
    #[test]
    fn notification_is_not_a_successful_tool_inventory() {
        assert!(rpc_result(json!({"jsonrpc":"2.0","method":"progress"})).is_err());
        assert!(rpc_result(json!({"id":2,"error":{"code":-32601,"message":"missing method"}})).is_err());
    }

    #[tokio::test]
    async fn stdio_handshake_and_tool_inventory_are_real_rpc_results() {
        let script = r#"const readline=require('readline').createInterface({input:process.stdin});let initialized=false;readline.on('line',line=>{const m=JSON.parse(line);if(m.method==='notifications/initialized'){initialized=true;return;}const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:initialized?{tools:[{name:'fixture_search',description:'Search the fixture'}]}:null;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');});"#;
        let result = probe_mcp(&json!({"transport":"stdio","command":"node","args":["-e",script]}),report("fixture","v1","mcp_handshake")).await;
        assert_eq!(result["state"],"passed","{result}");
        assert_eq!(result["toolCount"],1);
        assert_eq!(result["tools"][0]["name"],"fixture_search");
        assert_eq!(result["steps"][2]["id"],"tools");
    }

    #[tokio::test]
    async fn http_sse_pagination_and_session_cleanup() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut methods = Vec::new();
            for _ in 0..5 {
                let (mut socket,_) = listener.accept().await.unwrap();
                let mut data = Vec::new(); let mut chunk = [0_u8;4096];
                let (headers,body) = loop {
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n>0); data.extend_from_slice(&chunk[..n]);
                    if let Some(at) = data.windows(4).position(|s|s==b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&data[..at]).to_string();
                        let length = headers.lines().find_map(|line|line.to_lowercase().strip_prefix("content-length:").and_then(|s|s.trim().parse::<usize>().ok())).unwrap_or(0);
                        if data.len()>=at+4+length { break (headers,data[at+4..at+4+length].to_vec()); }
                    }
                };
                if headers.starts_with("DELETE") {
                    assert!(headers.to_lowercase().contains("mcp-session-id: fixture"));
                    methods.push("DELETE".to_string());
                    socket.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n").await.unwrap(); continue;
                }
                let body:Value=serde_json::from_slice(&body).unwrap();
                methods.push(body["method"].as_str().unwrap().to_string());
                let payload = match body["method"].as_str().unwrap() {
                    "initialize" => json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}}}),
                    "notifications/initialized" => {
                        socket.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();continue;
                    }
                    "tools/list" if body["params"]["cursor"].is_null() => json!({"tools":[{"name":"first"}],"nextCursor":"page2"}),
                    "tools/list" => json!({"tools":[{"name":"second"}]}),
                    method => panic!("unexpected method {method}"),
                };
                let reply=json!({"jsonrpc":"2.0","id":body["id"],"result":payload});
                let (content_type,content) = if payload.get("nextCursor").is_none() && body["method"]=="tools/list" { ("text/event-stream",format!("data: {reply}\r\n\r\n")) } else { ("application/json",reply.to_string()) };
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nMcp-Session-Id: fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{content}",content.len()).as_bytes()).await.unwrap();
            }
            methods
        });
        let result=probe_mcp(&json!({"transport":"http","url":format!("http://{address}/mcp")}),report("fixture","v1","mcp_handshake")).await;
        assert_eq!(result["state"],"passed","{result}");
        assert_eq!(result["toolCount"],2);
        assert_eq!(server.await.unwrap(),vec!["initialize","notifications/initialized","tools/list","tools/list","DELETE"]);
    }
}
