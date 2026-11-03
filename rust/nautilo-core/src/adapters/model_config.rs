//! Generic OpenAI-compatible model discovery + instance model overrides —
//! port of adapters/model-config.ts.

use serde_json::{json, Value};

use crate::errors::{CoreError, CoreResult, ErrorCode};
use crate::errors::now_iso;

/// Generic reasoning levels suggested for API-discovered models.
pub const GENERIC_MODEL_REASONING_EFFORTS: [&str; 3] = ["low", "medium", "high"];

/// Merges an instance's curated model configuration into a discovered
/// catalog. Configured entries override the same model id; unknown ids are
/// appended so custom models stay selectable.
pub fn merge_instance_model_config(catalog: &Value, models: Option<&Value>) -> Value {
    let Some(configs) = models.and_then(Value::as_array).filter(|m| !m.is_empty()) else {
        return catalog.clone();
    };
    let mut result = catalog.as_object().cloned().unwrap_or_default();
    let disabled: Vec<&str> = configs.iter()
        .filter(|config| config.get("enabled").and_then(Value::as_bool) == Some(false))
        .filter_map(|config| config.get("id").and_then(Value::as_str).map(str::trim))
        .collect();
    let mut merged: Vec<Value> = result.get("models").and_then(Value::as_array).cloned().unwrap_or_default()
        .into_iter().filter(|model| !disabled.contains(&model.get("id").and_then(Value::as_str).unwrap_or(""))).collect();
    for config in configs {
        let id = config.get("id").and_then(Value::as_str).unwrap_or("").trim();
        if id.is_empty() || disabled.contains(&id) { continue; }
        let index = merged.iter().position(|model| model.get("id").and_then(Value::as_str) == Some(id));
        let mut entry = index.and_then(|i| merged[i].as_object().cloned()).unwrap_or_else(|| {
            json!({"id": id, "displayName": id, "isDefault": false, "capabilities": [], "serviceTiers": [], "reasoningEfforts": []})
                .as_object().unwrap().clone()
        });
        if let Some(display) = config.get("displayName").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
            entry.insert("displayName".to_string(), json!(display));
        }
        if let Some(efforts) = config.get("reasoningEfforts").and_then(Value::as_array).filter(|e| !e.is_empty()) {
            entry.insert("reasoningEfforts".to_string(), json!(efforts));
        }
        let default = configured_model_reasoning_effort(config).or_else(|| {
            let existing = entry.get("defaultReasoningEffort")?.as_str()?;
            entry.get("reasoningEfforts")?.as_array()?.iter().any(|effort| effort.as_str() == Some(existing))
                .then(|| existing.to_string())
        });
        entry.remove("defaultReasoningEffort");
        if let Some(default) = default { entry.insert("defaultReasoningEffort".to_string(), json!(default)); }
        for field in ["contextWindow", "pricing"] {
            if let Some(value) = config.get(field).filter(|v| !v.is_null()) {
                entry.insert(field.to_string(), value.clone());
            }
        }
        if let Some(index) = index { merged[index] = Value::Object(entry); }
        else { merged.push(Value::Object(entry)); }
    }
    if result.get("defaultModel").and_then(Value::as_str).map(|id| disabled.contains(&id)).unwrap_or(false) {
        result.remove("defaultModel");
        if let Some(id) = merged.iter().find(|model| model.get("isDefault").and_then(Value::as_bool) == Some(true))
            .or_else(|| merged.first()).and_then(|model| model.get("id")) {
            result.insert("defaultModel".to_string(), id.clone());
        }
    }
    result.insert("models".to_string(), Value::Array(merged));
    Value::Object(result)
}

/// Explicit default wins; legacy ordered effort lists retain their first-entry default.
pub fn configured_model_reasoning_effort(config: &Value) -> Option<String> {
    if config.get("enabled").and_then(Value::as_bool) == Some(false) { return None; }
    let efforts = config.get("reasoningEfforts").and_then(Value::as_array);
    if let Some(explicit) = config.get("defaultReasoningEffort").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        if efforts.map(|values| values.is_empty() || values.iter().any(|v| v.as_str() == Some(explicit))).unwrap_or(true) {
            return Some(explicit.to_string());
        }
    }
    efforts.and_then(|values| values.first()).and_then(Value::as_str).map(str::to_string)
}

