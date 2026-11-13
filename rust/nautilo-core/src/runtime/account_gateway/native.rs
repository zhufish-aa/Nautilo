//! Resident native conversations and parked caller-tool exchanges.
use super::http::error;
use super::images::{materialize_images, without_image_data};
use super::tools;
use super::{hash, Route};
use crate::adapters::AdapterResumeRequest;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{
    net::TcpStream,
    sync::{mpsc, watch},
};

impl Route {
    pub(super) async fn serve_native(
        self: Arc<Self>,
        mut socket: TcpStream,
        body: &Value,
        identity: &str,
    ) -> anyhow::Result<()> {
        let Some(messages) = body["messages"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 2000)
        else {
            return error(
                &mut socket,
                400,
                "INVALID_MESSAGES",
                "Expected a non-empty messages array",
            )
            .await;
        };
        let mut conversation = self.exchange.lock().await;
        if conversation.worker.is_some() {
            let delivered = tools::deliver_results(&self.pending, messages);
            if delivered == 0 {
                return error(
                    &mut socket,
                    409,
                    "TOOL_RESULTS_REQUIRED",
                    "Return the outstanding tool_call_id results before starting another turn",
                )
                .await;
            }
        } else {
            let hashes = messages.iter().map(hash).collect::<Vec<_>>();
            let prefix = conversation.hashes.len();
            if prefix > hashes.len() || conversation.hashes.iter().zip(&hashes).any(|(a, b)| a != b)
            {
                return error(&mut socket,409,"NATIVE_CONVERSATION_DIVERGED","The caller history differs from the pinned native conversation; start an explicit new chat").await;
            }
            let tools = body["tools"].as_array().cloned().unwrap_or_default();
            if tools.len() > 256 {
                return error(
                    &mut socket,
                    400,
                    "TOO_MANY_TOOLS",
                    "The relay supports up to 256 caller tools",
                )
                .await;
            }
            if tools.iter().any(|t| {
                t["type"] != "function"
                    || t["function"]["name"].as_str().is_none_or(|n| n.is_empty())
            }) {
                return error(
                    &mut socket,
                    400,
                    "INVALID_CALLER_TOOLS",
                    "Expected named function tools",
                )
                .await;
            }
            let signature = hash(&json!(tools));
            if conversation
                .tools
                .as_ref()
                .is_some_and(|old| old != &signature)
            {
                return error(&mut socket,409,"NATIVE_TOOLS_CHANGED","The native conversation was created with a different caller tool set; start a new chat").await;
            }
            let mut request = self.template.lock().unwrap().clone();
            request.model = body["model"].as_str().map(str::to_string).or(request.model);
            request.reasoning_effort = body["reasoning_effort"]
                .as_str()
                .map(str::to_string)
                .or(request.reasoning_effort);
            let incoming = messages[prefix..]
                .iter()
                .filter(|m| m["role"] != "assistant" && m["role"] != "tool")
                .cloned()
                .collect::<Vec<_>>();
            if incoming.is_empty() {
                return error(
                    &mut socket,
                    400,
                    "NO_NEW_INPUT",
                    "No new caller input was supplied",
                )
                .await;
            }
            request.local_image_paths = match materialize_images(&incoming, &request.cwd) {
                Ok(paths) => paths,
                Err(e) => return error(&mut socket, 400, "INVALID_IMAGE", &e.to_string()).await,
            };
            request.prompt=format!("You are the model-provider bridge for a separate coding harness. Preserve the supplied message roles. Answer its user normally. Caller tools are exposed below as nautilo_relay_N; when using a caller tool call that relay and wait for its real result. The outer harness executes caller tools. Do not claim a tool ran before its result. This is a live native conversation, not a replay/resume summary.\n{}",serde_json::to_string(&without_image_data(&json!(incoming)))?);
            let (tx, rx) = mpsc::unbounded_channel();
            tools::bind_caller_tools(&mut request, &tools, self.pending.clone(), tx.clone());
            let native = self.native_id.lock().unwrap().clone();
            let run = match native {
                Some(id) => self.adapter.resume(AdapterResumeRequest {
                    start: request,
                    provider_session_id: id,
                }),
                None => self.adapter.start(request),
            };
            let run = match run {
                Ok(r) => r,
                Err(e) => {
                    return error(
                        &mut socket,
                        502,
                        "NATIVE_ACCOUNT_START_FAILED",
                        &e.to_string(),
                    )
                    .await
                }
            };
            let (cancel, cancelled) = watch::channel(false);
            *self.cancel.lock().unwrap() = Some(cancel);
            tokio::spawn(self.clone().forward_events(run, tx, cancelled));
            conversation.pending_history = Some((hashes, signature));
            conversation.worker = Some(rx);
        }
        super::completion::write_completion(&self, socket, body, &mut conversation, identity).await
    }
}
