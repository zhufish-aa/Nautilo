use super::{Definition, WorkflowService};
use crate::database::{workflow_plans, workflows, Repositories};
use crate::errors::{invalid, not_found, now_iso, CoreResult};
use crate::runtime::event_service::SessionEventBuilder;
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use uuid::Uuid;

pub(super) struct ApprovedLaunch {
    pub(super) plan: Value,
    pub(super) nodes: BTreeMap<String, Value>,
    pub(super) role_bindings: Value,
}

struct Slot {
    key: String,
    path: Vec<String>,
    name: String,
    scope: String,
    role: String,
    prompt: Option<String>,
    native_resume: bool,
    max_parallel: usize,
}

impl Slot {
    fn inventory(&self) -> Value {
        json!({
            "key": self.key, "name": self.name, "scope": self.scope, "role": self.role,
            "prompt": self.prompt, "requiresNativeResume": self.native_resume,
            "dynamicRole": self.path.is_empty()
        })
    }
}

fn slot_key(path: &[String]) -> String {
    path.iter().map(|id| id.replace('~', "~0").replace('/', "~1"))
        .collect::<Vec<_>>().join("/")
}

fn validate_session(db: &Connection, session: &Value) -> CoreResult<()> {
    if session["parentSessionId"].is_string() || session["status"] == "archived" {
        return Err(invalid("sessionId", "Use the main conversation to plan a workflow"));
    }
    if let Some(team_id) = session["teamId"].as_str() {
        let team = Repositories::new(db).teams().get(team_id)?
            .ok_or_else(|| not_found("team", team_id))?;
        if team["delegationPolicy"] == "direct_only" {
            return Err(invalid("delegationPolicy", "This team is configured for direct work only"));
        }
    }
    Ok(())
}

pub(crate) fn workflow_reference(db: &Connection, session: &Value, reference: &Value) -> CoreResult<Value> {
    validate_session(db, session)?;
    let id = reference["id"].as_str().filter(|id| !id.is_empty())
        .ok_or_else(|| invalid("workflowRef", "A saved workflow is required"))?;
    let revision = reference["revision"].as_u64().filter(|number| *number > 0)
        .ok_or_else(|| invalid("workflowRef", "Select a specific saved workflow revision"))?;
    let template = workflows::template(db, id, Some(revision))?
        .ok_or_else(|| not_found("workflow", id))?;
    Ok(json!({"id":id, "revision":revision, "name":template["name"]}))
}

pub(super) fn validate_plan_owner(db: &Connection, session: &Value, plan: &Value) -> CoreResult<()> {
    validate_session(db, session)?;
    if session["id"] != plan["sessionId"] || session["projectId"] != plan["projectId"]
        || session["teamId"] != plan["teamId"] {
        return Err(invalid("workflowPlan", "The conversation's team or project changed. Reference the workflow again."));
    }
    Ok(())
}

fn visible_plan(plan: &Value) -> Value {
    let mut visible = plan.clone();
    let fields = visible.as_object_mut().unwrap();
    for key in ["requestId", "inputs", "teamId", "projectId"] {
        fields.remove(key);
    }
    visible
}

fn visible_assignment(binding: &Value) -> Value {
    let mut assignment = json!({
        "agentInstanceId":binding["agentInstanceId"],
        "connectionId":binding["connectionId"], "connectionRevision":binding["connectionRevision"],
    });
    for field in ["model", "reasoningEffort", "serviceTier"] {
        assignment[field] = json!(binding[field].as_str().unwrap_or(""));
    }
    assignment
}

fn insert_assignment(plans: &mut BTreeMap<String, Value>, path: &[String], node_plan: Value) {
    let (id, tail) = path.split_first().expect("Agent slot contains a node");
    if tail.is_empty() {
        plans.insert(id.clone(), node_plan);
        return;
    }
    let call = plans.entry(id.clone()).or_insert_with(|| json!({"children":{}}));
    let mut children = serde_json::from_value(call["children"].take()).expect("child assignments are a map");
    insert_assignment(&mut children, tail, node_plan);
    call["children"] = json!(children);
}

