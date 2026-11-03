//! Codex event parsers — port of adapters/codex/events.ts and
//! app-server-events.ts (exec JSONL lines and app-server notifications).

use serde_json::{json, Value};

use crate::adapters::{normalize_json, AdapterEvent};

fn number_of(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_f64().map(|f| f as i64))
}

fn text_of(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

// ---------------------------------------------------------------- exec JSONL

fn item_events(event_type: &str, item: &Value, raw: &Value) -> Vec<AdapterEvent> {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    let completed = event_type == "item.completed";
    match item_type {
        "agent_message" if completed => item
            .get("text")
            .and_then(text_of)
            .map(|text| {
                vec![AdapterEvent::Message { text, phase: None, message_id: None, subagent_dispatch_id: None, raw: Some(raw.clone()) }]
            })
            .unwrap_or_default(),
        "reasoning" if completed => item
            .get("text")
            .and_then(text_of)
            .map(|text| {
                vec![AdapterEvent::Thinking { text, phase: None, message_id: None, subagent_dispatch_id: None, raw: Some(raw.clone()) }]
            })
            .unwrap_or_default(),
        "command_execution" => {
            let Some(command) = item.get("command").and_then(text_of) else {
                return vec![];
            };
            vec![AdapterEvent::Command {
                call_id: None,
                command,
                phase: Some(if completed { "completed" } else { "started" }.to_string()),
                exit_code: if completed { item.get("exit_code").and_then(number_of).map(|c| c as i32) } else { None },
                output: if completed { item.get("aggregated_output").and_then(text_of) } else { None },
                subagent_dispatch_id: None,
                raw: Some(raw.clone()),
            }]
        }
        "mcp_tool_call" => {
            let name = [item.get("server"), item.get("tool")]
                .iter()
                .filter_map(|v| v.and_then(text_of))
                .collect::<Vec<_>>()
                .join("/");
            vec![AdapterEvent::Tool {
                call_id: None,
                name: if name.is_empty() { "mcp".to_string() } else { name },
                phase: Some(if completed { "completed" } else { "started" }.to_string()),
                input: item.get("arguments").cloned(),
                output: item.get("result").cloned(),
                success: None,
                file_diff: None,
                subagent_dispatch_id: None,
                raw: Some(raw.clone()),
            }]
        }
        "web_search" => vec![AdapterEvent::Tool {
            call_id: None,
            name: "web_search".to_string(),
            phase: Some(if completed { "completed" } else { "started" }.to_string()),
            input: item.get("query").cloned(),
            output: None,
            success: None,
            file_diff: None,
            subagent_dispatch_id: None,
            raw: Some(raw.clone()),
        }],
        "file_change" if completed => {
            let changes = item.get("changes").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![item.clone()]);
            changes
                .iter()
                .filter_map(|change| {
                    let path = change.get("path").and_then(text_of)?;
                    Some(AdapterEvent::File {
                        path,
                        change_type: change.get("kind").and_then(text_of).or(Some("modified".to_string())),
                        additions: change.get("additions").and_then(number_of),
                        deletions: change.get("deletions").and_then(number_of),
                        diff: change.get("diff").and_then(text_of).or_else(|| change.get("patch").and_then(text_of)),
                        raw: Some(raw.clone()),
                    })
                })
                .collect()
        }
        _ => vec![],
    }
}

/// Parses one `codex exec --json` line.
pub fn parse_codex_json_event(value: &Value) -> Vec<AdapterEvent> {
    let Some(event_type) = value.get("type").and_then(Value::as_str) else {
        return normalize_json(value);
    };
    match event_type {
        "thread.started" => value
            .get("thread_id")
            .and_then(text_of)
            .map(|id| vec![AdapterEvent::Session { provider_session_id: id, raw: Some(value.clone()) }])
            .unwrap_or_default(),
        "turn.started" => vec![AdapterEvent::Status { phase: "turn_started".to_string(), raw: Some(value.clone()) }],
        "turn.completed" => {
            let mut events = vec![];
            if let Some(usage) = value.get("usage") {
                events.push(AdapterEvent::Usage {
                    input_tokens: usage.get("input_tokens").and_then(number_of),
                    cached_input_tokens: usage.get("cached_input_tokens").and_then(number_of),
                    output_tokens: usage.get("output_tokens").and_then(number_of),
                    reasoning_output_tokens: usage.get("reasoning_output_tokens").and_then(number_of),
                    context_used: None,
                    context_window: None,
                    raw: Some(value.clone()),
                });
            }
            events.push(AdapterEvent::Status { phase: "turn_completed".to_string(), raw: Some(value.clone()) });
            events
        }
        "turn.failed" => {
            let message = value
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(text_of)
                .unwrap_or_else(|| "Codex turn failed".to_string());
            vec![
                AdapterEvent::Status { phase: "turn_failed".to_string(), raw: Some(value.clone()) },
                AdapterEvent::Error { message },
            ]
        }
        "error" => vec![AdapterEvent::Error {
            message: value.get("message").and_then(text_of).unwrap_or_else(|| "Codex reported an error".to_string()),
        }],
        _ if event_type.starts_with("item.") => match value.get("item") {
            Some(item) => item_events(event_type, item, value),
            None => vec![],
        },
        _ => normalize_json(value),
    }
}

