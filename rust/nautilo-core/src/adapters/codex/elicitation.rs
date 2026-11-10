//! Native MCP approvals and plugin installation stay bound to this app-server/account.
use std::sync::Arc;
use serde_json::{json, Map, Value};
use crate::adapters::{AdapterStartRequest, json_rpc_process::JsonRpcProcessClient};

fn text(value: &Value) -> &str { value.as_str().unwrap_or("") }
fn array(value: &Value) -> &[Value] { value.as_array().map(Vec::as_slice).unwrap_or(&[]) }
fn cancel() -> Value { json!({"action":"cancel","content":null}) }

fn link(label: String, value: &Value) -> anyhow::Result<Value> {
    let url = reqwest::Url::parse(text(value))?;
    anyhow::ensure!(url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty() && url.password().is_none(), "插件未提供有效的 HTTPS 授权地址");
    Ok(json!({"label":label,"url":url.as_str()}))
}

async fn confirm(request: &AdapterStartRequest, title: &str, detail: &str, links: &[Value], label: &str) -> anyhow::Result<bool> {
    confirm_presented(request, title, detail, links, label, Value::Null).await
}

async fn confirm_presented(request: &AdapterStartRequest, title: &str, detail: &str, links: &[Value], label: &str, presentation: Value) -> anyhow::Result<bool> {
    let ask = request.request_interaction.as_ref().ok_or_else(|| anyhow::anyhow!("当前会话无法显示原生授权请求"))?;
    let mut input = json!({"kind":"approval","title":title,"detail":detail,"links":links,"options":[
        {"id":"confirm","label":label,"intent":"approve"}, {"id":"decline","label":"暂不","intent":"reject"}
    ]});
    if !presentation.is_null() { input["presentation"] = presentation; }
    let response = ask(input).await?;
    Ok(response["outcome"] == "selected" && response["optionId"] == "confirm")
}

fn install_params(reference: &str) -> anyhow::Result<Value> {
    let (name, marketplace) = reference.rsplit_once('@').filter(|(name, market)| !name.is_empty() && !market.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Codex 未提供完整的插件来源"))?;
    Ok(json!({"pluginName":name,"remoteMarketplaceName":marketplace,"installAttemptId":uuid::Uuid::new_v4().to_string()}))
}

pub(super) async fn handle(rpc: &Arc<JsonRpcProcessClient>, request: &AdapterStartRequest, params: &Value) -> anyhow::Result<Value> {
    let meta = &params["_meta"];
    let name = if !text(&meta["tool_name"]).is_empty() { text(&meta["tool_name"]) } else if !text(&params["serverName"]).is_empty() { text(&params["serverName"]) } else { "MCP" };
    let detail = text(&params["message"]);
    if params["serverName"] == "codex_apps" && meta["codex_approval_kind"] == "tool_suggestion" && meta["suggest_type"] == "install" {
        let presentation = json!({"type":"plugin_install","name":name,"pluginId":meta["tool_id"]});
        if meta["tool_type"] != "connector" && !confirm_presented(request, &format!("安装 {name}"), detail, &[], "安装", presentation.clone()).await? { return Ok(cancel()); }
        let mut expected: Vec<String> = array(&meta["app_connector_ids"]).iter().filter_map(Value::as_str).map(str::to_owned).collect();
        let apps = if meta["tool_type"] == "plugin" {
            let mut install = install_params(text(&meta["tool_id"]))?;
            let marketplace = text(&install["remoteMarketplaceName"]).to_string();
            if !marketplace.ends_with("-remote") {
                let catalog = rpc.request("plugin/list", json!({"cwds":[request.cwd]})).await?;
                if let Some(path) = array(&catalog["marketplaces"]).iter().find(|entry| entry["name"] == marketplace).and_then(|entry| entry["path"].as_str()) {
                    install.as_object_mut().unwrap().remove("remoteMarketplaceName");
                    install["marketplacePath"] = json!(path);
                }
            }
            if install.get("marketplacePath").is_none() {
                let remote_id = if let Some(id) = meta["remote_plugin_id"].as_str().filter(|id| !id.is_empty()) { id.to_string() } else {
                    let detail = rpc.request("plugin/read", json!({"remoteMarketplaceName":marketplace,"pluginName":install["pluginName"]})).await?;
                    detail.pointer("/plugin/summary/remotePluginId").and_then(Value::as_str).unwrap_or("").to_string()
                };
                anyhow::ensure!(!remote_id.is_empty(), "插件目录未返回远端安装标识，请刷新目录后重试");
                install["pluginName"] = json!(remote_id);
            }
            let installed = rpc.request("plugin/install", install).await?;
            array(&installed["appsNeedingAuth"]).to_vec()
        } else if meta["tool_type"] == "connector" {
            expected.push(text(&meta["tool_id"]).to_string());
            vec![json!({"id":meta["tool_id"],"name":name,"installUrl":meta["install_url"]})]
        } else { anyhow::bail!("Codex 返回了未知的插件安装类型"); };
        for app in &apps {
            if let Some(id) = app["id"].as_str().filter(|id| !id.is_empty()) { expected.push(id.to_string()); }
        }
        expected.sort(); expected.dedup();
        let links: Vec<Value> = apps.iter().map(|app| link(format!("连接 {}", app["name"].as_str().unwrap_or(name)), &app["installUrl"])).collect::<anyhow::Result<_>>()?;
        let mut checked = false;
        while !expected.is_empty() {
            let snapshot = rpc.request("app/installed", json!({"threadId":params["threadId"],"forceRefresh":true})).await?;
            if expected.iter().all(|id| array(&snapshot["apps"]).iter().any(|app| app["id"] == *id && app["enabled"] == true && app["callable"] == true)) { break; }
            let mut presentation = presentation.clone();
            presentation["type"] = json!("plugin_authorization");
            if !confirm_presented(request, &format!("连接 {name}"), if checked { "尚未检测到当前账号的连接，请完成授权后重试。" } else { detail }, &links, "检查连接", presentation).await? { return Ok(cancel()); }
            checked = true;
        }
        return Ok(json!({"action":"accept","content":{}}));
    }
    match text(&params["mode"]) {
        "url" => {
            let links = vec![link("打开授权页面".into(), &params["url"])?];
            Ok(if confirm(request, &format!("{name} 授权"), detail, &links, "已完成授权").await? { json!({"action":"accept","content":{}}) } else { cancel() })
        }
        "" | "form" | "openai/form" | "openaiForm" => {
            let schema = &params["requestedSchema"];
            let fields = schema["properties"].as_object().cloned().unwrap_or_default();
            if fields.is_empty() {
                return Ok(if confirm(request, name, detail, &[], "允许").await? { json!({"action":"accept","content":{}}) } else { cancel() });
            }
            let ask = request.request_interaction.as_ref().ok_or_else(|| anyhow::anyhow!("当前会话无法显示原生授权请求"))?;
            let questions: Vec<Value> = fields.iter().map(|(id, field)| {
                let values = if field["type"] == "boolean" { vec![json!("true"),json!("false")] } else { array(&field["enum"]).to_vec() };
                let options: Vec<Value> = values.iter().map(|value| {
                    let label = value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string());
                    json!({"id":label,"label":label})
                }).collect();
                json!({"id":id,"question":field["title"].as_str().or_else(||field["description"].as_str()).unwrap_or(id),"options":options})
            }).collect();
            let response = ask(json!({"kind":"question","title":name,"questions":questions})).await?;
            if response["outcome"] == "cancelled" { return Ok(cancel()); }
            Ok(json!({"action":"accept","content":form_content(schema, &response["answers"])?}))
        }
        mode => anyhow::bail!("当前 Codex 请求需要专用验证：{mode}"),
    }
}

