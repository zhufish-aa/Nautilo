use crate::errors::{invalid, CoreResult};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use crate::adapters::{AdapterRun,AdapterStartRequest};
use crate::adapters::codex::chat_compat::ChatCompatProxy;

/// Older Kimi builds do not initialize native Anthropic API providers. Keep
/// their supported Responses transport while the scoped bridge owns that wire.
pub fn prepare_protocol(request: &mut AdapterStartRequest) -> CoreResult<Option<Arc<ChatCompatProxy>>> {
    if request.instance.pointer("/providerOptions/runtimeConnectionId").is_none() || request.instance.pointer("/providerOptions/apiType").and_then(Value::as_str)!=Some("anthropic-messages") {return Ok(None)}
    let base=request.instance["providerOptions"]["baseUrl"].as_str().unwrap_or("").to_string();
    let proxy=Arc::new(ChatCompatProxy::start_protocol(base,request.env.clone().unwrap_or_default(),false,true)
        .map_err(|e|invalid("connectionId",&e.to_string()))?);
    let env=request.env.get_or_insert_with(HashMap::new);
    let key=env.get("NAUTILO_CONNECTION_API_KEY").cloned().unwrap_or_default();let local=uuid::Uuid::new_v4().to_string();
    for value in env.values_mut() {if value==&key {*value=local.clone();}}
    env.insert("OPENAI_API_KEY".into(),local);
    env.insert("OPENAI_BASE_URL".into(),proxy.base_url());
    request.instance["providerOptions"]["baseUrl"]=serde_json::json!(proxy.base_url());
    request.instance["providerOptions"]["apiType"]=serde_json::json!("openai-responses");
    Ok(Some(proxy))
}
pub fn keep_protocol(run: AdapterRun, proxy: Option<Arc<ChatCompatProxy>>) -> AdapterRun {
    let Some(proxy)=proxy else {return run};
    let (mut events,cancel,steer,write)=run.into_parts();let (sender,receiver)=tokio::sync::mpsc::unbounded_channel();
    let pump=proxy.clone();tokio::spawn(async move {while let Some(event)=events.recv().await {if sender.send(event).is_err(){break}}pump.close();});
    let mut run=AdapterRun::new(receiver,move||Box::pin(async move {cancel().await;proxy.close();}),write);
    if let Some(steer)=steer {run=run.with_steer(steer);}run
}

/// Kimi's explicit api_key_env binding avoids its global config and login.
pub fn prepare(instance: &Value, env: &mut HashMap<String, String>) -> CoreResult<()> {
    let options = &instance["providerOptions"];
    if options["runtimeConnectionId"].as_str().is_none() {
        return Ok(());
    }
    let root = env.get("NAUTILO_CONNECTION_DIRECTORY").ok_or_else(|| {
        invalid(
            "connectionId",
            "The API connection has no runtime directory",
        )
    })?;
    let path = std::path::PathBuf::from(root).join("kimi-code");
    let native = env.get("KIMI_CODE_HOME").map(std::path::PathBuf::from)
        .or_else(||std::env::var("KIMI_CODE_HOME").ok().map(std::path::PathBuf::from))
        .unwrap_or_else(||agenthub_plugin_sdk::native_config::home(env).join(".kimi-code"));
    agenthub_plugin_sdk::native_config::inherit_resources(&native, &path, &["mcp.json", "skills", "hooks", "agents", "plugins", "rules"])
        .map_err(|error|invalid("connectionId", &error.to_string()))?;
    let mcp = agenthub_plugin_sdk::native_config::read_json(&native.join("mcp.json"))
        .map_err(|error|invalid("connectionId", &error.to_string()))?;
    std::fs::write(path.join("mcp.json"), mcp.to_string())
        .map_err(|error|invalid("connectionId", &error.to_string()))?;
    std::fs::create_dir_all(&path)
        .map_err(|_| invalid("connectionId", "Unable to prepare Kimi configuration"))?;
    let models = instance["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m["enabled"] != false)
        .collect::<Vec<_>>();
    let protocol = match options["apiType"].as_str() {
        Some("anthropic-messages") => "anthropic",
        Some("openai-responses") => "openai_responses",
        _ => "openai",
    };
    let mut text = format!("default_model = {}\n\n[providers.nautilo]\ntype = {}\nbase_url = {}\napi_key_env = \"NAUTILO_CONNECTION_API_KEY\"\n", serde_json::json!(models.first().and_then(|m|m["id"].as_str()).unwrap_or("")),serde_json::json!(protocol),options["baseUrl"]);
    for model in models {
        text.push_str(&format!(
            "\n[models.{}]\nprovider = \"nautilo\"\nmodel = {}\nmax_context_size = {}\n",
            model["id"],
            model["id"],
            model["contextWindow"].as_u64().unwrap_or(128_000)
        ));
        if model["reasoningEfforts"]
            .as_array()
            .is_some_and(|v| !v.is_empty())
        {
            text.push_str("capabilities = [\"thinking\"]\n");
        }
    }
    let text = agenthub_plugin_sdk::native_config::kimi_config(&native, &text)
        .map_err(|error|invalid("connectionId", &error.to_string()))?;
    std::fs::write(path.join("config.toml"), text)
        .map_err(|_| invalid("connectionId", "Unable to write Kimi configuration"))?;
    env.insert("KIMI_CODE_HOME".into(), path.to_string_lossy().into_owned());
    Ok(())
}
