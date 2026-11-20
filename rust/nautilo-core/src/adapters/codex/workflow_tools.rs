//! Additive workflow tools for both new and existing native Codex threads.
//!
//! Codex fixes dynamicTools at thread creation; thread/resume has no such
//! parameter. A resident MCP connection can add tools while preserving the
//! original native thread. Its callback is rebound only under the turn lock.
use crate::adapters::runtime_mcp_bridge::{
    start_runtime_mcp_bridge, RuntimeMcpBridge, ToolExecutor,
};
use crate::adapters::AdapterStartRequest;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub(super) fn is_workflow_tool(tool: &Value) -> bool {
    tool["name"]
        .as_str()
        .is_some_and(|name| name.starts_with("agenthub_workflow_"))
}

pub(super) fn specs(request: &AdapterStartRequest) -> Vec<Value> {
    request
        .runtime_tools
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|tool| is_workflow_tool(tool))
        .cloned()
        .collect()
}

pub(super) struct WorkflowTools {
    bridge: RuntimeMcpBridge,
    execute: Arc<Mutex<Option<ToolExecutor>>>,
    name: String,
}

impl WorkflowTools {
    pub fn start(request: &AdapterStartRequest) -> anyhow::Result<Option<Self>> {
        let tools = specs(request);
        if tools.is_empty() {
            return Ok(None);
        }
        let execute: Arc<Mutex<Option<ToolExecutor>>> = Arc::new(Mutex::new(None));
        let callback = execute.clone();
        let bridge = start_runtime_mcp_bridge(
            "codex",
            tools,
            Some(Arc::new(move |call| {
                let execute = callback.lock().unwrap().clone();
                Box::pin(async move {
                    let execute = execute.ok_or_else(|| {
                        anyhow::anyhow!("The workflow tool binding is unavailable")
                    })?;
                    execute(call).await
                })
            })),
            None,
        )?;
        // Unique ownership prevents clobbering a user-defined MCP server.
        let name = format!("nautilo_workflow_{}", uuid::Uuid::new_v4().simple());
        let tools = Self {
            bridge,
            execute,
            name,
        };
        tools.bind(request);
        Ok(Some(tools))
    }

    pub fn bind(&self, request: &AdapterStartRequest) {
        // Session callbacks remain valid for background native activity. They
        // retain this node's scope; submission also checks echoed instance/attempt
        // so a late request cannot advance a later activation on the same session.
        *self.execute.lock().unwrap() = request
            .session_tool
            .clone()
            .or_else(|| request.execute_runtime_tool.clone());
    }

    pub fn server(&self) -> Value {
        json!({"name":self.name,"transport":"http","url":self.bridge.url})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn call(
        client: &reqwest::Client,
        tools: &WorkflowTools,
        method: &str,
        params: Value,
    ) -> Value {
        client
            .post(&tools.bridge.url)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn workflow_codex_mcp_keeps_its_url_and_uses_the_current_session_binding() {
        let callback = |label: &'static str| -> ToolExecutor {
            Arc::new(move |input| {
                Box::pin(async move {
                    assert_eq!(input["name"], "agenthub_workflow_submit");
                    Ok(
                        json!({"success":true,"content":json!({"binding":label,"arguments":input["arguments"]}).to_string()}),
                    )
                })
            })
        };
        let mut request = AdapterStartRequest {
            runtime_tools: Some(json!([
                {"name":"agenthub_workflow_submit","inputSchema":{"type":"object"}},
                {"name":"agenthub_delegate","inputSchema":{"type":"object"}}
            ])),
            execute_runtime_tool: Some(callback("foreground")),
            session_tool: Some(callback("first-node")),
            ..Default::default()
        };
        let tools = WorkflowTools::start(&request).unwrap().unwrap();
        let server = tools.server();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let listing = call(&client, &tools, "tools/list", json!({})).await;
        assert_eq!(listing["result"]["tools"].as_array().unwrap().len(), 1);
        assert_eq!(listing["result"]["tools"][0]["name"], "workflow_submit");
        for expected in ["first-node", "second-node"] {
            let receipt = call(
                &client,
                &tools,
                "tools/call",
                json!({"name":"workflow_submit","arguments":{"attempt":1}}),
            )
            .await;
            assert_eq!(receipt["result"]["isError"], false);
            let content: Value =
                serde_json::from_str(receipt["result"]["content"][0]["text"].as_str().unwrap())
                    .unwrap();
            assert_eq!(content["binding"], expected);
            assert_eq!(content["arguments"]["attempt"], 1);
            request.session_tool = Some(callback("second-node"));
            tools.bind(&request);
            assert_eq!(tools.server(), server);
        }
    }
}
