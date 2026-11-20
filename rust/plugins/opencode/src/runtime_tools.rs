//! Native MCP registration for Nautilo tools, isolated by local conversation.
//! The endpoint survives turns; its callback follows the current session binding.
use agenthub_plugin_sdk::DaemonChannel;
use serde_json::{json, Value};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
};

pub(super) const SERVER_NAME: &str = "nautilo_runtime";
pub(super) struct RuntimeTools {
    pub url: String,
    binding: Arc<RwLock<Option<String>>>,
    stop: watch::Sender<bool>,
}
impl RuntimeTools {
    pub async fn start(
        request: &Value,
        channel: Option<Arc<dyn DaemonChannel>>,
    ) -> anyhow::Result<Option<Self>> {
        let tools = request["runtimeTools"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if tools.is_empty() {
            return Ok(None);
        }
        anyhow::ensure!(
            request["localSessionId"]
                .as_str()
                .is_some_and(|id| !id.is_empty()),
            "Nautilo runtime tools require a local conversation identity"
        );
        let channel = channel
            .ok_or_else(|| anyhow::anyhow!("Nautilo runtime tool channel is unavailable"))?;
        let binding = Arc::new(RwLock::new(Some(session_binding(request)?.to_string())));
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let path = format!("/mcp/{}", uuid::Uuid::new_v4().simple());
        let url = format!("http://127.0.0.1:{}{path}", listener.local_addr()?.port());
        let (stop, mut closed) = watch::channel(false);
        let current = binding.clone();
        tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            let tools = Arc::new(tools);
            loop {
                tokio::select! {
                    _ = closed.changed() => break,
                    next = listener.accept() => {
                        let Ok((stream, address)) = next else { break };
                        if !address.ip().is_loopback() { continue; }
                        let (path, tools, channel, binding) = (path.clone(), tools.clone(), channel.clone(), current.clone());
                        connections.spawn(async move { let _ = handle(stream, &path, &tools, channel, binding).await; });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
            connections.abort_all();
        });
        Ok(Some(Self { url, binding, stop }))
    }
    pub fn bind(&self, request: &Value) -> anyhow::Result<()> {
        *self.binding.write().unwrap() = Some(session_binding(request)?.to_string());
        Ok(())
    }
    pub fn inject(&self, request: &Value) -> Value {
        let mut request = request.clone();
        let mut servers = request["mcpServers"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        servers.push(json!({"name":SERVER_NAME,"transport":"http","url":self.url}));
        request["mcpServers"] = json!(servers);
        request
    }
    pub async fn verify(&self, base: &str, cwd: &str) -> anyhow::Result<()> {
        let status = super::api_json(base, cwd, "/mcp", "GET", None).await?;
        anyhow::ensure!(
            status[SERVER_NAME]["status"] == "connected",
            "OpenCode did not connect Nautilo runtime tools: {}",
            status[SERVER_NAME]
        );
        Ok(())
    }
    pub fn close(&self) {
        *self.binding.write().unwrap() = None;
        let _ = self.stop.send(true);
    }
}
impl Drop for RuntimeTools {
    fn drop(&mut self) {
        self.close();
    }
}
fn session_binding(request: &Value) -> anyhow::Result<&str> {
    request["sessionBindingId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Nautilo runtime tools require a native session binding"))
}

async fn handle(
    mut stream: TcpStream,
    path: &str,
    tools: &[Value],
    channel: Arc<dyn DaemonChannel>,
    binding: Arc<RwLock<Option<String>>>,
) -> anyhow::Result<()> {
    let mut bytes = Vec::new();
    let end = loop {
        let mut chunk = [0; 4096];
        let n = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk)).await??;
        anyhow::ensure!(n > 0 && bytes.len() + n <= 64 * 1024, "Invalid MCP headers");
        bytes.extend_from_slice(&chunk[..n]);
        if let Some(at) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let header = String::from_utf8_lossy(&bytes[..end]);
    let mut first = header.lines().next().unwrap_or("").split_whitespace();
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let origin = header.lines().any(|line| {
        line.split_once(':')
            .is_some_and(|(k, _)| k.eq_ignore_ascii_case("origin"))
    });
    if target != path || origin {
        return write(&mut stream, 404, None).await;
    }
    if method == "DELETE" {
        return write(&mut stream, 202, None).await;
    }
    if method != "POST" {
        return write(&mut stream, 405, None).await;
    }
    let length = header
        .lines()
        .find_map(|line| {
            let (k, v) = line.split_once(':')?;
            k.eq_ignore_ascii_case("content-length")
                .then(|| v.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    anyhow::ensure!(length <= 8 * 1024 * 1024, "MCP request is too large");
    while bytes.len() < end + length {
        let mut chunk = [0; 4096];
        let n = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk)).await??;
        anyhow::ensure!(n > 0, "Incomplete MCP body");
        bytes.extend_from_slice(&chunk[..n]);
    }
    let message: Value = serde_json::from_slice(&bytes[end..end + length])?;
    let Some(id) = message.get("id").filter(|id| !id.is_null()) else {
        return write(&mut stream, 202, None).await;
    };
    let result = match message["method"].as_str().unwrap_or("") {
        "initialize" => json!({"protocolVersion":message["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26"),"capabilities":{"tools":{}},"serverInfo":{"name":SERVER_NAME,"version":env!("CARGO_PKG_VERSION")}}),
        "ping" => json!({}),
        "tools/list" => json!({"tools":tools}),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or("");
            if !tools.iter().any(|tool| tool["name"] == name) {
                return write(&mut stream, 200, Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":"Unknown Nautilo runtime tool"}}))).await;
            }
            let current = binding.read().unwrap().clone();
            let result = match current {
                Some(current) => channel.call_session_tool(&current, name, message["params"].get("arguments").cloned().unwrap_or(json!({}))).await,
                None => json!({"success":false,"content":"Native session was released"}),
            };
            let content = result["content"].as_str().map(str::to_string).unwrap_or_else(|| result["content"].to_string());
            json!({"isError":result["success"] != true,"content":[{"type":"text","text":content}]})
        }
        _ => return write(&mut stream, 200, Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}}))).await,
    };
    write(
        &mut stream,
        200,
        Some(json!({"jsonrpc":"2.0","id":id,"result":result})),
    )
    .await
}
async fn write(stream: &mut TcpStream, status: u16, value: Option<Value>) -> anyhow::Result<()> {
    let bytes = value
        .map(|v| serde_json::to_vec(&v))
        .transpose()?
        .unwrap_or_default();
    stream.write_all(format!("HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).as_bytes()).await?;
    stream.write_all(&bytes).await?;
    Ok(())
}
