//! Run-scoped observation for CLIs whose headless output buffers or drops
//! model deltas. The selected API wire stays unchanged, including opaque
//! reasoning and tool payloads; only its stream flag and selected effort are
//! supplied here. Native CLI execution still owns the agent loop.
use super::{AdapterEvent, AdapterRun, AdapterStartRequest};
use crate::errors::{CoreError, CoreResult, ErrorCode};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};

pub struct ApiStreamObserver {
    task: tokio::task::JoinHandle<()>,
    events: mpsc::UnboundedReceiver<AdapterEvent>,
    text: Arc<AtomicBool>,
    thinking: Arc<AtomicBool>,
}
impl Drop for ApiStreamObserver {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl ApiStreamObserver {
    pub fn prepare(request: &mut AdapterStartRequest) -> CoreResult<Option<Self>> {
        let options = &request.instance["providerOptions"];
        if options["runtimeConnectionId"].as_str().is_none() {
            return Ok(None);
        }
        let base = options["baseUrl"]
            .as_str()
            .unwrap_or("")
            .trim_end_matches('/')
            .to_string();
        let wire = options["apiType"]
            .as_str()
            .unwrap_or("openai-completions")
            .to_string();
        let env = request.env.get_or_insert_with(HashMap::new);
        let key = env
            .get("NAUTILO_CONNECTION_API_KEY")
            .cloned()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                CoreError::reason(
                    ErrorCode::RunStartFailed,
                    "The API connection has no credential",
                )
            })?;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(failed)?;
        listener.set_nonblocking(true).map_err(failed)?;
        let port = listener.local_addr().map_err(failed)?.port();
        let listener = tokio::net::TcpListener::from_std(listener).map_err(failed)?;
        let cap = uuid::Uuid::new_v4().to_string();
        let local = format!("http://127.0.0.1:{port}/{cap}/v1");
        for value in env.values_mut() {
            if value == &key {
                *value = cap.clone();
            }
        }
        for name in ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"] {
            if env.contains_key(name) {
                env.insert(name.into(), local.clone());
            }
        }
        request.instance["providerOptions"]["baseUrl"] = json!(local);
        let effort = request.reasoning_effort.clone();
        if let Some(effort) = &effort { env.insert("NAUTILO_BRIDGE_EFFORT".into(), effort.clone()); }
        let (sender, events) = mpsc::unbounded_channel();
        let text = Arc::new(AtomicBool::new(false));
        let thinking = Arc::new(AtomicBool::new(false));
        let flags = (text.clone(), thinking.clone());
        let task = tokio::spawn(async move {
            // JoinSet aborts outstanding upstream requests when the run ends.
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{
                        let Ok((socket,_))=accepted else {break};
                        let (base,wire,key,cap,effort,sender,flags)=(base.clone(),wire.clone(),key.clone(),cap.clone(),effort.clone(),sender.clone(),flags.clone());
                        tasks.spawn(async move {
                            let mut socket=socket;
                            if let Err(error)=serve(&mut socket,&base,&wire,&key,&cap,effort.as_deref(),sender,flags).await {
                                // Never put request headers, keys or prompts in an error event.
                                let message=error.to_string().replace(&key,"[redacted]");
                                let _=send_json(&mut socket,502,&json!({"error":{"type":"api_error","message":message}})).await;
                            }
                        });
                    },
                    _=tasks.join_next(), if !tasks.is_empty()=>{}
                }
            }
        });
        Ok(Some(Self {
            task,
            events,
            text,
            thinking,
        }))
    }

    pub fn wrap(mut self, run: AdapterRun) -> AdapterRun {
        let (mut native, cancel, steer, write) = run.into_parts();
        let abort = self.task.abort_handle();
        let (sender, receiver) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                tokio::select! { biased;
                    Some(event)=self.events.recv()=>{ if sender.send(event).is_err(){break} },
                    event=native.recv()=>{
                        let Some(event)=event else {break};
                        let duplicate=match &event {
                            AdapterEvent::Message{..}=>self.text.load(Ordering::Acquire),
                            AdapterEvent::Thinking{..}=>self.thinking.load(Ordering::Acquire),
                            _=>false,
                        };
                        if !duplicate && sender.send(event).is_err(){break}
                    }
                }
            }
        });
        let mut run = AdapterRun::new(
            receiver,
            move || {
                Box::pin(async move {
                    abort.abort();
                    cancel().await;
                })
            },
            write,
        );
        if let Some(steer) = steer {
            run = run.with_steer(steer)
        }
        run
    }
}
fn failed(error: impl std::fmt::Display) -> CoreError {
    CoreError::reason(ErrorCode::RunStartFailed, error.to_string())
}

