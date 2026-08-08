//! Generic OpenAI-compatible model discovery + instance model overrides —
//! port of adapters/model-config.ts.

use serde_json::{json, Map, Value};

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
    let mut merged: Vec<Value> = result.get("models").and_then(Value::as_array).cloned().unwrap_or_default();
    for config in configs {
        let id = config.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if id.is_empty() {
            continue;
        }
        if let Some(index) = merged.iter().position(|model| model.get("id").and_then(Value::as_str) == Some(id.as_str())) {
            let mut existing = merged[index].as_object().cloned().unwrap_or_default();
            if let Some(display) = config.get("displayName").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                existing.insert("displayName".to_string(), json!(display));
            }
            if let Some(efforts) = config.get("reasoningEfforts").and_then(Value::as_array).filter(|e| !e.is_empty()) {
                existing.insert("reasoningEfforts".to_string(), Value::Array(efforts.clone()));
            }
            if let Some(window) = config.get("contextWindow") {
                if !window.is_null() {
                    existing.insert("contextWindow".to_string(), window.clone());
                }
            }
            merged[index] = Value::Object(existing);
        } else {
            let mut entry = Map::new();
            entry.insert("id".to_string(), json!(id));
            entry.insert(
                "displayName".to_string(),
                config
                    .get("displayName")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| json!(s))
                    .unwrap_or_else(|| json!(id)),
            );
            entry.insert("isDefault".to_string(), json!(false));
            entry.insert(
                "reasoningEfforts".to_string(),
                config.get("reasoningEfforts").cloned().filter(|v| v.is_array()).unwrap_or_else(|| json!([])),
            );
            if let Some(window) = config.get("contextWindow") {
                if !window.is_null() {
                    entry.insert("contextWindow".to_string(), window.clone());
                }
            }
            entry.insert("capabilities".to_string(), json!([]));
            entry.insert("serviceTiers".to_string(), json!([]));
            merged.push(Value::Object(entry));
        }
    }
    result.insert("models".to_string(), Value::Array(merged));
    Value::Object(result)
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
pub async fn discover_openai_compatible_models(
    base_url: &str,
    api_key: Option<&str>,
    timeout_ms: u64,
    api_type: Option<&str>,
) -> CoreResult<Value> {
    let normalized = base_url.trim_end_matches('/');
    let endpoints = model_list_endpoints(normalized, api_type);
    let client = reqwest::Client::builder()
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
