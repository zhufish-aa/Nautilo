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
use crate::runtime::security::environment_policy::{build_environment, isolate_login_profile};

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
                && provider_option(target, "wireApi") != Some("anthropic")
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

    if provider_option(&target, "wireApi") == Some("anthropic") {
        return tool_result(false, "Anthropic conversion does not support native web search. Select a Responses or Chat search instance.");
    }
    let base_url = provider_option(&target, "baseUrl").unwrap_or("https://api.openai.com/v1").trim_end_matches('/').to_string();
    if validate_search_endpoint(&base_url).is_err() {
        return tool_result(false, "The selected official search instance has an invalid API URL.");
    }
    let endpoint = format!("{base_url}/responses");
    let environment = match build_native_search_environment(&target, credential_environment(credentials, target.get("id").and_then(Value::as_str).unwrap_or(""), "codex")) {
        Ok(environment) => environment,
        Err(_) => return tool_result(false, "The selected search account profile is invalid. Check its login directory and connection settings."),
    };
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

fn validate_search_endpoint(endpoint: &str) -> anyhow::Result<()> {
    let url = reqwest::Url::parse(endpoint)?;
    anyhow::ensure!(url.username().is_empty() && url.password().is_none() && url.query().is_none() && url.fragment().is_none(), "Credential-bearing URL is unsupported");
    anyhow::ensure!(url.scheme() == "https" || (url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))), "HTTPS is required except literal loopback");
    Ok(())
}

async fn bounded_search_body(mut response: reqwest::Response) -> anyhow::Result<Value> {
    const LIMIT: usize = 8 * 1024 * 1024;
    anyhow::ensure!(response.content_length().is_none_or(|n| n <= LIMIT as u64), "Response too large");
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(bytes.len() + chunk.len() <= LIMIT, "Response too large");
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}

