//! Codex model-provider path: native file-store credentials, coordinated refresh,
//! and streaming Responses conversion. Encrypted/keychain stores are not treated
//! as empty file stores: those keep using the selected genuine native runtime.
use crate::database::{Database, Repositories};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{io::AsyncWriteExt, net::TcpStream, sync::watch};
mod auth;
mod responses;

use responses::ResponseRelay;

pub struct CodexAccount {
    home: PathBuf,
    version: String,
    endpoint: String,
    refresh_endpoint: String,
}
impl CodexAccount {
    pub async fn relay(
        &self,
        socket: &mut TcpStream,
        body: &Value,
        identity: &str,
        db: &Arc<Mutex<Database>>,
        mut cancelled: watch::Receiver<bool>,
        headers_started: &mut bool,
    ) -> anyhow::Result<()> {
        let mut request = crate::adapters::claude::api_proxy::responses_request(body);
        request["store"] = json!(false);
        request["stream"] = json!(true);
        request["parallel_tool_calls"] = body
            .get("parallel_tool_calls")
            .cloned()
            .unwrap_or(json!(true));
        request["prompt_cache_key"] = json!(identity);
        if let Some(choice) = body.get("tool_choice") {
            request["tool_choice"] = if choice["type"] == "function" {
                json!({"type":"function","name":choice["function"]["name"]})
            } else {
                choice.clone()
            };
        }
        for key in [
            "max_output_tokens",
            "max_completion_tokens",
            "temperature",
            "top_p",
            "previous_response_id",
            "user",
            "safety_identifier",
            "prompt_cache_options",
        ] {
            request.as_object_mut().unwrap().remove(key);
        }
        if matches!(
            body["service_tier"].as_str(),
            Some("priority" | "ultrafast")
        ) {
            request["service_tier"] = body["service_tier"].clone();
        }
        let saved = Repositories::new(&db.lock().unwrap().raw)
            .account_gateway_sessions()
            .get(&format!("responses:{identity}"))?
            .unwrap_or(Value::Null);
        let mut reasoning = saved["reasoning"].as_object().cloned().unwrap_or_default();
        let mut input = vec![];
        let mut restored = HashSet::new();
        for item in request["input"].as_array().into_iter().flatten() {
            if item["type"] == "function_call" {
                if let Some(items) = item["call_id"]
                    .as_str()
                    .and_then(|id| reasoning.get(id))
                    .and_then(Value::as_array)
                {
                    for r in items {
                        if restored.insert(r["id"].to_string()) {
                            input.push(r.clone());
                        }
                    }
                }
            }
            input.push(item.clone());
        }
        request["input"] = json!(input);
        let mut credential = self.token(None).await?;
        let client = client()?;
        let mut reply = None;
        for attempt in 0..2 {
            let res = client
                .post(&self.endpoint)
                .bearer_auth(&credential.0)
                .header("chatgpt-account-id", &credential.1)
                .header("OpenAI-Beta", "responses=experimental")
                .header("originator", "codex_cli_rs")
                .header("User-Agent", format!("codex_cli_rs/{}", self.version))
                .header("version", &self.version)
                .header("session-id", identity)
                .header("thread-id", identity)
                .header("Accept", "text/event-stream")
                .json(&request)
                .send()
                .await?;
            if res.status() == 401 && attempt == 0 {
                credential = self.token(Some(&credential.0)).await?;
                continue;
            }
            anyhow::ensure!(
                res.status().is_success(),
                "Codex model request returned HTTP {} for the selected account",
                res.status().as_u16()
            );
            reply = Some(res);
            break;
        }
        let mut reply =
            reply.ok_or_else(|| anyhow::anyhow!("Codex account authentication failed"))?;
        let stream = body["stream"] == true;
        let id = format!("chatcmpl-{}", uuid::Uuid::new_v4());
        let model = &body["model"];
        let mut parser = ResponseRelay::default();
        if stream {
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n").await?;
        }
        *headers_started = stream;
        let mut buffer = String::new();
        let mut utf8 = vec![];
        loop {
            let bytes = tokio::select! {_ = cancelled.changed()=>anyhow::bail!("Codex account request cancelled"),bytes=reply.chunk()=>bytes?};
            let Some(bytes) = bytes else { break };
            utf8.extend_from_slice(&bytes);
            let length = match std::str::from_utf8(&utf8) {
                Ok(_) => utf8.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => anyhow::bail!("Codex returned invalid UTF-8"),
            };
            buffer.push_str(std::str::from_utf8(&utf8[..length])?);
            utf8.drain(..length);
            buffer = buffer.replace("\r\n", "\n");
            anyhow::ensure!(
                buffer.len() <= 2 * 1024 * 1024,
                "Codex event exceeds the frame limit"
            );
            while let Some(at) = buffer.find("\n\n") {
                let frame = buffer[..at].to_string();
                buffer.drain(..at + 2);
                let data = frame
                    .lines()
                    .filter_map(|l| l.strip_prefix("data:").map(str::trim_start))
                    .collect::<Vec<_>>()
                    .join("\n");
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let event: Value = serde_json::from_str(&data)?;
                for delta in parser.event(&event)? {
                    if stream {
                        let frame = json!({"id":id,"object":"chat.completion.chunk","model":model,"choices":[{"index":0,"delta":delta,"finish_reason":Value::Null}]});
                        socket
                            .write_all(format!("data: {frame}\n\n").as_bytes())
                            .await?;
                    }
                }
                if event["type"] == "response.completed" {
                    let output = event["response"]["output"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    let opaque = output
                        .iter()
                        .filter(|item| {
                            item["type"] == "reasoning" && item["encrypted_content"].is_string()
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    if !opaque.is_empty() {
                        for call in output.iter().filter(|v| v["type"] == "function_call") {
                            if let Some(id) = call["call_id"].as_str() {
                                reasoning.insert(id.into(), json!(opaque));
                            }
                        }
                    }
                    while reasoning.len() > 128 {
                        let key = reasoning.keys().next().unwrap().clone();
                        reasoning.remove(&key);
                    }
                    Repositories::new(&db.lock().unwrap().raw)
                        .account_gateway_sessions()
                        .save(
                            &json!({"id":format!("responses:{identity}"),"reasoning":reasoning}),
                            &crate::errors::now_iso(),
                        )?;
                }
            }
        }
        anyhow::ensure!(
            parser.completed,
            "Codex stream ended without a completed response"
        );
        let finish = if parser.calls.is_empty() {
            "stop"
        } else {
            "tool_calls"
        };
        if stream {
            let end = json!({"id":id,"object":"chat.completion.chunk","model":model,"choices":[{"index":0,"delta":{},"finish_reason":finish}]});
            socket
                .write_all(format!("data: {end}\n\n").as_bytes())
                .await?;
            if !parser.usage.is_null() {
                let u = json!({"id":id,"object":"chat.completion.chunk","model":model,"choices":[],"usage":parser.usage});
                socket
                    .write_all(format!("data: {u}\n\n").as_bytes())
                    .await?;
            }
            socket.write_all(b"data: [DONE]\n\n").await?;
        } else {
            let value = json!({"id":id,"object":"chat.completion","model":model,"choices":[{"index":0,"message":{"role":"assistant","content":parser.text,"reasoning_content":parser.reasoning,"tool_calls":parser.calls},"finish_reason":finish}],"usage":parser.usage});
            let data = value.to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}",data.len()).as_bytes()).await?;
        }
        Ok(())
    }
}
fn client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(1800))
        .build()?)
}
