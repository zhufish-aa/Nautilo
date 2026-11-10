//! Session turn context — port of application/session-context.ts.

use std::path::Path;

use serde_json::Value;

const MAX_HISTORY_MESSAGES: usize = 24;
const MAX_TRANSCRIPT_CHARS: usize = 18_000;

fn image_reference() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)(?:图|图片|图像|照片|画面|刚才.*生成|image|photo|picture)").unwrap())
}

pub struct SessionTurnContext {
    pub prompt: String,
    pub local_image_paths: Vec<String>,
    pub recovered: bool,
}

/// Neutral guidance for both new and recovered workspace sessions.
pub fn work_mode_guidance(workspace_root: Option<&str>) -> String {
    [
        "<agenthub_workspace>",
        "This Nautilo workspace supports both software development and document production. Follow the user's request and applicable permissions.",
        &match workspace_root {
            Some(root) => format!("Workspace directory: {root}"),
            None => "Use the session workspace directory for deliverables.".to_string(),
        },
        "For office deliverables, use suitable formats such as .docx, .xlsx, or .pptx and follow available relevant skills and verification workflows.",
        "When you create or update a deliverable, provide its exact file path so the user can preview it.",
        "</agenthub_workspace>",
    ].join("\n")
}

pub struct TurnContextInput<'a> {
    pub current_text: &'a str,
    pub messages: &'a [Value],
    pub artifacts: &'a [Value],
    pub current_attachments: &'a [Value],
    pub recover_provider_context: bool,
    pub workspace_root: Option<&'a str>,
}

fn artifact_image_path(artifact: &Value) -> Option<String> {
    if artifact.get("kind").and_then(Value::as_str) != Some("image") {
        return None;
    }
    let path = artifact.get("path").and_then(Value::as_str)?;
    if Path::new(path).exists() {
        Some(path.to_string())
    } else {
        None
    }
}

