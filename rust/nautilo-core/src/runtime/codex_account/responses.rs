//! Incremental Responses -> Chat Completions event projection.
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct ResponseRelay {
    pub(super) text: String,
    pub(super) reasoning: String,
    pub(super) calls: Vec<Value>,
    items: HashMap<String, usize>,
    pub(super) usage: Value,
    pub(super) completed: bool,
}
impl ResponseRelay {
    pub(super) fn event(&mut self, event: &Value) -> anyhow::Result<Vec<Value>> {
        let mut deltas = vec![];
        match event["type"].as_str().unwrap_or("") {
            "response.output_text.delta" => {
                let part = event["delta"].as_str().unwrap_or("");
                self.text.push_str(part);
                deltas.push(json!({"content":part}));
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                let part = event["delta"].as_str().unwrap_or("");
                self.reasoning.push_str(part);
                deltas.push(json!({"reasoning_content":part}));
            }
            "response.output_item.added" if event["item"]["type"] == "function_call" => {
                let item = &event["item"];
                let index = self.calls.len();
                self.items
                    .insert(item["id"].as_str().unwrap_or("").into(), index);
                let call = json!({"index":index,"id":item["call_id"],"type":"function","function":{"name":item["name"],"arguments":item["arguments"].as_str().unwrap_or("")}});
                self.calls.push(call.clone());
                deltas.push(json!({"tool_calls":[call]}));
            }
            "response.function_call_arguments.delta" => {
                if let Some(index) = self.items.get(event["item_id"].as_str().unwrap_or("")) {
                    let delta = event["delta"].as_str().unwrap_or("");
                    let old = self.calls[*index]["function"]["arguments"]
                        .as_str()
                        .unwrap_or("");
                    self.calls[*index]["function"]["arguments"] = json!(format!("{old}{delta}"));
                    deltas.push(
                        json!({"tool_calls":[{"index":index,"function":{"arguments":delta}}]}),
                    );
                }
            }
            "response.completed" => {
                self.completed = true;
                let u = &event["response"]["usage"];
                self.usage = json!({"prompt_tokens":u["input_tokens"],"completion_tokens":u["output_tokens"],"total_tokens":u["total_tokens"],"prompt_tokens_details":{"cached_tokens":u["input_tokens_details"]["cached_tokens"]},"completion_tokens_details":{"reasoning_tokens":u["output_tokens_details"]["reasoning_tokens"]}});
            }
            "error" | "response.failed" | "response.incomplete" => {
                anyhow::bail!("Codex account did not complete the model request")
            }
            _ => {}
        }
        Ok(deltas)
    }
}
