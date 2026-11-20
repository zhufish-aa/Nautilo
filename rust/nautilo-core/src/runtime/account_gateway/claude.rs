//! Port of Magpie renderClaudePromptAt/historyEnd (claude_subscription.go,
//! 4a1ac84421145de4c4078898c6441487ac45bd5e). A new API request carries
//! caller context; native resume is used only for a verified existing run.
use serde_json::{json, Value};

pub(super) fn render(messages: &[Value], choice: &Value) -> Vec<Value> {
    let split = messages
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, message)| {
            (message["role"] == "assistant"
                && message["tool_calls"].as_array().is_none_or(Vec::is_empty))
            .then_some(if index + 1 == messages.len() {
                0
            } else {
                index + 1
            })
        })
        .unwrap_or(0);
    let mut blocks = vec![];
    let mut text = String::new();
    let system = messages
        .iter()
        .filter(|m| matches!(m["role"].as_str(), Some("system" | "developer")))
        .map(|m| content_text(&m["content"]))
        .collect::<Vec<_>>()
        .join("\n\n");
    if !system.is_empty() || !choice.is_null() {
        text.push_str("<external_system_instructions>\n");
        text.push_str(&system);
        match choice.as_str() {
            Some("none") => text.push_str("\nDo not call any tools for this request."),
            Some("required") => {
                text.push_str("\nYou must call one of the caller's tools before answering.")
            }
            _ => {
                if let Some(name) = choice["function"]["name"].as_str() {
                    text.push_str(&format!(
                        "\nCall the caller's {name} tool before answering."
                    ));
                }
            }
        }
        text.push_str("\n</external_system_instructions>\n\n");
    }
    text.push_str("The caller's tools are exposed through nautilo_relay_N. Use the binding whose description names the requested caller tool; the caller executes it and returns its real result.\n\n");
    let mut history = false;
    let mut tool_history = false;
    for (index, message) in messages.iter().enumerate() {
        if index == 0 && split > 0 {
            history = true;
            text.push_str("<conversation_history>\nThe conversation so far, each turn of it answered already. Images and files in it were sent with those earlier messages: none of them is new, and none needs answering again.\n\n");
        }
        if index == split && split > 0 {
            text.push_str("</conversation_history>\n\n<current_turn>\nThe turn to answer now:\n\n");
        }
        if matches!(message["role"].as_str(), Some("system" | "developer")) {
            continue;
        }
        text.push_str(if message["role"] == "assistant" {
            "Assistant: "
        } else {
            "Human: "
        });
        if message["role"] == "tool" {
            tool_history = true;
            text.push_str(&format!(
                "[tool result {}]: ",
                message["tool_call_id"].as_str().unwrap_or("")
            ));
        }
        match &message["content"] {
            Value::String(value) => text.push_str(value),
            Value::Array(parts) => {
                for part in parts {
                    if part["type"] == "image_url" {
                        if !text.is_empty() {
                            blocks.push(json!({"type":"text","text":std::mem::take(&mut text)}));
                        }
                        let url = part["image_url"]["url"]
                            .as_str()
                            .or(part["image_url"].as_str())
                            .unwrap_or("");
                        let source = if let Some((kind, data)) = url
                            .strip_prefix("data:")
                            .and_then(|u| u.split_once(";base64,"))
                        {
                            json!({"type":"base64","media_type":kind,"data":data})
                        } else {
                            json!({"type":"url","url":url})
                        };
                        blocks.push(json!({"type":"image","source":source}));
                    } else if let Some(value) = part["text"].as_str() {
                        text.push_str(value);
                    }
                }
            }
            Value::Null => {}
            other => text.push_str(&other.to_string()),
        }
        for call in message["tool_calls"].as_array().into_iter().flatten() {
            tool_history = true;
            text.push_str(&format!(
                "\n[tool call {} {}]: {}",
                call["id"].as_str().unwrap_or(""),
                call["function"]["name"].as_str().unwrap_or(""),
                call["function"]["arguments"].as_str().unwrap_or("{}")
            ));
        }
        text.push_str("\n\n");
    }
    if tool_history {
        text.push_str("(The \"[tool call …]\" and \"[tool result …]\" lines above record calls made earlier. Writing such a line calls nothing: call a tool only with the tool itself.)\n\n");
    }
    if history {
        text.push_str("</current_turn>");
    }
    if !text.is_empty() {
        blocks.push(json!({"type":"text","text":text}));
    }
    blocks
}
fn content_text(content: &Value) -> String {
    content.as_str().map(str::to_string).unwrap_or_else(|| {
        content
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_tools_and_current_turn_keep_their_roles() {
        let messages = json!([{"role":"system","content":"Caller policy"},{"role":"user","content":"Old question"},{"role":"assistant","content":"Old reply"},{"role":"user","content":"Current request"},{"role":"assistant","tool_calls":[{"id":"call","function":{"name":"Read","arguments":"{}"}}]},{"role":"tool","tool_call_id":"call","content":"REAL_RESULT"}]);
        let text = render(messages.as_array().unwrap(), &Value::Null)
            .iter()
            .map(|b| b["text"].as_str().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("");
        assert!(text.contains("<external_system_instructions>\nCaller policy"));
        assert!(text.contains("<conversation_history>"));
        assert!(text.contains("<current_turn>"));
        assert!(text.contains("[tool call call Read]: {}"));
        assert!(text.contains("[tool result call]: REAL_RESULT"));
    }
}
