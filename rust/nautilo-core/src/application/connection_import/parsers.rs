use super::{
    document::{text, Documents},
    Candidate,
};
use serde_json::{json, Value};
use std::path::Path;

pub fn protocol(api: &str) -> Option<&'static str> {
    match api {
        "responses" | "openai-responses" => Some("responses"),
        "chat" | "openai-completions" | "openai-chat-completions" | "openai-compatible" => {
            Some("chat")
        }
        "anthropic" | "anthropic-messages" => Some("anthropic"),
        _ => None,
    }
}
pub fn builtin(id: &str) -> Option<(&'static str, &'static str)> {
    match id {
        "openai" => Some(("responses", "https://api.openai.com/v1")),
        "anthropic" => Some(("anthropic", "https://api.anthropic.com")),
        "deepseek" => Some(("chat", "https://api.deepseek.com/v1")),
        "kimi-coding" | "kimi-code" => Some(("anthropic", "https://api.kimi.com/coding")),
        "opencode-go" => Some(("chat", "https://opencode.ai/inference/go/v1")),
        _ => None,
    }
}
pub fn model(raw: &Value, fallback: &str) -> Option<Value> {
    let id = raw
        .as_str()
        .or_else(|| text(raw, &["id", "model"]))
        .unwrap_or(fallback)
        .trim();
    if id.is_empty() || id.len() > 512 {
        return None;
    }
    let mut result = json!({"id":id,"displayName":text(raw,&["name","displayName"]).unwrap_or(id),"enabled":true,"reasoningEfforts":[]});
    if let Some(efforts) = raw["reasoningEfforts"].as_array() {
        let efforts: Vec<&str> = efforts
            .iter()
            .filter_map(|v| v.as_str().or_else(|| v["key"].as_str()))
            .filter(|s| !s.is_empty())
            .take(32)
            .collect();
        result["reasoningEfforts"] = json!(efforts);
        if let Some(default) = raw["defaultReasoningEffort"]
            .as_str()
            .filter(|s| efforts.contains(s))
        {
            result["defaultReasoningEffort"] = json!(default);
        }
    }
    let mut pricing = json!({});
    for field in ["input", "output", "cacheRead", "cacheWrite"] {
        if let Some(value) = raw["pricing"][field]
            .as_f64()
            .or_else(|| raw["cost"][field].as_f64())
            .filter(|n| n.is_finite() && *n >= 0.0)
        {
            pricing[field] = json!(value);
        }
    }
    if !pricing.as_object().unwrap().is_empty() {
        result["pricing"] = pricing;
    }
    if let Some(n) = raw["contextWindow"]
        .as_u64()
        .or_else(|| raw["limit"]["context"].as_u64())
    {
        if n > 0 {
            result["contextWindow"] = json!(n);
        }
    }
    if let Some(input) = raw["input"]
        .as_array()
        .or_else(|| raw["modalities"]["input"].as_array())
    {
        result["inputModalities"] = if input.iter().any(|v| v == "image") {
            json!(["text", "image"])
        } else {
            json!(["text"])
        };
    }
    Some(result)
}
pub fn models(raw: &Value) -> Vec<Value> {
    if let Some(items) = raw.as_array() {
        items
            .iter()
            .filter_map(|v| model(v, ""))
            .take(500)
            .collect()
    } else if let Some(items) = raw.as_object() {
        items
            .iter()
            .filter_map(|(id, v)| model(v, id))
            .take(500)
            .collect()
    } else {
        Vec::new()
    }
}
pub fn add(
    out: &mut Vec<Candidate>,
    docs: &Documents,
    harness: &str,
    file: &Path,
    name: &str,
    api: &str,
    endpoint: &str,
    key: &Value,
    refs: &Value,
    models: Vec<Value>,
) {
    let Some(protocol) = protocol(api) else {
        return;
    };
    let endpoint = endpoint.trim().trim_end_matches('/');
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return;
    };
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return;
    }
    let Ok(mut base) = crate::adapters::model_config::validated_model_endpoint(endpoint) else {
        return;
    };
    if protocol == "anthropic" {
        base = base
            .trim_end_matches('/')
            .trim_end_matches("/messages")
            .trim_end_matches("/v1")
            .to_string();
    }
    let secret = docs.key(key, refs, file.parent().unwrap_or(Path::new(".")));
    let mut warnings: Vec<String> = Vec::new();
    if secret.is_none() {
        warnings.push("CREDENTIAL_MISSING".into());
    }
    if models.is_empty() {
        warnings.push("MODELS_MISSING".into());
    }
    out.push(Candidate{public:json!({"id":uuid::Uuid::new_v4().to_string(),"name":name.chars().take(180).collect::<String>(),"protocol":protocol,
        "baseUrl":base,"models":models,"hasCredential":secret.is_some(),"sources":[{"harness":harness,"path":file.to_string_lossy()}],"warnings":warnings}),secret});
}
pub fn codex(docs: &mut Documents, root: &Path, out: &mut Vec<Candidate>) {
    let file = root.join("config.toml");
    let cfg = docs.read("codex", &file);
    let auth = docs.read("codex", &root.join("auth.json"));
    let mut providers = cfg["model_providers"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    if !providers.contains_key("openai") && auth["OPENAI_API_KEY"].is_string() {
        providers.insert(
            "openai".into(),
            json!({"base_url":"https://api.openai.com/v1","wire_api":"responses"}),
        );
    }
    for (id, p) in providers {
        let env_key = p["env_key"]
            .as_str()
            .map(|name| json!(format!("{{env:{name}}}")));
        let key = p
            .get("experimental_bearer_token")
            .cloned()
            .or(env_key)
            .unwrap_or_else(|| auth["OPENAI_API_KEY"].clone());
        let mut selected = Vec::new();
        if cfg["model_provider"].as_str().unwrap_or("openai") == id {
            if let Some(m) = model(&cfg["model"], "") {
                selected.push(m);
            }
        }
        if let Some(profiles) = cfg["profiles"].as_object() {
            for p in profiles.values() {
                if p["model_provider"]
                    .as_str()
                    .unwrap_or(cfg["model_provider"].as_str().unwrap_or("openai"))
                    == id
                {
                    if let Some(m) = model(&p["model"], "") {
                        selected.push(m);
                    }
                }
            }
        }
        add(
            out,
            docs,
            "codex",
            &file,
            text(&p, &["name"]).unwrap_or(&id),
            p["wire_api"].as_str().unwrap_or("responses"),
            text(&p, &["base_url"]).unwrap_or(""),
            &key,
            &Value::Null,
            selected,
        );
    }
}
pub fn claude(docs: &mut Documents, root: &Path, out: &mut Vec<Candidate>) {
    let mut merged = serde_json::Map::new();
    let mut cfg = Value::Null;
    for filename in ["settings.json", "settings.local.json"] {
        let file = root.join(filename);
        let item = docs.read("claude-code", &file);
        if item.is_object() {
            cfg = item.clone();
            if let Some(env) = item["env"].as_object() {
                merged.extend(env.clone());
            }
        }
    }
    let get = |name: &str| {
        merged
            .get(name)
            .and_then(Value::as_str)
            .or_else(|| docs.env.get(name).map(String::as_str))
    };
    let key = get("ANTHROPIC_API_KEY").or_else(|| get("ANTHROPIC_AUTH_TOKEN"));
    if key.is_none() && get("ANTHROPIC_BASE_URL").is_none() {
        return;
    }
    let mut configured = Vec::new();
    for name in [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ] {
        if let Some(id) = get(name) {
            if let Some(m) = model(&json!(id), "") {
                configured.push(m);
            }
        }
    }
    if configured.is_empty() {
        if let Some(m) = model(&cfg["model"], "") {
            configured.push(m);
        }
    }
    add(
        out,
        docs,
        "claude-code",
        &root.join("settings.json"),
        "Claude Code",
        "anthropic",
        get("ANTHROPIC_BASE_URL").unwrap_or("https://api.anthropic.com"),
        &key.map(|s| json!(s)).unwrap_or(Value::Null),
        &Value::Null,
        configured,
    );
}
pub fn provider_map(
    docs: &Documents,
    harness: &str,
    file: &Path,
    cfg: &Value,
    auth: &Value,
    refs: &Value,
    out: &mut Vec<Candidate>,
) {
    let Some(providers) = cfg["providers"]
        .as_object()
        .or_else(|| cfg["provider"].as_object())
    else {
        return;
    };
    for (id, p) in providers {
        let options = if p["options"].is_object() {
            &p["options"]
        } else {
            p
        };
        let npm = p["npm"].as_str().unwrap_or("");
        let default = builtin(id);
        let api = text(p, &["api"]).unwrap_or(match npm {
            "@ai-sdk/openai" => "responses",
            "@ai-sdk/anthropic" => "anthropic",
            "@ai-sdk/openai-compatible" => "chat",
            _ => default.map(|v| v.0).unwrap_or("chat"),
        });
        let key = options
            .get("apiKey")
            .cloned()
            .or_else(|| {
                p["apiKeyEnv"]
                    .as_str()
                    .map(|name| json!(format!("{{env:{name}}}")))
            })
            .or_else(|| {
                if auth[id]["type"] == "api" || auth[id]["type"] == "api_key" {
                    auth[id].get("key").cloned()
                } else {
                    None
                }
            })
            .unwrap_or(Value::Null);
        let endpoint = text(options, &["baseURL", "baseUrl", "base_url"])
            .or_else(|| text(p, &["baseURL", "baseUrl", "base_url"]))
            .unwrap_or(default.map(|v| v.1).unwrap_or(""));
        let list = models(&p["models"]);
        // Per-model transport/endpoint overrides must not silently change protocol.
        let mut groups = std::collections::BTreeMap::<(String, String), Vec<Value>>::new();
        if let Some(items) = p["models"].as_array() {
            for raw in items {
                if let Some(m) = model(raw, "") {
                    groups
                        .entry((
                            text(raw, &["api"]).unwrap_or(api).into(),
                            text(raw, &["baseUrl", "baseURL"])
                                .unwrap_or(endpoint)
                                .into(),
                        ))
                        .or_default()
                        .push(m);
                }
            }
        }
        if groups.is_empty() {
            groups.insert((api.into(), endpoint.into()), list);
        }
        for ((api, url), items) in groups {
            add(
                out,
                docs,
                harness,
                file,
                text(p, &["displayName", "name"]).unwrap_or(id),
                &api,
                &url,
                &key,
                refs,
                items,
            );
        }
    }
}
pub fn kimi(docs: &mut Documents, root: &Path, out: &mut Vec<Candidate>) {
    let file = root.join("config.toml");
    let cfg = docs.read("kimi-code", &file);
    if let Some(providers) = cfg["providers"].as_object() {
        for (id, p) in providers {
            let configured = cfg["models"]
                .as_object()
                .map(|items| {
                    items
                        .values()
                        .filter(|m| m["provider"] == id.as_str())
                        .filter_map(|m| model(m, ""))
                        .collect()
                })
                .unwrap_or_default();
            let api = match p["type"].as_str().unwrap_or("") {
                "anthropic" => "anthropic",
                _ => "chat",
            };
            let key = p
                .get("api_key")
                .cloned()
                .or_else(|| {
                    p["api_key_env"]
                        .as_str()
                        .map(|name| json!(format!("{{env:{name}}}")))
                })
                .unwrap_or(Value::Null);
            add(
                out,
                docs,
                "kimi-code",
                &file,
                id,
                api,
                text(p, &["base_url"]).unwrap_or(""),
                &key,
                &Value::Null,
                configured,
            );
        }
    }
}
pub fn trae(docs: &mut Documents, file: &Path, out: &mut Vec<Candidate>) {
    let cfg = docs.read("trae", file);
    if let Some(providers) = cfg["model_providers"].as_object() {
        for (id, p) in providers {
            let configured = cfg["models"]
                .as_object()
                .map(|items| {
                    items
                        .values()
                        .filter(|m| m["model_provider"] == id.as_str())
                        .filter_map(|m| model(m, ""))
                        .collect()
                })
                .unwrap_or_default();
            let api = match p["provider"].as_str().unwrap_or("") {
                "anthropic" => "anthropic",
                "openai" => "chat",
                _ => continue,
            };
            let endpoint = text(p, &["base_url"]).unwrap_or(if api == "anthropic" {
                "https://api.anthropic.com"
            } else {
                "https://api.openai.com/v1"
            });
            add(
                out,
                docs,
                "trae",
                file,
                id,
                api,
                endpoint,
                &p["api_key"],
                &Value::Null,
                configured,
            );
        }
    }
}