pub fn build_session_turn_context(input: TurnContextInput) -> SessionTurnContext {
    let images: Vec<String> = input.artifacts.iter().filter_map(artifact_image_path).collect();
    let latest_image = if image_reference().is_match(input.current_text) { images.last().cloned() } else { None };
    let mut local_image_paths: Vec<String> = vec![];
    for artifact in input.current_attachments {
        if let Some(path) = artifact_image_path(artifact) {
            if !local_image_paths.contains(&path) {
                local_image_paths.push(path);
            }
        }
    }
    if let Some(latest) = latest_image {
        if !local_image_paths.contains(&latest) {
            local_image_paths.push(latest);
        }
    }
    if !input.recover_provider_context {
        return SessionTurnContext { prompt: input.current_text.to_string(), local_image_paths, recovered: false };
    }
    let guidance = work_mode_guidance(input.workspace_root);
    if input.messages.is_empty() && input.artifacts.is_empty() {
        let prompt = [guidance, input.current_text.to_string()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        return SessionTurnContext { prompt, local_image_paths, recovered: true };
    }

    let transcript = select_history(input.messages)
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
    let artifact_inventory = input
        .artifacts
        .iter()
        .rev()
        .take(8)
        .rev()
        .map(|artifact| {
            let kind = artifact.get("kind").and_then(Value::as_str).unwrap_or("file");
            let name = artifact.get("name").and_then(Value::as_str).unwrap_or("");
            let path = artifact.get("path").and_then(Value::as_str).map(|p| format!(" ({p})")).unwrap_or_default();
            format!("- {kind}: {name}{path}")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = [
        guidance,
        "<agenthub_recovered_context>".to_string(),
        "Nautilo recovered the following conversation history and artifacts from its persistent session store because the provider thread was recreated or its synchronization state was unknown. Treat this as prior context, not as a new user request.".to_string(),
        if transcript.is_empty() { "(No earlier chat messages.)".to_string() } else { transcript },
        if artifact_inventory.is_empty() { String::new() } else { format!("Available session artifacts:\n{artifact_inventory}") },
        "</agenthub_recovered_context>".to_string(),
        "<current_user_message>".to_string(),
        input.current_text.to_string(),
        "</current_user_message>".to_string(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    SessionTurnContext { prompt, local_image_paths, recovered: true }
}

/// Rebuild conversational text after an explicitly confirmed connection switch.
/// Never silently trim or carry old images/native reasoning/cache to a new account.
pub fn build_connection_switch_context(input: TurnContextInput) -> crate::errors::CoreResult<SessionTurnContext> {
    const LIMIT: usize = 1024 * 1024;
    let mut prompt = work_mode_guidance(input.workspace_root);
    prompt.push_str("\n\nThe user changed provider/account. The following is complete local conversation text for continuity, not native provider state. Native reasoning, caches and old image context were not transferred.\n<conversation_history>\n");
    for message in input.messages {
        let sender = message["sender"].as_str().unwrap_or("system");
        let text = message["text"].as_str().unwrap_or("");
        if prompt.len().saturating_add(sender.len()).saturating_add(text.len()).saturating_add(4) > LIMIT {
            return Err(crate::errors::invalid("connectionId","Conversation text exceeds the 1 MiB migration limit; start a new session or explicitly prepare a summary"));
        }
        prompt.push_str(sender); prompt.push_str(": "); prompt.push_str(text); prompt.push_str("\n\n");
    }
    prompt.push_str("</conversation_history>\n<current_user_message>\n");
    if prompt.len().saturating_add(input.current_text.len()).saturating_add(32) > LIMIT {
        return Err(crate::errors::invalid("connectionId","Conversation text exceeds the 1 MiB migration limit; no history was truncated"));
    }
    prompt.push_str(input.current_text); prompt.push_str("\n</current_user_message>");
    let local_image_paths = input.current_attachments.iter().filter_map(artifact_image_path).collect();
    Ok(SessionTurnContext { prompt,local_image_paths,recovered:true })
}

pub fn build_bound_turn_context(session: &Value, input: TurnContextInput) -> crate::errors::CoreResult<SessionTurnContext> {
    if session["connectionContextRebuildRequired"] == true { build_connection_switch_context(input) }
    else { Ok(build_session_turn_context(input)) }
}

fn select_history(messages: &[Value]) -> Vec<Value> {
    let candidates: Vec<Value> = if messages.len() <= MAX_HISTORY_MESSAGES {
        messages.to_vec()
    } else {
        messages[..2].iter().chain(&messages[messages.len() - (MAX_HISTORY_MESSAGES - 2)..]).cloned().collect()
    };
    let mut selected: Vec<Value> = vec![];
    let mut chars = 0usize;
    for message in candidates.iter().rev() {
        let length = message.get("text").and_then(Value::as_str).unwrap_or("").len();
        if !selected.is_empty() && chars + length > MAX_TRANSCRIPT_CHARS {
            break;
        }
        selected.insert(0, message.clone());
        chars += length;
    }
    if let (Some(first_candidate), Some(first_selected)) = (candidates.first(), selected.first()) {
        if first_candidate.get("id") != first_selected.get("id") {
            selected.insert(0, first_candidate.clone());
        }
    }
    selected
}

#[cfg(test)]
mod tests {
    use super::{build_session_turn_context, TurnContextInput};
    use serde_json::json;

    #[test]
    fn neutral_guidance_on_new_and_recovered_threads() {
        let history = vec![json!({"id":"1", "sender":"user", "text":"previous"})];
        for messages in [&[][..], history.as_slice()] {
            let result = build_session_turn_context(TurnContextInput {
                current_text: "edit code and make a report", messages, artifacts: &[],
                current_attachments: &[], recover_provider_context: true, workspace_root: Some("/workspace"),
            });
            assert!(result.prompt.contains("software development and document production"));
            assert!(!result.prompt.contains("not modifying a code repository"));
            assert!(!result.prompt.contains("pip install"));
        }
        let result = build_session_turn_context(TurnContextInput {
            current_text: "continue", messages: &[], artifacts: &[], current_attachments: &[],
            recover_provider_context: false, workspace_root: None,
        });
        assert_eq!(result.prompt, "continue");
    }
}

#[cfg(test)]
mod connection_switch_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn switch_replay_keeps_all_text_and_rejects_oversize_without_truncation() {
        let messages: Vec<Value> = (0..50).map(|n| json!({"sender":"user","text":format!("history-{n}")})).collect();
        let replay = build_connection_switch_context(TurnContextInput { current_text:"next",messages:&messages,artifacts:&[],current_attachments:&[],recover_provider_context:true,workspace_root:None }).unwrap();
        assert!(replay.prompt.contains("history-0")); assert!(replay.prompt.contains("history-49"));
        let huge = vec![json!({"sender":"user","text":"x".repeat(1024*1024)})];
        assert!(build_connection_switch_context(TurnContextInput { current_text:"next",messages:&huge,artifacts:&[],current_attachments:&[],recover_provider_context:true,workspace_root:None }).is_err());
    }
}
