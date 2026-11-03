//! Claude model catalog — port of adapters/claude/models.ts.
//! Live discovery through the Anthropic models API; falls back to the CLI
//! alias catalog when no credential or the endpoint is down.

use serde_json::{json, Map, Value};

use crate::errors::CoreResult;
use crate::errors::now_iso;

const DEFAULT_CONTEXT_WINDOW: i64 = 200_000;
const LARGE_CONTEXT_WINDOW: i64 = 1_000_000;
const CAPABILITIES: [&str; 3] = ["thinking", "tool_use", "vision"];
/// Claude Code --effort levels (claude --help, CLI 2.x).
pub const CLAUDE_EFFORT_LEVELS: [&str; 4] = ["low", "medium", "high", "max"];

fn context_window_for(model_id: &str) -> i64 {
    // Mythos-class models ship a 1M-token window; the models API does not
    // report one, so the window stays an estimate.
    let lower = model_id.to_lowercase();
    if lower.contains("fable") || lower.contains("mythos") {
        LARGE_CONTEXT_WINDOW
    } else {
        DEFAULT_CONTEXT_WINDOW
    }
}

fn model(id: &str, display_name: &str, description: Option<&str>, is_default: bool) -> Value {
    let mut entry = Map::new();
    entry.insert("id".to_string(), json!(id));
    entry.insert("displayName".to_string(), json!(display_name));
    if let Some(description) = description {
        entry.insert("description".to_string(), json!(description));
    }
    entry.insert("isDefault".to_string(), json!(is_default));
    entry.insert("contextWindow".to_string(), json!(context_window_for(id)));
    entry.insert("capabilities".to_string(), json!(CAPABILITIES));
    entry.insert("reasoningEfforts".to_string(), json!(CLAUDE_EFFORT_LEVELS));
    // Claude Code 2.x defaults to high; without this the UI fallback pins
    // fresh sessions to --effort low.
    entry.insert("defaultReasoningEffort".to_string(), json!("high"));
    entry.insert("serviceTiers".to_string(), json!([]));
    Value::Object(entry)
}

fn fallback_entry() -> Value {
    model("default", "默认（跟随 Claude Code 配置）", Some("不向 CLI 传 --model，使用 Claude Code 当前配置的模型"), true)
}

/// Static alias catalog, used when no Anthropic credential is available.
pub fn list_claude_models() -> Value {
    json!({
        "providerId": "claude-code",
        "defaultModel": "default",
        "source": "provider_cli",
        "fetchedAt": now_iso(),
        "models": [
            fallback_entry(),
            model("sonnet", "Claude Sonnet（最新别名）", Some("由 CLI 解析到最新的 Sonnet 模型，速度与能力均衡"), false),
            model("opus", "Claude Opus（最新别名）", Some("由 CLI 解析到最新的 Opus 模型，推理能力强"), false),
            model("haiku", "Claude Haiku（最新别名）", Some("由 CLI 解析到最新的 Haiku 模型，响应最快"), false),
            model("opusplan", "Opus Plan 模式", Some("计划阶段使用 Opus，执行阶段使用 Sonnet"), false)
        ]
    })
}

fn env_value<'a>(env: Option<&'a Value>, key: &str) -> Option<String> {
    env.and_then(|e| e.get(key)).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

/// GET /v1/models against the configured Anthropic endpoint (paged).
async fn fetch_anthropic_models(env: Option<&Value>) -> Result<Vec<Value>, String> {
    let api_key = env_value(env, "ANTHROPIC_API_KEY");
    let auth_token = env_value(env, "ANTHROPIC_AUTH_TOKEN");
    if api_key.is_none() && auth_token.is_none() {
        return Err("missing_credential".to_string());
    }
    let base_url = env_value(env, "ANTHROPIC_BASE_URL").unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let base_url = crate::adapters::model_config::validated_model_endpoint(&base_url).map_err(|_| "invalid_base_url".to_string())?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_millis(8_000))
        .build()
        .map_err(|e| format!("network:{e}"))?;
    let mut entries: Vec<Value> = vec![];
    let mut after: Option<String> = None;
    for _ in 0..5 {
        let mut url = reqwest::Url::parse(&format!("{base_url}/v1/models")).map_err(|_| "invalid_base_url".to_string())?;
        url.query_pairs_mut().append_pair("limit", "100");
        if let Some(after) = &after {
            url.query_pairs_mut().append_pair("after_id", after);
        }
        let mut request = client.get(url).header("anthropic-version", "2023-06-01");
        if let Some(key) = &api_key {
            request = request.header("x-api-key", key);
        }
        if let Some(token) = &auth_token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = request.send().await.map_err(|e| format!("network:{e}"))?;
        if !response.status().is_success() {
            return Err(format!("http_{}", response.status().as_u16()));
        }
        let body: Value = response.json().await.map_err(|_| "invalid_response".to_string())?;
        let data = body.get("data").and_then(Value::as_array).cloned().ok_or_else(|| "invalid_response".to_string())?;
        entries.extend(data);
        let has_more = body.get("has_more").and_then(Value::as_bool).unwrap_or(false);
        let last_id = body.get("last_id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        if !has_more || last_id.is_none() {
            break;
        }
        after = last_id;
    }
    Ok(entries)
}