// ---------------------------------------------------------------- app-server notifications

fn printable(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => serde_json::to_string_pretty(other).ok(),
    }
}

pub fn is_current_codex_turn_diff(params: &Value, thread_id: &str, turn_id: Option<&str>) -> bool {
    !thread_id.is_empty() && turn_id.is_some_and(|id| !id.is_empty())
        && params.get("threadId").and_then(Value::as_str) == Some(thread_id)
        && params.get("turnId").and_then(Value::as_str) == turn_id
}

pub fn parse_codex_app_server_notification(method: &str, params: &Value) -> Vec<AdapterEvent> {
    match method {
        "turn/diff/updated" => match (
            params.get("diff").and_then(Value::as_str),
            params.get("threadId").and_then(Value::as_str),
            params.get("turnId").and_then(Value::as_str),
        ) {
            (Some(diff), Some(thread_id), Some(turn_id)) => vec![AdapterEvent::TurnDiff {
                diff: diff.to_string(), thread_id: thread_id.to_string(), turn_id: turn_id.to_string(), raw: Some(params.clone()),
            }],
            _ => vec![],
        },
        "item/agentMessage/delta" => vec![AdapterEvent::Message {
            text: params.get("delta").and_then(text_of).unwrap_or_default(),
            phase: Some("delta".to_string()),
            message_id: params.get("itemId").and_then(text_of),
            subagent_dispatch_id: None,
            raw: Some(params.clone()),
        }],
        "item/reasoning/summaryTextDelta" => vec![AdapterEvent::Thinking {
            text: params.get("delta").and_then(text_of).unwrap_or_default(),
            phase: Some("delta".to_string()),
            message_id: params.get("itemId").and_then(text_of),
            subagent_dispatch_id: None,
            raw: Some(params.clone()),
        }],
        "turn/started" => vec![AdapterEvent::Status { phase: "turn_started".to_string(), raw: Some(params.clone()) }],
        "turn/completed" => vec![AdapterEvent::Status { phase: "turn_completed".to_string(), raw: Some(params.clone()) }],
        "thread/tokenUsage/updated" => {
            let usage = params.get("tokenUsage").or_else(|| params.get("usage")).cloned().unwrap_or(Value::Null);
            let total = usage.get("total").unwrap_or(&usage);
            let last = usage.get("last").unwrap_or(&usage);
            vec![AdapterEvent::Usage {
                input_tokens: total.get("inputTokens").and_then(number_of),
                cached_input_tokens: total.get("cachedInputTokens").and_then(number_of),
                output_tokens: total.get("outputTokens").and_then(number_of),
                reasoning_output_tokens: total.get("reasoningOutputTokens").and_then(number_of),
                // `total` is cumulative for the thread; `last` is the current
                // model request and drives the context ring.
                context_used: last.get("totalTokens").and_then(number_of),
                context_window: usage.get("modelContextWindow").and_then(number_of),
                raw: Some(params.clone()),
            }]
        }
        "item/started" | "item/completed" => parse_item(method, params),
        _ => vec![],
    }
}

