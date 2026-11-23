//! Local MCP transport for daemon-owned tools. Configuration lives as long as
//! its native worker. A call snapshots the active turn or session binding.
use crate::DaemonChannel;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
};

#[derive(Clone)]
pub enum ToolRoute {
    Run(String),
    Session(String),
}

pub fn bypass_loopback_proxy(env: &mut HashMap<String, String>) {
    let mut bypass = Vec::new();
    for key in ["NO_PROXY", "no_proxy"] {
        if let Some(value) = env.get(key).cloned().or_else(|| std::env::var(key).ok()) {
            for host in value
                .split(',')
                .map(str::trim)
                .filter(|host| !host.is_empty())
            {
                if !bypass.iter().any(|entry| entry == host) {
                    bypass.push(host.to_owned());
                }
            }
        }
    }
    for host in ["127.0.0.1", "localhost", "::1"] {
        if !bypass.iter().any(|entry| entry == host) {
            bypass.push(host.to_owned());
        }
    }
    let bypass = bypass.join(",");
    env.insert("NO_PROXY".into(), bypass.clone());
    env.insert("no_proxy".into(), bypass);
}

pub struct RuntimeTools {
    pub url: String,
    name: String,
    route: Arc<RwLock<Option<ToolRoute>>>,
    stop: watch::Sender<bool>,
}

impl RuntimeTools {
    pub async fn start(
        request: &Value,
        channel: Option<Arc<dyn DaemonChannel>>,
        route: ToolRoute,
        name: &str,
        public_name: fn(&str) -> &str,
    ) -> anyhow::Result<Option<Self>> {
        let Some(tools) = request["runtimeTools"]
            .as_array()
            .filter(|tools| !tools.is_empty())
        else {
            return Ok(None);
        };
        let channel = channel
            .ok_or_else(|| anyhow::anyhow!("Nautilo runtime tool channel is unavailable"))?;
        let mut names = Vec::with_capacity(tools.len());
        let mut public_tools = Vec::with_capacity(tools.len());
        for tool in tools {
            let native = tool["name"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Runtime tool name is missing"))?;
            let public = public_name(native);
            names.push((public.to_owned(), native.to_owned()));
            let mut definition = tool.clone();
            definition["name"] = json!(public);
            public_tools.push(definition);
        }
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let path = format!("/mcp/{}", uuid::Uuid::new_v4().simple());
        let url = format!("http://127.0.0.1:{}{path}", listener.local_addr()?.port());
        let (stop, mut closed) = watch::channel(false);
        let route = Arc::new(RwLock::new(Some(route)));
        let current = route.clone();
        let server_name = name.to_owned();
        tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            let tools = Arc::new(public_tools);
            let names = Arc::new(names);
            loop {
                tokio::select! {
                    _ = closed.changed() => break,
                    next = listener.accept() => {
                        let Ok((stream, address)) = next else { break };
                        if !address.ip().is_loopback() { continue; }
                        let (path, tools, names, channel, route, name) =
                            (path.clone(), tools.clone(), names.clone(), channel.clone(), current.clone(), server_name.clone());
                        connections.spawn(async move { let _ = handle(stream, &path, &tools, &names, &name, channel, route).await; });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
            connections.abort_all();
        });
        Ok(Some(Self {
            url,
            name: name.to_owned(),
            route,
            stop,
        }))
    }

    pub fn bind(&self, route: ToolRoute) {
        *self.route.write().unwrap() = Some(route);
    }

    pub fn suspend(&self) {
        *self.route.write().unwrap() = None;
    }

    pub fn server(&self) -> Value {
        json!({"name":self.name,"transport":"http","url":self.url})
    }

    pub fn append_to(&self, request: &mut Value) {
        let mut servers = request["mcpServers"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        servers.push(self.server());
        request["mcpServers"] = json!(servers);
    }

    pub fn close(&self) {
        self.suspend();
        let _ = self.stop.send(true);
    }
}

impl Drop for RuntimeTools {
    fn drop(&mut self) {
        self.close();
    }
}

async fn handle(
    mut stream: TcpStream,
    path: &str,
    tools: &[Value],
    names: &[(String, String)],
    server_name: &str,
    channel: Arc<dyn DaemonChannel>,
    route: Arc<RwLock<Option<ToolRoute>>>,
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
        "initialize" => json!({"protocolVersion":message["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26"),"capabilities":{"tools":{}},"serverInfo":{"name":server_name,"version":env!("CARGO_PKG_VERSION")}}),
        "ping" => json!({}),
        "tools/list" => json!({"tools":tools}),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or("");
            let Some((_, native_name)) = names.iter().find(|(public,_)|public == name) else {
                return write(&mut stream, 200, Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":"Unknown Nautilo runtime tool"}}))).await;
            };
            let current = route.read().unwrap().clone();
            let args = message["params"].get("arguments").cloned().unwrap_or(json!({}));
            let result = match current {
                Some(ToolRoute::Run(id)) => channel.call_tool(&id,native_name,args).await,
                Some(ToolRoute::Session(id)) => channel.call_session_tool(&id,native_name,args).await,
                None => json!({"success":false,"content":"Nautilo runtime tools have no active turn"}),
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
