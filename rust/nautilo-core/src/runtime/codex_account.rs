//! Magpie's Codex model path: native credentials, coordinated token refresh,
//! request normalization and streaming Responses conversion. Unsupported stores
//! are reported explicitly; they never silently switch to an Agent CLI relay.
use crate::database::{Database, Repositories};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{io::{AsyncReadExt,AsyncWriteExt}, net::TcpStream, sync::watch};
mod auth;
mod responses;
mod request;

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
        let (mut request,names_back) = request::prepare(body,identity,&self.home);
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
                            let mut r=r.clone();if let Some(object)=r.as_object_mut(){object.remove("id");object.remove("status");}input.push(r);
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
        let mut disconnected=[0u8;1];
        for attempt in 0..2 {
            let request = client
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
                .send();
            let res=tokio::select!{result=request=>result?,_=cancelled.changed()=>anyhow::bail!("Codex account request cancelled"),_=socket.read(&mut disconnected)=>return Ok(())};
            if res.status() == 401 && attempt == 0 {
                credential = self.token(Some(&credential.0)).await?;
                continue;
            }
            if !res.status().is_success() {
                let status=res.status().as_u16();
                let retry_after = res.headers().get(reqwest::header::RETRY_AFTER).and_then(|value| value.to_str().ok()).map(str::to_owned);
                let failure:Value=res.json().await.unwrap_or(Value::Null);
                let detail=failure["error"]["message"].as_str().or(failure["message"].as_str())
                    .unwrap_or("The upstream rejected the selected account's model request");
                let detail=detail.replace(&credential.0,"[redacted]").chars().take(1000).collect::<String>();
                return Err(crate::runtime::account_auth::ModelRequestError{status,retry_after,message:format!("Codex model request returned HTTP {status}: {detail}")}.into());
            }
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
            let bytes = tokio::select! {_ = cancelled.changed()=>anyhow::bail!("Codex account request cancelled"),bytes=reply.chunk()=>bytes?,_=socket.read(&mut disconnected)=>return Ok(())};
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
                for mut delta in parser.event(&event)? {
                    request::restore_names(&mut delta,&names_back);
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
                    // Parallel title/main/tool requests share the account, not
                    // an HTTP transaction. Merge under the database lock so
                    // one completed request cannot erase another's call IDs.
                    let guard = db.lock().unwrap();
                    let records = Repositories::new(&guard.raw).account_gateway_sessions();
                    let id = format!("responses:{identity}");
                    let saved = records.get(&id)?.unwrap_or(Value::Null);
                    let mut current = saved["reasoning"].as_object().cloned().unwrap_or_default();
                    current.extend(reasoning.clone());
                    records.save(&json!({"id":id,"reasoning":current}), &crate::errors::now_iso())?;
                }
            }
        }
        anyhow::ensure!(
            parser.completed,
            "Codex stream ended without a completed response"
        );
        for call in &mut parser.calls {request::restore_names(call,&names_back);}
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
