//! Official web search runtime tool — port of
//! runtime/orchestration/official-web-search.ts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::adapters::codex::app_server::start_codex_app_server;
use crate::adapters::codex::chat_compat::start_codex_chat_compat_app_server;
use crate::adapters::AdapterStartRequest;
use crate::database::{Database, Repositories};
use crate::runtime::orchestration::runtime_tool_names::RUNTIME_TOOL_WEB_SEARCH;
use crate::runtime::security::CredentialService;

pub fn official_web_search_tool() -> Value {
    json!({
        "name": RUNTIME_TOOL_WEB_SEARCH,
        "description": "Search the live web through the user-selected Codex instance. Use this when the current model provider does not have native web search.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["query"],
            "properties": {
                "query": { "type": "string", "minLength": 1, "description": "The exact web search query." },
                "search_context_size": { "type": "string", "enum": ["low", "medium", "high"], "description": "How much search context to provide." }
            }
        }
    })
}

fn provider_option<'a>(agent: &'a Value, key: &str) -> Option<&'a str> {
    agent.get("providerOptions").and_then(|o| o.get(key)).and_then(Value::as_str)
}

pub fn supports_official_web_search(agent: &Value, db: &Arc<Mutex<Database>>) -> bool {
    if provider_option(agent, "webSearchMode") != Some("official") {
        return false;
    }
    let Some(target_id) = provider_option(agent, "webSearchInstanceId") else {
        return false;
    };
    let target = Repositories::new(&db.lock().unwrap().raw).agents().get(target_id).ok().flatten();
    target
        .filter(|target| {
            target.get("enabled").and_then(Value::as_bool) == Some(true)
                && target.get("status").and_then(Value::as_str) != Some("disabled")
                && target.get("providerId").and_then(Value::as_str) == Some("codex")
        })
        .is_some()
}

fn tool_result(success: bool, content: impl Into<String>) -> Value {
    json!({ "success": success, "content": content.into() })
}

pub async fn execute_official_web_search(
    call: &Value,
    agent: &Value,
    db: &Arc<Mutex<Database>>,
    credentials: &Arc<CredentialService>,
) -> Value {
    let target_id = provider_option(agent, "webSearchInstanceId").unwrap_or("");
    let target = Repositories::new(&db.lock().unwrap().raw).agents().get(target_id).ok().flatten();
    let Some(target) = target.filter(|t| {
        t.get("enabled").and_then(Value::as_bool) == Some(true) && t.get("status").and_then(Value::as_str) != Some("disabled")
    }) else {
        return tool_result(false, "Web search is not configured. Select an enabled Codex search instance first.");
    };
    if target.get("providerId").and_then(Value::as_str) != Some("codex") {
        return tool_result(false, "The selected web search instance must use the Codex adapter.");
    }

    let base_url = provider_option(&target, "baseUrl").unwrap_or("https://api.openai.com/v1").trim_end_matches('/').to_string();
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return tool_result(false, "The selected official search instance has an invalid API URL.");
    }
    let endpoint = format!("{base_url}/responses");
    let environment = credential_environment(credentials, target.get("id").and_then(Value::as_str).unwrap_or(""), "codex");
    let api_key = environment
        .get("OPENAI_API_KEY")
        .or_else(|| environment.get("CODEX_API_KEY"))
        .or_else(|| environment.get("AGENTHUB_API_KEY"))
        .cloned();

    let arguments = match call.get("arguments") {
        Some(Value::String(text)) => serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!({})),
        Some(other) => other.clone(),
        None => json!({}),
    };
    let Some(query) = arguments.get("query").and_then(Value::as_str).map(str::trim).filter(|q| !q.is_empty()).map(str::to_string) else {
        return tool_result(false, "Search query cannot be empty.");
    };
    let context_size = match arguments.get("search_context_size").and_then(Value::as_str) {
        Some("low") => "low",
        Some("high") => "high",
        _ => "medium",
    };
    let model = provider_option(agent, "webSearchModel")
        .map(str::to_string)
        .or_else(|| {
            target
                .get("models")
                .and_then(Value::as_array)
                .and_then(|models| {
                    models.iter().find_map(|item| {
                        let id = item.get("id").and_then(Value::as_str)?;
                        regex::Regex::new(r"(?i)^gpt-\d").ok()?.is_match(id).then(|| id.to_string())
                    })
                })
        })
        .unwrap_or_else(|| "gpt-5.6".to_string());
    let reasoning_effort = provider_option(agent, "webSearchReasoningEffort").map(str::to_string);

    if api_key.is_some() && provider_option(&target, "wireApi") != Some("chat") {
        // Responses-compatible third-party endpoints can use the same native
        // web_search request shape.
        return execute_responses_web_search(&endpoint, &model, &query, context_size, &api_key.unwrap(), reasoning_effort.as_deref()).await;
    }
    // Third-party endpoints must go through a real Codex instance.
    execute_native_official_web_search(&target, &model, &query, environment, reasoning_effort.as_deref()).await
}

