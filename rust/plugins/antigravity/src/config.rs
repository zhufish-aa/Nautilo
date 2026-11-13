//! Only the official ACP transport changes. Native configuration and auth stay owned by agy.
use crate::rpc::Client;
use agenthub_plugin_sdk::process::ProcessRequest;
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn descriptor() -> Value {
    serde_json::from_str::<Value>(include_str!("../agenthub-plugin.json")).unwrap()["descriptor"]
        .clone()
}

pub fn process_request(request: &Value) -> anyhow::Result<ProcessRequest> {
    let instance = &request["instance"];
    // Official agy currently supports Gemini and native Google accounts, not OpenAI-compatible providers.
    anyhow::ensure!(instance.pointer("/providerOptions/baseUrl").and_then(Value::as_str).is_none_or(str::is_empty),
        "Antigravity uses its official Google account. Select an Antigravity login account instead of an OpenAI-compatible API connection.");
    let mut args: Vec<String> = instance["baseArgs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    anyhow::ensure!(
        !args.iter().any(|arg| matches!(
            arg.as_str(),
            "acp"
                | "--login"
                | "--worker"
                | "--print"
                | "-p"
                | "--output-format"
                | "--input-format"
        )),
        "Antigravity transport arguments are owned by the ACP adapter"
    );
    args.push("acp".into());
    // HTTP MCP supplied by the client requires an isolated session worker in official agy.
    if request["mcpServers"]
        .as_array()
        .is_some_and(|s| s.iter().any(|s| s["transport"] == "http"))
        || request["runtimeTools"]
            .as_array()
            .is_some_and(|t| !t.is_empty())
    {
        args.push("--process-per-session".into());
    }
    if let Some(mode) = request["permissionMode"].as_str().or_else(|| {
        instance
            .pointer("/providerOptions/permissionMode")
            .and_then(Value::as_str)
    }) {
        match mode {
            "bypassPermissions" => args.push("--dangerously-skip-permissions".into()),
            "default" | "manual" | "standard" => {}
            // These are session modes, applied through advertised ACP options below.
            "accept-edits" | "plan" | "auto" => {}
            other => anyhow::bail!("Unknown Antigravity permission mode: {other}"),
        }
    }
    let mut env: HashMap<String, String> = request["env"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
        .collect();
    if instance
        .pointer("/providerOptions/nativeLogin")
        .and_then(Value::as_bool)
        == Some(true)
    {
        env.retain(|k, _| {
            ![
                "GEMINI_API_KEY",
                "GOOGLE_API_KEY",
                "AGY_ADC_AUTH",
                "GOOGLE_APPLICATION_CREDENTIALS",
                "GOOGLE_GEMINI_BASE_URL",
            ]
            .iter()
            .any(|v| k.eq_ignore_ascii_case(v))
        });
    }
    Ok(ProcessRequest {
        command: instance["executable"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("agy")
            .into(),
        args,
        cwd: request["cwd"].as_str().map(str::to_owned),
        env: Some(env),
        // Keep the process alive across turns. Limits belong to each turn.
        inherit_env: false,
        ..Default::default()
    })
}

pub fn initialize() -> Value {
    json!({"protocolVersion":1,"clientInfo":{"name":"nautilo","title":"Nautilo","version":env!("CARGO_PKG_VERSION")},
        "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,
            "elicitation":{"form":{}},"session":{"list":{}}}})
}

pub fn mcp_servers(request: &Value) -> anyhow::Result<Vec<Value>> {
    request["mcpServers"].as_array().into_iter().flatten().map(|s| {
        let name = s["name"].as_str().ok_or_else(||anyhow::anyhow!("MCP server name is missing"))?;
        let pairs = |value: &Value| value.as_object().into_iter().flatten().map(|(n,v)|json!({"name":n,"value":v})).collect::<Vec<_>>();
        Ok(match s["transport"].as_str().unwrap_or("stdio") {
            "http" | "sse" => json!({"type":s["transport"],"name":name,"url":s["url"],"headers":pairs(&s["headers"])}),
            "stdio" => json!({"name":name,"command":s["command"],"args":s.get("args").cloned().unwrap_or(json!([])),"env":pairs(&s["env"])}),
            other => anyhow::bail!("Unsupported Antigravity MCP transport: {other}"),
        })
    }).collect()
}

pub fn choices(option: &Value) -> Vec<Value> {
    option["options"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            entry["options"]
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![entry.clone()])
        })
        .collect()
}

