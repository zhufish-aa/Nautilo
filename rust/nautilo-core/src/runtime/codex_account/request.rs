//! Magpie codexBody/codexInput/CodexToolName ports, pinned at
//! 4a1ac84421145de4c4078898c6441487ac45bd5e. See MAGPIE-LICENSE.txt.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

fn tool_name(name: &str) -> String {
    if !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
    {
        return name.into();
    }
    let prefix = name
        .bytes()
        .take(55)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-') {
                c as char
            } else {
                '_'
            }
        })
        .collect::<String>();
    let hash = format!("{:x}", Sha256::digest(name.as_bytes()));
    format!("{prefix}_{}", &hash[..8])
}
fn fix_name(value: &mut Value, back: &mut HashMap<String, String>) {
    if let Some(name) = value["name"].as_str() {
        let changed = tool_name(name);
        if changed != name {
            back.insert(changed.clone(), name.into());
            value["name"] = json!(changed);
        }
    }
}
fn fix_tools(tools: &mut Value, back: &mut HashMap<String, String>) {
    for tool in tools.as_array_mut().into_iter().flatten() {
        match tool["type"].as_str() {
            Some("function" | "custom") => fix_name(tool, back),
            Some("namespace") => fix_tools(&mut tool["tools"], back),
            _ => {}
        }
    }
}
fn bound(id: &str) -> String {
    if id.len() <= 64 {
        return id.into();
    }
    format!("{:x}", Sha256::digest(id.trim().as_bytes()))
}

pub(super) fn prepare(
    body: &Value,
    identity: &str,
    home: &Path,
) -> (Value, HashMap<String, String>) {
    let mut request = crate::adapters::claude::api_proxy::responses_request(body);
    let mut back = HashMap::new();
    for key in [
        "max_output_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
        "previous_response_id",
        "user",
        "safety_identifier",
        "prompt_cache_options",
    ] {
        request.as_object_mut().unwrap().remove(key);
    }
    request["store"] = json!(false);
    request["stream"] = json!(true);
    request["parallel_tool_calls"] = body
        .get("parallel_tool_calls")
        .cloned()
        .unwrap_or(json!(true));
    request["prompt_cache_key"] = body
        .get("prompt_cache_key")
        .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
        .cloned()
        .unwrap_or(json!(identity));
    let tier = match body["service_tier"].as_str() {
        Some("fast") => Some("priority"),
        Some("priority" | "ultrafast") => body["service_tier"].as_str(),
        _ => None,
    };
    if let Some(tier) = tier {
        request["service_tier"] = json!(tier);
    } else {
        request.as_object_mut().unwrap().remove("service_tier");
    }
    if let Some(choice) = body.get("tool_choice") {
        request["tool_choice"] = if choice["type"] == "function" {
            json!({"type":"function","name":choice["function"]["name"]})
        } else {
            choice.clone()
        };
    }
    if request["text"].is_null() {
        request["text"] = json!({"verbosity":"medium"});
    }
    if request["reasoning"].is_null() {
        request["reasoning"] = json!({});
    }
    if let Some(effort) = request["reasoning"]["effort"].as_str().map(str::to_string) {
        request["reasoning"]["effort"] = json!(if effort == "ultra" { "max" } else { &effort });
    }
    if request["reasoning"]["effort"] != "none" {
        if request["reasoning"]["summary"].is_null() {
            request["reasoning"]["summary"] = json!("auto");
        }
        let mut include = request["include"].as_array().cloned().unwrap_or_default();
        if !include
            .iter()
            .any(|item| item == "reasoning.encrypted_content")
        {
            include.push(json!("reasoning.encrypted_content"));
        }
        request["include"] = json!(include);
    }
    let mut input = request["input"].as_array().cloned().unwrap_or_default();
    let mut calls = HashSet::new();
    for item in &mut input {
        if item["call_id"].is_string() {
            item["call_id"] = json!(bound(item["call_id"].as_str().unwrap()));
        }
        if matches!(
            item["type"].as_str(),
            Some("function_call" | "custom_tool_call" | "local_shell_call")
        ) {
            calls.insert(item["call_id"].as_str().unwrap_or("").to_string());
        }
    }
    input.retain(|item| item["type"] != "item_reference");
    for item in &mut input {
        if matches!(
            item["type"].as_str(),
            Some("function_call" | "custom_tool_call")
        ) {
            fix_name(item, &mut back);
        }
        if matches!(
            item["type"].as_str(),
            Some("additional_tools" | "tool_search_output")
        ) {
            fix_tools(&mut item["tools"], &mut back);
        }
        if let Some(object) = item.as_object_mut() {
            object.remove("id");
            if matches!(
                object.get("type").and_then(Value::as_str),
                None | Some("message" | "reasoning")
            ) {
                object.remove("status");
            }
        }
        if item["role"] == "system" {
            item["role"] = json!("developer");
        }
        if matches!(
            item["type"].as_str(),
            Some("function_call_output" | "custom_tool_call_output" | "local_shell_call_output")
        ) {
            if let Some(id) = item["call_id"]
                .as_str()
                .filter(|id| !id.is_empty() && !calls.contains(*id))
            {
                *item = json!({"type":"message","role":"assistant","content":format!("[Previous tool result; call_id={id}]: {}",item["output"].as_str().map(str::to_string).unwrap_or_else(||item["output"].to_string()))});
            }
        }
    }
    // Use the native model's cached base instructions when available, with the
    // caller's system instructions kept as a developer message, as Magpie does.
    if let Ok(cache) = std::fs::read(home.join("models_cache.json")) {
        if let Ok(cache) = serde_json::from_slice::<Value>(&cache) {
            if let Some(base) = cache["models"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|model| model["slug"] == request["model"])
                .and_then(|model| model["base_instructions"].as_str())
            {
                let own = request["instructions"].as_str().unwrap_or("");
                if !own.trim().is_empty() && own.lines().next() != base.lines().next() {
                    input.insert(0,json!({"type":"message","role":"developer","content":[{"type":"input_text","text":own}]}));
                }
                request["instructions"] = json!(if own.lines().next() == base.lines().next() {
                    own
                } else {
                    base
                });
            }
        }
    }
    request["input"] = json!(input);
    fix_tools(&mut request["tools"], &mut back);
    if matches!(
        request["tool_choice"]["type"].as_str(),
        Some("function" | "custom")
    ) {
        fix_name(&mut request["tool_choice"], &mut back);
    }
    (request, back)
}

