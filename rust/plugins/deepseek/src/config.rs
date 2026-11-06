use serde_json::{json, Value};
use std::collections::HashMap;
use uuid::Uuid;

pub struct Config {
    pub executable: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub token: String,
}

pub fn prepare(request: &Value) -> anyhow::Result<Config> {
    let instance = &request["instance"];
    let mut env: HashMap<String, String> = request["env"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
        .collect();
    let root = agenthub_plugin_sdk::native_config::runtime_package(request, "deepseek")?;
    let bridge = root.join("bridge.mjs");
    std::fs::write(&bridge, include_str!("../resources/bridge.mjs"))?;
    let mut entries = vec![
        json!({"id":"nautilo-transport", "name":reqwest::Url::from_file_path(&bridge).map_err(|_|anyhow::anyhow!("Invalid bridge path"))?.as_str(),
        "config":{"tools":request["runtimeTools"].as_array().cloned().unwrap_or_default()}}),
    ];
    if request["skills"]
        .as_array()
        .is_some_and(|skills| !skills.is_empty())
    {
        entries.push(json!({"id":"nautilo-skills", "name":"@deepseek-ai/dsh-skill-filesystem", "config":{
            "providerName":"nautilo", "includeDefaultRoots":false, "customSkillDirs":[root.join("skills")]
        }}));
    }
    for (index, server) in request["mcpServers"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let mut cfg = json!({"serverName":format!("nautilo_{index}"),"failOnStartupError":true});
        if server["transport"] == "http" {
            cfg["transport"] = json!("streamable-http");
            cfg["url"] = server["url"].clone();
            cfg["headers"] = server["headers"]
                .as_object()
                .cloned()
                .map(Value::Object)
                .unwrap_or(json!({}));
        } else {
            cfg["transport"] = json!("stdio");
            cfg["command"] = server["command"].clone();
            cfg["args"] = server["args"]
                .as_array()
                .cloned()
                .map(Value::Array)
                .unwrap_or(json!([]));
            cfg["env"] = server["env"]
                .as_object()
                .cloned()
                .map(Value::Object)
                .unwrap_or(json!({}));
            cfg["cwd"] = request["cwd"].clone();
        }
        entries.push(json!({"id":format!("nautilo-mcp-{index}"), "name":"@deepseek-ai/dsh-mcp-client", "config":cfg}));
    }
    let options = &instance["providerOptions"];
    let selected = request["model"].as_str().map(str::to_string);
    let (provider, model) = if options["runtimeConnectionId"].is_string()
        || options["baseUrl"].is_string()
    {
        let route = format!(
            "nautilo-{}-{}",
            options["runtimeConnectionId"].as_str().unwrap_or("custom"),
            options["runtimeConnectionRevision"].as_u64().unwrap_or(0)
        );
        let selected = selected
            .or_else(|| {
                instance["models"]
                    .as_array()?
                    .iter()
                    .find(|m| m["enabled"] != false)?["id"]
                    .as_str()
                    .map(str::to_string)
            })
            .ok_or_else(|| anyhow::anyhow!("Select a configured model for DeepSeek Harness"))?;
        let mut model_entries: Vec<Value> = instance["models"].as_array().into_iter().flatten().filter(|m|m["enabled"]!=false).map(|m| {
            let mut entry = json!({"id":m["id"],"name":m["name"].as_str().or(m["displayName"].as_str()).unwrap_or(m["id"].as_str().unwrap_or(""))});
            if m["contextWindow"].is_number() { entry["contextWindow"]=m["contextWindow"].clone(); }
            if let Some(efforts)=m["reasoningEfforts"].as_array().filter(|v|!v.is_empty()) {
                entry["reasoningEfforts"]=Value::Object(efforts.iter().filter_map(|v|v.as_str().map(|s|(s.to_string(),json!(s)))).collect());
            }
            if m["inputModalities"].is_array() { entry["input"]=m["inputModalities"].clone(); }
            entry
        }).collect();
        if !model_entries.iter().any(|m| m["id"] == selected) {
            model_entries.push(json!({"id":selected}));
        }
        let credential_ref = format!("NAUTILO_DSH_KEY_{}", Uuid::new_v4().simple());
        let key = env
            .get("NAUTILO_CONNECTION_API_KEY")
            .or(env.get("DEEPSEEK_API_KEY"))
            .or(env.get("OPENAI_API_KEY"))
            .cloned()
            .ok_or_else(|| {
                anyhow::anyhow!("The selected DeepSeek connection has no API credential")
            })?;
        env.insert(credential_ref.clone(), key);
        entries[0]["config"]["connection"] = json!({"provider":route,"profile":{
            "api":options["apiType"].as_str().unwrap_or("openai-completions"), "baseURL":options["baseUrl"],
            "apiKeyEnv":credential_ref, "models":model_entries
        }});
        (Some(route), Some(selected))
    } else if let Some((provider, model)) = selected.as_deref().and_then(|id| id.split_once("::")) {
        (Some(provider.to_string()), Some(model.to_string()))
    } else {
        (None, selected)
    };
    let patch = root.join("nautilo.patch.json");
    std::fs::write(
        &patch,
        serde_json::to_vec_pretty(&json!([{"insert":entries}]))?,
    )?;
    let mut args: Vec<String> = instance["baseArgs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    if !args
        .iter()
        .any(|a| a == "--profile" || a.starts_with("--profile="))
    {
        args.extend(["--profile".into(), "web".into()]);
    }
    args.extend([
        "--patch".into(),
        patch.to_string_lossy().into_owned(),
        "--no-open".into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        "0".into(),
    ]);
    let token = Uuid::new_v4().to_string();
    env.insert("NAUTILO_DSH_TOKEN".into(), token.clone());
    Ok(Config {
        executable: instance["executable"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("dsh")
            .into(),
        args,
        env,
        provider,
        model,
        token,
    })
}
