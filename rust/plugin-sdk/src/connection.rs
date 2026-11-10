//! Native CLI configuration for a revision-bound API connection.
//! Generated files contain environment references, never API keys. Each
//! connection revision has its own CLI namespace and cannot reuse local auth.
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
type CoreResult<T> = anyhow::Result<T>;
fn invalid(field: &str, reason: &str) -> anyhow::Error {
    anyhow::anyhow!("{field}: {reason}")
}

/// The plugin owns native CLI configuration. The host supplies only the bound
/// endpoint, model metadata and an environment-scoped credential.
pub fn prepare_request(
    request: &Value,
    env: HashMap<String, String>,
) -> CoreResult<HashMap<String, String>> {
    let agent = &request["instance"];
    let options = &agent["providerOptions"];
    let Some(id) = options["runtimeConnectionId"].as_str() else {
        return Ok(env);
    };
    let api = options["apiType"].as_str().unwrap_or("openai-completions");
    let connection = json!({"id":id,"revision":options["runtimeConnectionRevision"],"name":options["runtimeConnectionName"],
        "protocol":match api {"anthropic-messages"=>"anthropic","openai-responses"=>"responses",_=>"chat"},
        "baseUrl":options["baseUrl"],"models":agent["models"],"selectedModel":request["model"],"selectedEffort":request["reasoningEffort"],"configurationDirectory":env.get("NAUTILO_CONNECTION_DIRECTORY")});
    let env = prepare(agent, &connection, env)?;
    if agent["providerId"] == "commandcode" {
        if let Some(home) = env.get("HOME") {
            crate::native_config::merge_mcp_file(&PathBuf::from(home).join(".commandcode/mcp.json"), request.get("mcpServers"))?;
        }
    }
    Ok(env)
}

