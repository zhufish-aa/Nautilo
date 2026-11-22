use super::native_api;
use agenthub_plugin_sdk::jsonrpc::JsonRpcClient;
use serde_json::{json, Value};
use std::collections::HashSet;

pub async fn read(instance: &Value, context: &Value) -> anyhow::Result<Value> {
    let Some(rpc) = native_api::open(instance, context).await? else {
        anyhow::bail!("models_unavailable");
    };
    let response = read_pages(&rpc).await;
    native_api::close(rpc).await;
    let entries = response.map_err(|error| {
        if native_api::needs_login(&error) {
            anyhow::anyhow!("请先登录 TRAE 企业版 CLI，再读取可用模型")
        } else {
            anyhow::anyhow!("TRAE 企业版 CLI 未能返回模型列表")
        }
    })?;
    Ok(catalog(&entries))
}

async fn read_pages(rpc: &JsonRpcClient) -> anyhow::Result<Vec<Value>> {
    let mut entries = Vec::new();
    let mut visited = HashSet::new();
    let mut cursor = None::<String>;
    loop {
        let page = rpc.request("model/list", json!({"limit": 100, "includeHidden": false, "cursor": cursor})).await?;
        let data = page["data"].as_array().ok_or_else(|| anyhow::anyhow!("Invalid model page"))?;
        entries.extend(data.iter().cloned());
        let Some(next) = page["nextCursor"].as_str().filter(|next| !next.is_empty()) else {
            return Ok(entries);
        };
        anyhow::ensure!(visited.insert(next.to_owned()) && visited.len() < 20, "Invalid model pagination");
        cursor = Some(next.to_owned());
    }
}

fn catalog(entries: &[Value]) -> Value {
    let mut seen = HashSet::new();
    let models: Vec<_> = entries.iter().filter_map(|entry| {
        let id = entry["id"].as_str().filter(|id| !id.trim().is_empty())?;
        if entry["hidden"] == true || !seen.insert(id) { return None; }
        let display_name = entry["displayName"].as_str().filter(|name| !name.is_empty()).unwrap_or(id);
        let mut efforts = Vec::new();
        for effort in entry["supportedReasoningEfforts"].as_array().into_iter().flatten()
            .filter_map(|option| option["reasoningEffort"].as_str()).filter(|effort| !effort.is_empty()) {
            if !efforts.contains(&effort) { efforts.push(effort); }
        }
        let mut model = json!({
            "id": id, "displayName": display_name, "isDefault": entry["isDefault"] == true,
            "capabilities": if efforts.is_empty() { vec![] } else { vec!["reasoning"] },
            "reasoningEfforts": efforts, "serviceTiers": []
        });
        if let Some(effort) = entry["defaultReasoningEffort"].as_str().filter(|effort| efforts.contains(effort)) {
            model["defaultReasoningEffort"] = json!(effort);
        }
        if let Some(context) = entry["contextWindow"].as_u64().filter(|size| *size > 0) {
            model["contextWindow"] = json!(context);
        }
        if let Some(modalities) = entry["inputModalities"].as_array() {
            let supported: Vec<_> = modalities.iter().filter_map(Value::as_str)
                .filter(|value| matches!(*value, "text" | "image")).collect();
            if !supported.is_empty() { model["inputModalities"] = json!(supported); }
        }
        Some(model)
    }).collect();
    let default = models.iter().find(|item| item["isDefault"] == true).map(|item| item["id"].clone());
    let mut result = json!({
        "providerId": "trae",
        "models": models,
        "source": if models.is_empty() { "unavailable" } else { "provider_cli" },
        "fetchedAt": chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now()).to_rfc3339(),
    });
    if let Some(default) = default { result["defaultModel"] = default; }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_keeps_native_model_ids_and_model_specific_efforts() {
        let entries = json!([
            {"id":"enterprise/a","model":"upstream/a","displayName":"Model A","isDefault":true,"contextWindow":256000,
             "supportedReasoningEfforts":[{"reasoningEffort":"medium"},{"reasoningEffort":"high"}],
             "defaultReasoningEffort":"medium","inputModalities":["text","image"]},
            {"id":"enterprise/b","model":"upstream/b","displayName":"Model B","supportedReasoningEfforts":[]},
            {"id":"enterprise/hidden","hidden":true}
        ]);
        let result = catalog(entries.as_array().unwrap());
        let models = result["models"].as_array().unwrap();
        assert_eq!(result["defaultModel"], "enterprise/a");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["reasoningEfforts"], json!(["medium", "high"]));
        assert_eq!(models[0]["defaultReasoningEffort"], "medium");
        assert_eq!(models[0]["inputModalities"], json!(["text", "image"]));
        assert_eq!(models[1]["reasoningEfforts"], json!([]));
    }
}