fn form_content(schema: &Value, answers: &Value) -> anyhow::Result<Value> {
    let mut content = Map::new();
    for (id, field) in schema["properties"].as_object().into_iter().flatten() {
        let Some(answer) = answers.get(id).and_then(Value::as_array).and_then(|v|v.first()).and_then(Value::as_str) else {
            anyhow::ensure!(!array(&schema["required"]).iter().any(|value|value == id), "缺少授权信息：{id}");
            continue;
        };
        let value = match text(&field["type"]) {
            "boolean" => { anyhow::ensure!(matches!(answer,"true"|"false"), "无效的布尔值：{id}"); json!(answer == "true") },
            "number" | "integer" => {
                let value: f64 = answer.parse()?;
                anyhow::ensure!(value.is_finite() && (field["type"] != "integer" || value.fract() == 0.0), "无效的数值：{id}");
                if field["type"] == "integer" { serde_json::from_str::<Value>(answer)? } else { json!(value) }
            }
            "" | "string" => json!(answer),
            kind => anyhow::bail!("暂无法填写此授权字段类型：{kind}"),
        };
        content.insert(id.clone(),value);
    }
    Ok(Value::Object(content))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn install_preserves_native_marketplace_and_refuses_incomplete_identity() {
        let params=install_params("github@openai-curated-remote").unwrap();
        assert_eq!(params["pluginName"],"github"); assert_eq!(params["remoteMarketplaceName"],"openai-curated-remote");
        assert!(install_params("github").is_err());
    }
    #[test]
    fn forms_keep_native_types_and_require_actual_answers() {
        let schema=json!({"required":["enabled","count"],"properties":{"enabled":{"type":"boolean"},"count":{"type":"integer"},"name":{"type":"string"}}});
        assert_eq!(form_content(&schema,&json!({"enabled":["true"],"count":["3"],"name":["GitHub"]})).unwrap(),json!({"enabled":true,"count":3,"name":"GitHub"}));
        assert!(form_content(&schema,&json!({"enabled":["yes"],"count":["3"]})).is_err());
        assert!(form_content(&schema,&json!({"enabled":["true"]})).is_err());
    }
    #[test]
    fn auth_links_do_not_allow_shell_or_credential_urls() {
        assert!(link("connect".into(),&json!("https://chatgpt.com/apps/github")).is_ok());
        for value in ["file:///C:/secret", "javascript:alert(1)", "https://user:password@example.com"] { assert!(link("connect".into(),&json!(value)).is_err()); }
    }
}
