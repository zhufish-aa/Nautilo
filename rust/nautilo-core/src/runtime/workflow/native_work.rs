//! Native child completion is separate from completion of the spawning tool.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWork {
    pub run_id: String,
    pub last_sequence: i64,
    pub children: BTreeMap<String, String>,
    pub closed: bool,
    pub released: bool,
    pub detached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
impl NativeWork {
    pub fn new(run_id: &str) -> Self {
        Self {
            run_id: run_id.into(),
            ..Default::default()
        }
    }
    pub fn pending(&self) -> bool {
        !self.released && !self.detached && self.children.values().any(|status| status == "running")
    }
    pub fn failure(&self) -> Option<String> {
        self.error.clone().or_else(|| {
            self.children
                .iter()
                .find(|(_, status)| status.as_str() == "failed")
                .map(|(id, _)| {
                    format!("Native child {id} failed before the workflow node could complete")
                })
        })
    }
    pub fn observe(&mut self, event: &Value) {
        let sequence = event["sequence"].as_i64().unwrap_or(0);
        if sequence <= self.last_sequence {
            return;
        }
        self.last_sequence = sequence;
        let kind = event["type"].as_str().unwrap_or("");
        if kind == "provider.runtime_closed" {
            self.closed = true;
            if self.pending() {
                self.error =
                    Some("The native runtime closed before its child work completed".into());
            }
            return;
        }
        if kind == "provider.background_error" {
            if self.pending() {
                self.error = Some(
                    event["payload"]["message"]
                        .as_str()
                        .unwrap_or("Native background execution failed")
                        .into(),
                );
            }
            return;
        }
        let payload = &event["payload"];
        let meta = payload.get("subagent").filter(|value| value.is_object());
        let Some(id) = payload["callId"].as_str() else {
            if meta.is_some() {
                self.error = Some(
                    "Native child dispatch did not expose an identity to track its completion"
                        .into(),
                );
            }
            return;
        };
        let key = match payload["subagentDispatchId"].as_str() {
            Some(parent) => format!("{parent}/{id}"),
            None => id.to_owned(),
        };
        if meta.is_none() && !self.children.contains_key(&key) {
            return;
        }
        let status = if kind == "tool.finished" && payload["success"] == false {
            "failed"
        } else if let Some(status) = meta
            .and_then(|value| value["status"].as_str())
            .filter(|status| ["running", "done", "failed"].contains(status))
        {
            status
        } else if kind == "tool.finished" && meta.is_none_or(|value| value["background"] != true) {
            "done"
        } else {
            "running"
        };
        self.children.insert(key, status.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn workflow_native_gate_distinguishes_spawn_receipts_child_completion_and_runtime_loss() {
        let mut work = NativeWork::new("run");
        work.observe(&json!({"sequence":1,"type":"tool.finished","payload":{"callId":"spawn","success":true,"subagent":{"status":"running"}}}));
        assert!(work.pending());
        work.observe(&json!({"sequence":2,"type":"tool.finished","payload":{"callId":"spawn","success":true,"subagent":{"status":"done"}}}));
        assert!(!work.pending());
        // A background Task launch is also an acknowledgement, not its result.
        work.observe(&json!({"sequence":3,"type":"tool.finished","payload":{"callId":"async","success":true,"subagent":{"background":true}}}));
        assert!(work.pending());
        work.observe(&json!({"sequence":4,"type":"tool.finished","payload":{"callId":"async","success":true}}));
        assert!(!work.pending());
        work.observe(&json!({"sequence":5,"type":"tool.started","payload":{"callId":"last","subagent":{"background":true}}}));
        work.observe(&json!({"sequence":6,"type":"provider.runtime_closed","payload":{}}));
        assert!(work.failure().unwrap().contains("closed"));
        work.observe(&json!({"sequence":1,"type":"tool.finished","payload":{"callId":"last","success":true}}));
        assert!(work.pending());
    }
}