impl WorkflowService {
    fn plan_definition(&self, reference: &Value) -> CoreResult<(Value, Definition, Vec<Slot>)> {
        let saved = self.get_template(reference)?;
        let definition: Definition = serde_json::from_value(saved["definition"].clone())
            .map_err(|error| invalid("definition", &error.to_string()))?;
        definition.validate().map_err(|error| invalid("definition", &error))?;
        let definition = self.expand(definition)?;
        let mut slots = Vec::new();
        self.collect_plan_slots(&definition, &mut Vec::new(), &mut Vec::new(), &mut HashSet::new(), &mut slots)?;
        Ok((saved["definition"].clone(), definition, slots))
    }

    fn collect_plan_slots(
        &self, definition: &Definition, path: &mut Vec<String>, parents: &mut Vec<String>,
        dynamic_roles: &mut HashSet<String>, slots: &mut Vec<Slot>,
    ) -> CoreResult<()> {
        for node in &definition.nodes {
            let name = node.name.clone().unwrap_or_else(|| node.id.clone());
            path.push(node.id.clone());
            if node.kind == "agent" && !node.bypass {
                let role = node.role.clone().expect("validated Agent role");
                slots.push(Slot {
                    key: slot_key(path), path: path.clone(), name: name.clone(),
                    scope: parents.join(" / "), role, prompt: node.prompt.clone(),
                    native_resume: node.session.as_deref() == Some("reuse"),
                    max_parallel: definition.limits.max_parallel,
                });
                for role in node.dynamic_subflow.iter().flat_map(|policy| &policy.roles) {
                    if dynamic_roles.insert(role.clone()) {
                        slots.push(Slot {
                            key: slot_key(&["$role".into(), role.clone()]), path: Vec::new(),
                            name: role.clone(), scope: name.clone(), role: role.clone(), prompt: None,
                            native_resume: false, max_parallel: definition.limits.max_parallel,
                        });
                    }
                }
            }
            if let Some(reference) = node.reference.as_ref().filter(|_| node.kind == "call") {
                let saved = self.get_template(&json!({"id":reference.id, "revision":reference.revision}))?;
                let child = serde_json::from_value(saved["definition"].clone())
                    .map_err(|error| invalid("definition", &error.to_string()))?;
                parents.push(name);
                self.collect_plan_slots(&child, path, parents, dynamic_roles, slots)?;
                parents.pop();
            }
            path.pop();
        }
        Ok(())
    }

    pub(super) fn plan_context(&self, session_id: &str, reference: &Value) -> CoreResult<Value> {
        let (definition, _, slots) = self.plan_definition(reference)?;
        Ok(json!({
            "template": reference,
            "definition": definition,
            "nodes": slots.iter().map(Slot::inventory).collect::<Vec<_>>(),
            "roster": self.agents_for_session(session_id)?
        }))
    }

