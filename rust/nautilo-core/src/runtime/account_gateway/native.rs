//! Resident native conversations and parked caller-tool exchanges.
use super::http::error;
use super::tools;
use super::{hash, Conversation, Route};
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
        conversation: &mut Conversation,
    ) -> anyhow::Result<()> {
        let Some(messages) = body["messages"]
            .as_array()
            .filter(|a| !a.is_empty())
        else {
            return error(
                &mut socket,
                400,
                "INVALID_MESSAGES",
                "Expected a non-empty messages array",
            )
            .await;
        };
        if conversation.worker.is_some() {
            let delivered = tools::deliver_results(&self.pending, messages);
            if delivered == 0 {
                // A parked worker may have ended between matching it and
                // delivering a result. Replay the API context in a fresh run,
                // as Magpie does when a saved run is unavailable.
                self.stop();
                conversation.worker=None;
                conversation.hashes.clear();
                *self.native_id.lock().unwrap()=None;
            }
            if delivered>0 {conversation.pending_history = Some((messages.iter().map(hash).collect(), hash(&json!(body["tools"].as_array().cloned().unwrap_or_default()))));}
        }
        if conversation.worker.is_none() {
            let hashes = messages.iter().map(hash).collect::<Vec<_>>();
            let prefix = conversation.hashes.len();
            let tools = body["tools"].as_array().cloned().unwrap_or_default();
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
            let mut request = self.template.lock().unwrap().clone();
            request.model = body["model"].as_str().map(str::to_string).or(request.model);
            request.reasoning_effort = body["reasoning_effort"]
                .as_str()
                .map(str::to_string)
                .or(request.reasoning_effort);
            let incoming = messages[prefix..]
                .iter()
                .filter(|m| prefix == 0 || (m["role"] != "assistant" && m["role"] != "tool"))
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
            let content=super::claude::render(&incoming,&body["tool_choice"]);
            request.prompt=content.iter().filter_map(|block|block["text"].as_str()).collect::<Vec<_>>().join("");
            request.instance["providerOptions"]["accountModelRelay"]=json!(true);
            request.instance["providerOptions"]["accountRelayContentBlocks"]=json!(content);
            let (tx, rx) = mpsc::unbounded_channel();
            tools::bind_caller_tools(&mut request, if body["tool_choice"]=="none" {&[]} else {&tools}, self.pending.clone(), tx.clone());
            let native = self.native_id.lock().unwrap().clone();
            let replay=native.as_ref().map(|_| {
                let mut fresh=request.clone();let content=super::claude::render(messages,&body["tool_choice"]);
                fresh.prompt=content.iter().filter_map(|block|block["text"].as_str()).collect::<Vec<_>>().join("");
                fresh.instance["providerOptions"]["accountRelayContentBlocks"]=json!(content);fresh
            });
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
            tokio::spawn(self.clone().forward_events(run, tx, cancelled, replay));
            conversation.pending_history = Some((hashes, signature));
            conversation.worker = Some(rx);
        }
        super::completion::write_completion(&self, socket, body, conversation, identity).await
    }
}
