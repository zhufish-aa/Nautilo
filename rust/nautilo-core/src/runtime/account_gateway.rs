//! A loopback Chat Completions model-provider endpoint backed by an explicitly
//! selected genuine Codex / Claude Code runtime. The outer harness owns caller
//! tools. A native MCP/dynamic-tool call parks until its HTTP tool result arrives.
//! Native auth, process reuse and native session IDs stay with the account CLI.
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
mod events;
mod http;
mod images;
mod native;
mod route;
mod tools;

use http::{error, read_http, response, write_sse};

pub struct AccountGateways {
    db: Arc<Mutex<Database>>,
    credentials: Arc<CredentialService>,
    adapters: AdapterRegistry,
    routes: tokio::sync::Mutex<HashMap<String, Arc<Route>>>,
}
struct Route {
    url: String,
    key: String,
    connection: Value,
    db: Arc<Mutex<Database>>,
    codex: Option<crate::runtime::codex_account::CodexAccount>,
    adapter: Arc<dyn crate::adapters::AgentCliAdapter>,
    template: Mutex<AdapterStartRequest>,
    native_id: Arc<Mutex<Option<String>>>,
    exchange: tokio::sync::Mutex<Conversation>,
    cancel: Mutex<Option<watch::Sender<bool>>>,
    pending: tools::PendingTools,
}
#[derive(Default)]
struct Conversation {
    hashes: Vec<String>,
    tools: Option<String>,
    pending_history: Option<(Vec<String>, String)>,
    worker: Option<mpsc::UnboundedReceiver<Value>>,
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
        }
    }
    pub async fn bind(
        &self,
        session_id: &str,
        connection: &Value,
        outer: &mut AdapterStartRequest,
    ) -> CoreResult<()> {
        let provider = connection["harness"].as_str().unwrap_or("");
        if !matches!(provider, "codex" | "claude-code") {
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
            route.exchange.lock().await.worker = None;
        }
    }
}
impl Route {
    async fn check_login(&self) -> CoreResult<()> {
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
    async fn serve(self: Arc<Self>, mut socket: TcpStream, identity: &str) -> anyhow::Result<()> {
        let (path, authorization, body) = match read_http(&mut socket).await {
            Ok(v) => v,
            Err(_) => {
                return error(
                    &mut socket,
                    400,
                    "INVALID_GATEWAY_REQUEST",
                    "Malformed or oversized HTTP request",
                )
                .await
            }
        };
        if authorization != format!("Bearer {}", self.key)
            || !path.starts_with(&format!("/{}/v1/", self.key))
        {
            return error(
                &mut socket,
                401,
                "GATEWAY_AUTH_REQUIRED",
                "Invalid local gateway credential",
            )
            .await;
        }
        if !self.allowed() {
            self.stop();
            return error(
                &mut socket,
                403,
                "ACCOUNT_ROUTE_DISABLED",
                "This explicit account route is disabled",
            )
            .await;
        }
        if path.ends_with("/models") {
            let models = self.connection["models"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|model| json!({"id": model["id"], "object": "model"}))
                .collect::<Vec<_>>();
            return response(&mut socket, 200, &json!({"object": "list", "data": models})).await;
        }
        if !path.ends_with("/chat/completions") {
            return error(
                &mut socket,
                404,
                "GATEWAY_ROUTE_NOT_FOUND",
                "Use the Chat Completions model-provider endpoint",
            )
            .await;
        }
        if let Some(codex) = &self.codex {
            let _exchange = self.exchange.lock().await;
            let (cancel, cancelled) = watch::channel(false);
            *self.cancel.lock().unwrap() = Some(cancel);
            let mut headers = false;
            return match codex
                .relay(
                    &mut socket,
                    &body,
                    identity,
                    &self.db,
                    cancelled,
                    &mut headers,
                )
                .await
            {
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
                    error(
                        &mut socket,
                        if code == "AGENT_NOT_AUTHENTICATED" {
                            401
                        } else {
                            502
                        },
                        code,
                        &message,
                    )
                    .await
                }
            };
        }
        self.serve_native(socket, &body, identity).await
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
    fn checkpoint(&self, id: &str, hashes: &[String], tools: &str) {
        let checkpoint = json!({
            "id": id,
            "nativeSessionId": self.native_id.lock().unwrap().clone(),
            "hashes": hashes,
            "tools": tools,
        });
        let db = self.db.lock().unwrap();
        let _ = Repositories::new(&db.raw)
            .account_gateway_sessions()
            .save(&checkpoint, &now_iso());
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