    pub(super) fn propose_plan(
        &self, session_id: &str, origin: &str, reference: &Value, args: &Value,
    ) -> CoreResult<Value> {
        let parent = {
            let db = self.db.lock().unwrap();
            if let Some(plan) = workflow_plans::get(&db.raw, session_id, origin)? {
                return Ok(visible_plan(&plan));
            }
            let parent = Repositories::new(&db.raw).sessions().get(session_id)?
                .ok_or_else(|| not_found("session", session_id))?;
            validate_session(&db.raw, &parent)?;
            parent
        };
        let (_, definition, slots) = self.plan_definition(reference)?;
        let inputs = definition.prepare_inputs(args["inputs"].clone())
            .map_err(|error| invalid("inputs", &error))?;
        let selected = args["nodes"].as_object().ok_or_else(|| invalid("nodes", "Provide assignments for the listed nodes"))?;
        if selected.len() != slots.len() {
            return Err(invalid("nodes", "Assign every listed node and dynamic role exactly once"));
        }
        let mut nodes = Vec::new();
        for slot in &slots {
            let raw = selected.get(&slot.key).ok_or_else(|| invalid("nodes", &format!("Missing assignment for {}", slot.name)))?;
            // The main Agent selects people. Account/model overrides come from the editable card.
            let choice = if parent["teamId"].is_string() {
                json!({"memberId":raw["memberId"]})
            } else {
                json!({"agentInstanceId":raw["agentInstanceId"]})
            };
            let task = raw["task"].as_str().unwrap_or("").trim();
            if !slot.path.is_empty() && task.is_empty() {
                return Err(invalid("task", &format!("Write a task for {}", slot.name)));
            }
            let binding = self.plan_binding(&parent, slot, &choice, false)?;
            nodes.push(json!({
                "key":slot.key, "name":slot.name, "scope":slot.scope, "role":slot.role,
                "task":task, "memberId":choice["memberId"], "memberName":binding["memberSnapshot"]["displayName"],
                "assignment":visible_assignment(&binding)
            }));
        }
        let plan = json!({
            "id":origin, "requestId":Uuid::new_v4().to_string(), "sessionId":session_id,
            "projectId":parent["projectId"], "teamId":parent["teamId"], "template":reference,
            "summary":args["summary"].as_str().unwrap_or("").trim(), "nodes":nodes,
            "status":"pending", "createdAt":now_iso(), "inputs":inputs
        });
        let event_builder = self.events.session_event_builder();
        let mut db = self.db.lock().unwrap();
        let tx = db.raw.transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(crate::database::connection::db_fail)?;
        if let Some(existing) = workflow_plans::get(&tx, session_id, origin)? {
            return Ok(visible_plan(&existing));
        }
        let latest = Repositories::new(&tx).sessions().get(session_id)?
            .ok_or_else(|| not_found("session", session_id))?;
        validate_plan_owner(&tx, &latest, &plan)?;
        workflow_plans::insert(&tx, &plan)?;
        let event = Self::record_plan_event(&tx, &event_builder, &latest, &plan)?;
        tx.commit().map_err(crate::database::connection::db_fail)?;
        drop(db);
        self.events.publish_committed(&[event]);
        Ok(visible_plan(&plan))
    }

    fn plan_binding(&self, parent: &Value, slot: &Slot, choice: &Value, check_resume: bool) -> CoreResult<Value> {
        let binding = self.resolve_binding(parent, &slot.role, choice, slot.max_parallel, true)
            .map_err(|error| invalid("assignment", &format!("{} · {error}", slot.name)))?;
        if check_resume && slot.native_resume && binding["capabilities"]["nativeResume"] != true {
            return Err(invalid("assignment", &format!("{} requires a Harness that supports native session reuse", slot.name)));
        }
        Ok(binding)
    }

