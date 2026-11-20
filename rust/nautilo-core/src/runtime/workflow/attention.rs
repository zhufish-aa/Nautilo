use super::WorkflowRun;
use serde_json::{json, Value};

impl WorkflowRun {
    /// Only current user decisions, based on the durable snapshot.
    pub fn attention(&self) -> Vec<Value> {
        let mut result = Vec::new();
        let title = self.definition.name.as_deref().unwrap_or(&self.definition.id);
        let item = |kind: &str, key: &str, instance_id: Option<&str>, detail: Option<&str>| {
            json!({
                "id":format!("{}:{kind}:{key}",self.id),"runId":self.id,"title":title,
                "kind":kind,"instanceId":instance_id,"detail":detail,
            })
        };
        if let Some(id) = self.approval_id.as_deref().filter(|_| self.active()) {
            result.push(item("delegate", id, None, None));
        }
        if let Some(workspace) = &self.workspace {
            match workspace.stage.as_str() {
                "waiting_merge" if self.active() => result.push(item("merge", workspace.approval_id.as_deref().unwrap_or("merge"), None, None)),
                "waiting_approval" if self.active() => result.push(item("verification", workspace.context["approvalIds"][0].as_str().unwrap_or("run"), None, None)),
                "uncertain" => result.push(item("recovery", "run", None, workspace.error.as_deref())),
                _ => {}
            }
        }
        for instance in &self.instances {
            if instance.status == "waiting_retry" {
                result.push(item("retry", &format!("{}:{}",instance.id,instance.attempt), Some(&instance.id), instance.error.as_deref()));
            }
            if let Some(workspace) = &instance.workspace {
                match workspace.stage.as_str() {
                    "waiting_approval" if self.active() => result.push(item("verification", workspace.context["approvalIds"][0].as_str().unwrap_or(&instance.id), Some(&instance.id), self.definition.node(&instance.node_id).name.as_deref())),
                    "uncertain" => result.push(item("recovery", &instance.id, Some(&instance.id), workspace.error.as_deref())),
                    _ => {}
                }
            }
        }
        if self.status == "needs_decision" && result.is_empty() && self.workspace.as_ref().is_none_or(|workspace| workspace.stage != "retained") {
            result.push(item("decision", "main", None, self.error.as_deref()));
        }
        result
    }
}