fn parse_item(method: &str, params: &Value) -> Vec<AdapterEvent> {
    let item = params.get("item").cloned().unwrap_or(Value::Null);
    let phase = if method == "item/completed" { "completed" } else { "started" };
    let id = item.get("id").and_then(text_of);
    match item.get("type").and_then(Value::as_str).unwrap_or("") {
        "collabAgentToolCall" => {
            // Codex multi-agent collab call; spawnAgent is Nautilo's sub-agent
            // dispatch, correlated back by the run loop.
            let state_summary = item
                .get("agentsStates")
                .and_then(Value::as_object)
                .map(|states| {
                    states
                        .iter()
                        .map(|(thread_id, state)| {
                            let status = state.get("status").and_then(text_of).unwrap_or_else(|| "unknown".to_string());
                            let message = state.get("message").and_then(text_of);
                            match message {
                                Some(message) => format!("{thread_id}: {status} — {message}"),
                                None => format!("{thread_id}: {status}"),
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            vec![AdapterEvent::Tool {
                call_id: id,
                name: item.get("tool").and_then(text_of).unwrap_or_else(|| "spawnAgent".to_string()),
                phase: Some(phase.to_string()),
                input: Some(json!({
                    "prompt": item.get("prompt").and_then(text_of),
                    "model": item.get("model").and_then(text_of)
                })),
                output: if phase == "completed" && !state_summary.is_empty() { Some(Value::String(state_summary)) } else { None },
                success: Some(item.get("status").and_then(text_of).as_deref() != Some("failed")),
                file_diff: None,
                subagent_dispatch_id: None,
                raw: Some(params.clone()),
            }]
        }
        "agentMessage" => {
            if phase == "started" {
                return vec![];
            }
            vec![AdapterEvent::Message {
                text: item.get("text").and_then(text_of).unwrap_or_default(),
                phase: Some("completed".to_string()),
                message_id: id,
                subagent_dispatch_id: None,
                raw: Some(params.clone()),
            }]
        }
        "reasoning" => {
            if phase == "started" {
                return vec![];
            }
            let summary = item
                .get("summary")
                .and_then(Value::as_array)
                .map(|parts| parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default();
            if summary.is_empty() {
                return vec![];
            }
            vec![AdapterEvent::Thinking {
                text: summary,
                phase: Some("completed".to_string()),
                message_id: id,
                subagent_dispatch_id: None,
                raw: Some(params.clone()),
            }]
        }
        "commandExecution" => vec![AdapterEvent::Command {
            call_id: id,
            command: item.get("command").and_then(text_of).unwrap_or_else(|| "command".to_string()),
            phase: Some(phase.to_string()),
            exit_code: item.get("exitCode").and_then(number_of).map(|c| c as i32),
            output: item.get("aggregatedOutput").and_then(text_of),
            subagent_dispatch_id: None,
            raw: Some(params.clone()),
        }],
        "mcpToolCall" | "dynamicToolCall" => {
            let name = if item.get("type").and_then(Value::as_str) == Some("mcpToolCall") {
                [item.get("server"), item.get("tool")]
                    .iter()
                    .filter_map(|v| v.and_then(text_of))
                    .collect::<Vec<_>>()
                    .join("/")
            } else {
                item.get("tool").and_then(text_of).unwrap_or_default()
            };
            vec![AdapterEvent::Tool {
                call_id: id,
                name: if name.is_empty() { "tool".to_string() } else { name },
                phase: Some(phase.to_string()),
                input: item.get("arguments").cloned().or_else(|| item.get("input").cloned()),
                output: item
                    .get("result")
                    .or_else(|| item.get("output"))
                    .or_else(|| item.get("error"))
                    .and_then(printable)
                    .map(Value::String),
                success: Some(item.get("status").and_then(text_of).as_deref() != Some("failed") && item.get("error").is_none()),
                file_diff: None,
                subagent_dispatch_id: None,
                raw: Some(params.clone()),
            }]
        }
        "webSearch" => vec![AdapterEvent::Tool {
            call_id: id,
            name: "web_search".to_string(),
            phase: Some(phase.to_string()),
            input: item.get("action").cloned().or_else(|| item.get("query").cloned()),
            output: if phase == "completed" {
                item.get("action").or_else(|| item.get("query")).and_then(printable).map(Value::String)
            } else {
                None
            },
            success: Some(true),
            file_diff: None,
            subagent_dispatch_id: None,
            raw: Some(params.clone()),
        }],
        "imageGeneration" => {
            if phase == "started" {
                return vec![AdapterEvent::Tool {
                    call_id: id,
                    name: "image_generation".to_string(),
                    phase: Some("started".to_string()),
                    input: item.get("revisedPrompt").cloned(),
                    output: None,
                    success: None,
                    file_diff: None,
                    subagent_dispatch_id: None,
                    raw: Some(params.clone()),
                }];
            }
            let result = item.get("result").and_then(text_of);
            let saved_path = item.get("savedPath").and_then(text_of).filter(|p| std::path::Path::new(p).exists());
            let status = item.get("status").and_then(text_of);
            let mut events = vec![AdapterEvent::Tool {
                call_id: id.clone(),
                name: "image_generation".to_string(),
                phase: Some("completed".to_string()),
                input: None,
                output: Some(Value::String(
                    saved_path.clone().or(result.clone()).or_else(|| status.clone()).unwrap_or_else(|| "图片已生成".to_string()),
                )),
                success: Some(status.as_deref() != Some("failed")),
                file_diff: None,
                subagent_dispatch_id: None,
                raw: Some(params.clone()),
            }];
            if result.is_some() || saved_path.is_some() {
                events.push(AdapterEvent::Artifact {
                    artifact_type: "image".to_string(),
                    name: saved_path
                        .as_ref()
                        .and_then(|p| p.split(['/', '\\']).last().map(str::to_string))
                        .unwrap_or_else(|| format!("generated-{}.png", id.unwrap_or_else(|| "image".to_string()))),
                    mime_type: Some("image/png".to_string()),
                    // Codex already persisted the image; prefer the path over a
                    // multi-megabyte base64 payload.
                    data: if saved_path.is_some() { None } else { result },
                    path: saved_path,
                    raw: Some(params.clone()),
                });
            }
            events
        }
        "fileChange" if phase == "completed" => item
            .get("changes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|change| {
                let path = change.get("path").and_then(text_of)?;
                Some(AdapterEvent::File {
                    path,
                    change_type: change.get("kind").and_then(text_of),
                    additions: change.get("additions").and_then(number_of),
                    deletions: change.get("deletions").and_then(number_of),
                    diff: change.get("diff").and_then(text_of).or_else(|| change.get("patch").and_then(text_of)),
                    raw: Some(params.clone()),
                })
            })
            .collect(),
        _ => vec![],
    }
}

/// Tags events emitted from a subscribed child agent thread with their dispatch id.
pub fn with_subagent_dispatch(events: Vec<AdapterEvent>, dispatch_id: &str) -> Vec<AdapterEvent> {
    events
        .into_iter()
        .map(|event| match event {
            AdapterEvent::Message { text, phase, message_id, raw, .. } => AdapterEvent::Message {
                text,
                phase,
                message_id,
                subagent_dispatch_id: Some(dispatch_id.to_string()),
                raw,
            },
            AdapterEvent::Thinking { text, phase, message_id, raw, .. } => AdapterEvent::Thinking {
                text,
                phase,
                message_id,
                subagent_dispatch_id: Some(dispatch_id.to_string()),
                raw,
            },
            AdapterEvent::Tool { call_id, name, phase, input, output, success, file_diff, raw, .. } => AdapterEvent::Tool {
                call_id,
                name,
                phase,
                input,
                output,
                success,
                file_diff,
                subagent_dispatch_id: Some(dispatch_id.to_string()),
                raw,
            },
            AdapterEvent::Command { call_id, command, phase, exit_code, output, raw, .. } => AdapterEvent::Command {
                call_id,
                command,
                phase,
                exit_code,
                output,
                subagent_dispatch_id: Some(dispatch_id.to_string()),
                raw,
            },
            other => other,
        })
        .collect()
}

#[cfg(test)]
mod native_diff_tests {
    use super::*;

    #[test]
    fn native_diff_empty_is_a_valid_replacement() {
        let events = parse_codex_app_server_notification("turn/diff/updated", &json!({ "threadId": "t", "turnId": "u", "diff": "" }));
        assert!(matches!(events.as_slice(), [AdapterEvent::TurnDiff { diff, .. }] if diff.is_empty()));
        assert!(parse_codex_app_server_notification("turn/diff/updated", &json!({ "threadId": "t", "turnId": "u", "diff": null })).is_empty());
    }

    #[test]
    fn native_diff_requires_exact_main_thread_and_current_turn() {
        assert!(is_current_codex_turn_diff(&json!({ "threadId": "t", "turnId": "u" }), "t", Some("u")));
        assert!(!is_current_codex_turn_diff(&json!({ "threadId": "child", "turnId": "u" }), "t", Some("u")));
        assert!(!is_current_codex_turn_diff(&json!({ "threadId": "t", "turnId": "old" }), "t", Some("u")));
        assert!(!is_current_codex_turn_diff(&json!({ "threadId": "t", "turnId": "u" }), "t", None));
    }
}
