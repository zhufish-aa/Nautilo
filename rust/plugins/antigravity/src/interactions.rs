//! Native ACP permission and form replies must reach the agent unchanged in meaning.
use agenthub_plugin_sdk::{jsonrpc::JsonRpcClient, DaemonChannel};
use serde_json::{json, Value};
use std::sync::Arc;

pub async fn respond(
    rpc: &JsonRpcClient,
    id: &Value,
    method: &str,
    params: &Value,
    channel: Option<Arc<dyn DaemonChannel>>,
) {
    let Some(channel) = channel else {
        rpc.respond_error(id, -32601, "No Nautilo interaction channel is available");
        return;
    };
    if method == "session/request_permission" {
        let options = params["options"].as_array().cloned().unwrap_or_default();
        let reply=channel.ask("",json!({"kind":"approval","title":params["toolCall"]["title"].as_str().unwrap_or("Antigravity 权限请求"),
            "detail":super::events::printable(&params["toolCall"]["rawInput"]),"options":options.iter().map(|o|json!({"id":o["optionId"],"label":o["name"],"intent":if o["kind"].as_str().unwrap_or("").starts_with("reject"){"reject"}else{"approve"}})).collect::<Vec<_>>()})).await;
        let selected = reply["optionId"]
            .as_str()
            .filter(|selected| options.iter().any(|o| o["optionId"] == *selected));
        rpc.respond(
            id,
            if reply["outcome"] == "selected" && selected.is_some() {
                json!({"outcome":{"outcome":"selected","optionId":selected.unwrap()}})
            } else {
                json!({"outcome":{"outcome":"cancelled"}})
            },
        );
    } else if method == "elicitation/create" && params["mode"].as_str().unwrap_or("form") == "form"
    {
        match form(params) {
            Ok(input) => {
                let reply = channel.ask("", input).await;
                match form_answer(params, &reply) {
                    Ok(answer) => rpc.respond(id, answer),
                    Err(error) => rpc.respond_error(id, -32602, &error.to_string()),
                }
            }
            Err(error) => rpc.respond_error(id, -32602, &error.to_string()),
        }
    } else {
        rpc.respond_error(id, -32601, &format!("Unsupported native request: {method}"));
    }
}

fn enum_values(field: &Value) -> Vec<Value> {
    if field["type"] == "array" {
        return enum_values(&field["items"]);
    }
    if let Some(a) = field["oneOf"].as_array() {
        return a.clone();
    }
    if let Some(a) = field["anyOf"].as_array() {
        return a.clone();
    }
    field["enum"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| json!({"const":v,"title":v}))
        .collect()
}
pub fn form(params: &Value) -> anyhow::Result<Value> {
    let props = params["requestedSchema"]["properties"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Invalid ACP elicitation schema"))?;
    let mut questions = vec![];
    for (name, field) in props {
        let mut q = json!({"id":name,"question":field["title"].as_str().unwrap_or(name),"isOther":false,"allowEmpty":!params["requestedSchema"]["required"].as_array().is_some_and(|a|a.contains(&json!(name)))});
        let choices = enum_values(field);
        if field["type"] == "array" {
            anyhow::ensure!(
                !choices.is_empty(),
                "A multi-select form needs native choices"
            );
            q["multiSelect"] = json!(true);
        }
        if !choices.is_empty() {
            q["options"]=json!(choices.iter().enumerate().map(|(i,c)|json!({"id":i.to_string(),"label":c["title"].as_str().or_else(||c["const"].as_str()).unwrap_or(""),"description":c["description"]})).collect::<Vec<_>>());
        } else if field["type"] == "boolean" {
            q["options"] = json!([{"id":"true","label":"是"},{"id":"false","label":"否"}]);
        } else {
            anyhow::ensure!(
                matches!(
                    field["type"].as_str(),
                    Some("string" | "integer" | "number")
                ),
                "Unsupported ACP form field type"
            );
            q["inputType"] = json!("text");
            q["initialValue"] = json!(field["default"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_default());
        }
        questions.push(q);
    }
    Ok(
        json!({"kind":"question","title":params["message"].as_str().unwrap_or("Antigravity 提问"),"questions":questions}),
    )
}
pub fn form_answer(params: &Value, reply: &Value) -> anyhow::Result<Value> {
    if reply["outcome"] != "selected" {
        return Ok(json!({"action":"cancel"}));
    }
    let mut content = serde_json::Map::new();
    for (name, field) in params["requestedSchema"]["properties"]
        .as_object()
        .into_iter()
        .flatten()
    {
        let Some(answers) = reply["answers"][name].as_array() else {
            continue;
        };
        let text = match answers.first().and_then(Value::as_str) {
            Some(text) => text,
            None if field["type"] == "array" => "",
            None => continue,
        };
        let choices = enum_values(field);
        let value = if !choices.is_empty() {
            let values = answers
                .iter()
                .map(|text| {
                    choices
                        .iter()
                        .find(|v| v["title"] == *text || v["const"] == *text)
                        .and_then(|v| v.get("const"))
                        .cloned()
                        .ok_or_else(|| anyhow::anyhow!("Invalid form selection"))
                })
                .collect::<anyhow::Result<Vec<_>>>()?;
            if field["type"] == "array" {
                anyhow::ensure!(
                    field["minItems"]
                        .as_u64()
                        .is_none_or(|n| values.len() >= n as usize)
                        && field["maxItems"]
                            .as_u64()
                            .is_none_or(|n| values.len() <= n as usize),
                    "Invalid number of form selections"
                );
                json!(values)
            } else {
                values[0].clone()
            }
        } else {
            match field["type"].as_str().unwrap_or("string") {
                "boolean" => match text {
                    "true" | "是" => json!(true),
                    "false" | "否" => json!(false),
                    _ => anyhow::bail!("Invalid boolean input"),
                },
                "number" | "integer" => {
                    let value: Value = serde_json::from_str(text)?;
                    anyhow::ensure!(
                        value.is_number()
                            && (field["type"] != "integer" || value.is_i64() || value.is_u64()),
                        "Invalid numeric input"
                    );
                    value
                }
                _ => json!(text),
            }
        };
        content.insert(name.clone(), value);
    }
    for required in params["requestedSchema"]["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        anyhow::ensure!(
            content.contains_key(required),
            "Required form field was not answered: {required}"
        );
    }
    Ok(json!({"action":"accept","content":content}))
}