async fn serve(
    socket: &mut tokio::net::TcpStream,
    base: &str,
    wire: &str,
    key: &str,
    cap: &str,
    effort: Option<&str>,
    sender: mpsc::UnboundedSender<AdapterEvent>,
    flags: (Arc<AtomicBool>, Arc<AtomicBool>),
) -> anyhow::Result<()> {
    let mut header = Vec::new();
    let mut byte = [0u8; 1];
    while !header.ends_with(b"\r\n\r\n") {
        anyhow::ensure!(header.len() < 32768, "API request headers exceed the limit");
        if socket.read(&mut byte).await? == 0 {
            return Ok(());
        }
        header.push(byte[0]);
    }
    let header = String::from_utf8(header)?;
    let prefix = format!("/{cap}/v1/");
    let route = header
        .lines()
        .next()
        .and_then(|s| s.split_whitespace().nth(1))
        .unwrap_or("");
    let Some(route) = route.strip_prefix(&prefix) else {
        send_json(socket, 404, &json!({})).await?;
        return Ok(());
    };
    let suffix = match wire {
        "anthropic-messages" => "messages",
        "openai-responses" => "responses",
        _ => "chat/completions",
    };
    if route != suffix {
        send_json(
            socket,
            404,
            &json!({"error":{"message":"Unknown API route"}}),
        )
        .await?;
        return Ok(());
    }
    let len = header
        .lines()
        .find_map(|line| {
            line.to_lowercase()
                .strip_prefix("content-length:")
                .and_then(|v| v.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    anyhow::ensure!(len <= 64 * 1024 * 1024, "API request exceeds the limit");
    let mut bytes = vec![0; len];
    socket.read_exact(&mut bytes).await?;
    let mut body: Value = serde_json::from_slice(&bytes)?;
    let streaming = body["stream"] == true;
    body["stream"] = json!(true);
    if let Some(effort) = effort.filter(|s| !s.is_empty()) {
        match wire {
            "openai-responses" => {
                if !body["reasoning"].is_object() {
                    body["reasoning"] = json!({});
                }
                body["reasoning"]["effort"] = json!(effort);
                if !matches!(effort, "none" | "off") {
                    body["reasoning"]["summary"] = json!("auto");
                }
            }
            "anthropic-messages" => {
                if !body["output_config"].is_object() {
                    body["output_config"] = json!({});
                }
                body["output_config"]["effort"] = json!(effort);
            }
            _ => body["reasoning_effort"] = json!(effort),
        }
    }
    let endpoint = if base.ends_with(&format!("/{suffix}")) {
        base.to_string()
    } else {
        format!("{base}/{suffix}")
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let mut request = client
        .post(endpoint)
        .bearer_auth(key)
        .json(&body)
        .timeout(std::time::Duration::from_secs(1800));
    if wire == "anthropic-messages" {
        request = request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01");
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Unable to reach the selected API endpoint"))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let reply = response.text().await?.replace(key, "[redacted]");
        send_json(
            socket,
            status,
            &serde_json::from_str(&reply).unwrap_or_else(|_| json!({"error":{"message":reply}})),
        )
        .await?;
        return Ok(());
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|s| s.to_str().ok())
        .is_some_and(|s| s.contains("text/event-stream"))
    {
        // Some upstreams ignore stream:true. Preserve their actual behavior.
        let value: Value = response.json().await?;
        send_json(socket, 200, &value).await?;
        return Ok(());
    }
    if streaming {
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n").await?;
    }
    let mut capture = Capture::new(wire, sender, flags);
    let mut buffer = Vec::new();
    let mut data = String::new();
    while let Some(chunk) = response.chunk().await? {
        if streaming {
            socket.write_all(&chunk).await?;
            socket.flush().await?;
        }
        buffer.extend_from_slice(&chunk);
        anyhow::ensure!(
            buffer.len() <= 32 * 1024 * 1024,
            "API stream frame exceeds the limit"
        );
        while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
            let line = String::from_utf8(buffer.drain(..=end).collect())?;
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !data.is_empty() {
                    if data != "[DONE]" {
                        capture.event(&serde_json::from_str::<Value>(&data)?)?;
                    }
                    data.clear();
                }
            } else if let Some(value) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n')
                }
                data.push_str(value.strip_prefix(' ').unwrap_or(value));
            }
        }
    }
    anyhow::ensure!(
        capture.terminal,
        "The API stream ended before its completion event"
    );
    capture.finish();
    if !streaming {
        send_json(socket, 200, &capture.reply()).await?;
    }
    Ok(())
}
async fn send_json(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    value: &Value,
) -> anyhow::Result<()> {
    let body = value.to_string();
    socket.write_all(format!("HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await?;
    Ok(())
}

struct Capture {
    wire: String,
    id: String,
    sender: mpsc::UnboundedSender<AdapterEvent>,
    flags: (Arc<AtomicBool>, Arc<AtomicBool>),
    parts: BTreeMap<String, (bool, String)>,
    result: Value,
    blocks: BTreeMap<usize, Value>,
    arguments: HashMap<usize, String>,
    terminal: bool,
}
impl Capture {
    fn new(
        wire: &str,
        sender: mpsc::UnboundedSender<AdapterEvent>,
        flags: (Arc<AtomicBool>, Arc<AtomicBool>),
    ) -> Self {
        Self {
            wire: wire.into(),
            id: uuid::Uuid::new_v4().to_string(),
            sender,
            flags,
            parts: BTreeMap::new(),
            result: json!({}),
            blocks: BTreeMap::new(),
            arguments: HashMap::new(),
            terminal: false,
        }
    }
    fn delta(&mut self, key: String, thinking: bool, text: &str) {
        if text.is_empty() {
            return;
        }
        self.parts
            .entry(key.clone())
            .or_insert_with(|| (thinking, String::new()))
            .1
            .push_str(text);
        if thinking {
            self.flags.1.store(true, Ordering::Release);
        } else {
            self.flags.0.store(true, Ordering::Release);
        }
        let message_id = Some(format!("api-{}:{key}", self.id));
        let event = if thinking {
            AdapterEvent::Thinking {
                text: text.into(),
                phase: Some("delta".into()),
                message_id,
                subagent_dispatch_id: None,
                raw: None,
            }
        } else {
            AdapterEvent::Message {
                text: text.into(),
                phase: Some("delta".into()),
                message_id,
                subagent_dispatch_id: None,
                raw: None,
            }
        };
        let _ = self.sender.send(event);
    }
    fn full(&mut self, key: String, thinking: bool, text: &str) {
        let sent = self.parts.get(&key).map(|p| p.1.as_str()).unwrap_or("");
        if let Some(delta) = text.strip_prefix(sent) {
            let delta = delta.to_string();
            self.delta(key, thinking, &delta);
        }
    }
    fn event(&mut self, event: &Value) -> anyhow::Result<()> {
        anyhow::ensure!(
            event["error"].is_null()
                && !matches!(
                    event["type"].as_str(),
                    Some("error" | "response.failed" | "response.incomplete")
                ),
            "The selected API returned a stream error"
        );
        match self.wire.as_str() {
            "openai-responses" => {
                let id = event["item_id"].as_str().unwrap_or("item");
                match event["type"].as_str() {
                    Some("response.output_text.delta") => self.delta(
                        format!("text:{id}:{}", event["content_index"].as_u64().unwrap_or(0)),
                        false,
                        event["delta"].as_str().unwrap_or(""),
                    ),
                    Some("response.reasoning_summary_text.delta") => self.delta(
                        format!(
                            "thought:{id}:{}",
                            event["summary_index"].as_u64().unwrap_or(0)
                        ),
                        true,
                        event["delta"].as_str().unwrap_or(""),
                    ),
                    Some("response.completed") => {
                        self.result = event["response"].clone();
                        self.terminal = true;
                        for item in self.result["output"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default()
                        {
                            let id = item["id"].as_str().unwrap_or("item");
                            let thinking = item["type"] == "reasoning";
                            for (i, part) in item[if thinking { "summary" } else { "content" }]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .enumerate()
                            {
                                self.full(
                                    format!(
                                        "{}:{id}:{i}",
                                        if thinking { "thought" } else { "text" }
                                    ),
                                    thinking,
                                    part["text"].as_str().unwrap_or(""),
                                );
                            }
                        }
                    }
                    _ => {}
                }
            }
            "anthropic-messages" => {
                let index = event["index"].as_u64().unwrap_or(0) as usize;
                match event["type"].as_str() {
                    Some("message_start") => self.result = event["message"].clone(),
                    Some("content_block_start") => {
                        let block = event["content_block"].clone();
                        let thinking = block["type"] == "thinking";
                        self.delta(
                            format!("block:{index}"),
                            thinking,
                            block[if thinking { "thinking" } else { "text" }]
                                .as_str()
                                .unwrap_or(""),
                        );
                        self.blocks.insert(index, block);
                    }
                    Some("content_block_delta") => {
                        let delta = &event["delta"];
                        let kind = delta["type"].as_str().unwrap_or("");
                        if matches!(kind, "thinking_delta" | "text_delta") {
                            let thinking = kind == "thinking_delta";
                            let field = if thinking { "thinking" } else { "text" };
                            let text = delta[field].as_str().unwrap_or("");
                            self.delta(format!("block:{index}"), thinking, text);
                            let block = self.blocks.entry(index).or_insert_with(|| json!({}));
                            let current = block[field].as_str().unwrap_or("").to_string();
                            block[field] = json!(current + text);
                        } else if kind == "signature_delta" {
                            let block = self.blocks.entry(index).or_insert_with(|| json!({}));
                            block["signature"] = json!(format!(
                                "{}{}",
                                block["signature"].as_str().unwrap_or(""),
                                delta["signature"].as_str().unwrap_or("")
                            ));
                        } else if kind == "input_json_delta" {
                            self.arguments
                                .entry(index)
                                .or_default()
                                .push_str(delta["partial_json"].as_str().unwrap_or(""));
                        }
                    }
                    Some("content_block_stop") => {
                        if let Some(arguments) = self.arguments.remove(&index) {
                            self.blocks.entry(index).or_insert_with(|| json!({}))["input"] =
                                serde_json::from_str(&arguments)?;
                        }
                    }
                    Some("message_delta") => {
                        for (key, value) in event["delta"].as_object().into_iter().flatten() {
                            self.result[key] = value.clone();
                        }
                        for (key, value) in event["usage"].as_object().into_iter().flatten() {
                            self.result["usage"][key] = value.clone();
                        }
                    }
                    Some("message_stop") => self.terminal = true,
                    _ => {}
                }
            }
            _ => {
                if self.result["choices"].is_null() {
                    self.result = json!({"id":event["id"],"object":"chat.completion","created":event["created"],"model":event["model"],"choices":[{"index":0,"message":{"role":"assistant","content":""},"finish_reason":null}]});
                }
                let choice = &event["choices"][0];
                let delta = &choice["delta"];
                for (field, thinking) in [("content", false), ("reasoning_content", true)] {
                    let text = delta[field]
                        .as_str()
                        .or_else(|| {
                            if thinking {
                                delta["reasoning"].as_str()
                            } else {
                                None
                            }
                        })
                        .unwrap_or("");
                    self.delta(field.into(), thinking, text);
                    let msg = &mut self.result["choices"][0]["message"];
                    let prior = msg[field].as_str().unwrap_or("").to_string();
                    msg[field] = json!(prior + text);
                }
                for tool in delta["tool_calls"].as_array().into_iter().flatten() {
                    let index = tool["index"].as_u64().unwrap_or(0) as usize;
                    let call = self.blocks.entry(index).or_insert_with(
                        || json!({"type":"function","id":"","function":{"name":"","arguments":""}}),
                    );
                    for field in ["id", "type"] {
                        if let Some(value) = tool[field].as_str() {
                            call[field] = json!(value);
                        }
                    }
                    for field in ["name", "arguments"] {
                        if let Some(text) = tool["function"][field].as_str() {
                            call["function"][field] = json!(format!(
                                "{}{}",
                                call["function"][field].as_str().unwrap_or(""),
                                text
                            ));
                        }
                    }
                }
                if let Some(reason) = choice["finish_reason"].as_str() {
                    self.terminal = true;
                    self.result["choices"][0]["finish_reason"] = json!(reason);
                }
                if event["usage"].is_object() {
                    self.result["usage"] = event["usage"].clone();
                }
            }
        }
        Ok(())
    }
    fn reply(&self) -> Value {
        let mut result = self.result.clone();
        if self.wire == "anthropic-messages" {
            result["content"] = json!(self.blocks.values().collect::<Vec<_>>());
        } else if self.wire != "openai-responses" && !self.blocks.is_empty() {
            result["choices"][0]["message"]["tool_calls"] =
                json!(self.blocks.values().collect::<Vec<_>>());
        }
        result
    }
    fn finish(&self) {
        for (key, (thinking, text)) in &self.parts {
            let message_id = Some(format!("api-{}:{key}", self.id));
            let event = if *thinking {
                AdapterEvent::Thinking {
                    text: text.clone(),
                    phase: Some("completed".into()),
                    message_id,
                    subagent_dispatch_id: None,
                    raw: None,
                }
            } else {
                AdapterEvent::Message {
                    text: text.clone(),
                    phase: Some("completed".into()),
                    message_id,
                    subagent_dispatch_id: None,
                    raw: None,
                }
            };
            let _ = self.sender.send(event);
        }
    }
}
