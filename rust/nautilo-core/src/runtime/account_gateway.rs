//! Account-pinned model endpoints. Codex and OpenCode use their native model
//! HTTP protocols; Claude Code and Antigravity use Magpie's CLI/tool-bridge
//! approach. The outer Harness owns caller tools and its native conversation.
use crate::{
    adapters::{registry::AdapterRegistry, AdapterStartRequest},
    database::{Database, Repositories},
    errors::{invalid, now_iso, CoreResult},
    runtime::security::CredentialService,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::{
    io::AsyncWriteExt,
    net::TcpStream,
    sync::{mpsc, watch},
};

mod completion;
mod claude;
mod conversations;
mod events;
mod http;
mod images;
mod native;
mod route;
mod server;
mod tools;
#[cfg(test)]
mod native_smoke;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod opencode_tests;

use http::{error, response, write_sse};

pub(crate) fn supports_account_provider(provider: &str) -> bool {
    matches!(provider, "codex" | "claude-code" | "opencode" | "antigravity")
}

pub struct AccountGateways {
    db: Arc<Mutex<Database>>,
    credentials: Arc<CredentialService>,
    adapters: AdapterRegistry,
    routes: tokio::sync::Mutex<HashMap<String, Arc<Route>>>,
    server: tokio::sync::OnceCell<server::GatewayServer>,
}
struct Route {
    route_id: String,
    conversations: tokio::sync::Mutex<Vec<Arc<Route>>>,
    url: String,
    key: String,
    connection: Value,
    db: Arc<Mutex<Database>>,
    codex: Option<Arc<crate::runtime::codex_account::CodexAccount>>,
    opencode: Option<Arc<crate::runtime::opencode_account::OpenCodeAccount>>,
    antigravity: Option<Arc<crate::runtime::antigravity_account::AntigravityAccount>>,
    adapter: Arc<dyn crate::adapters::AgentCliAdapter>,
    template: Mutex<AdapterStartRequest>,
    native_id: Arc<Mutex<Option<String>>>,
    exchange: Arc<tokio::sync::Mutex<Conversation>>,
    cancel: Mutex<Option<watch::Sender<bool>>>,
    pending: tools::PendingTools,
}
struct Conversation {
    hashes: Vec<String>,
    tools: Option<String>,
    pending_history: Option<(Vec<String>, String)>,
    worker: Option<mpsc::UnboundedReceiver<Value>>,
    model: Option<String>,
    last_assistant: Option<String>,
    reusable: bool,
    used_at: std::time::Instant,
}
impl Default for Conversation {
    fn default() -> Self {
        Self { hashes: vec![], tools: None, pending_history: None, worker: None, model: None, last_assistant: None,
            reusable: true, used_at: std::time::Instant::now() }
    }
}
impl AccountGateways {
    pub fn new(
        db: Arc<Mutex<Database>>,
        credentials: Arc<CredentialService>,
        adapters: AdapterRegistry,
    ) -> Self {
        Self {
            db,
            credentials,
            adapters,
            routes: tokio::sync::Mutex::new(HashMap::new()),
            server: tokio::sync::OnceCell::new(),
        }
    }
    pub async fn bind(
        &self,
        session_id: &str,
        connection: &Value,
        outer: &mut AdapterStartRequest,
    ) -> CoreResult<()> {
        let provider = connection["harness"].as_str().unwrap_or("");
        if !supports_account_provider(provider) {
            return Err(invalid(
                "connectionId",
                "This account has no native model relay",
            ));
        }
        let identity = format!(
            "{}:{}:{}",
            session_id,
            connection["id"].as_str().unwrap_or(""),
            connection["revision"].as_u64().unwrap_or(0)
        );
        let mut routes = self.routes.lock().await;
        let route = if let Some(route) = routes.get(&identity) {
            route.clone()
        } else {
            let route = self
                .open_route(provider, &identity, connection, outer)
                .await?;
            routes.insert(identity.clone(), route.clone());
            route
        };
        drop(routes);
        route.check_login().await?;
        let configured = connection["models"].as_array().map(Vec::as_slice).unwrap_or_default();
        let catalog = if matches!(provider, "opencode" | "antigravity")
            || (route::requested_model(outer).is_none() && configured.is_empty())
        {
            let native = route.template.lock().unwrap().clone();
            self.adapters.list_models(&native.instance, Some(&json!({"env": native.env}))).await?
        } else {
            Value::Null
        };
        route::bind_selected_model(outer, configured, &catalog)?;
        self.configure_outer(&route, session_id, connection, outer);
        Ok(())
    }
    pub async fn cancel_session(&self, session: &str) {
        let prefix = format!("{session}:");
        let routes = {
            let routes = self.routes.lock().await;
            routes
                .iter()
                .filter(|(id, _)| id.starts_with(&prefix))
                .map(|(_, route)| route.clone())
                .collect::<Vec<_>>()
        };
        for route in routes {
            route.stop();
            let children = route.conversations.lock().await.clone();
            for child in children { child.stop(); }
        }
    }
}
impl Route {
    async fn check_login(&self) -> CoreResult<()> {
        if self.opencode.is_some() || self.antigravity.is_some() { return Ok(()); }
        if let Some(codex) = &self.codex {
            return codex.check_login().await.map_err(|cause| {
                if crate::runtime::account_auth::is_authentication_error(&cause.to_string()) {
                    crate::runtime::account_auth::required(&self.connection)
                } else {
                    crate::errors::CoreError::reason(
                        crate::errors::ErrorCode::RunStartFailed,
                        cause.to_string(),
                    )
                }
            });
        }
        let template = self.template.lock().unwrap().clone();
        crate::runtime::account_auth::check_native_login(&self.connection, &template).await
    }

    fn stop(&self) {
        if let Some(cancel) = self.cancel.lock().unwrap().take() {
            let _ = cancel.send(true);
        }
        self.pending.lock().unwrap().clear();
    }
    fn allowed(&self) -> bool {
        let db = self.db.lock().unwrap();
        let r = Repositories::new(&db.raw);
        let s = r
            .integration_settings()
            .get("integration-settings")
            .ok()
            .flatten()
            .unwrap_or(Value::Null);
        s["gateway"]["enabled"] == true
            && s["gateway"]["connectionIds"]
                .as_array()
                .is_some_and(|a| a.contains(&self.connection["id"]))
            && r.runtime_connections()
                .get(self.connection["id"].as_str().unwrap_or(""))
                .ok()
                .flatten()
                .is_some_and(|c| c["enabled"] == true)
    }
    async fn serve(self: Arc<Self>, mut socket: TcpStream, path: &str, body: Value) -> anyhow::Result<()> {
        if !self.allowed() {
            self.stop();
            for child in self.conversations.lock().await.iter() { child.stop(); }
            return error(
                &mut socket,
                403,
                "ACCOUNT_ROUTE_DISABLED",
                "This explicit account route is disabled",
            )
            .await;
        }
        if path == "/v1/models" {
            let models = self.connection["models"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|model| json!({"id": model["id"], "object": "model"}))
                .collect::<Vec<_>>();
            return response(&mut socket, 200, &json!({"object": "list", "data": models})).await;
        }
        if path != "/v1/chat/completions" {
            return error(
                &mut socket,
                404,
                "GATEWAY_ROUTE_NOT_FOUND",
                "Use the Chat Completions model-provider endpoint",
            )
            .await;
        }
        let identity = self.route_id.as_str();
        if self.codex.is_some() || self.opencode.is_some() || self.antigravity.is_some() {
            // Direct account APIs accept independent requests. Cancellation is
            // scoped to this HTTP call, never to another call on the account.
            let child = self.new_conversation(identity);
            self.conversations.lock().await.push(child.clone());
            let (cancel, cancelled) = watch::channel(false);
            *child.cancel.lock().unwrap() = Some(cancel);
            let mut headers = false;
            let result = if let Some(codex) = &self.codex { codex.relay(
                    &mut socket,
                    &body,
                    identity,
                    &self.db,
                    cancelled,
                    &mut headers,
                )
                .await } else if let Some(opencode)=&self.opencode {
                    let cwd=self.template.lock().unwrap().cwd.clone();
                    opencode.relay(&mut socket,&body,identity,&cwd,cancelled,&mut headers).await
                } else { self.antigravity.as_ref().unwrap().relay(&mut socket,&body,cancelled,&mut headers).await };
            self.conversations.lock().await.retain(|current| !Arc::ptr_eq(current, &child));
            let result = match result {
                Ok(()) => Ok(()),
                Err(e) if headers => {
                    let (code, message) = self.account_error(&e.to_string());
                    write_sse(
                        &mut socket,
                        &json!({"error":{"code":code,"message":message}}),
                    )
                    .await?;
                    socket.write_all(b"data: [DONE]\n\n").await?;
                    Ok(())
                }
                Err(e) => {
                    let (code, message) = self.account_error(&e.to_string());
                    let status=e.downcast_ref::<crate::runtime::account_auth::ModelRequestError>()
                        .map(|error|error.status).filter(|status|(400..600).contains(status)).unwrap_or(502);
                    error(
                        &mut socket,
                        if code == "AGENT_NOT_AUTHENTICATED" {
                            401
                        } else {
                            status
                        },
                        code,
                        &message,
                    )
                    .await
                }
            };
            return result;
        }
        let Some(messages) = body["messages"].as_array().filter(|messages| !messages.is_empty()) else {
            return error(&mut socket, 400, "INVALID_MESSAGES", "Expected a non-empty messages array").await;
        };
        let (child, mut conversation) = self.select_conversation(&body, messages, identity).await;
        let child_id = child.template.lock().unwrap().local_session_id.clone().unwrap();
        let result = child.clone().serve_native(socket, &body, &child_id, &mut conversation).await;
        if result.is_err() { child.stop(); conversation.reusable = false; }
        if !conversation.reusable { child.invalidate_checkpoint(&child_id); }
        conversation.used_at = std::time::Instant::now();
        drop(conversation);
        self.prune_conversations().await;
        result
    }
    fn account_error(&self, message: &str) -> (&'static str, String) {
        if crate::runtime::account_auth::is_authentication_error(message) {
            (
                "AGENT_NOT_AUTHENTICATED",
                crate::runtime::account_auth::required(&self.connection)
                    .0
                    .message,
            )
        } else {
            ("NATIVE_ACCOUNT_ERROR", message.to_owned())
        }
    }
    fn checkpoint(&self, id: &str, hashes: &[String], tools: &str, model: Option<&str>, last_assistant: Option<&str>) {
        let checkpoint = json!({
            "id": id,
            "nativeSessionId": self.native_id.lock().unwrap().clone(),
            "routeId": self.route_id,
            "model": model,
            "lastAssistant": last_assistant,
            "localSessionId": self.template.lock().unwrap().local_session_id,
            "hashes": hashes,
            "tools": tools,
        });
        let db = self.db.lock().unwrap();
        let _ = Repositories::new(&db.raw)
            .account_gateway_sessions()
            .save(&checkpoint, &now_iso());
    }

    fn invalidate_checkpoint(&self, id: &str) {
        let db = self.db.lock().unwrap();
        let records = Repositories::new(&db.raw).account_gateway_sessions();
        if let Ok(Some(mut row)) = records.get(id) {
            row["reusable"] = json!(false);
            let _ = records.save(&row, &now_iso());
        }
    }
}
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
fn stream_delta(
    state: &mut HashMap<String, String>,
    key: String,
    part: &str,
    phase: Option<&str>,
) -> String {
    let old = state.entry(key).or_default();
    if phase == Some("delta") {
        old.push_str(part);
        return part.into();
    }
    if part.starts_with(old.as_str()) {
        let delta = part[old.len()..].to_string();
        *old = part.into();
        delta
    } else if old.is_empty() {
        *old = part.into();
        part.into()
    } else {
        String::new()
    }
}
