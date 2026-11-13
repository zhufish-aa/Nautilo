//! ACP updates stay incremental and retain tool IDs and full edit contents.
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Default)]
pub struct Events {
    segment: u64,
    kind: Option<&'static str>,
    text: String,
    prefix: String,
    tools: HashMap<String, Value>,
}

impl Events {
    pub fn new() -> Self {
        Self {
            prefix: uuid::Uuid::new_v4().to_string(),
            ..Default::default()
        }
    }
    pub fn begin_turn(&mut self) {
        self.kind = None;
        self.text.clear();
        self.segment = 0;
        self.prefix = uuid::Uuid::new_v4().to_string();
        self.tools.retain(|_, tool| {
            !matches!(
                tool["status"].as_str(),
                Some("completed" | "failed" | "cancelled")
            )
        });
    }
    fn flush(&mut self) -> Vec<Value> {
        let Some(kind) = self.kind.take() else {
            return vec![];
        };
        let text = std::mem::take(&mut self.text);
        let id = format!("{}-{}", self.prefix, self.segment);
        self.segment += 1;
        if text.is_empty() {
            vec![]
        } else {
            vec![json!({"kind":kind,"phase":"completed","messageId":id,"text":text})]
        }
    }
    pub fn finish(&mut self, cancelled: bool) -> Vec<Value> {
        let mut result = self.flush();
        for (id, tool) in &mut self.tools {
            if cancelled
                && !matches!(
                    tool["status"].as_str(),
                    Some("completed" | "failed" | "cancelled")
                )
            {
                tool["status"] = json!("cancelled");
                result.push(json!({"kind":"tool","callId":id,"name":tool["title"],"phase":"completed","success":false,"raw":tool}));
            }
        }
        result
    }
    pub fn update(&mut self, update: &Value) -> Vec<Value> {
        let ty = update["sessionUpdate"].as_str().unwrap_or("");
        match ty {
            "agent_message_chunk" | "agent_thought_chunk" => {
                let Some(text) = update.pointer("/content/text").and_then(Value::as_str) else {
                    return vec![json!({"kind":"status","phase":"native_content","raw":update})];
                };
                let kind = if ty == "agent_message_chunk" {
                    "message"
                } else {
                    "thinking"
                };
                let mut result = if self.kind.is_some_and(|k| k != kind) {
                    self.flush()
                } else {
                    vec![]
                };
                self.kind = Some(kind);
                self.text.push_str(text);
                result.push(json!({"kind":kind,"phase":"delta","messageId":format!("{}-{}",self.prefix,self.segment),"text":text}));
                result
            }
            "user_message_chunk" => vec![], // Prompt acknowledgements must not duplicate the optimistic user bubble.
            "tool_call" | "tool_call_update" => {
                let Some(id) = update["toolCallId"].as_str() else {
                    return vec![];
                };
                let mut result = self.flush();
                let previous = self.tools.get(id).cloned();
                let mut tool = previous.clone().unwrap_or_else(|| json!({"title":"tool"}));
                for (k, v) in update.as_object().into_iter().flatten() {
                    tool[k] = v.clone();
                }
                if previous.as_ref() == Some(&tool) {
                    return result;
                }
                let status = tool["status"].as_str().unwrap_or("in_progress");
                let done = matches!(status, "completed" | "failed" | "cancelled");
                let mut event = json!({"kind":"tool","callId":id,"name":tool["title"],
                    "phase":if done{"completed"}else if previous.is_some(){"updated"}else{"started"},"raw":tool});
                if let Some(input) = tool.get("rawInput") {
                    event["input"] = input.clone();
                }
                if let Some(output) = tool.get("rawOutput") {
                    event["output"] = output.clone();
                } else if let Some(content) = tool.get("content") {
                    event["output"] = json!(printable(content));
                }
                if done {
                    event["success"] = json!(status == "completed");
                }
                for content in tool["content"].as_array().into_iter().flatten() {
                    if content["type"] == "diff" {
                        event["fileDiff"] = json!({"operation":if content["oldText"].is_null(){"write"}else{"edit"},"path":content["path"],"before":content["oldText"].as_str().unwrap_or(""),"after":content["newText"].as_str().unwrap_or("")});
                    }
                }
                self.tools.insert(id.into(), tool);
                result.push(event);
                result
            }
            "usage_update" => vec![
                json!({"kind":"usage","usageScope":"context","contextUsed":update["used"],"contextWindow":update["size"],"raw":update}),
            ],
            "available_commands_update" => vec![
                json!({"kind":"commands","commands":update["availableCommands"].as_array().into_iter().flatten().map(|c|{
                json!({"name":c["name"],"description":c["description"],"inputHint":c.pointer("/input/hint")})
            }).collect::<Vec<_>>()}),
            ],
            "plan" => vec![json!({"kind":"status","phase":"plan_updated","raw":update})],
            "config_option_update" | "current_mode_update" | "session_info_update" => {
                vec![json!({"kind":"status","phase":ty,"raw":update})]
            }
            _ => vec![json!({"kind":"status","phase":"native_update","raw":update})],
        }
    }
}

pub fn printable(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        return s.into();
    }
    if let Some(s) = v.get("text").and_then(Value::as_str) {
        return s.into();
    }
    if let Some(a) = v.as_array() {
        return a
            .iter()
            .map(printable)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
    }
    if let Some(c) = v.get("content") {
        return printable(c);
    }
    if v.is_null() {
        String::new()
    } else {
        v.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streaming_and_tool_boundaries_keep_final_answer() {
        let mut e = Events::new();
        let a=e.update(&json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Thinking"}}));
        let b=e.update(&json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}));
        assert_eq!(a[0]["phase"], "delta");
        assert_eq!(b[0]["kind"], "thinking");
        let id = b[1]["messageId"].clone();
        let done = e.finish(false);
        assert_eq!(done[0]["messageId"], id);
        assert_eq!(done[0]["text"], "Hello");
    }
    #[test]
    fn concurrent_tools_merge_partial_updates_and_keep_file_diff() {
        let mut e = Events::new();
        e.update(&json!({"sessionUpdate":"tool_call","toolCallId":"a","title":"write_file","rawInput":{"path":"a.ts"},"status":"in_progress"}));
        e.update(&json!({"sessionUpdate":"tool_call","toolCallId":"b","title":"read_file","status":"in_progress"}));
        let done=e.update(&json!({"sessionUpdate":"tool_call_update","toolCallId":"a","status":"completed","content":[{"type":"diff","path":"a.ts","oldText":"old","newText":"new"}]}));
        assert_eq!(done[0]["name"], "write_file");
        assert_eq!(done[0]["input"]["path"], "a.ts");
        assert_eq!(done[0]["fileDiff"]["after"], "new");
        assert_eq!(e.finish(true)[0]["callId"], "b");
    }
}
