use std::collections::HashMap;
use serde_json::{json, Value};

/// Pi's bundled subagent extension publishes completed child messages in
/// partialResult.details.results. These are snapshots, not text deltas.
pub fn child_events(value: &Value, name: &str, seen: &mut HashMap<String, Value>) -> Vec<Value> {
    if !["subagent","task","agent"].contains(&name.to_lowercase().as_str()) { return vec![]; }
    let Some(parent) = value["toolCallId"].as_str() else {return vec![]};
    let result = value.get("partialResult").or_else(||value.get("result")).unwrap_or(&Value::Null);
    let mut events = vec![];
    let mut push = |key:String, mut event:Value| {
        event["subagentDispatchId"] = json!(parent);
        if seen.get(&key) != Some(&event) {seen.insert(key,event.clone());events.push(event);}
    };
    for (child_index,child) in result["details"]["results"].as_array().into_iter().flatten().enumerate() {
        let prefix = format!("{parent}:child:{child_index}");
        for (index,message) in child["messages"].as_array().into_iter().flatten().enumerate() {
            if message["role"] == "toolResult" {
                let id = message["toolCallId"].as_str().unwrap_or("");
                push(format!("{prefix}:result:{index}"),json!({"kind":"tool","callId":format!("{prefix}:{id}"),
                    "name":message["toolName"].as_str().unwrap_or("tool"),"phase":"completed",
                    "output":super::tool_result_text(message),"success":message["isError"] != true}));
            } else if message["role"] == "assistant" {
                for (part_index,part) in message["content"].as_array().into_iter().flatten().enumerate() {
                    let key=format!("{prefix}:message:{index}:{part_index}");
                    match part["type"].as_str() {
                        Some("text" | "thinking") => {
                            let thinking=part["type"] == "thinking";
                            push(key.clone(),json!({"kind":if thinking {"thinking"} else {"message"},"phase":"completed","messageId":key,
                                "text":part[if thinking {"thinking"} else {"text"}]}));
                        }
                        Some("toolCall") => push(key,json!({"kind":"tool","callId":format!("{prefix}:{}",part["id"].as_str().unwrap_or("")),
                            "name":part["name"],"phase":"started","input":part["arguments"]})),
                        _=>{}
                    }
                }
            }
        }
    }
    events
}