fn credential_environment(credentials: &Arc<CredentialService>, agent_instance_id: &str, provider_id: &str) -> HashMap<String, String> {
    let credential = match credentials.read(agent_instance_id) {
        Ok(Some(credential)) => credential,
        _ => return HashMap::new(),
    };
    let api_key = credential.get("apiKey").and_then(Value::as_str).unwrap_or("");
    if api_key.is_empty() {
        return HashMap::new();
    }
    let mut environment = HashMap::new();
    if let Some(env_name) = credential.get("envName").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        environment.insert(env_name.to_string(), api_key.to_string());
        return environment;
    }
    let _ = provider_id;
    environment.insert("OPENAI_API_KEY".to_string(), api_key.to_string());
    environment
}

async fn execute_responses_web_search(
    endpoint: &str,
    model: &str,
    query: &str,
    context_size: &str,
    api_key: &str,
    reasoning_effort: Option<&str>,
) -> Value {
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build() {
        Ok(client) => client,
        Err(error) => return tool_result(false, format!("Web search request failed: {error}")),
    };
    let mut body = Map::new();
    body.insert("model".to_string(), json!(model));
    body.insert("tools".to_string(), json!([{ "type": "web_search", "search_context_size": context_size }]));
    body.insert("tool_choice".to_string(), json!("required"));
    body.insert("include".to_string(), json!(["web_search_call.action.sources"]));
    body.insert("input".to_string(), json!(query));
    if let Some(effort) = reasoning_effort {
        body.insert("reasoning".to_string(), json!({ "effort": effort }));
    }
    let response = match client
        .post(endpoint)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {api_key}"))
        .json(&Value::Object(body))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return tool_result(false, format!("Web search request failed: {error}")),
    };
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let message = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return tool_result(false, format!("Web search failed ({}): {message}", status.as_u16()));
    }
    tool_result(true, format_search_result(&body))
}

fn format_search_result(body: &Value) -> String {
    let output_text = body
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| extract_responses_message_text(body.get("output")));
    let mut citations: Vec<(String, String)> = vec![];
    for item in body.get("output").and_then(Value::as_array).cloned().unwrap_or_default() {
        for part in item.get("content").and_then(Value::as_array).cloned().unwrap_or_default() {
            for annotation in part.get("annotations").and_then(Value::as_array).cloned().unwrap_or_default() {
                if let Some(url) = annotation.get("url").and_then(Value::as_str) {
                    let title = annotation.get("title").and_then(Value::as_str).unwrap_or(url).to_string();
                    if !citations.iter().any(|(existing, _)| existing == url) {
                        citations.push((url.to_string(), title));
                    }
                }
            }
        }
    }
    let text = if output_text.is_empty() { "Official web search returned no summary.".to_string() } else { output_text };
    if citations.is_empty() {
        return text;
    }
    let sources = citations.iter().map(|(url, title)| format!("- [{title}]({url})")).collect::<Vec<_>>().join("\n");
    format!("{text}\n\nSources:\n{sources}")
}

