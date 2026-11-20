//! Account-pinned route construction and outer-Harness endpoint binding.
use super::{hash, AccountGateways, Conversation, Route};
use crate::{
    adapters::AdapterStartRequest,
    database::Repositories,
    errors::{invalid, CoreResult},
    runtime::security::environment_policy::{build_environment, provider_environment_passthrough},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub(super) fn requested_model(outer: &AdapterStartRequest) -> Option<&str> {
    outer.model.as_deref().map(str::trim).filter(|model| !model.is_empty())
}

fn enabled_model_id(model: &Value) -> Option<&str> {
    model["id"].as_str().map(str::trim).filter(|id| !id.is_empty() && model["enabled"] != false)
}

pub(super) fn bind_selected_model(
    outer: &mut AdapterStartRequest,
    configured: &[Value],
    catalog: &Value,
) -> CoreResult<()> {
    let discovered = catalog["models"].as_array().map(Vec::as_slice).unwrap_or_default();
    let selected = requested_model(outer).or_else(|| {
        if !configured.is_empty() {
            return configured.iter().find_map(enabled_model_id);
        }
        catalog["defaultModel"].as_str()
            .filter(|id| discovered.iter().any(|model| enabled_model_id(model) == Some(*id)))
            .or_else(|| discovered.iter().filter(|model| model["isDefault"] == true).find_map(enabled_model_id))
            .or_else(|| discovered.iter().find_map(enabled_model_id))
    }).ok_or_else(|| invalid("model", "Choose an enabled model from the selected account"))?.to_owned();
    if configured.iter().any(|model| model["id"] == selected && model["enabled"] == false) {
        return Err(invalid("model", "This model is disabled. Choose an enabled model."));
    }
    outer.model = Some(selected.clone());
    let Some(discovered) = discovered.iter().find(|model| enabled_model_id(model) == Some(selected.as_str())) else {
        return Ok(());
    };
    let mut models = outer.instance["models"].as_array().cloned().unwrap_or_default();
    if let Some(existing) = models.iter_mut().find(|model| model["id"] == selected) {
        let mut merged = discovered.as_object().cloned().unwrap_or_default();
        if let Some(fields) = existing.as_object() { merged.extend(fields.clone()); }
        *existing = Value::Object(merged);
    } else {
        models.push(discovered.clone());
    }
    outer.instance["models"] = json!(models);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_model_capabilities_reach_the_outer_harness_without_overwriting_overrides() {
        let catalog = json!({"models":[{"id":"opencode/free","reasoningEfforts":["low","high","max"],"contextWindow":200000}]});
        let mut outer = AdapterStartRequest { instance: json!({"models":[]}), model: Some("opencode/free".into()), ..Default::default() };
        bind_selected_model(&mut outer, &[], &catalog).unwrap();
        assert_eq!(outer.instance["models"][0]["reasoningEfforts"], json!(["low","high","max"]));
        outer.instance["models"][0]["contextWindow"] = json!(12345);
        bind_selected_model(&mut outer, &[], &catalog).unwrap();
        assert_eq!(outer.instance["models"].as_array().unwrap().len(), 1);
        assert_eq!(outer.instance["models"][0]["contextWindow"], 12345);
    }

    #[test]
    fn a_cleared_model_on_account_switch_uses_only_the_new_accounts_catalog() {
        let catalog = json!({"models":[
            {"id":"gemini-4-argon"},
            {"id":"gemini-3.8-flash","isDefault":true,"reasoningEfforts":["low","high"]}
        ]});
        let mut outer = AdapterStartRequest {
            instance: json!({"models":[]}), model: Some(String::new()), ..Default::default()
        };
        bind_selected_model(&mut outer, &[], &catalog).unwrap();
        assert_eq!(outer.model.as_deref(), Some("gemini-3.8-flash"));
        assert_eq!(outer.instance["models"][0]["reasoningEfforts"], json!(["low","high"]));

        let curated = [json!({"id":"gemini-3.8-flash","enabled":false}), json!({"id":"gemini-4-argon"})];
        outer.model = None;
        bind_selected_model(&mut outer, &curated, &catalog).unwrap();
        assert_eq!(outer.model.as_deref(), Some("gemini-4-argon"));

        outer.model = None;
        assert!(bind_selected_model(&mut outer, &curated[..1], &catalog).is_err());
    }
}

impl AccountGateways {
    pub(super) async fn open_route(
        &self,
        provider: &str,
        identity: &str,
        connection: &Value,
        outer: &AdapterStartRequest,
    ) -> CoreResult<Arc<Route>> {
        let adapter = self.adapters.get(provider)?;
        let source={
            let db=self.db.lock().unwrap();
            let mut sources=Repositories::new(&db.raw).agents().list_default()?.into_iter()
                .filter(|a|a["providerId"]==provider && a["enabled"]!=false).collect::<Vec<_>>();
            sources.sort_by_key(|a|a.pointer("/providerOptions/configurationKind").and_then(Value::as_str)!=Some("harness"));
            sources.into_iter().next()
        }
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
            build_environment(None, provider_environment_passthrough(&instance, Some(&adapter.descriptor()))),
        )?;
        let codex = if provider == "codex" {
            let detection = adapter.detect(&source).await;
            // codex_models.go's pinned fallback is 0.159.0. Model inference
            // does not depend on starting the Codex Agent or on its presence.
            let version=detection.version.as_deref().unwrap_or("0.159.0").trim_start_matches("codex-cli ");
            let home=connection["loginProfileDirectory"].as_str().filter(|path|!path.is_empty()).map(std::path::PathBuf::from)
                .or_else(||env.get("CODEX_HOME").map(std::path::PathBuf::from))
                .unwrap_or_else(||dirs::home_dir().unwrap_or_default().join(".codex"));
            Some(crate::runtime::codex_account::CodexAccount::file_store(&home,version).map_err(|cause| {
                if crate::runtime::account_auth::is_authentication_error(&cause.to_string()) {crate::runtime::account_auth::required(connection)}
                else {invalid("connectionId",&cause.to_string())}
            })?)
        } else {
            None
        };
        let server = self.server.get_or_try_init(super::server::GatewayServer::open).await?;
        let key = uuid::Uuid::new_v4().to_string();
        let saved = Repositories::new(&self.db.lock().unwrap().raw)
            .account_gateway_sessions()
            .get(identity)?
            .unwrap_or(Value::Null);
        let route = Arc::new(Route {
            route_id: identity.to_string(),
            conversations: tokio::sync::Mutex::new(Vec::new()),
            url: server.url.clone(),
            key,
            connection: connection.clone(),
            db: self.db.clone(),
            codex: codex.map(Arc::new),
            opencode: (provider == "opencode").then(|| Arc::new(crate::runtime::opencode_account::OpenCodeAccount::new(connection,&env))),
            antigravity: (provider == "antigravity").then(|| Arc::new(crate::runtime::antigravity_account::AntigravityAccount::new(
                self.credentials.connection_directory(connection["id"].as_str().unwrap_or(""),connection["revision"].as_u64().unwrap_or(0)).join("model-gateway"),env.clone(),&instance,&outer.cwd
            ))),
            adapter,
            template: Mutex::new(AdapterStartRequest {
                instance,
                env: Some(env),
                local_session_id: Some(format!("relay-{identity}")),
                cwd: outer.cwd.clone(),
                ..Default::default()
            }),
            native_id: Arc::new(Mutex::new(None)),
            exchange: Arc::new(tokio::sync::Mutex::new(Conversation::default())),
            cancel: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
        });
        route.restore_conversations(&saved).await;
        server.register(&route);
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