    pub fn decide_plan(&self, input: &Value) -> CoreResult<Value> {
        let session_id = input["sessionId"].as_str().unwrap_or("");
        let id = input["planId"].as_str().unwrap_or("");
        let action = input["action"].as_str().unwrap_or("");
        if !matches!(action, "approve" | "reject") {
            return Err(invalid("action", "Choose approve or reject"));
        }
        let (mut plan, parent) = {
            let db = self.db.lock().unwrap();
            let plan = workflow_plans::get(&db.raw, session_id, id)?.ok_or_else(|| not_found("workflowPlan", id))?;
            if plan["status"] != "pending" {
                return Ok(visible_plan(&plan));
            }
            let parent = Repositories::new(&db.raw).sessions().get(session_id)?
                .ok_or_else(|| not_found("session", session_id))?;
            if action == "approve" {
                validate_plan_owner(&db.raw, &parent, &plan)?;
            }
            (plan, parent)
        };
        if action == "reject" {
            let event_builder = self.events.session_event_builder();
            let mut db = self.db.lock().unwrap();
            let tx = db.raw.transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(crate::database::connection::db_fail)?;
            let latest = workflow_plans::get(&tx, session_id, id)?.ok_or_else(|| not_found("workflowPlan", id))?;
            if latest["status"] != "pending" { return Ok(visible_plan(&latest)); }
            plan["status"] = json!("rejected");
            workflow_plans::decide(&tx, &plan)?;
            Self::update_plan_card(&tx, &event_builder, session_id, &plan)?;
            tx.commit().map_err(crate::database::connection::db_fail)?;
            drop(db);
            self.events.wake_timeline(session_id);
            return Ok(visible_plan(&plan));
        }

        let (_, _, slots) = self.plan_definition(&plan["template"])?;
        let mut nodes = BTreeMap::new();
        let mut role_bindings = Map::new();
        let assignments = input.get("assignments").filter(|v| !v.is_null()).map(|v| {
            v.as_object().ok_or_else(|| invalid("assignments", "Invalid workflow assignments"))
        }).transpose()?;
        if assignments.is_some_and(|items| items.keys().any(|key| !slots.iter().any(|slot| &slot.key == key))) {
            return Err(invalid("assignments", "An assignment refers to a node outside this plan"));
        }
        let saved_nodes = plan["nodes"].as_array_mut().ok_or_else(|| invalid("nodes", "The saved plan is incomplete"))?;
        if slots.len() != saved_nodes.len() {
            return Err(invalid("nodes", "The saved plan does not match the pinned workflow"));
        }
        for (slot, node) in slots.iter().zip(saved_nodes) {
            if node["key"] != slot.key {
                return Err(invalid("nodes", "The saved plan does not match the pinned workflow"));
            }
            let mut choice = node["assignment"].clone();
            if let Some(edited) = assignments.and_then(|items| items.get(&slot.key)) {
                if !edited["agentInstanceId"].is_string() {
                    return Err(invalid("agentInstanceId", "An edited node needs a Harness"));
                }
                choice = edited.clone();
            }
            // Only the editable execution fields can change, never the team identity or permission mode.
            let mut raw = json!({"memberId":node["memberId"]});
            for field in ["agentInstanceId", "connectionId", "connectionRevision", "model", "reasoningEffort", "serviceTier"] {
                if let Some(value) = choice.get(field) {
                    let valid = value.is_null() || if field == "connectionRevision" { value.as_u64().is_some_and(|n| n > 0) } else { value.is_string() };
                    if !valid { return Err(invalid(field, "Invalid value in workflow assignment")); }
                    raw[field] = value.clone();
                }
            }
            if raw["connectionId"].is_null() && choice.get("connectionId").is_some() {
                raw["connectionRevision"] = Value::Null;
            }
            let binding = self.plan_binding(&parent, slot, &raw, true)?;
            node["assignment"] = visible_assignment(&binding);
            if slot.path.is_empty() {
                role_bindings.insert(slot.role.clone(), binding);
            } else {
                insert_assignment(&mut nodes, &slot.path, json!({"binding":binding, "task":node["task"]}));
            }
        }
        let launch = json!({
            "sessionId":session_id, "requestId":plan["requestId"], "ref":plan["template"], "inputs":plan["inputs"]
        });
        self.start_launch(&launch, None, Some(ApprovedLaunch {
            plan, nodes, role_bindings: Value::Object(role_bindings),
        }))?;
        let db = self.db.lock().unwrap();
        let saved = workflow_plans::get(&db.raw, session_id, id)?.ok_or_else(|| not_found("workflowPlan", id))?;
        Ok(visible_plan(&saved))
    }

    pub(super) fn update_plan_card(
        db: &Connection, event_builder: &SessionEventBuilder, session_id: &str, plan: &Value,
    ) -> CoreResult<()> {
        crate::database::timeline::update_workflow_plan(db, session_id, &event_builder.redact(&visible_plan(plan)))
    }

    fn record_plan_event(
        db: &Connection, event_builder: &SessionEventBuilder, session: &Value, plan: &Value,
    ) -> CoreResult<Value> {
        let mut event = event_builder.prepare_for_session(
            session, &json!({"projectRunId":session["projectRunId"]}), "workflow.plan", json!({"plan":visible_plan(plan)}),
        );
        Repositories::new(db).events().append_in_transaction(&mut event)?;
        Ok(event)
    }
}
