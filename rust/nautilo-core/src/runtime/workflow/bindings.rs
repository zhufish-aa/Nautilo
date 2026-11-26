use super::{definition::binding_paths, Definition, Edge, Node};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BindingIssue {
    pub path: String,
    pub node_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_id: Option<String>,
    pub message: String,
    pub warning: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Available {
    Guaranteed,
    Unknown,
    Missing,
}

fn common(paths: impl IntoIterator<Item = Available>) -> Available {
    let mut seen = false;
    let mut state = Available::Guaranteed;
    for path in paths {
        seen = true;
        match path {
            Available::Missing => return Available::Missing,
            Available::Unknown => state = Available::Unknown,
            Available::Guaranteed => {}
        }
    }
    if seen { state } else { Available::Missing }
}

impl Definition {
    pub(crate) fn binding_issues(&self) -> Vec<BindingIssue> {
        let mut inputs = BTreeMap::<&str, Vec<&Edge>>::new();
        for edge in &self.edges {
            inputs.entry(&edge.to).or_default().push(edge);
            if let Some(target) = edge.on_limit.as_deref().filter(|target| *target != edge.to) {
                inputs.entry(target).or_default().push(edge);
            }
        }
        let steps = self.guaranteed_results(&inputs);
        let mut issues = Vec::new();
        for node in &self.nodes {
            let mut requirements = Vec::new();
            if let Some(prompt) = node.prompt.as_ref().filter(|_| !node.bypass) {
                for path in binding_paths(prompt) {
                    requirements.push(("prompt".into(), path, false));
                }
            }
            if let Some(each) = &node.for_each {
                requirements.push(("forEach.source".into(), each.source.clone(), true));
            }
            for (key, value) in &node.input {
                for path in references(value) {
                    requirements.push((format!("input.{key}"), path, false));
                }
            }
            for (field, binding, list) in requirements {
                let path = format!("nodes.{}.{}", node.id, field);
                let mut add = |message, warning| issues.push(BindingIssue {
                    path: path.clone(), node_id: node.id.clone(), exit_id: None, message, warning,
                });
                let availability = self.availability(node, &binding, &steps, &inputs);
                if let Some(default) = node.fallbacks.get(&binding) {
                    if list && !default.is_array() {
                        add(format!("{} needs an array fallback for {binding}", node.id), false);
                    }
                } else if availability != Available::Guaranteed {
                    add(format!("{} may receive no value for {binding}. Use a required field or set a fallback.", node.id), availability == Available::Unknown);
                }
            }
            for exit in &node.exits {
                if !self.edges.iter().any(|edge| edge.from[0] == node.id && edge.from[1] == exit.id) {
                    issues.push(BindingIssue {
                        path: format!("nodes.{}.exits.{}", node.id, exit.id),
                        node_id: node.id.clone(), exit_id: Some(exit.id.clone()),
                        message: format!("Connect outlet {} to a node or return", exit.name),
                        // Legacy definitions may intentionally leave an outlet
                        // unused. The editor highlights it without breaking
                        // the saved template's existing behavior.
                        warning: true,
                    });
                }
            }
        }
        issues
    }

    fn guaranteed_results<'a>(&'a self, inputs: &BTreeMap<&str, Vec<&'a Edge>>) -> BTreeMap<&'a str, BTreeSet<&'a str>> {
        let possible = self.nodes.iter().map(|node| node.id.as_str()).collect::<BTreeSet<_>>();
        let mut facts = self.nodes.iter().map(|node| {
            (node.id.as_str(), if node.id == self.entry { BTreeSet::new() } else { possible.clone() })
        }).collect::<BTreeMap<_, _>>();
        loop {
            let mut changed = false;
            for node in self.nodes.iter().filter(|node| node.id != self.entry) {
                let edges = inputs.get(node.id.as_str()).map(Vec::as_slice).unwrap_or_default();
                let from = |edge: &Edge| {
                    let source = self.node(&edge.from[0]);
                    let mut known = facts[source.id.as_str()].clone();
                    if !source.bypass && matches!(source.kind.as_str(), "agent" | "call" | "dispatch")
                        && source.on_error.as_deref() != Some(edge.from[1].as_str())
                        && source.for_each.as_ref().and_then(|each| each.empty_exit.as_deref()) != Some(edge.from[1].as_str())
                    {
                        known.insert(source.id.as_str());
                    }
                    known
                };
                let fixed_fork = node.scope.as_deref().and_then(|scope| {
                    let fork = self.node(scope);
                    (fork.kind == "dispatch" || (fork.kind == "main" && fork.dispatch.as_deref() == Some("all"))).then_some(fork)
                });
                let known = if node.kind == "join" && node.wait == "all" && !node.sources.is_empty() {
                    edges.iter().flat_map(|edge| from(edge)).collect()
                } else if node.kind == "join" && node.wait == "all" && fixed_fork.is_some() {
                    let fork = fixed_fork.unwrap();
                    let mut known = BTreeSet::new();
                    for branch in self.edges.iter().filter(|edge| edge.from[0] == fork.id) {
                        let producers = edges.iter().filter(|edge| {
                            let source = edge.from[0].as_str();
                            (source == fork.id && edge.from == branch.from) ||
                                (source != fork.id && self.reaches_without(&branch.to, source, Some(&node.id)))
                        });
                        known.extend(intersection(producers.map(|edge| from(edge))));
                    }
                    known.extend(intersection(edges.iter().map(|edge| from(edge))));
                    known
                } else {
                    intersection(edges.iter().map(|edge| from(edge)))
                };
                if facts[node.id.as_str()] != known {
                    changed = true;
                    facts.insert(&node.id, known);
                }
            }
            if !changed { return facts; }
        }
    }

    fn availability(
        &self, node: &Node, binding: &str, steps: &BTreeMap<&str, BTreeSet<&str>>, inputs: &BTreeMap<&str, Vec<&Edge>>,
    ) -> Available {
        let path = binding.split('.').collect::<Vec<_>>();
        match path.as_slice() {
            ["input"] | ["steps"] | ["exit"] | ["incoming"] => Available::Guaranteed,
            ["input", key, rest @ ..] => field(&self.inputs, key, rest),
            ["exit", exit] if node.exits.iter().any(|port| &port.id == exit) => Available::Guaranteed,
            ["item", rest @ ..] if node.for_each.is_some() => if rest.is_empty() { Available::Guaranteed } else { Available::Unknown },
            ["steps", step, rest @ ..] if steps[node.id.as_str()].contains(step) => {
                let producer = self.node(step);
                match rest {
                    [] | ["instances"] | ["latest"] => Available::Guaranteed,
                    ["latest", "result", results @ ..] | ["instances", "0", "result", results @ ..] => {
                        self.result_at(producer, None, results, inputs, 0)
                    }
                    ["latest", "instanceId" | "iteration" | "item" | "branches"] => Available::Guaranteed,
                    _ => Available::Unknown,
                }
            }
            ["incoming", "from" | "instanceId" | "attempt" | "branch"] if node.id != self.entry => Available::Guaranteed,
            ["incoming", "result", rest @ ..] => common(inputs.get(node.id.as_str()).into_iter().flatten().map(|edge| {
                self.result_at(self.node(&edge.from[0]), Some(&edge.from[1]), rest, inputs, 0)
            })),
            ["incoming", "previous", ..] => Available::Unknown,
            _ => Available::Missing,
        }
    }

    fn result_at(
        &self, node: &Node, exit: Option<&str>, path: &[&str], inputs: &BTreeMap<&str, Vec<&Edge>>, depth: usize,
    ) -> Available {
        let Some((key, rest)) = path.split_first() else { return Available::Guaranteed; };
        if depth > self.nodes.len() { return Available::Unknown; }
        if exit.is_some() && exit == node.on_error.as_deref() {
            return if *key == "error" && rest.is_empty() { Available::Guaranteed } else { Available::Missing };
        }
        if exit.is_some() && exit == node.for_each.as_ref().and_then(|each| each.empty_exit.as_deref()) {
            return Available::Unknown;
        }
        match node.kind.as_str() {
            "main" => field(&self.inputs, key, rest),
            "agent" if !node.bypass => field(&node.outputs, key, rest),
            "agent" | "dispatch" => common(inputs.get(node.id.as_str()).into_iter().flatten().map(|edge| {
                self.result_at(self.node(&edge.from[0]), Some(&edge.from[1]), path, inputs, depth + 1)
            })),
            "join" if node.wait == "all" && node.sources.iter().any(|source| source == key) => {
                match rest {
                    [] => Available::Guaranteed,
                    ["result", path @ ..] => common(inputs[node.id.as_str()].iter().filter(|edge| &edge.from[0] == key).map(|edge| {
                        self.result_at(self.node(key), Some(&edge.from[1]), path, inputs, depth + 1)
                    })),
                    _ => Available::Unknown,
                }
            }
            "join" if node.sources.iter().any(|source| source == key) => Available::Missing,
            _ => Available::Unknown,
        }
    }
}

fn field(fields: &BTreeMap<String, Value>, name: &str, path: &[&str]) -> Available {
    let Some(mut kind) = fields.get(name) else { return Available::Missing; };
    for name in path {
        if kind == "json" || kind.as_str().is_some_and(|kind| kind.starts_with("list<")) {
            return Available::Unknown;
        }
        if !kind["required"].as_array().is_some_and(|required| required.iter().any(|key| key == *name)) {
            return Available::Missing;
        }
        let Some(next) = kind["properties"].get(*name) else { return Available::Missing; };
        kind = next;
    }
    Available::Guaranteed
}

fn intersection<'a>(mut paths: impl Iterator<Item = BTreeSet<&'a str>>) -> BTreeSet<&'a str> {
    let mut common = paths.next().unwrap_or_default();
    for path in paths {
        common.retain(|key| path.contains(key));
    }
    common
}

fn references(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) => binding_paths(text),
        Value::Array(items) => items.iter().flat_map(references).collect(),
        Value::Object(object) => object.values().flat_map(references).collect(),
        _ => Vec::new(),
    }
}
