//! Session-owned HTTP MCP endpoint for Nautilo orchestration/browser tools.
//! A random loopback capability isolates each native conversation.
use agenthub_plugin_sdk::DaemonChannel;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
};

pub struct RuntimeTools {
    pub url: String,
    stop: watch::Sender<bool>,
}
impl Drop for RuntimeTools {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

impl RuntimeTools {
    pub async fn start(tools: Vec<Value>, channel: Arc<dyn DaemonChannel>) -> anyhow::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let path = format!("/mcp/{}", uuid::Uuid::new_v4().simple());
        let url = format!("http://127.0.0.1:{}{}", listener.local_addr()?.port(), path);
        let (stop, mut closed) = watch::channel(false);
        let tools = Arc::new(tools);
        tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _=closed.changed()=>break,
                    result=listener.accept()=>{let Ok((stream,address))=result else{break};if !address.ip().is_loopback(){continue}
                        let path=path.clone();let tools=tools.clone();let channel=channel.clone();
                        connections.spawn(async move{let _=handle(stream,&path,&tools,channel).await;});
                    },
                    _=connections.join_next(),if !connections.is_empty()=>{},
                }
            }
            connections.abort_all();
        });
        Ok(Self { url, stop })
    }
}

async fn handle(
    mut stream: TcpStream,
    path: &str,
    tools: &[Value],
    channel: Arc<dyn DaemonChannel>,
) -> anyhow::Result<()> {
    let mut bytes = vec![];
    let end;
    loop {
        let mut buf = [0; 4096];
        let n = tokio::time::timeout(std::time::Duration::from_secs(10), stream.read(&mut buf))
            .await??;
        anyhow::ensure!(
            n > 0 && bytes.len() + n <= 8 * 1024 * 1024,
            "Invalid MCP request size"
        );
        bytes.extend_from_slice(&buf[..n]);
        if let Some(at) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
            end = at + 4;
            break;
        }
    }
    let header = String::from_utf8_lossy(&bytes[..end]);
    let first = header.lines().next().unwrap_or("");
    let method = first.split_whitespace().next().unwrap_or("");
    let target = first.split_whitespace().nth(1).unwrap_or("");
    let length = header
        .lines()
        .find_map(|line| {
            let (k, v) = line.split_once(':')?;
            k.eq_ignore_ascii_case("content-length")
                .then(|| v.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
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
    anyhow::ensure!(length <= 8 * 1024 * 1024, "MCP request too large");
    while bytes.len() < end + length {
        let mut buf = [0; 4096];
        let n = tokio::time::timeout(std::time::Duration::from_secs(10), stream.read(&mut buf))
            .await??;
        anyhow::ensure!(n > 0, "MCP request body ended early");
        bytes.extend_from_slice(&buf[..n]);
    }
    let message: Value = serde_json::from_slice(&bytes[end..end + length])?;
    let Some(id) = message.get("id").filter(|v| !v.is_null()) else {
        return write(&mut stream, 202, None).await;
    };
    let result=match message["method"].as_str().unwrap_or("") {
        "initialize"=>json!({"protocolVersion":message["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"nautilo","version":env!("CARGO_PKG_VERSION")}}),
        "ping"=>json!({}),
        "tools/list"=>json!({"tools":tools}),
        "tools/call"=>{
            let requested=message["params"]["name"].as_str().unwrap_or("");
            let Some(tool)=tools.iter().find(|t|t["name"]==requested) else{return write(&mut stream,200,Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":"Unknown Nautilo runtime tool"}}))).await};
            let result=channel.call_tool("",tool["name"].as_str().unwrap(),message["params"].get("arguments").cloned().unwrap_or(json!({}))).await;
            json!({"isError":result["success"]!=true,"content":[{"type":"text","text":super::events::printable(&result["content"])}]})
        },
        method=>return write(&mut stream,200,Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":format!("Method not found: {method}")}}))).await,
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
    stream.write_all(format!("HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len()).as_bytes()).await?;
    stream.write_all(&bytes).await?;
    Ok(())
}
