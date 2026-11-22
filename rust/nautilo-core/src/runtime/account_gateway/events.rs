//! Native adapter events projected into caller-visible stream frames.
use super::{stream_delta, Route};
use crate::adapters::{AdapterEvent, AdapterRun, AdapterStartRequest};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{mpsc, watch};

impl Route {
    pub(super) async fn forward_events(
        self: Arc<Self>,
        mut run: AdapterRun,
        tx: mpsc::UnboundedSender<Value>,
        mut cancelled: watch::Receiver<bool>,
        mut replay: Option<AdapterStartRequest>,
    ) {
        let mut seen = HashMap::<String, String>::new();
        let mut stderr=String::new();
        loop {
            let event = tokio::select! {
                _ = cancelled.changed() => {
                    let _ = tx.send(json!({"error": "Account relay cancelled"}));
                    run.cancel().await;
                    break;
                }
                event = run.events.recv() => event,
            };
            match event {
                Some(AdapterEvent::Session {
                    provider_session_id,
                    ..
                }) => {
                    *self.native_id.lock().unwrap() = Some(provider_session_id);
                }
                Some(AdapterEvent::Message {
                    text,
                    phase,
                    message_id,
                    subagent_dispatch_id: None,
                    ..
                }) => {
                    emit_delta(
                        &tx,
                        &mut seen,
                        "content",
                        message_id,
                        &text,
                        phase.as_deref(),
                    );
                }
                Some(AdapterEvent::Thinking {
                    text,
                    phase,
                    message_id,
                    subagent_dispatch_id: None,
                    ..
                }) => {
                    emit_delta(
                        &tx,
                        &mut seen,
                        "reasoning_content",
                        message_id,
                        &text,
                        phase.as_deref(),
                    );
                }
                Some(AdapterEvent::Usage {
                    input_tokens,
                    input_tokens_includes_cache,
                    output_tokens,
                    cached_input_tokens,
                    cache_creation_input_tokens,
                    reasoning_output_tokens,
                    ..
                }) => {
                    let input_tokens = input_tokens.map(|input| {
                        if input_tokens_includes_cache == Some(false) {
                            input + cached_input_tokens.unwrap_or(0) + cache_creation_input_tokens.unwrap_or(0)
                        } else {
                            input
                        }
                    });
                    let _ = tx.send(json!({"usage": {
                        "prompt_tokens": input_tokens,
                        "completion_tokens": output_tokens,
                        "total_tokens": input_tokens.zip(output_tokens).map(|(i, o)| i + o),
                        "prompt_tokens_details": {"cached_tokens": cached_input_tokens},
                        "completion_tokens_details": {"reasoning_tokens": reasoning_output_tokens}
                    }}));
                }
                Some(AdapterEvent::Error { message }) => {
                    // Port of subscriptionBridge.start's missing saved-session
                    // fallback. Only before output/tool execution, and only a
                    // native resume refusal; provider/auth errors are preserved.
                    let missing=format!("{stderr}\n{message}").to_ascii_lowercase();
                    if seen.is_empty() && self.pending.lock().unwrap().is_empty()
                        && ["no conversation found with session id","session not found","unknown session id"].iter().any(|needle|missing.contains(needle)) {
                        if let Some(request)=replay.take() {
                            run.cancel().await;
                            *self.native_id.lock().unwrap()=None;
                            match self.adapter.start(request) {
                                Ok(fresh)=>{run=fresh;stderr.clear();continue;},
                                Err(error)=>{let _=tx.send(json!({"error":error.to_string()}));break;}
                            }
                        }
                    }
                    let _ = tx.send(json!({"error": message}));
                    run.cancel().await;
                    break;
                }
                Some(AdapterEvent::Timeout { .. }) => {
                    let _ = tx.send(json!({"error": "Native account request timed out"}));
                    run.cancel().await;
                    break;
                }
                Some(AdapterEvent::Exit { exit_code, .. }) => {
                    let _ =
                        tx.send(json!({"done": true, "failed": exit_code.is_some_and(|c| c != 0)}));
                    break;
                }
                None => {
                    let _ = tx
                        .send(json!({"error": "Native account stream ended without a completion"}));
                    break;
                }
                Some(AdapterEvent::Raw{stream,text}) if stream=="stderr"=> {
                    stderr.push_str(&text);
                    if stderr.len()>8192 {stderr=stderr.chars().rev().take(4096).collect::<String>().chars().rev().collect();}
                }
                _ => {}
            }
        }
    }
}

fn emit_delta(
    tx: &mpsc::UnboundedSender<Value>,
    seen: &mut HashMap<String, String>,
    field: &str,
    message_id: Option<String>,
    text: &str,
    phase: Option<&str>,
) {
    let key = format!("{field}:{}", message_id.unwrap_or_default());
    let delta = stream_delta(seen, key, text, phase);
    if !delta.is_empty() {
        let mut frame = serde_json::Map::new();
        frame.insert(field.into(), json!(delta));
        let _ = tx.send(Value::Object(frame));
    }
}