pub(super) fn restore_names(value: &mut Value, back: &HashMap<String, String>) {
    match value {
        Value::Array(values) => {
            for value in values {
                restore_names(value, back)
            }
        }
        Value::Object(object) => {
            if let Some(name) = object
                .get("name")
                .and_then(Value::as_str)
                .and_then(|name| back.get(name))
            {
                object.insert("name".into(), json!(name));
            }
            for value in object.values_mut() {
                restore_names(value, back);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_keeps_tool_results_together_and_restores_original_names() {
        let id = "long-call".repeat(10);
        let name = "client tool with spaces";
        let body = json!({"model":"gpt-6.1-sol","service_tier":"fast","messages":[{"role":"system","content":"Caller instructions"},{"role":"assistant","tool_calls":[{"id":id,"function":{"name":name,"arguments":"{}"}}]},{"role":"tool","tool_call_id":id,"content":"REAL_RESULT"}],"tools":[{"type":"function","function":{"name":name,"parameters":{"type":"object"}}}]});
        let (mut request, back) = prepare(&body, "session", Path::new("missing-test-home"));
        let call = request["input"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["type"] == "function_call")
            .unwrap();
        let result = request["input"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["type"] == "function_call_output")
            .unwrap();
        assert_eq!(call["call_id"], result["call_id"]);
        assert_eq!(call["call_id"].as_str().unwrap().len(), 64);
        assert_eq!(request["service_tier"], "priority");
        assert_eq!(request["include"][0], "reasoning.encrypted_content");
        restore_names(&mut request, &back);
        assert_eq!(request["tools"][0]["name"], name);
    }
}
