//! Run-scoped MCP bridge: port of adapters/runtime-mcp-bridge.ts.
//! A minimal loopback HTTP server speaking just enough MCP (Streamable HTTP,
//! JSON responses) for provider CLIs to call Nautilo runtime tools and the
//! permission-prompt hook. The random path is the bearer capability; the
//! server lives only as long as its provider process.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::adapters::BoxFuture;

pub type PermissionPromptHandler = Arc<dyn Fn(Value, Value) -> BoxFuture<anyhow::Result<Value>> + Send + Sync>;
pub type ToolExecutor = Arc<dyn Fn(Value) -> BoxFuture<anyhow::Result<Value>> + Send + Sync>;

pub const PERMISSION_PROMPT_TOOL_NAME: &str = "permission_prompt";

fn public_tool_name(name: &str) -> &str {
    if let Some(rest) = name.strip_prefix("agenthub.") {
        rest
    } else if let Some(rest) = name.strip_prefix("agenthub_") {
        rest
    } else {
        name
    }
}

pub struct RuntimeMcpBridge {
    pub url: String,
    shutdown: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    handle: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl RuntimeMcpBridge {
    /// Stops the accept loop and joins the server thread.
    pub fn close(&self) {
        if let Some(sender) = self.shutdown.lock().unwrap().take() {
            let _ = sender.send(());
        }
        if let Some(handle) = self.handle.lock().unwrap().take() {
            let _ = handle.join();
        }
    }
}

impl Drop for RuntimeMcpBridge {
    fn drop(&mut self) {
        self.close();
    }
}

/// Starts the bridge on 127.0.0.1 with a random port and token path.
/// `tools` are RuntimeToolSpec JSON values ({name, description, inputSchema});
/// `execute` receives {providerId, name, arguments} and yields
/// {success, content}. `on_permission_prompt` receives (tool_name, input) and
/// yields the {behavior, ...} verdict JSON.
///
/// Must be called from within the tokio runtime: tool handlers are async and
/// are driven on the captured runtime handle.
pub fn start_runtime_mcp_bridge(
    provider_id: &str,
    tools: Vec<Value>,
    execute: Option<ToolExecutor>,
    on_permission_prompt: Option<PermissionPromptHandler>,
) -> anyhow::Result<RuntimeMcpBridge> {
    let mut by_public_name: Map<String, Value> = Map::new();
    for tool in &tools {
        let name = public_tool_name(tool.get("name").and_then(Value::as_str).unwrap_or(""));
        if by_public_name.contains_key(name) {
            anyhow::bail!("Duplicate runtime tool name: {name}");
        }
        by_public_name.insert(name.to_string(), tool.clone());
    }

    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let token = Uuid::new_v4().to_string().replace('-', "");
    let path = format!("/mcp/{token}");
    let url = format!("http://127.0.0.1:{port}{path}");

    let runtime = tokio::runtime::Handle::current();
    let (shutdown_sender, shutdown) = std::sync::mpsc::channel::<()>();
    let provider_id = provider_id.to_string();
    let handle = std::thread::spawn(move || {
        let session_id = Uuid::new_v4().to_string();
        loop {
            if shutdown.try_recv().is_ok() {
                return;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    let outcome = handle_http(
                        stream,
                        &path,
                        &session_id,
                        &by_public_name,
                        &provider_id,
                        &execute,
                        &on_permission_prompt,
                        &runtime,
                    );
                    if let Err(error) = outcome {
                        eprintln!("[nautilo-core] mcp bridge connection error: {error}");
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(_) => return,
            }
        }
    });

    Ok(RuntimeMcpBridge { url, shutdown: Mutex::new(Some(shutdown_sender)), handle: Mutex::new(Some(handle)) })
}

#[allow(clippy::too_many_arguments)]
fn handle_http(
    mut stream: std::net::TcpStream,
    expected_path: &str,
    session_id: &str,
    tools: &Map<String, Value>,
    provider_id: &str,
    execute: &Option<ToolExecutor>,
    on_permission_prompt: &Option<PermissionPromptHandler>,
    runtime: &tokio::runtime::Handle,
) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let pathname = target.split('?').next().unwrap_or("/");
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; content_length.min(8 * 1024 * 1024)];
    reader.read_exact(&mut body)?;

    let local = stream.peer_addr().map(|address| address.ip().is_loopback()).unwrap_or(false);
    if !local || pathname != expected_path {
        write_response(&mut stream, 404, &[], None)?;
        return Ok(());
    }
    if method != "POST" {
        write_response(&mut stream, 405, b"{}", None)?;
        return Ok(());
    }

