//! Cross-turn continuity — port of runtime/orchestration/conversation-continuity.ts.

use serde_json::Value;

const MAX_MESSAGES: usize = 18;
const MAX_TRANSCRIPT_CHARS: usize = 12_000;
const MAX_ARTIFACTS: usize = 12;

fn references_prior_artifact() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(?:这|那|刚才|刚刚|上次|上一张|前面|之前).{0,8}(?:图|图片|图像|文件|结果)|(?:this|that|previous|last|earlier).{0,12}(?:image|picture|photo|file|result)",
        )
        .unwrap()
    })
}

pub struct ConversationContinuity {
    pub prompt: Option<String>,
    pub local_image_paths: Vec<String>,
}

pub struct ContinuityInput<'a> {
    pub current_project_run_id: &'a str,
    pub current_text: &'a str,
    pub messages: &'a [Value],
    pub artifacts: &'a [Value],
    pub recover_provider_context: bool,
}

/// Builds a bounded, persistent handoff between separate orchestration turns.
pub struct ConversationContinuityBuilder;

impl ConversationContinuityBuilder {
    pub fn build(input: ContinuityInput) -> ConversationContinuity {
        let history: Vec<Value> = if input.recover_provider_context {
            {
                let filtered: Vec<&Value> = input
                    .messages
                    .iter()
                    .filter(|message| {
                        message.get("projectRunId").and_then(Value::as_str) != Some(input.current_project_run_id)
                    })
                    .filter(|message| {
                        let kind = message.get("kind").and_then(Value::as_str);
                        kind.is_none() || kind == Some("chat")
                    })
                    .collect();
                filtered.iter().rev().take(MAX_MESSAGES).rev().map(|v| (*v).clone()).collect::<Vec<Value>>()
            }
        } else {
            vec![]
        };
        let selected = bounded_messages(&history);
        let references_prior = references_prior_artifact().is_match(input.current_text);
        let current_attachments: Vec<Value> = input
            .artifacts
            .iter()
            .filter(|artifact| {
                artifact.get("projectRunId").and_then(Value::as_str) == Some(input.current_project_run_id)
                    && artifact.get("metadata").and_then(|m| m.get("source")).and_then(Value::as_str) == Some("user_attachment")
            })
            .cloned()
            .collect();
        let contextual: Vec<Value> = if input.recover_provider_context || references_prior {
            input.artifacts.iter().rev().take(MAX_ARTIFACTS).rev().cloned().collect()
        } else {
            vec![]
        };
        let mut by_id = std::collections::HashMap::new();
        for artifact in contextual.into_iter().chain(current_attachments.iter().cloned()) {
            if let Some(id) = artifact.get("id").and_then(Value::as_str) {
                by_id.insert(id.to_string(), artifact);
            }
        }
        let artifacts: Vec<Value> = by_id.into_values().collect();
        let current_ids: std::collections::HashSet<&str> =
            current_attachments.iter().filter_map(|a| a.get("id").and_then(Value::as_str)).collect();
        let local_image_paths: Vec<String> = artifacts
            .iter()
            .filter(|artifact| artifact.get("kind").and_then(Value::as_str) == Some("image"))
            .filter_map(|artifact| artifact.get("path").and_then(Value::as_str).map(str::to_string))
            .filter(|path| std::path::Path::new(path).exists())
            .filter(|_| references_prior || !current_ids.is_empty())
            .filter(|path| {
                // Only current attachments or explicitly referenced images.
                references_prior
                    || current_attachments.iter().any(|a| a.get("path").and_then(Value::as_str) == Some(path.as_str()))
            })
            .collect();

        if selected.is_empty() && artifacts.is_empty() {
            return ConversationContinuity { prompt: None, local_image_paths };
        }

        let transcript = selected
            .iter()
            .map(|message| {
                let sender = match message.get("sender").and_then(Value::as_str) {
                    Some("user") => "User",
                    Some("agent") => "Assistant",
                    _ => "System",
                };
                format!("{}: {}", sender, message.get("text").and_then(Value::as_str).unwrap_or(""))
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let inventory = artifacts
            .iter()
            .map(|artifact| {
                let kind = artifact.get("kind").and_then(Value::as_str).unwrap_or("file");
                let name = artifact.get("name").and_then(Value::as_str).unwrap_or("");
                let path = artifact.get("path").and_then(Value::as_str).map(|p| format!(" ({p})")).unwrap_or_default();
                format!("- {kind}: {name}{path}")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let prompt = [
            "<agenthub_conversation_continuity>".to_string(),
            if input.recover_provider_context {
                "The provider session could not be trusted as synchronized, so Nautilo recovered bounded chat history. Treat it as prior context, not a new request.".to_string()
            } else {
                "These are cross-Agent artifacts that are not guaranteed to exist in the main provider session. Use them only to resolve the current follow-up reference.".to_string()
            },
            transcript,
            if inventory.is_empty() {
                String::new()
            } else {
                format!("Recent artifacts produced by this chat and its delegated child sessions:\n{inventory}")
            },
            "</agenthub_conversation_continuity>".to_string(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
        ConversationContinuity { prompt: Some(prompt), local_image_paths }
    }
}

fn bounded_messages(messages: &[Value]) -> Vec<Value> {
    let mut selected: Vec<Value> = vec![];
    let mut chars = 0usize;
    for message in messages.iter().rev() {
        let length = message.get("text").and_then(Value::as_str).unwrap_or("").len();
        if !selected.is_empty() && chars + length > MAX_TRANSCRIPT_CHARS {
            break;
        }
        selected.insert(0, message.clone());
        chars += length;
    }
    selected
}