fn directory(connection: &Value, harness: &str) -> CoreResult<PathBuf> {
    let id = connection["id"].as_str().unwrap_or("");
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(invalid(
            "connectionId",
            "Invalid connection configuration identity",
        ));
    }
    let path = connection["configurationDirectory"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir()
                .join("nautilo-api-connections")
                .join(std::process::id().to_string())
                .join(format!(
                    "{id}-{}",
                    connection["revision"].as_u64().unwrap_or(0)
                ))
        })
        .join(harness);
    std::fs::create_dir_all(&path).map_err(|_| {
        invalid(
            "connectionId",
            "Unable to prepare the CLI connection directory",
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).map_err(|_| {
            invalid(
                "connectionId",
                "Unable to secure the CLI connection directory",
            )
        })?;
    }
    Ok(path)
}
fn write(path: &std::path::Path, text: &str) -> CoreResult<()> {
    std::fs::write(path, text)
        .map_err(|_| anyhow::anyhow!("Unable to write the CLI connection configuration"))
}
fn native_models(connection: &Value) -> Vec<Value> {
    connection["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m["enabled"] != false && m["id"].as_str().is_some_and(|id| !id.is_empty()))
        .collect()
}
pub fn prepare(
    agent: &Value,
    connection: &Value,
    mut env: HashMap<String, String>,
) -> CoreResult<HashMap<String, String>> {
    let harness = agent["providerId"].as_str().unwrap_or("");
    let protocol = connection["protocol"].as_str().unwrap_or("chat");
    let api = match protocol {
        "anthropic" => "anthropic-messages",
        "responses" => "openai-responses",
        _ => "openai-completions",
    };
    let base = connection["baseUrl"].as_str().unwrap_or("");
    let models = native_models(connection);
    match harness {
        "kimi-code" => {
            let dir = directory(connection, harness)?;
            let native = env.get("KIMI_CODE_HOME").map(PathBuf::from)
                .unwrap_or_else(|| crate::native_config::home(&env).join(".kimi-code"));
            crate::native_config::inherit_resources(&native, &dir, &["mcp.json", "skills", "hooks", "agents", "plugins", "rules"])?;
            write(&dir.join("mcp.json"), &crate::native_config::read_json(&native.join("mcp.json"))?.to_string())?;
            let provider_type = match protocol {
                "anthropic" => "anthropic",
                "responses" => "openai_responses",
                _ => "openai",
            };
            let mut config = format!("default_model = {}\n\n[providers.nautilo]\ntype = {}\nbase_url = {}\napi_key_env = \"NAUTILO_CONNECTION_API_KEY\"\n", json!(models.first().and_then(|m| m["id"].as_str()).unwrap_or("")), json!(provider_type), json!(base));
            for model in &models {
                config.push_str(&format!(
                    "\n[models.{}]\nprovider = \"nautilo\"\nmodel = {}\nmax_context_size = {}\n",
                    model["id"],
                    model["id"],
                    model["contextWindow"].as_u64().unwrap_or(128_000)
                ));
                if model["reasoningEfforts"]
                    .as_array()
                    .is_some_and(|v| !v.is_empty())
                {
                    config.push_str("capabilities = [\"thinking\"]\n");
                }
            }
            write(&dir.join("config.toml"), &crate::native_config::kimi_config(&native, &config)?)?;
            env.insert("KIMI_CODE_HOME".into(), dir.to_string_lossy().into_owned());
        }
        "omp" => {
            let dir = directory(connection, harness)?;
            let native = models.iter().map(|model| {
                let efforts=model["reasoningEfforts"].as_array().into_iter().flatten().filter_map(Value::as_str)
                    .filter(|effort|["minimal","low","medium","high","xhigh","max"].contains(effort)).collect::<Vec<_>>();
                let mut native=json!({
                "id": model["id"], "name": model.get("displayName").unwrap_or(&model["id"]),
                "reasoning": model["reasoningEfforts"].as_array().is_some_and(|v| !v.is_empty()),
                "input": ["text", "image"], "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0},
                "contextWindow": model["contextWindow"].as_u64().unwrap_or(128_000), "maxTokens": 16_384,
                });
                // Without explicit thinking metadata OMP infers the generic
                // OpenAI effort range and silently turns configured max into
                // xhigh. Custom models own their declared wire values.
                if protocol!="anthropic" && !efforts.is_empty(){
                    native["thinking"]=json!({"mode":"effort","efforts":efforts});
                    native["compat"]=json!({"reasoningEffortMap":efforts.iter().map(|effort|(effort.to_string(),json!(effort))).collect::<Map<String,Value>>()});
                }
                native
            }).collect::<Vec<_>>();
            let provider = json!({"baseUrl":base,"api":api,"models":native});
            let extension = dir.join("nautilo-provider.mjs");
            write(&extension, &format!("export default function(pi) {{ pi.registerProvider('nautilo', {{...{provider}, apiKey: process.env.NAUTILO_CONNECTION_API_KEY}}); }}\n"))?;
            // Add one provider through OMP's extension API. Keep the real
            // agent directory, native extensions, settings, MCP and skills.
            env.insert("NAUTILO_OMP_PROVIDER_EXTENSION".into(), extension.to_string_lossy().into_owned());
            // Retain the durable session location used by existing API chats.
            env.insert("NAUTILO_OMP_SESSION_ROOT".into(), dir.to_string_lossy().into_owned());
        }
        "opencode" => {
            let models: Map<String, Value> = models.iter().filter_map(|model| {
                let variants: Map<String, Value> = model["reasoningEfforts"].as_array().into_iter().flatten()
                    .filter_map(Value::as_str).map(|effort| (effort.to_string(), if protocol == "anthropic" {
                        json!({"effort":effort})
                    } else { json!({"reasoningEffort":effort}) })).collect();
                Some((model["id"].as_str()?.into(), json!({
                    "id":model["id"], "name":model.get("displayName").unwrap_or(&model["id"]),
                    "reasoning":!variants.is_empty(), "variants":variants,
                    "options":if protocol == "responses" {json!({"reasoningSummary":"auto","include":["reasoning.encrypted_content"]})} else {json!({})},
                    "limit":{"context":model["contextWindow"].as_u64().unwrap_or(128_000),"output":16_384}
                })))
            }).collect();
            let npm = match protocol {
                "anthropic" => "@ai-sdk/anthropic",
                "responses" => "@ai-sdk/openai",
                _ => "@ai-sdk/openai-compatible",
            };
            let mut config: Value = env.get("OPENCODE_CONFIG_CONTENT").map(|text|serde_json::from_str(text)).transpose()?
                .unwrap_or_else(||json!({}));
            crate::native_config::merge(&mut config, json!({
                "enabled_providers":["nautilo"],
                "provider":{"nautilo":{"name":connection["name"],"npm":npm,"options":{"baseURL":base,"apiKey":"{env:NAUTILO_CONNECTION_API_KEY}"},"models":models}}
            }));
            env.insert("OPENCODE_CONFIG_CONTENT".into(), config.to_string());
        }
        "commandcode" => {
            let dir = directory(connection, harness)?;
            let config_dir = dir.join(".commandcode");
            std::fs::create_dir_all(&config_dir).map_err(|_| {
                invalid(
                    "connectionId",
                    "Unable to prepare Command Code configuration",
                )
            })?;
            let native = crate::native_config::home(&env).join(".commandcode");
            crate::native_config::inherit_resources(&native, &config_dir,
                &["config.json", "settings.json", "mcp.json", "skills", "agents", "commands", "hooks", "rules", "mods", "taste"])?;
            write(&config_dir.join("mcp.json"), &crate::native_config::read_json(&native.join("mcp.json"))?.to_string())?;
            let models: Map<String, Value> = models.iter().filter_map(|model| Some((model["id"].as_str()?.into(), json!({
                "name":model.get("displayName").unwrap_or(&model["id"]),
                "contextWindow":model["contextWindow"].as_u64().unwrap_or(128_000),
                "reasoningEfforts":model.get("reasoningEfforts").cloned().unwrap_or_else(||json!([]))
            })))).collect();
            write(&config_dir.join("providers.json"), &json!({"provider":{"nautilo":{"name":connection["name"],"api":api,"baseURL":base,"apiKey":"$NAUTILO_CONNECTION_API_KEY","models":models}}}).to_string())?;
            env.insert("HOME".into(), dir.to_string_lossy().into_owned());
            env.insert("USERPROFILE".into(), dir.to_string_lossy().into_owned());
            env.insert("CMD_LOCAL_ONLY".into(), "1".into());
            env.insert("CMD_DISABLE_REMOTE_MODEL_CATALOG".into(), "1".into());
            // 1.88 still checks the presence of a Command Code account key in
            // print mode before resolving a BYOK route. Local-only transport
            // refuses all account traffic; use a non-secret marker, never the
            // selected provider's key, for this local startup check.
            env.insert("COMMAND_CODE_API_KEY".into(), "nautilo-local-only".into());
        }
        _ => {}
    }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn each_native_configuration_binds_only_the_selected_endpoint_and_references_its_key() {
        let root = std::env::temp_dir().join(format!("nautilo-plugin-config-test-{}",std::process::id()));
        let home = root.join("native"); std::fs::create_dir_all(&home).unwrap();
        let connection = json!({"id":"test-plugin-config","configurationDirectory":root.join("bound"),"name":"Selected provider","revision":3,"protocol":"chat","baseUrl":"https://selected.example/v1","models":[{"id":"deepseek/custom","reasoningEfforts":["low","max"]}]});
        for harness in ["pi", "kimi-code", "omp", "opencode", "commandcode"] {
            let env = prepare(
                &json!({"providerId":harness}),
                &connection,
                HashMap::from([("HOME".into(),home.to_string_lossy().into_owned()), ("USERPROFILE".into(),home.to_string_lossy().into_owned()), (
                    "NAUTILO_CONNECTION_API_KEY".into(),
                    "private-test-key".into(),
                )]),
            )
            .unwrap();
            assert_eq!(
                env.get("NAUTILO_CONNECTION_API_KEY").unwrap(),
                "private-test-key"
            );
            let text = match harness {
                "kimi-code" => std::fs::read_to_string(
                    PathBuf::from(&env["KIMI_CODE_HOME"]).join("config.toml"),
                )
                .unwrap(),
                "omp" => std::fs::read_to_string(&env["NAUTILO_OMP_PROVIDER_EXTENSION"])
                .unwrap(),
                "opencode" => env["OPENCODE_CONFIG_CONTENT"].clone(),
                "commandcode" => std::fs::read_to_string(
                    PathBuf::from(&env["HOME"]).join(".commandcode/providers.json"),
                )
                .unwrap(),
                _ => continue,
            };
            assert!(text.contains("https://selected.example/v1"));
            assert!(text.contains("deepseek/custom"));
            assert!(text.contains("NAUTILO_CONNECTION_API_KEY"));
            assert!(!text.contains("private-test-key"));
            if harness == "omp" {
                assert!(!env.contains_key("PI_CODING_AGENT_DIR"));
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
