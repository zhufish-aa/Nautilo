//! One model step for the workspace assistant. Credentials and HTTP stay in the daemon.
use crate::application::connection_service::credential_key;
use crate::application::core_daemon::Daemon;
use crate::errors::{invalid, CoreResult};
use serde_json::{json, Value};
use std::time::Duration;

pub async fn search(daemon: &Daemon, input: &Value) -> CoreResult<Value> {
    use crate::database::Repositories;
    use crate::runtime::orchestration::official_web_search::{execute_official_web_search, supports_official_web_search};

    let query = input["query"].as_str().map(str::trim).filter(|query| !query.is_empty() && query.chars().count() <= 1800)
        .ok_or_else(|| invalid("query", "Supply a public search query of 1 to 1800 characters"))?;
    let candidates = Repositories::new(&daemon.db.lock().unwrap().raw).agents().list_default()?;
    let source = candidates.iter().find(|agent| agent["enabled"] == true && supports_official_web_search(agent, &daemon.db))
        .ok_or_else(|| invalid("webSearch", "Enable Official web search in a Harness configuration first."))?;
    let call = json!({"arguments":{"query":query,"search_context_size":"low"}});
    Ok(execute_official_web_search(&call, source, &daemon.db, &daemon.credentials).await)
}

pub async fn step(daemon: &Daemon, input: &Value) -> CoreResult<Value> {
    let id = input["connectionId"].as_str().unwrap_or("");
    let model = input["model"].as_str().unwrap_or("");
    let connection = daemon.connections.get(id, None)?;
    let account = connection["kind"] == "login";
    if connection["enabled"] != true || (account && connection["accountGateway"] != true) {
        return Err(invalid("connectionId", "请为助手选择已启用的 API 连接或已开放模型调用的账号。"));
    }
    let instructions = input["instructions"].as_str().unwrap_or("");
    let parts = input["context"]
        .as_array()
        .ok_or_else(|| invalid("context", "Invalid assistant context"))?;
    let context: Vec<&str> = parts.iter().filter_map(Value::as_str).collect();
    let specs = input["tools"]
        .as_array()
        .ok_or_else(|| invalid("tools", "Invalid assistant tools"))?;
    if context.is_empty()
        || context.len() != parts.len()
        || context.len() > 128
        || context.iter().map(|part| part.len()).sum::<usize>() > 1_048_576
        || instructions.len() > 16_384
        || specs.len() > 12
    {
        return Err(invalid("context", "助手请求超出大小限制。"));
    }
    let catalog = if account && !connection["models"].as_array().is_some_and(|models| !models.is_empty()) {
        Some(daemon.connections.discover_models(&json!({"connectionId":id,"revision":connection["revision"]}), true, false).await?)
    } else { None };
    let selected = catalog.as_ref().unwrap_or(&connection)["models"]
        .as_array().into_iter().flatten()
        .find(|item| item["id"] == model && item["enabled"] != false)
        .ok_or_else(|| invalid("model", "请选择这个连接下已启用的助手模型。"))?;
    let (base, key) = if account {
        daemon.runs.account_gateways.assistant_endpoint(&connection).await?
    } else {
        let key = daemon.credentials.read(&credential_key(id, connection["revision"].as_u64().unwrap_or(0)))?
            .and_then(|entry| entry["apiKey"].as_str().map(str::to_owned))
            .filter(|key| !key.is_empty())
            .ok_or_else(|| invalid("connectionId", "助手 API 连接缺少密钥。"))?;
        (connection["baseUrl"].as_str().unwrap_or("").to_owned(), key)
    };
    let base = base.trim_end_matches('/');
    let protocol = if account { "chat" } else { connection["protocol"].as_str().unwrap_or("chat") };
    let messages: Vec<Value> = context
        .iter()
        .map(|part| json!({"role":"user","content":part}))
        .collect();
    let (suffix, mut body) = match protocol {
        "responses" => (
            "/responses",
            json!({"model":model,"instructions":instructions,"input":messages,"store":false,"max_output_tokens":4096}),
        ),
        "anthropic" => {
            let stable = json!({"type":"ephemeral"});
            let mut blocks: Vec<_> = context
                .iter()
                .map(|text| json!({"type":"text","text":text}))
                .collect();
            if let Some(last) = blocks.last_mut() {
                last["cache_control"] = stable.clone();
            }
            (
                "/messages",
                json!({"model":model,"system":[{"type":"text","text":instructions,"cache_control":stable}],"messages":[{"role":"user","content":blocks}],"max_tokens":4096}),
            )
        }
        _ => {
            let mut chat = vec![json!({"role":"system","content":instructions})];
            chat.extend(messages);
            ("/chat/completions", json!({"model":model,"messages":chat}))
        }
    };
    if !specs.is_empty() {
        body["tools"] = Value::Array(specs.iter().map(|spec| match protocol {
            "anthropic" => json!({"name":spec["name"],"description":spec["description"],"input_schema":spec["parameters"]}),
            "responses" => json!({"type":"function","name":spec["name"],"description":spec["description"],"parameters":spec["parameters"]}),
            _ => json!({"type":"function","function":{"name":spec["name"],"description":spec["description"],"parameters":spec["parameters"]}})
        }).collect());
    }
    let stream_id = input["streamId"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok());
    if stream_id.is_some() {
        body["stream"] = json!(true);
        if protocol == "chat" {
            body["stream_options"] = json!({"include_usage":true});
        }
    }
    if let Some(effort) = input["reasoningEffort"].as_str().filter(|e| !e.is_empty()) {
        if selected["defaultReasoningEffort"] != effort
            && !selected["reasoningEfforts"].as_array().is_some_and(|levels| levels.iter().any(|l| l == effort)) {
            return Err(invalid("reasoningEffort", "推理强度不在模型配置中。"));
        }
        let off = matches!(effort, "off" | "none");
        let deepseek = model.to_ascii_lowercase().contains("deepseek")
            || connection["baseUrl"]
                .as_str()
                .and_then(|s| reqwest::Url::parse(s).ok())
                .is_some_and(|url| url.host_str() == Some("api.deepseek.com"));
        match protocol {
            "responses" => body["reasoning"] = json!({"effort":if off {"none"}else{effort}}),
            "anthropic" => {
                if off {
                    body["thinking"] = json!({"type":"disabled"});
                } else {
                    body["output_config"] = json!({"effort":effort});
                    if deepseek {
                        body["thinking"] = json!({"type":"enabled"});
                    }
                }
            }
            _ => {
                if deepseek {
                    body["thinking"] = json!({"type":if off{"disabled"}else{"enabled"}});
                }
                if !deepseek || !off {
                    body["reasoning_effort"] = json!(if off { "none" } else { effort });
                }
            }
        }
    }
    let endpoint = if base.ends_with(suffix) {
        base.to_owned()
    } else {
        format!("{base}{suffix}")
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| invalid("model", "Could not start the assistant model request"))?;
    let request = client.post(endpoint).json(&body);
    let request = if protocol == "anthropic" {
        request
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
    } else {
        request.bearer_auth(&key)
    };
    let response = request.send().await.map_err(|e| {
        invalid(
            "model",
            if e.is_timeout() {
                "助手模型请求超时。"
            } else {
                "无法连接助手模型，请检查 API 连接。"
            },
        )
    })?;
    let status = response.status();
    let is_sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.to_ascii_lowercase().contains("text/event-stream"));
    let value: Value = if status.is_success() && is_sse {
        super::assistant_stream::read(response, protocol, stream_id.unwrap_or("")).await?
    } else {
        response.json().await.unwrap_or(Value::Null)
    };
    if !status.is_success() {
        let reason = daemon.redaction.text(
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Model request failed"),
        );
        return Err(invalid(
            "model",
            &format!(
                "HTTP {} · {}",
                status.as_u16(),
                reason.chars().take(800).collect::<String>()
            ),
        ));
    }
    let mut text = String::new();
    let mut tool = None;
    match protocol {
        "responses" | "anthropic" => {
            for item in value[if protocol == "responses" {
                "output"
            } else {
                "content"
            }]
            .as_array()
            .into_iter()
            .flatten()
            {
                match item["type"].as_str() {
                    Some("function_call" | "tool_use") if tool.is_none() => tool = Some(item),
                    Some("message") => {
                        for part in item["content"].as_array().into_iter().flatten() {
                            text.push_str(part["text"].as_str().unwrap_or(""));
                        }
                    }
                    Some("text") => text.push_str(item["text"].as_str().unwrap_or("")),
                    _ => {}
                }
            }
        }
        _ => {
            let message = &value["choices"][0]["message"];
            tool = message.pointer("/tool_calls/0/function");
            text = message["content"].as_str().unwrap_or("").to_owned();
        }
    }
    let usage = &value["usage"];
    let cache_read = usage["cache_read_input_tokens"]
        .as_u64()
        .or_else(|| usage["prompt_cache_hit_tokens"].as_u64())
        .or_else(|| {
            usage
                .pointer("/prompt_tokens_details/cached_tokens")
                .and_then(Value::as_u64)
        })
        .or_else(|| {
            usage
                .pointer("/input_tokens_details/cached_tokens")
                .and_then(Value::as_u64)
        });
    let input_tokens = usage["input_tokens"]
        .as_u64()
        .or_else(|| usage["prompt_tokens"].as_u64())
        .map(|tokens| {
            if protocol == "anthropic" {
                tokens
                    + cache_read.unwrap_or(0)
                    + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0)
            } else {
                tokens
            }
        });
    if let Some(tool) = tool {
        let args = if tool["input"].is_object() {
            tool["input"].clone()
        } else {
            serde_json::from_str(tool["arguments"].as_str().unwrap_or(""))
                .map_err(|_| invalid("model", "助手模型返回的工具参数不完整。"))?
        };
        if !args.is_object() {
            return Err(invalid("model", "助手模型返回了无效的工具参数。"));
        }
        return Ok(
            json!({"call":{"name":tool["name"],"arguments":args},"inputTokens":input_tokens,"cacheReadTokens":cache_read}),
        );
    }
    if text.trim().is_empty() {
        return Err(invalid("model", "助手模型没有返回可用的回答。"));
    }
    Ok(json!({"text":text,"inputTokens":input_tokens,"cacheReadTokens":cache_read}))
}
