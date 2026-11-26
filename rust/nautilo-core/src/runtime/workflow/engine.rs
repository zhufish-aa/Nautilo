use super::{binding_value, check_fields, read_path, render, Definition, Node};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[path = "source_joins.rs"]
mod source_joins;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub node_id: String,
    pub status: String,
    pub attempt: u32,
    pub iteration: u32,
    pub incoming: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_run_id: Option<String>,
    #[serde(default)]
    pub dynamic_child_reported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_text: Option<String>,
    #[serde(default)]
    pub prompt_prepared: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_work: Option<super::NativeWork>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance: Option<super::Acceptance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<super::NodeWorkspace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branches: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submission_error: Option<String>,
    pub reminders: u32,
    pub completed_at: Option<i64>,
    pub next_reminder_at: Option<i64>,
    pub deadline_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub frames: Vec<Frame>,
    pub traversals: BTreeMap<usize, u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Frame {
    pub batch: String,
    pub branch: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: String,
    pub node_id: String,
    pub expected: BTreeSet<String>,
    pub arrivals: BTreeMap<String, Value>,
    pub closed: BTreeSet<String>,
    pub joined: bool,
    #[serde(default)]
    pub arrival_traversals: BTreeMap<String, BTreeMap<usize, u32>>,
    pub frames: Vec<Frame>,
    pub traversals: BTreeMap<usize, u32>,
    #[serde(default)]
    pub joins: BTreeMap<String, SourceJoin>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceJoin {
    pub arrivals: BTreeMap<String, Value>,
    pub traversals: BTreeMap<usize, u32>,
    pub joined: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub sequence: usize,
    pub timestamp: i64,
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    pub message: String,
    pub data: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub session_id: Option<String>,
    pub instance_id: Option<String>,
    pub recipient: String,
    pub status: String,
    pub text: String,
    pub created_at: i64,
    pub run_id: Option<String>,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub data_only: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: String,
    pub revision: u64,
    pub session_id: String,
    pub project_id: String,
    pub request_id: String,
    pub definition: Definition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_fingerprint: Option<String>,
    pub inputs: Value,
    pub bindings: Value,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub approved_nodes: BTreeMap<String, Value>,
    pub status: String,
    pub instances: Vec<Instance>,
    pub batches: Vec<Batch>,
    pub events: Vec<Event>,
    pub messages: Vec<Message>,
    pub created_at: i64,
    pub updated_at: i64,
    pub result: Option<Value>,
    pub error: Option<String>,
    #[serde(default)]
    pub paused_at: Option<i64>,
    #[serde(default)]
    pub parent_run_id: Option<String>,
    #[serde(default)]
    pub approval_id: Option<String>,
    #[serde(default)]
    pub paused_duration_ms: i64,
    #[serde(default)]
    pub paused_by_parent: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_projection: Option<super::TaskProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<super::Workspace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance: Option<super::Acceptance>,
}
impl WorkflowRun {
    pub fn start(
        id: String,
        session_id: String,
        project_id: String,
        request_id: String,
        definition: Definition,
        inputs: Value,
        bindings: Value,
        now: i64,
    ) -> Result<Self, String> {
        Self::start_with_plan(id, session_id, project_id, request_id, definition, inputs, bindings, now, BTreeMap::new())
    }
    pub(crate) fn start_with_plan(
        id: String,
        session_id: String,
        project_id: String,
        request_id: String,
        definition: Definition,
        inputs: Value,
        bindings: Value,
        now: i64,
        approved_nodes: BTreeMap<String, Value>,
    ) -> Result<Self, String> {
        definition.validate()?;
        let inputs = definition.prepare_inputs(inputs)?;
        let mut run = Self {
            id,
            revision: 0,
            session_id,
            project_id,
            request_id,
            definition,
            layout: None,
            launch_fingerprint: None,
            inputs,
            bindings,
            approved_nodes,
            status: "running".into(),
            instances: vec![],
            batches: vec![],
            events: vec![],
            messages: vec![],
            created_at: now,
            updated_at: now,
            result: None,
            error: None,
            paused_at: None,
            parent_run_id: None,
            approval_id: None,
            paused_duration_ms: 0,
            paused_by_parent: false,
            task_projection: None,
            workspace: None,
            acceptance: None,
        };
        run.event(
            "workflow.started",
            None,
            "Workflow started",
            Value::Null,
            now,
        );
        let entry = run.definition.entry.clone();
        run.activate(&entry, Value::Null, None, vec![], BTreeMap::new(), now)?;
        run.settle(now)?;
        Ok(run)
    }
    pub(crate) fn binding_for(&self, node: &Node) -> &Value {
        self.approved_nodes.get(&node.id).and_then(|plan| plan.get("binding"))
            .unwrap_or(&self.bindings[node.role.as_deref().unwrap_or("")])
    }
    pub fn event(&mut self, kind: &str, id: Option<&str>, message: &str, data: Value, now: i64) {
        let node_id = id
            .and_then(|id| self.instances.iter().find(|v| v.id == id))
            .map(|v| v.node_id.clone());
        self.events.push(Event {
            sequence: self.events.len() + 1,
            timestamp: now,
            r#type: kind.into(),
            instance_id: id.map(str::to_owned),
            node_id,
            message: message.into(),
            data,
        });
        self.updated_at = now;
    }
    fn index(&self, id: &str) -> Result<usize, String> {
        self.instances
            .iter()
            .position(|v| v.id == id)
            .ok_or_else(|| "Unknown workflow instance".into())
    }
    pub fn active(&self) -> bool {
        ["running", "paused", "finalizing"].contains(&self.status.as_str())
    }
    pub fn context(&self, node: &Node, incoming: &Value, item: Option<&Value>) -> Value {
        let exits: serde_json::Map<String, Value> = node
            .exits
            .iter()
            .map(|e| (e.id.clone(), json!(e.name)))
            .collect();
        // Explicit evidence references survive a feedback loop without copying
        // the whole ancestry into incoming.previous forever. This context is
        // rendered once when the new instance is activated and then frozen.
        let mut steps = serde_json::Map::<String, Value>::new();
        for instance in self
            .instances
            .iter()
            .filter(|i| i.status == "completed" && i.result.is_some())
        {
            let value = json!({"instanceId":instance.id,"iteration":instance.iteration,"item":instance.item,"branches":instance.branches,"result":instance.result});
            let entry = steps
                .entry(instance.node_id.clone())
                .or_insert_with(|| json!({"instances":[],"latest":null}));
            entry["instances"]
                .as_array_mut()
                .unwrap()
                .push(value.clone());
            entry["latest"] = value;
        }
        json!({"input":self.inputs,"incoming":incoming,"item":item,"exit":exits,"steps":steps,"_fallbacks":node.fallbacks})
    }
    fn activate(
        &mut self,
        node_id: &str,
        incoming: Value,
        item: Option<Value>,
        frames: Vec<Frame>,
        traversals: BTreeMap<usize, u32>,
        now: i64,
    ) -> Result<(), String> {
        if !self.active() {
            return Ok(());
        }
        if node_id.starts_with('$') {
            let mut values = self
                .result
                .take()
                .and_then(|r| r.as_array().cloned())
                .unwrap_or_default();
            values.push(incoming);
            self.result = Some(Value::Array(values));
            for f in &frames {
                if let Some(batch) = self.batches.iter_mut().find(|b| b.id == f.batch) {
                    batch.closed.insert(f.branch.clone());
                }
            }
            self.event(
                "workflow.returned",
                None,
                "Result returned to caller",
                json!({"target":node_id}),
                now,
            );
            if node_id == "$return_needs_decision" {
                self.escalate("A loop reached its configured limit", now);
            }
            return Ok(());
        }
        if self.instances.len() >= self.definition.limits.max_instances {
            return Err("Workflow instance budget exhausted".into());
        }
        let node = self.definition.node(node_id).clone();
        if self.source_cancelled(node_id, &frames) {
            self.event(
                "node.skipped",
                None,
                "A completed join cancelled this producer",
                json!({"nodeId":node_id}),
                now,
            );
            return Ok(());
        }
        if node.kind == "join" {
            return self.arrive(&node, incoming, frames, traversals, now);
        }
        if node.bypass {
            let result = incoming["result"].clone();
            let id = self.insert(&node, incoming, item, frames, traversals, "completed", now)?;
            self.instances.last_mut().unwrap().completed_at = Some(now);
            self.event("node.skipped", Some(&id), "Node bypassed", Value::Null, now);
            return self.route(&id, &[node.exits[0].id.clone()], result, now);
        }
        if let Some(each) = node.for_each.as_ref().filter(|_| item.is_none()) {
            let context = self.context(&node, &incoming, None);
            let list = binding_value(&context, &each.source)
                .and_then(|v| v.as_array().cloned())
                .ok_or_else(|| format!("{}.forEach.source must resolve to an array", node.id))?;
            if list.len() > each.max_items {
                return Err(format!("{} exceeds maxItems", node.id));
            }
            if list.is_empty() {
                let mut empty_frames = frames.clone();
                let batch_id = Uuid::new_v4().to_string();
                self.batches.push(Batch {
                    id: batch_id.clone(),
                    node_id: node_id.into(),
                    expected: BTreeSet::new(),
                    arrivals: BTreeMap::new(),
                    closed: BTreeSet::new(),
                    joined: false,
                    frames,
                    traversals: traversals.clone(),
                    arrival_traversals: BTreeMap::new(),
                    joins: BTreeMap::new(),
                });
                empty_frames.push(Frame {
                    batch: batch_id,
                    branch: "$empty".into(),
                });
                let id = self.insert(
                    &node,
                    incoming,
                    None,
                    empty_frames,
                    traversals,
                    "completed",
                    now,
                )?;
                if let Some(exit) = &each.empty_exit {
                    self.route(&id, &[exit.clone()], json!({"items":[]}), now)?;
                } else {
                    return Err(format!(
                        "{} received an empty list without an emptyExit",
                        node.id
                    ));
                }
                return Ok(());
            }
            let keys: Vec<String> = list
                .iter()
                .map(|item| {
                    read_path(item, &each.key)
                        .filter(|v| v.is_string() || v.is_number())
                        .map(|v| {
                            v.as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| v.to_string())
                        })
                        .ok_or_else(|| format!("{} item key is missing", node.id))
                })
                .collect::<Result<_, _>>()?;
            if keys.iter().collect::<BTreeSet<_>>().len() != keys.len() {
                return Err("forEach item keys must be unique".into());
            }
            let batch_id = Uuid::new_v4().to_string();
            self.batches.push(Batch {
                id: batch_id.clone(),
                node_id: node_id.into(),
                expected: keys.iter().cloned().collect(),
                arrivals: BTreeMap::new(),
                closed: BTreeSet::new(),
                joined: false,
                arrival_traversals: BTreeMap::new(),
                joins: BTreeMap::new(),
                frames: frames.clone(),
                traversals: traversals.clone(),
            });
            for (key, item) in keys.into_iter().zip(list) {
                let mut child = frames.clone();
                child.push(Frame {
                    batch: batch_id.clone(),
                    branch: key,
                });
                self.activate(
                    node_id,
                    incoming.clone(),
                    Some(item),
                    child,
                    traversals.clone(),
                    now,
                )?;
            }
            return Ok(());
        }
        let status = if ["agent", "call"].contains(&node.kind.as_str()) {
            "ready"
        } else {
            "completed"
        };
        let id = self.insert(
            &node,
            incoming.clone(),
            item.clone(),
            frames,
            traversals,
            status,
            now,
        )?;
        match node.kind.as_str() {
            "main" => {
                let exits = node.exits.iter().map(|e| e.id.clone()).collect::<Vec<_>>();
                let value = if node.id == self.definition.entry {
                    self.inputs.clone()
                } else {
                    incoming
                };
                self.route(&id, &exits, value, now)?;
            }
            "dispatch" => {
                let exits=node.exits.iter().map(|exit|exit.id.clone()).collect::<Vec<_>>();
                let value=incoming.get("result").cloned().unwrap_or(incoming);
                let instance=self.instances.iter_mut().find(|instance|instance.id == id).unwrap();
                instance.result=Some(value.clone());instance.branches=Some(exits.clone());instance.completed_at=Some(now);
                self.event("node.distributed",Some(&id),"Input forwarded to every outlet",json!({"branches":exits,"result":value}),now);
                self.route(&id,&exits,value,now)?;
            }
            "condition" => {
                let context = self.context(&node, &incoming, item.as_ref());
                let selected = node
                    .cases
                    .iter()
                    .find(|case| case.matches(&context))
                    .map(|c| c.exit.clone())
                    .or(node.otherwise.clone())
                    .ok_or("Missing condition fallback")?;
                self.route(&id, &[selected], incoming, now)?;
            }
            _ => {}
        }
        Ok(())
    }
    fn insert(
        &mut self,
        node: &Node,
        incoming: Value,
        item: Option<Value>,
        frames: Vec<Frame>,
        traversals: BTreeMap<usize, u32>,
        status: &str,
        now: i64,
    ) -> Result<String, String> {
        let iteration = self
            .instances
            .iter()
            .filter(|i| i.node_id == node.id)
            .count() as u32
            + 1;
        let mut prompt = node
            .prompt
            .as_ref()
            .filter(|_| !node.bypass && !(node.for_each.is_some() && item.is_none() && status == "completed"))
            .map(|p| render(p, &self.context(node, &incoming, item.as_ref())))
            .transpose()?;
        let task = self.approved_nodes.get(&node.id).and_then(|plan| plan["task"].as_str());
        if let (Some(prompt), Some(task)) = (&mut prompt, task) {
            prompt.push_str("\n\nTask approved for this workflow run:\n");
            prompt.push_str(task);
        }
        let id = Uuid::new_v4().to_string();
        self.instances.push(Instance {
            id: id.clone(),
            node_id: node.id.clone(),
            status: status.into(),
            attempt: 1,
            iteration,
            incoming,
            item,
            prompt,
            task_text: None,
            prompt_prepared: false,
            session_id: None,
            run_id: None,
            execution_key: None,
            native_work: None,
            acceptance: (node.kind == "agent" && !node.bypass && self.workspace.is_some()).then(super::Acceptance::default),
            workspace: None,
            branches: None,
            result: None,
            error: None,
            reminders: 0,
            last_output: None,
            submission_error: None,
            completed_at: None,
            next_reminder_at: None,
            deadline_at: None,
            created_at: now,
            updated_at: now,
            frames,
            traversals,
            child_run_id: None,
            dynamic_child_reported: false,
            approval_id: None,
        });
        self.event(
            "node.activated",
            Some(&id),
            "Node activated",
            json!({"status":status,"prompt":self.instances.last().and_then(|i|i.prompt.clone()),"incoming":self.instances.last().map(|i|&i.incoming),"item":self.instances.last().and_then(|i|i.item.clone()),"attempt":1,"iteration":iteration}),
            now,
        );
        Ok(id)
    }
    fn route(&mut self, id: &str, exits: &[String], result: Value, now: i64) -> Result<(), String> {
        let i = self.index(id)?;
        let current = self.instances[i].clone();
        let edges = self
            .definition
            .edges
            .iter()
            .enumerate()
            .filter(|(_, e)| e.from[0] == current.node_id && exits.contains(&e.from[1]))
            .map(|(n, e)| (n, e.clone()))
            .collect::<Vec<_>>();
        let mut frames = current.frames.clone();
        let group = edges.len() > 1
            || self.definition.node(&current.node_id).kind == "dispatch"
            || self.definition.node(&current.node_id).for_each.is_none()
                && self
                    .definition
                    .nodes
                    .iter()
                    .any(|n| n.kind == "join" && n.scope.as_deref() == Some(&current.node_id))
            || self.definition.node(&current.node_id).kind == "main"
                && self.definition.node(&current.node_id).dispatch.as_deref() == Some("all");
        let batch_id = Uuid::new_v4().to_string();
        if group {
            self.batches.push(Batch {
                id: batch_id.clone(),
                node_id: current.node_id.clone(),
                expected: exits.iter().cloned().collect(),
                arrivals: BTreeMap::new(),
                closed: BTreeSet::new(),
                joined: false,
                arrival_traversals: BTreeMap::new(),
                frames: frames.clone(),
                traversals: current.traversals.clone(),
                joins: BTreeMap::new(),
            });
        }
        for (edge_index, edge) in edges {
            if !self.active() {
                break;
            }
            let mut counts = current.traversals.clone();
            let count = counts.entry(edge_index).or_default();
            let target = if edge.max_traversals.is_some_and(|limit| *count >= limit) {
                edge.on_limit.clone().unwrap()
            } else {
                *count += 1;
                edge.to.clone()
            };
            if group {
                frames = current.frames.clone();
                frames.push(Frame {
                    batch: batch_id.clone(),
                    branch: edge.from[1].clone(),
                });
            }
            self.event(
                "edge.traversed",
                Some(id),
                "Selected outlet",
                json!({"edgeIndex":edge_index,"branch":edge.from[1],"target":target}),
                now,
            );
            // Keep the immediately preceding input for feedback, with a
            // bounded depth so repeated loops do not grow the payload forever.
            let incoming = json!({"from":current.node_id,"instanceId":current.id,"attempt":current.attempt,"branch":edge.from[1],"result":result,"previous":trim_history(&current.incoming,2)});
            self.activate(&target, incoming, None, frames.clone(), counts, now)?;
        }
        Ok(())
    }
    fn arrive(
        &mut self,
        node: &Node,
        incoming: Value,
        frames: Vec<Frame>,
        traversals: BTreeMap<usize, u32>,
        now: i64,
    ) -> Result<(), String> {
        if !node.sources.is_empty() {
            return self.arrive_source_join(node, incoming, frames, traversals, now);
        }
        let frame = frames
            .iter()
            .rev()
            .find(|f| {
                self.batches
                    .iter()
                    .any(|b| b.id == f.batch && Some(&b.node_id) == node.scope.as_ref())
            })
            .ok_or_else(|| format!("Join {} was reached outside its scope", node.id))?
            .clone();
        let b = self
            .batches
            .iter()
            .position(|b| b.id == frame.batch)
            .unwrap();
        if self.batches[b].joined {
            return Ok(());
        }
        if !self.batches[b].expected.is_empty()
            && self.batches[b]
                .arrivals
                .insert(frame.branch.clone(), incoming)
                .is_some()
        {
            return Err(format!("Join {} received the same branch twice", node.id));
        }
        if !self.batches[b].expected.is_empty() {
            self.batches[b]
                .arrival_traversals
                .insert(frame.branch, traversals.clone());
        }
        let required = match node.wait.as_str() {
            "firstValid" => 1,
            "quorum" => node.quorum.unwrap_or(1),
            _ => self.batches[b].expected.len(),
        };
        self.event("join.progress",None,"Join received a branch",json!({"nodeId":node.id,"batchId":self.batches[b].id,"received":self.batches[b].arrivals.len(),"required":required}),now);
        if self.batches[b].arrivals.len() < required {
            return Ok(());
        }
        let batch = self.batches[b].clone();
        self.batches[b].joined = true;
        if node.remaining == "cancel" {
            let ids = self
                .instances
                .iter()
                .filter(|i| {
                    !["completed", "failed", "cancelled"].contains(&i.status.as_str())
                        && i.frames.iter().any(|f| f.batch == batch.id)
                })
                .map(|i| i.id.clone())
                .collect::<Vec<_>>();
            for id in ids {
                let i = self.index(&id)?;
                self.instances[i].status = "cancelled".into();
                self.event(
                    "node.cancelled",
                    Some(&id),
                    "Join obtained sufficient results",
                    Value::Null,
                    now,
                );
            }
        }
        let mut merged = traversals;
        for (k, v) in batch.traversals {
            merged
                .entry(k)
                .and_modify(|count| *count = (*count).max(v))
                .or_insert(v);
        }
        for counts in batch.arrival_traversals.values() {
            for (k, v) in counts {
                merged
                    .entry(*k)
                    .and_modify(|count| *count = (*count).max(*v))
                    .or_insert(*v);
            }
        }
        let id = self.insert(
            node,
            json!(batch.arrivals),
            None,
            batch.frames,
            merged,
            "completed",
            now,
        )?;
        self.event(
            "join.completed",
            Some(&id),
            "Join released its result",
            json!({"batchId":batch.id}),
            now,
        );
        self.route(&id, &[node.exits[0].id.clone()], json!(batch.arrivals), now)
    }
    pub fn submit(
        &mut self,
        id: &str,
        attempt: u32,
        names: &[String],
        result: Value,
        now: i64,
    ) -> Result<Value, String> {
        let i = self.index(id)?;
        let current = self.instances[i].clone();
        let node = self.definition.node(&current.node_id).clone();
        if current.attempt != attempt {
            return Err("Stale execution attempt".into());
        }
        if current.status == "waiting_retry" {
            return Err("The previous execution attempt has ended".into());
        }
        if node.kind == "agent" && current.child_run_id.is_some() && !current.dynamic_child_reported {
            return Err("Wait for the node's subworkflow result before submitting its final outlet".into());
        }
        let mut ids = names
            .iter()
            .map(|name| {
                node.exits
                    .iter()
                    .find(|p| &p.name == name)
                    .map(|p| p.id.clone())
                    .ok_or_else(|| {
                        format!(
                            "Unknown outlet {name}. Choose one of {}",
                            node.exits
                                .iter()
                                .map(|p| p.name.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        )
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if ids.is_empty()
            || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
            || node.exit_mode == "one" && ids.len() != 1
        {
            return Err("Select the configured number of distinct outlets".into());
        }
        // Multi-select outlets form a set. A transport retry may reorder them.
        ids.sort();
        check_fields(&node.outputs, &result)?;
        self.instances[i].submission_error = None;
        if let Some(existing) = current.branches {
            return if existing == ids && current.result.as_ref() == Some(&result) {
                Ok(json!({"accepted":true,"instanceId":id,"duplicate":true}))
            } else {
                Err("Conflicting submission for this instance".into())
            };
        }
        if !self.active() || ["cancelled", "failed"].contains(&current.status.as_str()) {
            return Err("This execution no longer accepts results".into());
        }
        self.instances[i].branches = Some(ids);
        self.instances[i].result = Some(result);
        for m in &mut self.messages {
            if m.instance_id.as_deref() == Some(id) && m.recipient == "child" {
                m.status = "resolved".into();
            }
        }
        self.event(
            "node.submitted",
            Some(id),
            "Node submitted a named outlet",
            json!({"branches":self.instances[i].branches,"result":self.instances[i].result}),
            now,
        );
        if current.completed_at.is_some() {
            self.finish(id, now)?;
        }
        self.settle(now)?;
        Ok(json!({"accepted":true,"instanceId":id,"duplicate":false}))
    }
    pub fn execution_finished(
        &mut self,
        id: &str,
        success: bool,
        error: Option<String>,
        now: i64,
    ) -> Result<(), String> {
        let i = self.index(id)?;
        if !self.active()
            || ["cancelled", "completed", "failed"].contains(&self.instances[i].status.as_str())
        {
            return Ok(());
        }
        if !success {
            return self.fail(
                id,
                &error.unwrap_or_else(|| "Agent execution failed".into()),
                now,
            );
        }
        self.instances[i].completed_at = Some(now);
        if self.instances[i].branches.is_some() {
            self.finish(id, now)?;
        } else {
            let policy = self
                .definition
                .node(&self.instances[i].node_id)
                .submission_policy
                .clone();
            self.instances[i].status = "waiting_submission".into();
            if self.instances[i].deadline_at.is_none() {
                self.instances[i].next_reminder_at = Some(now + policy.grace_ms);
                self.instances[i].deadline_at = Some(now + policy.grace_ms + policy.timeout_ms);
            }
            self.event(
                "node.waiting_submission",
                Some(id),
                "Agent turn ended without a submission",
                Value::Null,
                now,
            );
        }
        self.settle(now)
    }
    pub fn execution_result(
        &mut self,
        id: &str,
        attempt: u32,
        success: bool,
        error: Option<String>,
        output: Option<String>,
        now: i64,
    ) -> Result<(), String> {
        let i = self.index(id)?;
        if !self.active()
            || self.instances[i].attempt != attempt
            || ["completed", "cancelled", "failed"].contains(&self.instances[i].status.as_str())
        {
            return Ok(());
        }
        if let Some(output) = &output {
            self.instances[i].last_output = Some(output.chars().take(12000).collect());
        }
        if success
            && self.definition.node(&self.instances[i].node_id).completion == "structured_final"
            && self.instances[i].branches.is_none()
        {
            let accepted = structured_receipt(output.as_deref().unwrap_or(""))
                .and_then(|(names, result)| self.submit(id, attempt, &names, result, now));
            if let Err(reason) = accepted {
                self.instances[i].submission_error = Some(reason.clone());
                self.event(
                    "node.submission_rejected",
                    Some(id),
                    &reason,
                    json!({"attempt":attempt,"mode":"structured_final"}),
                    now,
                );
            }
        }
        self.execution_finished(id, success, error, now)
    }
    pub(super) fn finish(&mut self, id: &str, now: i64) -> Result<(), String> {
        let i = self.index(id)?;
        if self.instances[i].status == "completed" {
            return Ok(());
        }
        let exits = self.instances[i]
            .branches
            .clone()
            .ok_or("Missing selected outlets")?;
        let result = self.instances[i].result.clone().ok_or("Missing result")?;
        if self.instances[i].acceptance.as_ref().is_some_and(|gate|gate.status != "passed") {
            if self.instances[i].status != "verifying" {
                self.instances[i].status="verifying".into();self.instances[i].updated_at=now;
                self.event("node.waiting_verification",Some(id),"Waiting for required acceptance",Value::Null,now);
            }
            return Ok(());
        }
        self.instances[i].status = "completed".into();
        self.instances[i].updated_at = now;
        self.instances[i].next_reminder_at = None;
        self.event(
            "node.completed",
            Some(id),
            "Node completed",
            Value::Null,
            now,
        );
        if let Err(error) = self.route(id, &exits, result, now) {
            // The submission itself is already valid. Preserve its receipt and
            // evidence when a downstream input or budget cannot be satisfied.
            self.escalate(&error, now);
        }
        Ok(())
    }
    pub fn fail(&mut self, id: &str, error: &str, now: i64) -> Result<(), String> {
        let i = self.index(id)?;
        if !self.active()
            || ["completed", "failed", "cancelled"].contains(&self.instances[i].status.as_str())
        {
            return Ok(());
        }
        let node = self.definition.node(&self.instances[i].node_id);
        if node.kind == "agent" && self.instances[i].attempt < node.max_attempts {
            let instance = &mut self.instances[i];
            instance.status = "waiting_retry".into();
            instance.error = Some(error.into());
            instance.deadline_at = None;
            instance.next_reminder_at = None;
            instance.updated_at = now;
            for message in self.messages.iter_mut().filter(|message| {
                message.instance_id.as_deref() == Some(id) && ["queued","waiting_approval"].contains(&message.status.as_str())
            }) {
                message.status = "resolved".into();
            }
            self.event("node.retry_available", Some(id), error, Value::Null, now);
            return Ok(());
        }
        self.finish_failure(id, error, now)
    }
    pub(crate) fn decline_retry(&mut self, id: &str, now: i64) -> Result<(), String> {
        let i = self.index(id)?;
        if self.instances[i].status != "waiting_retry" || self.status != "running" {
            return Err("This node is not waiting for a retry decision".into());
        }
        let reason = self.instances[i].error.clone().unwrap_or_else(|| "Retry declined".into());
        self.finish_failure(id, &reason, now)
    }
    pub(crate) fn retry_node(&mut self, id: &str, now: i64) -> Result<(), String> {
        let i = self.index(id)?;
        let instance = &mut self.instances[i];
        let limit = self.definition.node(&instance.node_id).max_attempts;
        if self.status != "running" || instance.status != "waiting_retry" || instance.attempt >= limit {
            return Err("This node has no remaining retry".into());
        }
        instance.attempt += 1;
        instance.status = "ready".into();
        instance.run_id = None;
        instance.execution_key = None;
        instance.native_work = None;
        instance.child_run_id = None;
        instance.dynamic_child_reported = false;
        instance.approval_id = None;
        instance.result = None;
        instance.error = None;
        instance.branches = None;
        instance.last_output = None;
        instance.submission_error = None;
        instance.reminders = 0;
        instance.completed_at = None;
        instance.updated_at = now;
        // Specifying a new attempt changes the scope appended to the original
        // frozen prompt. Strip the previously appended execution contract.
        if instance.prompt_prepared {
            instance.prompt = instance.prompt.take().map(|prompt| {
                let prompt = prompt.rsplit_once("\n\n[NAUTILO_WORKFLOW_NODE]\n").map(|(prompt,_)| prompt).unwrap_or(&prompt);
                format!("{prompt}\n\n[NAUTILO_WORKFLOW_NODE]\n{}\n{}", json!({"workflowRunId":self.id,"instanceId":id,"attempt":instance.attempt}), self.definition.node(&instance.node_id).submission_instruction())
            });
        }
        if instance.acceptance.is_some() {
            instance.acceptance = Some(super::Acceptance::default());
        }
        if let Some(workspace) = &mut instance.workspace {
            workspace.stage = "ready".into();
            workspace.outcome = None;
            workspace.error = None;
        }
        let attempt = instance.attempt;
        self.event("node.retrying", Some(id), "Retrying the selected node", json!({"attempt":attempt}), now);
        Ok(())
    }
    fn finish_failure(&mut self, id: &str, error: &str, now: i64) -> Result<(), String> {
        let i = self.index(id)?;
        self.instances[i].status = "failed".into();
        self.instances[i].error = Some(error.into());
        self.instances[i].updated_at = now;
        self.event("node.failed", Some(id), error, Value::Null, now);
        let node = self.definition.node(&self.instances[i].node_id).clone();
        if let Some(exit) = node.on_error {
            if let Err(route_error) = self.route(id, &[exit], json!({"error":error}), now) {
                self.escalate(&route_error, now);
            }
        } else {
            let frames = self.instances[i].frames.clone();
            for f in frames {
                if let Some(batch) = self.batches.iter_mut().find(|b| b.id == f.batch) {
                    batch.closed.insert(f.branch);
                }
            }
            // A parallel race may still produce enough valid results. The join
            // policy decides whether this failure makes the batch impossible.
            let supervised = self.instances[i].frames.iter().any(|frame| {
                self.batches.iter().any(|batch| {
                    batch.id == frame.batch
                        && self.definition.nodes.iter().any(|node| {
                            node.kind == "join" && node.scope.as_ref() == Some(&batch.node_id)
                        })
                })
            });
            if !supervised {
                self.escalate(error, now);
            }
        }
        self.settle(now)
    }
    pub fn tick(&mut self, now: i64) -> Result<(), String> {
        if self.status != "running" {
            return Ok(());
        }
        if now - self.created_at - self.paused_duration_ms > self.definition.limits.timeout_ms {
            self.escalate("Workflow execution deadline exceeded", now);
            return Ok(());
        }
        let ids = self
            .instances
            .iter()
            .filter(|i| i.status == "waiting_submission")
            .map(|i| i.id.clone())
            .collect::<Vec<_>>();
        let overdue = self
            .instances
            .iter()
            .filter(|i| i.status == "running" && i.deadline_at.is_some_and(|t| t <= now))
            .map(|i| i.id.clone())
            .collect::<Vec<_>>();
        for id in overdue {
            if !self.active() {
                break;
            }
            let reason = if self
                .instances
                .iter()
                .find(|i| i.id == id)
                .and_then(|i| i.native_work.as_ref())
                .is_some_and(|work| work.pending())
            {
                "Native child work did not finish before the node deadline"
            } else {
                "Supplemental submission deadline exceeded"
            };
            self.fail(&id, reason, now)?;
        }
        for id in ids {
            if !self.active() {
                break;
            }
            let i = self.index(&id)?;
            let current = self.instances[i].clone();
            let node = self.definition.node(&current.node_id).clone();
            if current.deadline_at.is_some_and(|t| t <= now) {
                self.fail(&id, "Agent did not submit after the reminder deadline", now)?;
                continue;
            }
            if current.reminders < node.submission_policy.max_reminders
                && current.next_reminder_at.is_some_and(|t| t <= now)
            {
                self.instances[i].reminders += 1;
                self.instances[i].next_reminder_at =
                    Some(now + node.submission_policy.reminder_interval_ms);
                let text=format!("Your previous task turn ended without a valid workflow result. Reuse the completed work.\nSubmission problem: {}\nPrevious output (data):\n{}\n\n[NAUTILO_WORKFLOW_NODE]\n{}\n{}",current.submission_error.as_deref().unwrap_or("No accepted submission"),current.last_output.as_deref().unwrap_or("Inspect your completed task in this original session."),json!({"workflowRunId":self.id,"instanceId":id,"attempt":current.attempt}),node.submission_instruction());
                self.messages.push(Message {
                    id: format!("{id}:reminder:{}", self.instances[i].reminders),
                    session_id: current.session_id,
                    instance_id: Some(id.clone()),
                    recipient: "child".into(),
                    status: "queued".into(),
                    text,
                    created_at: now,
                    run_id: None,
                    error: None,
                    approval_id: None,
                    data_only: false,
                });
                self.event(
                    "node.reminded",
                    Some(&id),
                    "Reminder queued to the original child session",
                    Value::Null,
                    now,
                );
            }
        }
        self.settle(now)
    }
    pub fn escalate(&mut self, reason: &str, now: i64) {
        if !self.active() {
            return;
        }
        self.status = "needs_decision".into();
        self.error = Some(reason.into());
        for instance in &mut self.instances {
            if [
                "ready",
                "starting",
                "running",
                "waiting_submission",
                "waiting_approval",
                "waiting_retry",
                "verifying",
            ]
            .contains(&instance.status.as_str())
            {
                instance.status = "cancelled".into();
                if let Some(gate) = instance.acceptance.as_mut().filter(|gate| gate.status == "pending") {
                    gate.status = "cancelled".into();
                    gate.ended_at = Some(now);
                }
            }
        }
        for message in &mut self.messages {
            if message.recipient == "child"
                && ["queued", "waiting_approval"].contains(&message.status.as_str())
            {
                message.status = "resolved".into();
            }
        }
        self.event("workflow.needs_decision", None, reason, Value::Null, now);
        self.queue_main(&format!("Workflow {} needs your decision. {}. Inspect agenthub_workflow_status for existing evidence, reminders and affected nodes.",self.id,reason),now);
    }
    pub(crate) fn queue_main(&mut self, text: &str, now: i64) {
        if self.parent_run_id.is_some() {
            return;
        }
        let id = format!("{}:main:{}", self.id, self.status);
        self.queue_main_message(id, text, self.status == "completed", now);
    }
    pub(crate) fn queue_main_message(&mut self, id: String, text: &str, data_only: bool, now: i64) {
        if self.messages.iter().any(|m| m.id == id) {
            return;
        }
        self.messages.push(Message {
            id,
            session_id: Some(self.session_id.clone()),
            instance_id: None,
            recipient: "main".into(),
            status: "queued".into(),
            text: text.into(),
            created_at: now,
            run_id: None,
            error: None,
            approval_id: None,
            data_only,
        });
    }
    pub fn settle(&mut self, now: i64) -> Result<(), String> {
        if !self.active() {
            return Ok(());
        }
        let impossible = self.batches.iter().filter(|b| !b.joined).any(|batch| {
            let join = self.definition.nodes.iter().find(|n| {
                n.kind == "join"
                    && n.sources.is_empty()
                    && n.scope.as_deref() == Some(&batch.node_id)
            });
            join.is_some_and(|n| {
                let required = match n.wait.as_str() {
                    "firstValid" => 1,
                    "quorum" => n.quorum.unwrap_or(1),
                    _ => batch.expected.len(),
                };
                batch.expected.len()
                    - batch
                        .closed
                        .iter()
                        .filter(|k| {
                            batch.expected.contains(*k)
                                && !batch.arrivals.contains_key(*k)
                                && !self.instances.iter().any(|i| {
                                    [
                                        "ready",
                                        "starting",
                                        "running",
                                        "waiting_submission",
                                        "waiting_approval",
                                        "waiting_retry",
                                        "verifying",
                                    ]
                                    .contains(&i.status.as_str())
                                        && i.frames
                                            .iter()
                                            .any(|f| f.batch == batch.id && &f.branch == *k)
                                })
                        })
                        .count()
                    < required
            })
        });
        if impossible || self.source_join_impossible() {
            self.escalate("A required join can no longer receive enough branches", now);
            return Ok(());
        }
        if !self.instances.iter().any(|i| {
            [
                "ready",
                "starting",
                "running",
                "waiting_submission",
                "waiting_approval",
                "waiting_retry",
                "verifying",
            ]
            .contains(&i.status.as_str())
        }) {
            if self.batches.iter().any(|b| {
                !b.joined && !b.arrivals.is_empty()
                    || b.joins
                        .values()
                        .any(|join| !join.joined && !join.arrivals.is_empty())
            }) {
                self.escalate("A join is waiting without any running producer", now);
            } else if self.result.is_none() {
                self.escalate("Workflow has no reachable return result", now);
            } else {
                if self.acceptance.as_ref().is_some_and(|gate|gate.status != "passed") {
                    if self.status == "paused" { return Ok(()); }
                    if self.status != "finalizing" {
                        self.status="finalizing".into();self.event("workflow.finalizing",None,"Waiting for workflow acceptance",Value::Null,now);
                    }
                    return Ok(());
                }
                self.status = "completed".into();
                self.event(
                    "workflow.completed",
                    None,
                    "Workflow completed",
                    Value::Null,
                    now,
                );
                self.queue_main(
                    &format!(
                        "Workflow {} completed. Named outlets and results: {}. Acceptance: {}",
                        self.id,
                        self.result.as_ref().unwrap(),
                        self.acceptance.as_ref().map(|gate|gate.details.clone()).unwrap_or(Value::Null)
                    ),
                    now,
                );
            }
        }
        Ok(())
    }
    pub fn cancel(&mut self, now: i64) {
        if !self.active() && self.status != "needs_decision" {
            return;
        }
        self.status = "cancelled".into();
        self.approval_id = None;
        for i in &mut self.instances {
            if !["completed", "failed", "cancelled"].contains(&i.status.as_str()) {
                i.status = "cancelled".into();
                if let Some(gate) = i.acceptance.as_mut().filter(|gate| gate.status == "pending") {
                    gate.status = "cancelled".into();
                    gate.ended_at = Some(now);
                }
            }
        }
        if let Some(gate) = self.acceptance.as_mut().filter(|gate| gate.status == "pending") {
            gate.status = "cancelled".into();
            gate.ended_at = Some(now);
        }
        for m in &mut self.messages {
            if ["queued", "waiting_approval"].contains(&m.status.as_str()) {
                m.status = "resolved".into();
            }
        }
        self.event(
            "workflow.cancelled",
            None,
            "Workflow cancelled",
            Value::Null,
            now,
        );
    }
    pub fn pause(&mut self, paused: bool, now: i64) {
        if paused && self.status == "running" {
            self.status = "paused".into();
            self.paused_at = Some(now);
        } else if !paused && self.status == "paused" {
            let paused_at = self.paused_at.take().unwrap_or(now);
            self.paused_duration_ms += now - paused_at;
            self.status = "running".into();
            for i in &mut self.instances {
                let shift = now - paused_at.max(i.completed_at.unwrap_or(i.created_at));
                if let Some(t) = i.deadline_at.as_mut() {
                    *t += shift;
                }
                if let Some(t) = i.next_reminder_at.as_mut() {
                    *t += shift;
                }
            }
        } else {
            return;
        }
        self.event(
            if paused {
                "workflow.paused"
            } else {
                "workflow.resumed"
            },
            None,
            if paused {
                "Scheduling paused"
            } else {
                "Scheduling resumed"
            },
            Value::Null,
            now,
        );
    }
}
fn structured_receipt(text: &str) -> Result<(Vec<String>, Value), String> {
    let text = text.trim();
    let content = if text.starts_with("```") && text.ends_with("```") {
        text.split_once('\n')
            .map(|(_, body)| body[..body.len() - 3].trim())
            .ok_or("Expected a complete JSON result")?
    } else {
        text
    };
    let value: Value = serde_json::from_str(content)
        .map_err(|_| "The final reply must be a JSON object with a named branch and result")?;
    if value.get("branch").is_some() == value.get("branches").is_some() {
        return Err("Provide exactly one branch name or branches list".into());
    }
    let names = if let Some(name) = value["branch"].as_str() {
        vec![name.into()]
    } else {
        value["branches"]
            .as_array()
            .ok_or("branches must be an array of names")?
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "Outlet names must be strings".into())
            })
            .collect::<Result<Vec<_>, String>>()?
    };
    let result = value.get("result").cloned().ok_or("Missing result field")?;
    Ok((names, result))
}
fn trim_history(value: &Value, depth: usize) -> Value {
    let mut copy = value.clone();
    if let Some(fields) = copy.as_object_mut() {
        if depth == 0 {
            fields.remove("previous");
        } else if let Some(previous) = fields.get_mut("previous") {
            *previous = trim_history(previous, depth - 1);
        }
    }
    copy
}