fn discovery_warning(reason: &str, env: Option<&Value>) -> String {
    let base_url = env_value(env, "ANTHROPIC_BASE_URL").unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let base_url = base_url.trim_end_matches('/');
    if reason == "missing_credential" {
        return "未找到 Anthropic 凭证（ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN），无法在线拉取模型列表，已回退到内置别名目录。".to_string();
    }
    if reason == "invalid_base_url" {
        return "ANTHROPIC_BASE_URL 必须使用 HTTPS（本机可用 HTTP），且不能包含凭证、查询参数或片段。已回退到内置别名目录。".to_string();
    }
    if let Some(status) = reason.strip_prefix("http_") {
        return format!("模型列表接口 {base_url}/v1/models 返回 HTTP {status}（凭证或中转站不支持该接口），已回退到内置别名目录。");
    }
    if reason == "invalid_response" {
        return format!("模型列表接口 {base_url}/v1/models 返回了无法解析的内容，已回退到内置别名目录。");
    }
    if let Some(detail) = reason.strip_prefix("network:") {
        return format!("请求模型列表接口 {base_url}/v1/models 失败：{detail}，已回退到内置别名目录。");
    }
    format!("模型列表接口 {base_url}/v1/models 未返回任何模型，已回退到内置别名目录。")
}

/// Live model discovery through the Anthropic models API; falls back to the
/// CLI alias catalog with a warning when discovery fails.
pub async fn discover_claude_models(env: Option<&Value>) -> CoreResult<Value> {
    match fetch_anthropic_models(env).await {
        Ok(entries) if !entries.is_empty() => {
            let mut pairs: Vec<(String, Value)> = entries
                .iter()
                .filter(|entry| {
                    entry.get("type").is_none() || entry.get("type").and_then(Value::as_str) == Some("model")
                })
                .filter_map(|entry| {
                    let id = entry.get("id").and_then(Value::as_str)?.trim().to_string();
                    if id.is_empty() {
                        return None;
                    }
                    let created = entry.get("created_at").and_then(Value::as_str).unwrap_or("").to_string();
                    let display = entry.get("display_name").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&id);
                    let description = if created.len() >= 10 { Some(format!("发布于 {}", &created[..10])) } else { None };
                    Some((created, model(&id, display, description.as_deref(), false)))
                })
                .collect();
            pairs.sort_by(|left, right| right.0.cmp(&left.0));
            let mut models = vec![fallback_entry()];
            models.extend(pairs.into_iter().map(|(_, m)| m));
            Ok(json!({
                "providerId": "claude-code",
                "defaultModel": "default",
                "source": "provider_cli",
                "fetchedAt": now_iso(),
                "models": models
            }))
        }
        Ok(_) => fallback_with_warning("empty_result", env),
        Err(reason) => {
            // Anthropic-protocol shims rarely implement the models route; the
            // OpenAI-compatible catalog at the host root usually works.
            let base = env_value(env, "ANTHROPIC_BASE_URL").unwrap_or_default();
            let base = base.trim_end_matches('/');
            if base.to_lowercase().ends_with("/anthropic") {
                let credential = env_value(env, "ANTHROPIC_API_KEY").or_else(|| env_value(env, "ANTHROPIC_AUTH_TOKEN"));
                let root = base[..base.len() - "/anthropic".len()].to_string();
                if let Ok(catalog) = crate::adapters::model_config::discover_openai_compatible_models(&root, credential.as_deref(), 10_000, None).await {
                    if catalog.get("models").and_then(Value::as_array).is_some_and(|m| !m.is_empty()) {
                        let mut models = vec![fallback_entry()];
                        for entry in catalog.get("models").and_then(Value::as_array).cloned().unwrap_or_default() {
                            let id = entry.get("id").and_then(Value::as_str).unwrap_or("");
                            let name = entry.get("displayName").and_then(Value::as_str).unwrap_or(id);
                            models.push(model(id, name, None, false));
                        }
                        return Ok(json!({
                            "providerId": "claude-code",
                            "defaultModel": "default",
                            "source": "provider_api",
                            "fetchedAt": now_iso(),
                            "models": models
                        }));
                    }
                }
            }
            eprintln!("[nautilo-core] claude-code model discovery failed ({reason}); falling back to CLI alias catalog");
            fallback_with_warning(&reason, env)
        }
    }
}

fn fallback_with_warning(reason: &str, env: Option<&Value>) -> CoreResult<Value> {
    let mut catalog = list_claude_models().as_object().cloned().unwrap_or_default();
    catalog.insert("warning".to_string(), json!(discovery_warning(reason, env)));
    Ok(Value::Object(catalog))
}

#[cfg(test)]
mod native_discovery_security_tests {
    use super::*;
    #[tokio::test]
    async fn native_discovery_never_follows_credential_redirects() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", source.local_addr().unwrap());
        let target_url = format!("http://{}/models", target.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = source.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            stream.read(&mut buffer).unwrap();
            write!(stream, "HTTP/1.1 302 Found\r\nLocation: {target_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let env = json!({"ANTHROPIC_BASE_URL": base_url, "ANTHROPIC_API_KEY": "fixture-key", "ANTHROPIC_AUTH_TOKEN": "fixture-token"});
        assert!(fetch_anthropic_models(Some(&env)).await.is_err());
        server.join().unwrap();
        assert!(matches!(target.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock));
    }
}
