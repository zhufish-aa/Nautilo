use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Definition {
    pub schema_version: u32,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub entry: String,
    #[serde(default)]
    pub inputs: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub input_defaults: BTreeMap<String, Value>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    #[serde(default)]
    pub limits: Limits,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Node {
    pub id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub exits: Vec<Exit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default = "tool")]
    pub completion: String,
    #[serde(default)]
    pub outputs: BTreeMap<String, Value>,
    #[serde(default = "one")]
    pub exit_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub for_each: Option<ForEach>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<WorkspacePolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<String>,
    #[serde(default = "all")]
    pub wait: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quorum: Option<usize>,
    #[serde(default = "continuing")]
    pub remaining: String,
    #[serde(default)]
    pub cases: Vec<Case>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub otherwise: Option<String>,
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<TemplateRef>,
    #[serde(default)]
    pub input: BTreeMap<String, Value>,
    #[serde(default)]
    pub exit_map: BTreeMap<String, String>,
    #[serde(default)]
    pub submission_policy: SubmissionPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dynamic_subflow: Option<DynamicSubflow>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fallbacks: BTreeMap<String, Value>,
    #[serde(default = "one_attempt")]
    pub max_attempts: u32,
}
fn one_attempt() -> u32 { 1 }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DynamicSubflow {
    pub roles: Vec<String>,
    pub max_instances: usize,
    pub max_depth: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacePolicy {
    #[serde(default = "inherit")]
    pub mode: String,
    #[serde(default)]
    pub allowed_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification_templates: Option<Vec<String>>,
}
fn inherit() -> String {
    "inherit".into()
}
fn one() -> String {
    "one".into()
}
fn tool() -> String {
    "tool".into()
}
impl Node {
    pub fn submission_instruction(&self) -> String {
        let format = if self.completion == "structured_final" {
            "Finish this turn with exactly one JSON object containing branch (the selected outlet name) and result (the completed structured result). A fenced JSON object is also accepted."
        } else {
            "Submit branch and result using the available workflow_submit / agenthub_workflow_submit tool (possibly MCP-namespaced) before ending the turn. Echo the exact instanceId and attempt from the workflow scope above. Once the receipt says accepted, end this turn immediately. The workflow engine continues from your result. Do not poll its status or perform more work after acceptance."
        };
        format!(
            "{format} Valid outlet names: {}. Result fields: {}. Select {}.",
            self.exits
                .iter()
                .map(|e| e.name.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            json!(self.outputs),
            if self.exit_mode == "some" {
                "one or more distinct names, using branches for multiple outlets"
            } else {
                "exactly one outlet"
            }
        )
    }
}
fn all() -> String {
    "all".into()
}
fn continuing() -> String {
    "continue".into()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Exit {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edge {
    pub from: [String; 2],
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_traversals: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_limit: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateRef {
    pub id: String,
    pub revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForEach {
    pub source: String,
    pub key: String,
    pub max_items: usize,
    pub max_parallel: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub empty_exit: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Case {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<String>,
    #[serde(default)]
    pub equals: Value,
    pub exit: String,
}
impl Case {
    pub fn matches(&self, context: &Value) -> bool {
        let value = binding_value(context, &self.path);
        let operator = self.operator.as_deref().unwrap_or("eq");
        let Some(value) = value else { return operator == "missing"; };
        match operator {
            "eq" => value == self.equals,
            "ne" => value != self.equals,
            "exists" => true,
            "missing" => false,
            "gt" | "ge" | "lt" | "le" => {
                let Some((actual, target)) = value.as_f64().zip(self.equals.as_f64()) else { return false; };
                match operator {
                    "gt" => actual > target, "ge" => actual >= target,
                    "lt" => actual < target, _ => actual <= target,
                }
            }
            _ => false,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Limits {
    pub max_instances: usize,
    pub timeout_ms: i64,
    pub max_parallel: usize,
    pub max_depth: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_instances: 1000,
            timeout_ms: 3_600_000,
            max_parallel: 8,
            max_depth: 8,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct SubmissionPolicy {
    pub grace_ms: i64,
    pub reminder_interval_ms: i64,
    pub max_reminders: u32,
    pub timeout_ms: i64,
}
impl Default for SubmissionPolicy {
    fn default() -> Self {
        Self {
            grace_ms: 3000,
            reminder_interval_ms: 15_000,
            max_reminders: 1,
            timeout_ms: 60_000,
        }
    }
}

impl Definition {
    pub fn node(&self, id: &str) -> &Node {
        self.nodes
            .iter()
            .find(|n| n.id == id)
            .expect("validated workflow node")
    }
    pub fn validate(&self) -> Result<(), String> {
        self.validate_structure()?;
        if let Some(issue) = self.binding_issues().into_iter().find(|issue| !issue.warning) {
            return Err(issue.message);
        }
        Ok(())
    }
    pub(crate) fn validate_structure(&self) -> Result<(), String> {
        if self.schema_version != 1 || self.id.trim().is_empty() {
            return Err("Expected schemaVersion 1 and a workflow id".into());
        }
        if self.nodes.is_empty() || self.nodes.len() > 500 || self.edges.len() > 4000 {
            return Err("A workflow requires 1–500 nodes and at most 4000 edges".into());
        }
        if self.limits.max_instances == 0
            || self.limits.max_instances > 100_000
            || self.limits.max_parallel == 0
            || self.limits.timeout_ms < 1000
            || self.limits.max_depth == 0 && self.nodes.iter().any(|n| n.kind == "call")
            || self.limits.max_depth > 32
        {
            return Err("Workflow limits must be positive".into());
        }
        let mut ids = HashSet::new();
        for n in &self.nodes {
            if !(1..=5).contains(&n.max_attempts) || (n.max_attempts > 1 && n.kind != "agent") {
                return Err(format!("Invalid attempt limit on {}", n.id));
            }
            for case in &n.cases {
                let operator = case.operator.as_deref().unwrap_or("eq");
                if !["eq","ne","gt","ge","lt","le","exists","missing"].contains(&operator)
                    || (["gt","ge","lt","le"].contains(&operator) && !case.equals.is_number())
                {
                    return Err(format!("Invalid condition comparison on {}", n.id));
                }
            }
            if let Some(policy) = &n.dynamic_subflow {
                let distinct = policy.roles.iter().collect::<HashSet<_>>();
                if n.kind != "agent" || distinct.is_empty() || distinct.len() != policy.roles.len()
                    || policy.roles.iter().any(|role| role.trim().is_empty())
                    || policy.max_instances == 0 || policy.max_instances > 100_000
                    || policy.max_depth > 31
                {
                    return Err(format!("Invalid dynamic subworkflow policy on {}", n.id));
                }
            }
            if let Some(prompt) = &n.prompt {
                for reference in binding_paths(prompt).iter().filter_map(|path| {
                    path.strip_prefix("steps.")
                        .and_then(|path| path.split('.').next())
                }) {
                    if !self.nodes.iter().any(|node| node.id == reference) {
                        return Err(format!("{} reads unknown step {}", n.id, reference));
                    }
                }
            }
            if n.id.trim().is_empty() || n.id.starts_with('$') || !ids.insert(&n.id) {
                return Err(format!("Duplicate or invalid node id {}", n.id));
            }
            if !["main", "dispatch", "agent", "join", "condition", "call"].contains(&n.kind.as_str()) {
                return Err(format!("Unsupported node kind {}", n.kind));
            }
            if !["one", "some"].contains(&n.exit_mode.as_str())
                || n.dispatch.as_deref().is_some_and(|d| d != "all")
            {
                return Err(format!("Invalid exit mode on {}", n.id));
            }
            if !["tool", "structured_final"].contains(&n.completion.as_str()) {
                return Err(format!("Unknown completion mode on {}", n.id));
            }
            let mut exit_ids = HashSet::new();
            let mut names = HashSet::new();
            if n.exits.is_empty() {
                return Err(format!("{} requires at least one named exit", n.id));
            }
            for p in &n.exits {
                if p.id.trim().is_empty()
                    || p.name.trim().is_empty()
                    || !exit_ids.insert(&p.id)
                    || !names.insert(&p.name)
                {
                    return Err(format!("{} has duplicate or empty exits", n.id));
                }
                if self
                    .edges
                    .iter()
                    .filter(|e| e.from == [n.id.clone(), p.id.clone()])
                    .count()
                    != 1
                {
                    return Err(format!(
                        "{}.{} must have one connected destination",
                        n.id, p.id
                    ));
                }
            }
            if n.kind == "agent"
                && (n.role.as_deref().unwrap_or("").trim().is_empty()
                    || n.prompt.as_deref().unwrap_or("").trim().is_empty())
            {
                return Err(format!("{} requires a role and prompt", n.id));
            }
            if n.kind == "join"
                && (!["all", "firstValid", "quorum"].contains(&n.wait.as_str())
                    || n.exits.len() != 1
                    || n.wait == "quorum" && n.quorum.unwrap_or(0) == 0
                    || !["continue", "cancel"].contains(&n.remaining.as_str()))
            {
                return Err(format!("Invalid join policy on {}", n.id));
            }
            if n.kind == "condition"
                && (n.otherwise.is_none()
                    || n.cases.iter().any(|c| !exit_ids.contains(&c.exit))
                    || !exit_ids.contains(n.otherwise.as_ref().unwrap()))
            {
                return Err(format!(
                    "{} requires valid cases and an otherwise exit",
                    n.id
                ));
            }
            if n.kind == "call"
                && n.reference.as_ref().is_none_or(|reference| {
                    reference.id.trim().is_empty() || reference.revision == 0
                })
            {
                return Err(format!("{} requires a pinned template reference", n.id));
            }
            if n.session
                .as_deref()
                .is_some_and(|s| !["fresh", "reuse"].contains(&s))
            {
                return Err(format!("Invalid session policy on {}", n.id));
            }
            if let Some(each) = &n.for_each {
                if n.kind != "agent"
                    || each.key.is_empty()
                    || each.max_items == 0
                    || each.max_parallel == 0
                    || each.max_items > self.limits.max_instances
                {
                    return Err(format!("Invalid forEach on {}", n.id));
                }
                if each
                    .empty_exit
                    .as_ref()
                    .is_some_and(|id| !exit_ids.contains(id))
                {
                    return Err(format!("Unknown empty exit on {}", n.id));
                }
            }
            if let Some(exit) = &n.on_error {
                if !exit_ids.contains(exit) {
                    return Err(format!("Unknown error exit on {}", n.id));
                }
            }
            let p = &n.submission_policy;
            if let Some(workspace) = &n.workspace {
                if n.kind != "agent"
                    || !["inherit", "isolated"].contains(&workspace.mode.as_str())
                    || workspace.allowed_paths.iter().any(|path| {
                        path.trim().is_empty()
                            || std::path::Path::new(path).is_absolute()
                            || path.replace('\\', "/").split('/').any(|part| part == "..")
                    })
                    || workspace
                        .verification_templates
                        .as_ref()
                        .is_some_and(|ids| {
                            ids.iter().any(|id| id.trim().is_empty())
                                || ids.iter().collect::<HashSet<_>>().len() != ids.len()
                        })
                {
                    return Err(format!("Invalid workspace policy on {}", n.id));
                }
            }
            if p.grace_ms < 0
                || p.reminder_interval_ms < 100
                || p.timeout_ms < 100
                || p.max_reminders > 20
            {
                return Err(format!("Invalid submission policy on {}", n.id));
            }
            for t in n.outputs.values() {
                validate_type(t)?;
            }
            if let Some(prompt) = &n.prompt {
                validate_prompt(prompt, n)?;
            }
        }
        if !ids.contains(&self.entry) || self.node(&self.entry).kind != "main" {
            return Err("Entry must reference a main node".into());
        }
        for t in self.inputs.values() {
            validate_type(t)?;
        }
        for n in &self.nodes {
            if let Some(scope) = &n.scope {
                if !ids.contains(scope) || scope == &n.id {
                    return Err(format!("Unknown join scope on {}", n.id));
                }
            }
            if n.kind == "join" && n.scope.is_none() {
                return Err(format!("Join {} needs a dispatch scope", n.id));
            }
            if n.kind == "join"
                && n.sources.is_empty()
                && self
                    .nodes
                    .iter()
                    .filter(|candidate| candidate.kind == "join" && candidate.scope == n.scope)
                    .count()
                    > 1
            {
                return Err(format!(
                    "Dispatch scope {} needs explicit sources for overlapping joins",
                    n.scope.as_deref().unwrap_or("")
                ));
            }
            if !n.sources.is_empty() {
                let sources: HashSet<_> = n.sources.iter().collect();
                if n.kind != "join"
                    || sources.len() != n.sources.len()
                    || sources
                        .iter()
                        .any(|source| !ids.contains(*source) || *source == &n.id)
                {
                    return Err(format!("{} needs distinct existing join sources", n.id));
                }
                if self.node(n.scope.as_deref().unwrap()).for_each.is_some() {
                    return Err(format!("{} must collect foreach items with an item join before using named node sources", n.id));
                }
                if n.wait == "quorum" && n.quorum.unwrap_or(0) > n.sources.len() {
                    return Err(format!("{} quorum exceeds its source count", n.id));
                }
                let incoming: HashSet<_> = self
                    .edges
                    .iter()
                    .filter(|edge| edge.to == n.id || edge.on_limit.as_ref() == Some(&n.id))
                    .map(|edge| &edge.from[0])
                    .collect();
                if sources != incoming {
                    return Err(format!(
                        "{} sources must match its directly connected predecessors",
                        n.id
                    ));
                }
            }
            if let Some(prompt) = &n.prompt {
                for field in binding_paths(prompt).iter().filter_map(|path| {
                    path.strip_prefix("input.")
                        .and_then(|path| path.split('.').next())
                }) {
                    if !self.inputs.contains_key(field) {
                        return Err(format!(
                            "{} reads undeclared workflow input {}",
                            n.id, field
                        ));
                    }
                }
            }
        }
        for e in &self.edges {
            if !ids.contains(&e.from[0])
                || !self
                    .node(&e.from[0])
                    .exits
                    .iter()
                    .any(|p| p.id == e.from[1])
            {
                return Err("Edge references an unknown source exit".into());
            }
            for target in [&e.to].into_iter().chain(e.on_limit.iter()) {
                if !ids.contains(target)
                    && !["$return", "$return_needs_decision"].contains(&target.as_str())
                {
                    return Err(format!("Unknown target {target}"));
                }
            }
            if e.max_traversals == Some(0) || e.max_traversals.is_some() != e.on_limit.is_some() {
                return Err(
                    "A limited edge requires a positive maxTraversals and onLimit target".into(),
                );
            }
        }
        let mut reachable = HashSet::new();
        self.reachable(&self.entry, &mut reachable);
        if reachable.len() != self.nodes.len() {
            return Err("Every node must be reachable from the entry".into());
        }
        // Removing bounded edges must remove every cycle. Each remaining cycle
        // could otherwise repeat without consuming its declared limit.
        let mut visiting = HashSet::new();
        let mut done = HashSet::new();
        for n in &self.nodes {
            self.check_cycle(&n.id, &mut visiting, &mut done)?;
            // A new dispatch activation is the correlation boundary for a new
            // source-join round. Do not silently mix old and new loop arrivals.
            if !n.sources.is_empty()
                && self
                    .edges
                    .iter()
                    .filter(|e| e.from[0] == n.id)
                    .any(|edge| self.reaches_without(&edge.to, &n.id, n.scope.as_deref()))
            {
                return Err(format!(
                    "Feedback through join {} must re-enter its dispatch scope {}",
                    n.id,
                    n.scope.as_deref().unwrap()
                ));
            }
        }
        for (key, value) in &self.input_defaults {
            if self.inputs.get(key).is_none_or(|kind| !type_matches(kind, value)) {
                return Err(format!("Default value does not match workflow input {key}"));
            }
        }
        Ok(())
    }
    pub(crate) fn prepare_inputs(&self, value: Value) -> Result<Value, String> {
        let Value::Object(mut inputs) = value else { return Err("Expected workflow inputs to be an object".into()); };
        for (key, value) in &self.input_defaults {
            inputs.entry(key.clone()).or_insert_with(|| value.clone());
        }
        let inputs = Value::Object(inputs);
        check_fields(&self.inputs, &inputs)?;
        Ok(inputs)
    }
    pub(super) fn reaches_without(&self, from: &str, target: &str, stop: Option<&str>) -> bool {
        let mut pending = vec![from];
        let mut seen = HashSet::new();
        while let Some(id) = pending.pop() {
            if Some(id) == stop || !seen.insert(id) {
                continue;
            }
            if id == target {
                return true;
            }
            for edge in self.edges.iter().filter(|edge| edge.from[0] == id) {
                pending.push(&edge.to);
                if let Some(limit) = &edge.on_limit {
                    pending.push(limit);
                }
            }
        }
        false
    }
    fn reachable<'a>(&'a self, id: &'a str, seen: &mut HashSet<&'a str>) {
        if !seen.insert(id) {
            return;
        }
        for e in self.edges.iter().filter(|e| e.from[0] == id) {
            for target in [&e.to]
                .into_iter()
                .chain(e.on_limit.iter())
                .filter(|t| !t.starts_with('$'))
            {
                self.reachable(target, seen);
            }
        }
    }
    fn check_cycle<'a>(
        &'a self,
        id: &'a str,
        visiting: &mut HashSet<&'a str>,
        done: &mut HashSet<&'a str>,
    ) -> Result<(), String> {
        if done.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id) {
            return Err(format!("Cycle through {id} requires a bounded edge"));
        }
        for e in self.edges.iter().filter(|e| e.from[0] == id) {
            let target = if e.max_traversals.is_some() {
                e.on_limit.as_ref().unwrap()
            } else {
                &e.to
            };
            if !target.starts_with('$') {
                self.check_cycle(target, visiting, done)?;
            }
        }
        visiting.remove(id);
        done.insert(id);
        Ok(())
    }
}
pub fn validate_type(t: &Value) -> Result<(), String> {
    validate_type_depth(t, 0)
}
fn validate_type_depth(t: &Value, depth: usize) -> Result<(), String> {
    if depth > 16 {
        return Err("Workflow field types may nest at most 16 levels".into());
    }
    if let Some(s) = t.as_str() {
        if ["text", "number", "boolean", "json"].contains(&s) {
            return Ok(());
        }
        if let Some(inner) = s.strip_prefix("list<").and_then(|v| v.strip_suffix('>')) {
            return validate_type_depth(&json!(inner), depth + 1);
        }
    }
    if let Some(values) = t.get("enum").and_then(Value::as_array) {
        if !values.is_empty()
            && values.iter().all(Value::is_string)
            && values
                .iter()
                .filter_map(Value::as_str)
                .collect::<HashSet<_>>()
                .len()
                == values.len()
            && t.get("properties").is_none()
        {
            return Ok(());
        }
    }
    if let Some(props) = t.get("properties").and_then(Value::as_object) {
        if let Some(required) = t.get("required") {
            let names = required
                .as_array()
                .ok_or("TypeSpec.required must be an array of property names")?;
            if names
                .iter()
                .any(|name| name.as_str().is_none_or(|key| !props.contains_key(key)))
            {
                return Err("TypeSpec.required refers to an unknown property".into());
            }
        }
        for v in props.values() {
            validate_type_depth(v, depth + 1)?;
        }
        return Ok(());
    }
    Err(format!("Invalid workflow type {t}"))
}
pub fn check_fields(types: &BTreeMap<String, Value>, value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or("Expected an object result")?;
    for (key, t) in types {
        let value = object
            .get(key)
            .ok_or_else(|| format!("Missing field {key}"))?;
        if !type_matches(t, value) {
            return Err(format!("Field {key} does not match {t}"));
        }
    }
    Ok(())
}
pub(super) fn type_matches(t: &Value, v: &Value) -> bool {
    match t.as_str() {
        Some("json") => true,
        Some("text") => v.is_string(),
        Some("number") => v.is_number(),
        Some("boolean") => v.is_boolean(),
        Some(s) => s
            .strip_prefix("list<")
            .and_then(|s| s.strip_suffix('>'))
            .is_some_and(|inner| {
                v.as_array()
                    .is_some_and(|items| items.iter().all(|item| type_matches(&json!(inner), item)))
            }),
        None => {
            if let Some(options) = t.get("enum").and_then(Value::as_array) {
                return options.contains(v);
            }
            let Some(props) = t.get("properties").and_then(Value::as_object) else {
                return false;
            };
            let Some(object) = v.as_object() else {
                return false;
            };
            if t["required"].as_array().is_some_and(|keys| {
                keys.iter()
                    .any(|k| !object.contains_key(k.as_str().unwrap_or("")))
            }) {
                return false;
            }
            props
                .iter()
                .all(|(key, t)| object.get(key).is_none_or(|value| type_matches(t, value)))
        }
    }
}
fn validate_prompt(prompt: &str, node: &Node) -> Result<(), String> {
    validate_braces(prompt)?;
    for path in binding_paths(prompt) {
        let key = path.as_str();
        if !["input", "incoming", "item", "exit", "steps"]
            .iter()
            .any(|base| key == *base || key.starts_with(&format!("{base}.")))
        {
            return Err(format!("Unknown prompt binding {key} on {}", node.id));
        }
        if let Some(id) = key.strip_prefix("exit.") {
            if !node.exits.iter().any(|e| e.id == id) {
                return Err(format!("Unknown prompt exit {id} on {}", node.id));
            }
        }
    }
    Ok(())
}
fn binding_regex() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\\\{\{|\{\{\s*([^{}]*?)\s*\}\}").unwrap())
}
pub(super) fn binding_paths(prompt: &str) -> Vec<String> {
    binding_regex()
        .captures_iter(prompt)
        .filter_map(|capture| capture.get(1).map(|value| value.as_str().trim().to_owned()))
        .collect()
}
fn validate_braces(prompt: &str) -> Result<(), String> {
    if binding_regex().replace_all(prompt, "").contains("{{") {
        return Err("Unclosed prompt variable. Prefix a literal {{ with a backslash.".into());
    }
    Ok(())
}
pub fn read_path(context: &Value, path: &str) -> Option<Value> {
    let mut v = context;
    for part in path.split('.') {
        v = if let Some(items) = v.as_array() {
            items.get(part.parse::<usize>().ok()?)?
        } else {
            v.get(part)?
        };
    }
    Some(v.clone())
}
pub fn binding_value(context: &Value, path: &str) -> Option<Value> {
    read_path(context, path).or_else(|| context["_fallbacks"].get(path).cloned())
}
pub fn render(prompt: &str, context: &Value) -> Result<String, String> {
    validate_braces(prompt)?;
    let re = binding_regex();
    let mut missing = None;
    let result = re
        .replace_all(prompt, |cap: &regex::Captures| {
            let Some(key) = cap.get(1) else {
                return "{{".into();
            };
            match binding_value(context, key.as_str().trim()) {
                Some(Value::String(s)) => s,
                Some(v) => v.to_string(),
                None => {
                    missing = Some(key.as_str().trim().to_string());
                    String::new()
                }
            }
        })
        .into_owned();
    match missing {
        Some(path) => Err(format!("Unbound prompt input {path}")),
        None => Ok(result),
    }
}
