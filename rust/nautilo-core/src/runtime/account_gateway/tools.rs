//! Caller-tool names and parked results. Native CLI capabilities remain enabled.
use crate::adapters::AdapterStartRequest;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

pub(super) type PendingTools = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

struct PendingCall {
    id: String,
    pending: PendingTools,
}

impl Drop for PendingCall {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.id);
    }
}

pub(super) fn deliver_results(pending: &PendingTools, messages: &[Value]) -> usize {
    let mut pending = pending.lock().unwrap();
    messages
        .iter()
        .filter(|message| message["role"] == "tool")
        .filter_map(|message| {
            let id = message["tool_call_id"].as_str()?;
            let sender = pending.remove(id)?;
            sender.send(message["content"].clone()).ok()
        })
        .count()
}

pub(super) fn bind_caller_tools(
    request: &mut AdapterStartRequest,
    tools: &[Value],
    pending: PendingTools,
    output: mpsc::UnboundedSender<Value>,
) {
    let mut names = HashMap::new();
    let specs = tools
        .iter()
        .enumerate()
        .map(|(index, tool)| {
            let relay_name = format!("nautilo_relay_{index}");
            let original_name = tool["function"]["name"].as_str().unwrap_or("");
            names.insert(relay_name.clone(), original_name.to_string());
            json!({
                "name": relay_name,
                "description": format!("Caller tool {}: {}", original_name,
                    tool["function"]["description"].as_str().unwrap_or("")),
                "inputSchema": tool["function"]["parameters"].as_object()
                    .cloned().unwrap_or_else(|| serde_json::Map::from_iter([
                        ("type".into(), json!("object"))
                    ]))
            })
        })
        .collect::<Vec<_>>();
    request.runtime_tools = Some(json!(specs));

    request.execute_runtime_tool = Some(Arc::new(move |call| {
        let pending = pending.clone();
        let output = output.clone();
        let name = names.get(call["name"].as_str().unwrap_or("")).cloned();
        Box::pin(async move {
            let name = name.ok_or_else(|| anyhow::anyhow!("Unknown caller tool"))?;
            let id = format!("relay-{}", uuid::Uuid::new_v4());
            let (sender, receiver) = oneshot::channel();
            pending.lock().unwrap().insert(id.clone(), sender);
            let _pending_call = PendingCall {
                id: id.clone(),
                pending,
            };
            let arguments = if let Some(text) = call["arguments"].as_str() {
                text.to_string()
            } else {
                call["arguments"].to_string()
            };
            output
                .send(json!({"tool_calls": [{
                    "index": 0, "id": id, "type": "function",
                    "function": { "name": name, "arguments": arguments }
                }]}))
                .map_err(|_| anyhow::anyhow!("Caller disconnected"))?;
            let result = tokio::time::timeout(Duration::from_secs(300), receiver).await??;
            Ok(json!({
                "success": true,
                "content": result.as_str().map(str::to_string)
                    .unwrap_or_else(|| result.to_string())
            }))
        })
    }));
}
