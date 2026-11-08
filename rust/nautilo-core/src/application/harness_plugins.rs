use super::connection_service::apply_connection;
use super::core_daemon::Daemon;
use crate::adapters::AgentCliAdapter;
use crate::database::Repositories;
use crate::errors::{invalid, not_found, CoreResult};
use crate::runtime::security::environment_policy::{
    build_environment, isolate_login_profile, provider_environment_passthrough,
};
use serde_json::{json, Value};

pub async fn manage(daemon: &Daemon, input: Value) -> CoreResult<Value> {
    let id = input["agentInstanceId"].as_str().unwrap_or("");
    let mut instance = {
        let db = daemon.db.lock().unwrap();
        Repositories::new(&db.raw).agents().get(id)?.ok_or_else(|| not_found("agent", id))?
    };
    let provider = instance["providerId"].as_str().unwrap_or("").to_owned();
    daemon.adapters.get(&provider)?;
    let manager = daemon.plugins.manager_for(&provider)
        .ok_or_else(|| invalid("providerId", "This harness has no plugin manager"))?;
    if let Some(id) = input["connectionId"].as_str() {
        let connection = daemon.connections.get(id, None)?;
        if connection["enabled"] != true || connection["kind"] != "login" || connection["harness"] != provider {
            return Err(invalid("connectionId", "Select an enabled login for this harness"));
        }
        instance = apply_connection(&instance, &connection)?;
    }
    let env = build_environment(None, provider_environment_passthrough(&instance, Some(&manager.descriptor())));
    let env = isolate_login_profile(&instance, env)?;
    let operation = &input["operation"];
    if !matches!(operation["action"].as_str(), Some("list" | "install" | "remove" | "enable" | "disable")) {
        return Err(invalid("action", "Unknown harness plugin operation"));
    }
    manager.harness_plugins(json!({"instance": instance, "context": {"env": env}, "operation": operation})).await
}