fn model_list_endpoints(base_url: &str, api_type: Option<&str>) -> Vec<String> {
    let mut roots = vec![base_url.to_string()];
    let lower = base_url.to_lowercase();
    if lower.ends_with("/anthropic") {
        roots.push(base_url[..base_url.len() - "/anthropic".len()].to_string());
    }
    let suffix = if api_type == Some("google-generative-ai") { "v1beta" } else { "v1" };
    let mut endpoints: Vec<String> = vec![];
    for root in &roots {
        endpoints.push(format!("{root}/models"));
        let root_lower = root.to_lowercase();
        if !(root_lower.ends_with("/v1") || root_lower.ends_with("/v1beta")) {
            endpoints.push(format!("{root}/{suffix}/models"));
        }
    }
    endpoints.dedup();
    endpoints
}

fn model_list_headers(api_key: Option<&str>, api_type: Option<&str>) -> Vec<(String, String)> {
    let mut headers = vec![("accept".to_string(), "application/json".to_string())];
    let Some(api_key) = api_key else {
        return headers;
    };
    match api_type {
        Some("anthropic-messages") => {
            headers.push(("x-api-key".to_string(), api_key.to_string()));
            headers.push(("anthropic-version".to_string(), "2023-06-01".to_string()));
        }
        Some("google-generative-ai") => {
            headers.push(("x-goog-api-key".to_string(), api_key.to_string()));
        }
        _ => {
            headers.push(("authorization".to_string(), format!("Bearer {api_key}")));
        }
    }
    headers
}

/// Normalizes OpenAI-compatible /models payloads (`data` or `models` arrays).
pub fn parse_openai_compatible_model_list(value: &Value) -> Value {
    let entries = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    let models: Vec<Value> = entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?.trim().to_string();
            if id.is_empty() {
                return None;
            }
            let display = entry
                .get("display_name")
                .and_then(Value::as_str)
                .or_else(|| entry.get("name").and_then(Value::as_str))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&id);
            Some(json!({
                "id": id,
                "displayName": display,
                "isDefault": false,
                "reasoningEfforts": GENERIC_MODEL_REASONING_EFFORTS,
                "capabilities": [],
                "serviceTiers": []
            }))
        })
        .collect();
    json!({
        "providerId": "openai-compatible",
        "models": models,
        "source": "provider_api",
        "fetchedAt": now_iso()
    })
}

/// Provider API model discovery against GET {baseUrl}/models. Requests
/// without a credential are sent unauthenticated so local endpoints work.
pub(crate) fn validated_model_endpoint(base_url: &str) -> CoreResult<String> {
    let url = reqwest::Url::parse(base_url).map_err(|_| CoreError::reason(
        ErrorCode::IpcInternalError, "Model endpoint must be a valid absolute HTTP(S) URL"))?;
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(CoreError::reason(ErrorCode::IpcInternalError, "Model endpoint cannot contain credentials, query parameters or fragments"));
    }
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(CoreError::reason(ErrorCode::IpcInternalError, "Model endpoint requires HTTPS; HTTP is allowed only for 127.0.0.1 or [::1]"));
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

