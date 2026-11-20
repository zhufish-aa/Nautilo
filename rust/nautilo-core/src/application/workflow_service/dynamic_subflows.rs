use super::*;
use crate::runtime::workflow::{Acceptance, Message};

impl WorkflowService {
    pub(super) fn dynamic_subflow_allowed(&self, scope: &Value) -> bool {
        self.get(scope["runId"].as_str().unwrap_or("")).is_ok_and(|run| {
            run.instances.iter().any(|instance| {
                scope["instanceId"] == instance.id && run.definition.node(&instance.node_id).dynamic_subflow.is_some()
            })
        })
    }

    pub(super) fn owns_dynamic_subflow(&self, scope: &Value, child: &str) -> bool {
        self.get(scope["runId"].as_str().unwrap_or("")).is_ok_and(|run| {
            run.instances.iter().any(|instance| {
                scope["instanceId"] == instance.id && scope["attempt"] == instance.attempt
                    && instance.child_run_id.as_deref() == Some(child)
            })
        })
    }

    pub(super) fn start_dynamic_subflow(&self, scope: &Value, input: &Value) -> CoreResult<Value> {
        let parent_id = scope["runId"].as_str().unwrap_or("");
        let instance_id = scope["instanceId"].as_str().unwrap_or("");
        let parent = self.get(parent_id)?;
        let instance = parent.instances.iter().find(|instance| instance.id == instance_id && scope["attempt"] == instance.attempt)
            .ok_or_else(|| invalid("instanceId", "This subworkflow request is from a stale execution"))?;
        let node = parent.definition.node(&instance.node_id);
        let policy = node.dynamic_subflow.as_ref().ok_or_else(|| invalid("permissions", "This Agent node was not allowed to create subworkflows"))?;
        let request = input["requestId"].as_str().filter(|id| !id.trim().is_empty() && id.len() <= 200)
            .ok_or_else(|| invalid("requestId", "A stable subworkflow request identity is required"))?;
        let request = format!("dynamic:{instance_id}:{}:{request}", instance.attempt);
        let fingerprint = format!("{:x}", Sha256::digest(json!([input["definition"],input["inputs"]]).to_string()));
        if let Some(child_id) = &instance.child_run_id {
            return receipt(self.get(child_id)?, &request, &fingerprint);
        }
        let mut definition: Definition = serde_json::from_value(input["definition"].clone())
            .map_err(|error| invalid("definition", &error.to_string()))?;
        definition.validate().map_err(|error| invalid("definition", &error))?;
        let bindings: serde_json::Map<_, _> = policy.roles.iter().filter_map(|role| {
            parent.bindings.get(role).cloned().map(|binding| (role.clone(), binding))
        }).collect();
        let paths = node.workspace.as_ref().map(|workspace| workspace.allowed_paths.as_slice()).unwrap_or_default();
        for child in &mut definition.nodes {
            if child.kind == "call" && !paths.is_empty() {
                return Err(invalid("workspace", "Use explicit child nodes when this caller restricts writable paths"));
            }
            if child.kind != "agent" { continue; }
            if !paths.is_empty() {
                if child.workspace.as_ref().is_some_and(|workspace| workspace.allowed_paths.iter().any(|path| !paths.contains(path))) {
                    return Err(invalid("workspace", "A subworkflow cannot widen the caller's allowed paths"));
                }
                let workspace = child.workspace.get_or_insert(crate::runtime::workflow::WorkspacePolicy {
                    mode: "isolated".into(), allowed_paths: vec![], verification_templates: None,
                });
                if workspace.allowed_paths.is_empty() { workspace.allowed_paths = paths.to_vec(); }
            }
        }
        let depth = parent.definition.limits.max_depth.checked_sub(1)
            .ok_or_else(|| invalid("maxDepth", "The workflow nesting budget is exhausted"))?;
        definition.limits.max_depth = definition.limits.max_depth.min(depth).min(policy.max_depth);
        definition.limits.max_instances = definition.limits.max_instances.min(policy.max_instances);
        definition.limits.max_parallel = definition.limits.max_parallel.min(parent.definition.limits.max_parallel);
        definition.limits.timeout_ms = definition.limits.timeout_ms.min(
            parent.created_at + parent.definition.limits.timeout_ms + parent.paused_duration_ms - now(),
        );
        let definition = self.expand(definition)?;
        self.check_dynamic_roles(&definition, &bindings)?;
        if let Some(workspace) = &parent.workspace {
            self.workspace_requirements(&definition, &workspace.project)?;
        }
        let mut child = WorkflowRun::start(
            Uuid::new_v4().to_string(), parent.session_id.clone(), parent.project_id.clone(),
            request.clone(), definition, input["inputs"].clone(), Value::Object(bindings), now(),
        ).map_err(|error| invalid("definition", &error))?;
        child.parent_run_id = Some(parent.id.clone());
        child.launch_fingerprint = Some(fingerprint.clone());
        child.workspace = parent.workspace.clone();
        child.messages.clear();
        for instance in child.instances.iter_mut().filter(|instance| child.definition.node(&instance.node_id).kind == "agent") {
            if child.workspace.is_some() {
                instance.acceptance = Some(Acceptance::default());
            }
        }
        let mut db = self.db.lock().unwrap();
        let tx = db.raw.transaction_with_behavior(TransactionBehavior::Immediate).map_err(crate::database::connection::db_fail)?;
        let mut latest = workflows::get(&tx, &parent.id)?.ok_or_else(|| not_found("workflow", &parent.id))?;
        let caller = latest.instances.iter_mut().find(|instance| instance.id == instance_id && scope["attempt"] == instance.attempt)
            .ok_or_else(|| invalid("instanceId", "This node has changed execution attempts"))?;
        if let Some(id) = &caller.child_run_id {
            return receipt(workflows::get(&tx, id)?.ok_or_else(|| not_found("workflow", id))?, &request, &fingerprint);
        }
        if latest.status != "running" || caller.status != "running" || caller.branches.is_some() {
            return Err(invalid("instanceId", "Only the active Agent, before final submission, can start a subworkflow"));
        }
        let budget = workflows::family_budget(&tx, &parent.id)?;
        if child.instances.len() > budget.remaining_instances {
            return Err(invalid("maxInstances", "The shared instance budget is exhausted"));
        }
        caller.child_run_id = Some(child.id.clone());
        latest.event("workflow.child_started", Some(instance_id), "Agent started an authorized subworkflow", json!({"childRunId":child.id}), now());
        workflows::save(&tx, &mut child)?;
        workflows::save(&tx, &mut latest)?;
        tx.commit().map_err(crate::database::connection::db_fail)?;
        self.wake.notify_one();
        receipt(child, &request, &fingerprint)
    }

