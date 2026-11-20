use super::WorkflowService;
use crate::database::workflows;
use crate::errors::{invalid, CoreResult};
use crate::runtime::workflow::{Definition, Instance, WorkflowRun};
use serde_json::{json, Value};
use std::collections::HashSet;

impl WorkflowService {
    pub(super) fn bind_child_roles(
        &self,
        parent: &Value,
        definition: &Definition,
        raw: &Value,
        resolved: &mut Value,
    ) -> CoreResult<()> {
        for node in definition.nodes.iter().filter(|n| n.kind == "call") {
            let reference = node.reference.as_ref().unwrap();
            let saved =
                self.get_template(&json!({"id":reference.id,"revision":reference.revision}))?;
            let child: Definition = serde_json::from_value(saved["definition"].clone())
                .map_err(|e| invalid("definition", &e.to_string()))?;
            let bindings = self.bindings(parent, &child, raw)?;
            resolved
                .as_object_mut()
                .unwrap()
                .extend(bindings.as_object().unwrap().clone());
            self.bind_child_roles(parent, &child, raw, resolved)?;
        }
        Ok(())
    }
    pub(super) fn launch_child(&self, parent: &WorkflowRun, instance: &Instance) -> CoreResult<()> {
        let node = parent.definition.node(&instance.node_id);
        let reference = node.reference.as_ref().unwrap();
        let saved = self.get_template(&json!({"id":reference.id,"revision":reference.revision}))?;
        let mut definition: Definition = serde_json::from_value(saved["definition"].clone())
            .map_err(|e| invalid("definition", &e.to_string()))?;
        let budget = workflows::family_budget(&self.db.lock().unwrap().raw, &parent.id)?;
        definition.limits.max_depth = definition.limits.max_depth.min(
            parent
                .definition
                .limits
                .max_depth
                .checked_sub(1)
                .ok_or_else(|| invalid("maxDepth", "Subworkflow nesting budget exhausted"))?,
        );
        definition.limits.max_instances = definition.limits.max_instances.min(
            parent
                .definition
                .limits
                .max_instances
                .saturating_sub(parent.instances.len())
                .min(budget.remaining_instances),
        );
        definition.limits.max_parallel = definition
            .limits
            .max_parallel
            .min(parent.definition.limits.max_parallel);
        definition.limits.timeout_ms = definition.limits.timeout_ms.min(
            parent.created_at + parent.definition.limits.timeout_ms + parent.paused_duration_ms
                - super::now(),
        );
        let context = parent.context(node, &instance.incoming, None);
        let inputs =
            Self::child_inputs(&json!(node.input), &context).map_err(|e| invalid("input", &e))?;
        let approved_nodes = parent.approved_nodes.get(&node.id)
            .and_then(|plan| plan.get("children")).cloned()
            .map(serde_json::from_value).transpose()
            .map_err(|error| invalid("workflowPlan", &error.to_string()))?.unwrap_or_default();
        let mut child = WorkflowRun::start_with_plan(
            uuid::Uuid::new_v4().to_string(),
            parent.session_id.clone(),
            parent.project_id.clone(),
            format!("{}:subflow", instance.id),
            definition,
            inputs,
            parent.bindings.clone(),
            super::now(),
            approved_nodes,
        )
        .map_err(|e| invalid("definition", &e))?;
        child.parent_run_id = Some(parent.id.clone());
        child.layout = saved.get("layout").cloned();
        child.workspace=parent.workspace.clone();
        for instance in child.instances.iter_mut().filter(|instance|child.definition.node(&instance.node_id).kind == "agent") {
            if child.workspace.is_some() {instance.acceptance=Some(crate::runtime::workflow::Acceptance::default());}
        }
        child.messages.clear();
        let mut db = self.db.lock().unwrap();
        let tx = db
            .raw
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(crate::database::connection::db_fail)?;
        let mut latest = workflows::get(&tx, &parent.id)?
            .ok_or_else(|| invalid("workflow", "Missing caller"))?;
        let budget = workflows::family_budget(&tx, &parent.id)?;
        if child.instances.len() > budget.remaining_instances {
            return Err(invalid(
                "maxInstances",
                "The shared workflow instance budget was exhausted",
            ));
        }
        let i = latest
            .instances
            .iter_mut()
            .find(|v| v.id == instance.id)
            .ok_or_else(|| invalid("instance", "Missing caller node"))?;
        if latest.status != "running" || i.status != "ready" {
            return Ok(());
        }
        i.status = "running".into();
        i.child_run_id = Some(child.id.clone());
        latest.event(
            "workflow.child_started",
            Some(&instance.id),
            "Subworkflow started",
            json!({"childRunId":child.id}),
            super::now(),
        );
        workflows::save(&tx, &mut child)?;
        workflows::save(&tx, &mut latest)?;
        tx.commit().map_err(crate::database::connection::db_fail)?;
        self.wake.notify_one();
        Ok(())
    }
    pub(super) fn reconcile_child(
        &self,
        parent: &WorkflowRun,
        instance: &Instance,
    ) -> CoreResult<()> {
        if !["running", "starting"].contains(&instance.status.as_str()) {
            return Ok(());
        }
        let child = self.get(instance.child_run_id.as_deref().unwrap())?;
        if child.active() {
            return Ok(());
        }
        if child.status != "completed" {
            return self.change(&parent.id, |r| {
                r.fail(
                    &instance.id,
                    child
                        .error
                        .as_deref()
                        .unwrap_or("Subworkflow ended without a result"),
                    super::now(),
                )
            });
        }
        let returns = child
            .result
            .as_ref()
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("result", "Subworkflow has no return"))?;
        let node = parent.definition.node(&instance.node_id);
        let mut names = Vec::new();
        for value in returns {
            let origin = value["from"]
                .as_str()
                .ok_or_else(|| invalid("result", "Missing return source"))?;
            let branch = value["branch"].as_str().unwrap_or("");
            let name = &child
                .definition
                .node(origin)
                .exits
                .iter()
                .find(|e| e.id == branch)
                .ok_or_else(|| invalid("result", "Unknown child outlet"))?
                .name;
            let exit = node
                .exit_map
                .get(name)
                .ok_or_else(|| invalid("exitMap", "Unmapped child outlet"))?;
            let outer = node
                .exits
                .iter()
                .find(|e| &e.id == exit)
                .unwrap()
                .name
                .clone();
            if !names.contains(&outer) {
                names.push(outer);
            }
        }
        self.change(&parent.id, |r| {
            let i = r
                .instances
                .iter_mut()
                .find(|i| i.id == instance.id)
                .ok_or("Unknown caller")?;
            i.completed_at = Some(super::now());
            r.submit(
                &instance.id,
                instance.attempt,
                &names,
                json!({"returns":returns}),
                super::now(),
            )
            .map(|_| ())
        })
    }
    /// Verify every pinned dependency before any node can run. Runtime call
    /// nodes execute as scoped child workflows, preserving their own inputs.
    pub(super) fn expand(&self, definition: Definition) -> CoreResult<Definition> {
        self.validate_references(
            &definition,
            &mut HashSet::new(),
            0,
            definition.limits.max_depth,
        )?;
        Ok(definition)
    }
    fn validate_references(
        &self,
        definition: &Definition,
        path: &mut HashSet<String>,
        depth: usize,
        max_depth: usize,
    ) -> CoreResult<()> {
        if depth > max_depth {
            return Err(invalid("ref", "Maximum workflow nesting depth exceeded"));
        }
        for node in definition.nodes.iter().filter(|n| n.kind == "call") {
            let reference = node.reference.as_ref().unwrap();
            let key = format!("{}@{}", reference.id, reference.revision);
            if !path.insert(key.clone()) {
                return Err(invalid(
                    "ref",
                    "Recursive template references require an explicit bounded graph",
                ));
            }
            let saved = workflows::template(
                &self.db.lock().unwrap().raw,
                &reference.id,
                Some(reference.revision),
            )?
            .ok_or_else(|| invalid("ref", &format!("Missing pinned workflow {key}")))?;
            let child: Definition = serde_json::from_value(saved["definition"].clone())
                .map_err(|e| invalid("definition", &e.to_string()))?;
            child.validate().map_err(|e| invalid("definition", &e))?;
            for edge in child.edges.iter().filter(|e| e.to == "$return") {
                let name = &child
                    .node(&edge.from[0])
                    .exits
                    .iter()
                    .find(|p| p.id == edge.from[1])
                    .unwrap()
                    .name;
                let mapped = node.exit_map.get(name).ok_or_else(|| {
                    invalid("exitMap", &format!("Map the subworkflow outlet {name}"))
                })?;
                if !node.exits.iter().any(|e| &e.id == mapped) {
                    return Err(invalid(
                        "exitMap",
                        "Mapping refers to an unknown caller outlet",
                    ));
                }
            }
            self.validate_references(&child, path, depth + 1, max_depth)?;
            path.remove(&key);
        }
        Ok(())
    }
    pub(super) fn child_inputs(value: &Value, context: &Value) -> Result<Value, String> {
        match value {
            Value::String(s) if s.starts_with("{{") && s.ends_with("}}") => {
                crate::runtime::workflow::binding_value(context, s[2..s.len() - 2].trim())
                    .ok_or_else(|| format!("Missing child input {s}"))
            }
            Value::String(s) => crate::runtime::workflow::render(s, context).map(Value::String),
            Value::Array(values) => values
                .iter()
                .map(|v| Self::child_inputs(v, context))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array),
            Value::Object(object) => object
                .iter()
                .map(|(k, v)| Self::child_inputs(v, context).map(|v| (k.clone(), v)))
                .collect::<Result<serde_json::Map<_, _>, _>>()
                .map(Value::Object),
            _ => Ok(value.clone()),
        }
    }
}