pub async fn discover_openai_compatible_models(
    base_url: &str,
    api_key: Option<&str>,
    timeout_ms: u64,
    api_type: Option<&str>,
) -> CoreResult<Value> {
    let normalized = validated_model_endpoint(base_url)?;
    let endpoints = model_list_endpoints(&normalized, api_type);
    let client = reqwest::Client::builder()
        // Custom API-key headers must never be forwarded to a redirect target.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .map_err(|e| CoreError::reason(ErrorCode::IpcInternalError, e.to_string()))?;
    let mut last_error = String::new();
    for endpoint in &endpoints {
        let mut request = client.get(endpoint);
        for (name, value) in model_list_headers(api_key, api_type) {
            request = request.header(name, value);
        }
        let outcome: CoreResult<Value> = async {
            let response = request
                .send()
                .await
                .map_err(|e| CoreError::reason(ErrorCode::IpcInternalError, e.to_string()))?;
            if !response.status().is_success() {
                return Err(CoreError::reason(
                    ErrorCode::IpcInternalError,
                    format!("GET {endpoint} failed ({})", response.status().as_u16()),
                ));
            }
            let body: Value = response
                .json()
                .await
                .map_err(|e| CoreError::reason(ErrorCode::IpcInternalError, e.to_string()))?;
            let catalog = parse_openai_compatible_model_list(&body);
            if catalog.get("models").and_then(Value::as_array).is_none_or(|m| m.is_empty()) {
                return Err(CoreError::reason(ErrorCode::IpcInternalError, format!("GET {endpoint} returned no models")));
            }
            Ok(catalog)
        }
        .await;
        match outcome {
            Ok(catalog) => return Ok(catalog),
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(CoreError::reason(
        ErrorCode::IpcInternalError,
        if last_error.is_empty() { format!("Unable to fetch models from {normalized}") } else { last_error },
    ))
}

#[cfg(test)]
mod model_configuration_tests {
    use super::*;

    #[tokio::test]
    async fn discovery_rejects_unsafe_urls_without_echoing_secrets() {
        for endpoint in ["http://example.com", "https://user:fixture-secret@example.com", "https://example.com?token=fixture-secret", "https://example.com#fixture-secret", "not-a-url"] {
            let error = discover_openai_compatible_models(endpoint, Some("fixture-key"), 100, None).await.unwrap_err();
            assert!(!error.to_string().contains("fixture-secret"));
        }
    }

    #[tokio::test]
    async fn discovery_never_follows_credential_redirects() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        for api_type in [Some("anthropic-messages"), Some("google-generative-ai"), None] {
            let target = TcpListener::bind("127.0.0.1:0").unwrap();
            target.set_nonblocking(true).unwrap();
            let source = TcpListener::bind("127.0.0.1:0").unwrap();
            let base_url = format!("http://{}/v1", source.local_addr().unwrap());
            let target_url = format!("http://{}/models", target.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = source.accept().unwrap();
                let mut buffer = [0_u8; 4096];
                stream.read(&mut buffer).unwrap();
                write!(stream, "HTTP/1.1 307 Temporary Redirect\r\nLocation: {target_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            });
            assert!(discover_openai_compatible_models(&base_url, Some("fixture-key"), 200, api_type).await.is_err());
            server.join().unwrap();
            assert!(matches!(target.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock));
        }
    }

    #[test]
    fn preserves_ids_prices_and_explicit_default_while_hiding_disabled_models() {
        let catalog = json!({"defaultModel": "a", "models": [
            {"id": "a", "isDefault": true, "reasoningEfforts": ["low", "high"]},
            {"id": "b", "displayName": "B", "reasoningEfforts": []}
        ]});
        let config = json!([
            {"id": "a", "enabled": false},
            {"id": "b", "displayName": "Friendly", "reasoningEfforts": ["low", "high"], "defaultReasoningEffort": "high", "pricing": {"input": 0, "output": 2.5}}
        ]);
        let result = merge_instance_model_config(&catalog, Some(&config));
        assert_eq!(result["defaultModel"], "b");
        assert_eq!(result["models"].as_array().unwrap().len(), 1);
        assert_eq!(result["models"][0]["id"], "b");
        assert_eq!(result["models"][0]["defaultReasoningEffort"], "high");
        assert_eq!(result["models"][0]["pricing"], json!({"input": 0, "output": 2.5}));
        assert!(result["models"][0]["pricing"].get("cacheRead").is_none());
    }

    #[test]
    fn legacy_order_and_invalid_defaults_fall_back_safely() {
        assert_eq!(configured_model_reasoning_effort(&json!({"reasoningEfforts": ["medium", "high"]})).as_deref(), Some("medium"));
        assert_eq!(configured_model_reasoning_effort(&json!({"reasoningEfforts": ["medium"], "defaultReasoningEffort": "invalid"})).as_deref(), Some("medium"));
        assert_eq!(configured_model_reasoning_effort(&json!({"reasoningEfforts": [], "defaultReasoningEffort": "custom"})).as_deref(), Some("custom"));
        assert_eq!(configured_model_reasoning_effort(&json!({"enabled": false, "reasoningEfforts": ["high"]})), None);
    }
}
