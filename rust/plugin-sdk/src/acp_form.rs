//! Convert native ACP form elicitation to Nautilo question cards and back.
use serde_json::{json, Value};

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
pub fn form(params: &Value, fallback_title: &str) -> anyhow::Result<Value> {
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
        json!({"kind":"question","title":params["message"].as_str().unwrap_or(fallback_title),"questions":questions}),
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