fn extract_responses_message_text(value: Option<&Value>) -> String {
    let Some(items) = value.and_then(Value::as_array) else {
        return String::new();
    };
    items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .map(|item| {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                return text.to_string();
            }
            item.get("content")
                .and_then(Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
        .trim()
        .to_string()
}

/// Builds the child environment for a native Codex web-search subprocess.
///
/// The process runtime clears the child environment by design (exact env, never
/// inherited), so the spawned Codex CLI must receive the daemon's own process
/// environment merged with the search instance's credentials on top. This mirrors
/// the TS daemon's `{ ...process.env, ...environment }` so that official-login
/// instances (no API key in the credential store) still start and can locate
/// `~/.codex/auth.json` via USERPROFILE/HOME instead of dying on an empty
/// environment (node aborts before it can even respond to `initialize`).
fn build_native_search_environment(environment: HashMap<String, String>) -> HashMap<String, String> {
    let mut merged: HashMap<String, String> = std::env::vars().collect();
    merged.extend(environment);
    merged
}

/// Launches a real Codex turn whose model owns a native web search tool.
async fn execute_native_official_web_search(
    target: &Value,
    model: &str,
    query: &str,
    environment: HashMap<String, String>,
    reasoning_effort: Option<&str>,
) -> Value {
    let mut native_target = target.as_object().cloned().unwrap_or_default();
    let mut options = native_target
        .get("providerOptions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    options.insert("webSearch".to_string(), json!(true));
    options.insert("webSearchMode".to_string(), json!("native"));
    native_target.insert("providerOptions".to_string(), Value::Object(options));
    let native_target = Value::Object(native_target);

    let prompt = [
        "Use your native web search tool to answer the following query.",
        "Return a concise factual summary and include source URLs or citations when available.",
        &format!("Query: {query}"),
    ]
    .join("\n");
    let request = AdapterStartRequest {
        instance: native_target.clone(),
        prompt,
        cwd: std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        model: Some(model.to_string()),
        reasoning_effort: reasoning_effort.map(str::to_string),
        env: Some(build_native_search_environment(environment)),
        timeout_ms: Some(120_000),
        idle_timeout_ms: Some(60_000),
        max_output_bytes: Some(8 * 1024 * 1024),
        ..Default::default()
    };
    let run = if provider_option(target, "wireApi") == Some("chat") {
        start_codex_chat_compat_app_server(request, None)
    } else {
        start_codex_app_server(request, None)
    };
    let run = match run {
        Ok(run) => run,
        Err(error) => return tool_result(false, format!("Official Codex native web search failed: {error}")),
    };
    let (mut events, cancel, _steer, _write) = run.into_parts();
    let mut answer = String::new();
    let mut completed_message = String::new();
    let mut failure: Option<String> = None;
    while let Some(event) = events.recv().await {
        match event {
            crate::adapters::AdapterEvent::Message { text, phase, .. } => {
                if phase.as_deref() == Some("delta") {
                    answer.push_str(&text);
                } else {
                    completed_message = text;
                }
            }
            crate::adapters::AdapterEvent::Error { message } => failure = Some(message),
            crate::adapters::AdapterEvent::Raw { stream, text } if stream == "stderr" => {
                if !text.trim().is_empty() {
                    failure = Some(text.trim().to_string());
                }
            }
            _ => {}
        }
    }
    cancel().await;
    let text = if !answer.trim().is_empty() { answer.trim().to_string() } else { completed_message.trim().to_string() };
    if !text.is_empty() {
        return tool_result(true, text);
    }
    tool_result(false, format!("Official Codex native web search failed: {}", failure.unwrap_or_else(|| "no search result returned".to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The child env must carry the daemon's own platform basics (home dir)
    /// plus the instance credentials. Before the fix the helper passed the raw
    /// (possibly empty) credential map straight through, which left the spawned
    /// Codex CLI with no environment at all and aborted on startup.
    #[test]
    fn native_search_environment_preserves_process_env_and_layers_credentials() {
        let credential_env: HashMap<String, String> =
            [("OPENAI_API_KEY".to_string(), "sk-test".to_string())].into_iter().collect();
        let merged = build_native_search_environment(credential_env);

        // Credentials are layered on top and win over anything inherited.
        assert_eq!(merged.get("OPENAI_API_KEY").map(String::as_str), Some("sk-test"));

        // The daemon's home-directory variable must survive the merge so the
        // official-login Codex CLI can locate ~/.codex/auth.json.
        let has_home = merged.get("HOME").is_some() || merged.get("USERPROFILE").is_some() || merged.get("HOMEDRIVE").is_some();
        assert!(has_home, "expected a home-directory variable in the merged child environment");
    }
}
