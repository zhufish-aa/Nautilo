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

pub use agenthub_plugin_sdk::acp_form::form_answer;

pub fn form(params: &Value) -> anyhow::Result<Value> {
    agenthub_plugin_sdk::acp_form::form(params, "Antigravity 提问")
}
