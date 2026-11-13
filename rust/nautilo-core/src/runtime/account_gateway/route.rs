//! Account-pinned route construction and outer-Harness endpoint binding.
use super::{hash, AccountGateways, Conversation, Route};
use crate::{
    adapters::AdapterStartRequest,
    database::Repositories,
    errors::{invalid, CoreResult},
    runtime::security::environment_policy::build_environment,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::net::TcpListener;

impl AccountGateways {
    pub(super) async fn open_route(
        &self,
        provider: &str,
        identity: &str,
        connection: &Value,
        outer: &AdapterStartRequest,
    ) -> CoreResult<Arc<Route>> {
        let adapter = self.adapters.get(provider)?;
        let source={let db=self.db.lock().unwrap();Repositories::new(&db.raw).agents().list_default()?.into_iter().find(|a|a["providerId"]==provider)}
    .unwrap_or_else(||json!({"id":format!("account-relay:{provider}"),"providerId":provider,"executable":adapter.descriptor()["defaultExecutable"],"baseArgs":[],"enabled":true,"providerOptions":{}}));
        let mut native_connection = connection.clone();
        native_connection
            .as_object_mut()
            .unwrap()
            .remove("viaAccountGateway");
        let instance =
            crate::application::connection_service::apply_connection(&source, &native_connection)?;
        let env = crate::application::connection_service::connection_environment(
            &instance,
            &native_connection,
            &self.credentials,
            build_environment(None, HashMap::new()),
        )?;
        let codex = if provider == "codex" {
            let detection = adapter.detect(&source).await;
            detection.version.as_deref().and_then(|version| {
                let version = version.trim_start_matches("codex-cli ");
                crate::runtime::codex_account::CodexAccount::file_store(
                    std::path::Path::new(
                        connection["loginProfileDirectory"].as_str().unwrap_or(""),
                    ),
                    version,
                )
            })
        } else {
            None
        };
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| invalid("gateway", &e.to_string()))?;
        let key = uuid::Uuid::new_v4().to_string();
        let url = format!(
            "http://127.0.0.1:{}/{key}/v1",
            listener.local_addr().unwrap().port()
        );
        let saved = Repositories::new(&self.db.lock().unwrap().raw)
            .account_gateway_sessions()
            .get(identity)?
            .unwrap_or(Value::Null);
        let route = Arc::new(Route {
            url,
            key,
            connection: connection.clone(),
            db: self.db.clone(),
            codex,
            adapter,
            template: Mutex::new(AdapterStartRequest {
                instance,
                env: Some(env),
                local_session_id: Some(format!("relay-{identity}")),
                cwd: outer.cwd.clone(),
                ..Default::default()
            }),
            native_id: Arc::new(Mutex::new(
                saved["nativeSessionId"].as_str().map(str::to_string),
            )),
            exchange: tokio::sync::Mutex::new(Conversation {
                hashes: saved["hashes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect(),
                tools: saved["tools"].as_str().map(str::to_string),
                pending_history: None,
                worker: None,
            }),
            cancel: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
        });
        let weak = Arc::downgrade(&route);
        let task_identity = identity.to_string();
        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    break;
                };
                let Some(route) = weak.upgrade() else { break };
                let identity = task_identity.clone();
                tokio::spawn(async move {
                    let _ = route.serve(socket, &identity).await;
                });
            }
        });
        Ok(route)
    }

    pub(super) fn configure_outer(
        &self,
        route: &Route,
        session_id: &str,
        connection: &Value,
        outer: &mut AdapterStartRequest,
    ) {
        {
            let mut t = route.template.lock().unwrap();
            t.request_interaction = outer.request_interaction.clone();
            t.permission_mode = outer.permission_mode.clone();
            t.timeout_ms = outer.timeout_ms;
            t.idle_timeout_ms = outer.idle_timeout_ms;
            t.model = outer.model.clone();
            t.reasoning_effort = outer.reasoning_effort.clone();
            t.service_tier = outer.service_tier.clone();
        }
        let harness = outer.instance["providerId"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let options = outer.instance["providerOptions"].as_object_mut().unwrap();
        options.insert("baseUrl".into(), json!(route.url));
        options.insert("apiType".into(), json!("openai-completions"));
        if harness == "codex" {
            options.insert("wireApi".into(), json!("chat"));
        }
        let env = outer.env.get_or_insert_with(HashMap::new);
        for k in [
            "NAUTILO_CONNECTION_API_KEY",
            "AGENTHUB_API_KEY",
            "OPENAI_API_KEY",
        ] {
            env.insert(k.into(), route.key.clone());
        }
        env.insert("OPENAI_BASE_URL".into(), route.url.clone());
        if let Some(descriptor) = self.adapters.find(&harness).map(|a| a.descriptor()) {
            for name in descriptor["credentialEnv"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                env.insert(name.into(), route.key.clone());
            }
            if let Some(name) = descriptor["baseUrlEnv"].as_str() {
                env.insert(name.into(), route.url.clone());
            }
        }
        env.insert(
            "NAUTILO_CONNECTION_DIRECTORY".into(),
            self.credentials
                .connection_directory(
                    connection["id"].as_str().unwrap(),
                    connection["revision"].as_u64().unwrap(),
                )
                .join("account-relay")
                .join(hash(&json!(session_id)))
                .to_string_lossy()
                .into_owned(),
        );
    }
}