    let message: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let (status, payload, include_session) = handle_rpc(message, session_id, tools, provider_id, execute, on_permission_prompt, runtime);
    let body_out = match &payload {
        Some(value) => serde_json::to_vec(value).unwrap_or_default(),
        None => vec![],
    };
    write_response(&mut stream, status, &body_out, include_session.then_some(session_id))?;
    Ok(())
}

/// Handles one MCP JSON-RPC message; returns (status, body, send_session_header).
#[allow(clippy::too_many_arguments)]
fn handle_rpc(
    message: Value,
    session_id: &str,
    tools: &Map<String, Value>,
    provider_id: &str,
    execute: &Option<ToolExecutor>,
    on_permission_prompt: &Option<PermissionPromptHandler>,
    runtime: &tokio::runtime::Handle,
) -> (u16, Option<Value>, bool) {
    let Some(object) = message.as_object() else {
        return (400, Some(json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}})), false);
    };
    let method = object.get("method").and_then(Value::as_str).unwrap_or("");
    let id = object.get("id").cloned();

    // Notifications get a bare 202, per Streamable HTTP.
    let Some(id) = id else {
        return (202, None, false);
    };
    let reply = |result: Value| (200, Some(json!({ "jsonrpc": "2.0", "id": id, "result": result })), false);
    let reply_error = |code: i64, message: &str| {
        (200, Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })), false)
    };

    match method {
        "initialize" => (
            200,
            Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": object
                        .get("params")
                        .and_then(|params| params.get("protocolVersion"))
                        .cloned()
                        .unwrap_or_else(|| json!("2025-03-26")),
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "agenthub-runtime", "version": "0.1.0" },
                    "instructions": "Nautilo session-scoped orchestration tools. Call them only when delegation is useful."
                }
            })),
            true,
        ),
        "ping" => reply(json!({})),
        "tools/list" => {
            let mut list: Vec<Value> = tools
                .iter()
                .map(|(name, tool)| {
                    json!({
                        "name": name,
                        "description": tool.get("description").cloned().unwrap_or(Value::Null),
                        "inputSchema": tool.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object" })),
                    })
                })
                .collect();
            if on_permission_prompt.is_some() {
                list.push(json!({
                    "name": PERMISSION_PROMPT_TOOL_NAME,
                    "description": "Nautilo permission prompt bridge used by --permission-prompt-tool; not for direct model use.",
                    "inputSchema": {
                        "type": "object",
                        "properties": { "tool_name": { "type": "string" }, "input": { "type": "object" } },
                        "required": ["tool_name", "input"]
                    }
                }));
            }
            reply(json!({ "tools": list }))
        }
        "tools/call" => {
            let params = object.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            if name == PERMISSION_PROMPT_TOOL_NAME {
                if let Some(handler) = on_permission_prompt {
                    let tool_name = arguments.get("tool_name").cloned().unwrap_or(Value::Null);
                    let input = arguments.get("input").cloned().unwrap_or_else(|| json!({}));
                    let outcome = runtime.block_on(handler(tool_name, input));
                    return match outcome {
                        Ok(result) => reply(json!({ "isError": false, "content": [{ "type": "text", "text": result.to_string() }] })),
                        Err(error) => reply(json!({ "isError": true, "content": [{ "type": "text", "text": error.to_string() }] })),
                    };
                }
                return reply_error(-32601, "method not found");
            }
            let public = public_tool_name(name);
            match (tools.get(public), execute) {
                (Some(tool), Some(execute)) => {
                    let call = json!({
                        "providerId": provider_id,
                        "name": tool.get("name").cloned().unwrap_or(Value::Null),
                        "arguments": arguments,
                    });
                    let outcome = runtime.block_on(execute(call));
                    match outcome {
                        Ok(result) => {
                            let success = result.get("success").and_then(Value::as_bool).unwrap_or(false);
                            let content = result.get("content").and_then(Value::as_str).unwrap_or("").to_string();
                            reply(json!({ "isError": !success, "content": [{ "type": "text", "text": content }] }))
                        }
                        Err(error) => {
                            reply(json!({ "isError": true, "content": [{ "type": "text", "text": error.to_string() }] }))
                        }
                    }
                }
                _ => reply(json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("Unknown Nautilo tool: {name}") }]
                })),
            }
        }
        _ => reply_error(-32601, "method not found"),
    }
}

fn write_response(stream: &mut std::net::TcpStream, status: u16, body: &[u8], session_id: Option<&str>) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Internal Server Error",
    };
    let mut headers = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n",
        body.len()
    );
    if let Some(session_id) = session_id {
        headers.push_str(&format!("mcp-session-id: {session_id}\r\n"));
    }
    headers.push_str("\r\n");
    stream.write_all(headers.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}