async fn execute_responses_web_search(
    endpoint: &str,
    model: &str,
    query: &str,
    context_size: &str,
    api_key: &str,
    reasoning_effort: Option<&str>,
) -> Value {
    if validate_search_endpoint(endpoint).is_err() {
        return tool_result(false, "Invalid search endpoint. Use HTTPS without URL credentials or query parameters.");
    }
    let client = match reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(20)).timeout(std::time::Duration::from_secs(120)).build() {
        Ok(client) => client,
        Err(_) => return tool_result(false, "Web search client initialization failed."),
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
        Err(_) => return tool_result(false, "Web search request failed or timed out. Check the selected provider connection."),
    };
    let status = response.status();
    if !status.is_success() {
        return tool_result(false, format!("Web search upstream rejected the request ({}). Check endpoint, model and API key.", status.as_u16()));
    }
    let body = match bounded_search_body(response).await {
        Ok(body) => body,
        Err(_) => return tool_result(false, "Web search returned an invalid, oversized or incomplete response."),
    };
    if body.get("error").is_some_and(|error| !error.is_null()) || matches!(body.get("status").and_then(Value::as_str), Some("failed" | "incomplete" | "cancelled")) {
        return tool_result(false, "Web search upstream reported a failed or incomplete response.");
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
/// The runtime uses an exact environment. Keep platform basics while preventing daemon secrets or an API key from
/// overriding the explicitly selected login account.
fn build_native_search_environment(target: &Value, environment: HashMap<String, String>) -> crate::errors::CoreResult<HashMap<String, String>> {
    isolate_login_profile(target, build_environment(None, environment))
}

async fn execute_native_official_web_search(
    target: &Value,
    model: &str,
    query: &str,
    environment: HashMap<String, String>,
    reasoning_effort: Option<&str>,
) -> Value {
    if provider_option(target, "wireApi") == Some("anthropic") {
        return tool_result(false, "Anthropic conversion does not support native web search.");
    }
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
        env: Some(environment),
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
        Err(_) => return tool_result(false, "Official Codex native web search could not start. Check the selected search instance configuration."),
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
    tool_result(false, if failure.is_some() { "Official Codex native web search failed. Check the selected provider connection." } else { "Official Codex native web search returned no result." })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_endpoint_policy_rejects_plaintext_and_embedded_secrets() {
        for url in ["http://example.com/v1/responses", "http://localhost/v1/responses", "https://user:secret@example.com", "https://example.com?key=secret", "https://example.com#secret", "file:///tmp/key"] {
            assert!(validate_search_endpoint(url).is_err());
        }
        assert!(validate_search_endpoint("https://api.openai.com/v1/responses").is_ok());
        assert!(validate_search_endpoint("http://127.0.0.1:1234/v1/responses").is_ok());
    }

    async fn search_fixture(reply: String) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://127.0.0.1:{}/v1/responses", listener.local_addr().unwrap().port());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new(); let mut byte = [0u8; 1];
            while !bytes.ends_with(b"\r\n\r\n") { socket.read_exact(&mut byte).await.unwrap(); bytes.push(byte[0]); }
            let headers = String::from_utf8(bytes).unwrap();
            let length: usize = headers.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap();
            let mut body = vec![0; length]; socket.read_exact(&mut body).await.unwrap();
            socket.write_all(reply.as_bytes()).await.unwrap();
        });
        (endpoint, task)
    }

    #[tokio::test]
    async fn search_rejects_redirects_and_redacts_remote_errors() {
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let location = format!("http://127.0.0.1:{}/steal", target.local_addr().unwrap().port());
        let body = "private-provider-error secret-key";
        let (endpoint, task) = search_fixture(format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())).await;
        let result = execute_responses_web_search(&endpoint, "m", "query", "low", "secret-key", None).await;
        assert_eq!(result["success"], false);
        assert!(!result.to_string().contains("secret-key")); assert!(!result.to_string().contains("private-provider-error"));
        assert!(tokio::time::timeout(std::time::Duration::from_millis(100), target.accept()).await.is_err());
        task.await.unwrap();
    }

    #[tokio::test]
    async fn search_rejects_oversized_body_and_anthropic_native_route() {
        let (endpoint, task) = search_fixture("HTTP/1.1 200 OK\r\nContent-Length: 8388609\r\nConnection: close\r\n\r\n{}".into()).await;
        let result = execute_responses_web_search(&endpoint, "m", "query", "low", "key", None).await;
        assert_eq!(result["success"], false); assert!(result["content"].as_str().unwrap().contains("oversized"));
        task.await.unwrap();
        let result = execute_native_official_web_search(&json!({"providerOptions":{"wireApi":"anthropic"}}), "m", "q", HashMap::new(), None).await;
        assert_eq!(result["success"], false); assert!(result["content"].as_str().unwrap().contains("does not support"));
    }

    #[tokio::test]
    async fn search_treats_http_success_error_payload_as_failure() {
        let body = r#"{"error":{"message":"private-key"},"status":"failed"}"#;
        let (endpoint, task) = search_fixture(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())).await;
        let result = execute_responses_web_search(&endpoint, "m", "q", "low", "key", None).await;
        assert_eq!(result["success"], false); assert!(!result.to_string().contains("private-key"));
        task.await.unwrap();
    }

    /// The child env must carry the daemon's own platform basics (home dir)
    /// plus the instance credentials. Before the fix the helper passed the raw
    /// (possibly empty) credential map straight through, which left the spawned
    /// Codex CLI with no environment at all and aborted on startup.
    #[test]
    fn native_search_environment_preserves_platform_basics_and_layers_credentials() {
        let credential_env: HashMap<String, String> =
            [("OPENAI_API_KEY".to_string(), "sk-test".to_string())].into_iter().collect();
        let merged = build_native_search_environment(&json!({ "providerId": "codex" }), credential_env).unwrap();

        // Credentials are layered on top and win over anything inherited.
        assert_eq!(merged.get("OPENAI_API_KEY").map(String::as_str), Some("sk-test"));

        // The daemon's home-directory variable must survive the merge so the
        // official-login Codex CLI can locate ~/.codex/auth.json.
        let has_home = merged.get("HOME").is_some() || merged.get("USERPROFILE").is_some() || merged.get("HOMEDRIVE").is_some();
        assert!(has_home, "expected a home-directory variable in the merged child environment");
    }
    #[test]
    fn native_search_uses_selected_profile_without_vault_api_credentials() {
        let directory = std::env::temp_dir().join("search-account-a").to_string_lossy().to_string();
        let target = json!({ "providerId": "codex", "baseArgs": [], "providerOptions": { "loginProfileDirectory": directory } });
        let environment = HashMap::from([("OPENAI_API_KEY".to_string(), "secret".to_string())]);
        let environment = build_native_search_environment(&target, environment).unwrap();
        assert_eq!(environment.get("CODEX_HOME"), Some(&directory));
        assert!(!environment.contains_key("OPENAI_API_KEY"));
    }

}