    fn check_dynamic_roles(&self, definition: &Definition, bindings: &serde_json::Map<String, Value>) -> CoreResult<()> {
        for node in &definition.nodes {
            for role in node.role.iter().chain(node.dynamic_subflow.iter().flat_map(|policy| policy.roles.iter())) {
                if !bindings.contains_key(role) {
                    return Err(invalid("role", &format!("The caller cannot delegate to {role}")));
                }
            }
            if let Some(reference) = &node.reference {
                let template = self.get_template(&json!({"id":reference.id,"revision":reference.revision}))?;
                let child = serde_json::from_value(template["definition"].clone()).map_err(|error| invalid("definition", &error.to_string()))?;
                self.check_dynamic_roles(&child, bindings)?;
            }
        }
        Ok(())
    }

    pub(super) fn reconcile_dynamic_subflow(&self, parent: &WorkflowRun, instance: &Instance) -> CoreResult<()> {
        let child = self.get(instance.child_run_id.as_deref().unwrap_or(""))?;
        if parent.status != "running" || child.active()
            || child.instances.iter().any(|instance| instance.native_work.as_ref().is_some_and(|work| work.pending()))
        {
            return Ok(());
        }
        self.change(&parent.id, |run| {
            let instance = run.instances.iter_mut().find(|item| item.id == instance.id)
                .ok_or("Missing caller for dynamic subworkflow")?;
            if instance.status != "waiting_submission" || instance.dynamic_child_reported {
                return Ok(());
            }
            instance.dynamic_child_reported = true;
            instance.completed_at = None;
            let node = run.definition.node(&instance.node_id);
            let result = json!({"status":child.status,"return":child.result,"error":child.error});
            let scope = json!({"workflowRunId":run.id,"instanceId":instance.id,"attempt":instance.attempt});
            run.messages.push(Message {
                id: format!("{}:dynamic-result:{}", instance.id, instance.attempt),
                session_id: instance.session_id.clone(), instance_id: Some(instance.id.clone()),
                recipient: "child".into(), status: "queued".into(), created_at: now(),
                text: format!("The subworkflow you started has finished. Use this outcome to complete your assigned task.\n{result}\n\n[NAUTILO_WORKFLOW_NODE]\n{scope}\n{}", node.submission_instruction()),
                run_id: None, error: None, approval_id: None, data_only: false,
            });
            Ok(())
        })
    }
}

fn receipt(run: WorkflowRun, request: &str, fingerprint: &str) -> CoreResult<Value> {
    if run.request_id != request || run.launch_fingerprint.as_deref() != Some(fingerprint) {
        return Err(invalid("requestId", "This node has already started a different subworkflow"));
    }
    Ok(json!({"accepted":true,"runId":run.id,"status":run.status}))
}