pub fn option<'a>(session: &'a Value, category: &str) -> Option<&'a Value> {
    session["configOptions"].as_array()?.iter().find(|o| {
        o["category"] == category
            || o["id"] == category
            || (category == "thought_level"
                && ["thinking", "effort", "reasoning"]
                    .iter()
                    .any(|hint| o["id"].as_str().unwrap_or("").to_lowercase().contains(hint)))
    })
}

pub async fn apply(rpc: &Client, session: &mut Value, request: &Value) -> anyhow::Result<()> {
    let id = session["sessionId"].as_str().unwrap_or("").to_owned();
    for (key, category) in [("model", "model"), ("reasoningEffort", "thought_level")] {
        let Some(selected) = request[key].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let opt = option(session, category).cloned();
        if let Some(opt) = opt {
            let values = choices(&opt);
            // Native effort IDs are model-dependent. Use the advertised ID or exact label only.
            let chosen = values
                .iter()
                .find(|v| {
                    v["value"] == selected
                        || v["name"]
                            .as_str()
                            .is_some_and(|s| s.eq_ignore_ascii_case(selected))
                })
                .or_else(|| {
                    if selected == "xhigh" {
                        values
                            .iter()
                            .find(|v| v["value"] == "extra" || v["name"] == "Extra")
                    } else {
                        None
                    }
                })
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "Antigravity does not offer {key}={selected} for this account/model"
                    )
                })?;
            let value = chosen["value"].clone();
            if opt["currentValue"] != value {
                let update = rpc
                    .request(
                        "session/set_config_option",
                        json!({"sessionId":id,"configId":opt["id"],"value":value}),
                    )
                    .await?;
                if update["configOptions"].is_array() {
                    session["configOptions"] = update["configOptions"].clone();
                }
            }
        } else if key == "model"
            && session
                .pointer("/models/currentModelId")
                .and_then(Value::as_str)
                == Some(selected)
        {
        } else if key == "model"
            && session
                .pointer("/models/availableModels")
                .and_then(Value::as_array)
                .is_some_and(|m| m.iter().any(|m| m["modelId"] == selected))
        {
            rpc.request(
                "session/set_model",
                json!({"sessionId":id,"modelId":selected}),
            )
            .await?;
        } else {
            anyhow::bail!("Antigravity did not advertise a way to apply {key}={selected}");
        }
    }
    let mode = request["permissionMode"]
        .as_str()
        .filter(|m| matches!(*m, "accept-edits" | "plan" | "auto"));
    if let Some(mode) = mode {
        let offered = session
            .pointer("/modes/availableModes")
            .and_then(Value::as_array)
            .is_some_and(|m| m.iter().any(|m| m["id"] == mode));
        anyhow::ensure!(offered, "Antigravity does not offer mode {mode}");
        if session
            .pointer("/modes/currentModeId")
            .and_then(Value::as_str)
            != Some(mode)
        {
            rpc.request("session/set_mode", json!({"sessionId":id,"modeId":mode}))
                .await?;
            session["modes"]["currentModeId"] = json!(mode);
        }
    }
    Ok(())
}

pub fn catalog(session: &Value) -> Value {
    let effort = option(session, "thought_level");
    let efforts: Vec<Value> = effort
        .map(choices)
        .unwrap_or_default()
        .iter()
        .filter_map(|o| o.get("value").cloned())
        .collect();
    let selected = effort.and_then(|o| o.get("currentValue")).cloned();
    let options = option(session, "model").map(choices).unwrap_or_else(|| {
        session
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    });
    let models:Vec<Value>=options.iter().filter_map(|o|{
        let id=o.get("value").or_else(||o.get("modelId"))?.as_str()?;
        let mut model=json!({"id":id,"displayName":o.get("name").or_else(||o.get("displayName")).and_then(Value::as_str).unwrap_or(id),"reasoningEfforts":efforts,"isDefault":option(session,"model").is_some_and(|opt|opt["currentValue"]==id)||session.pointer("/models/currentModelId").and_then(Value::as_str)==Some(id),"capabilities":[],"serviceTiers":[]});
        if let Some(value)=&selected {model["defaultReasoningEffort"]=value.clone();}
        Some(model)
    }).collect();
    json!({"providerId":"antigravity","models":models,"source":"provider_cli","fetchedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)})
}
