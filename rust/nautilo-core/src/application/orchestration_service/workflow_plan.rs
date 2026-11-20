//! Convert persisted legacy task plans into the same workflow language used by
//! authored graphs. This module neither launches models nor changes task state.
use super::OrchestrationPromptBuilder;
use crate::runtime::workflow::{Definition, Limits};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) struct TaskWorkflowPlan {
    pub definition: Definition,
    pub inputs: Value,
    pub bindings: Value,
    /// Original task IDs remain authoritative in legacy receipts and history.
    pub task_nodes: BTreeMap<String, String>,
    pub target_sessions: BTreeMap<String, String>,
}

fn key(id: &str) -> String {
    format!("task_{:x}", Sha256::digest(id.as_bytes()))
}
fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("A task needs a nonempty {field}"))
}

/// The execution adapter supplies the original deadline/concurrency policy.
/// Completed dependencies are supplied as scoped evidence, never regenerated
/// as Agent nodes. This also compiles a single-task retry without its siblings.
pub(crate) fn compile(
    project_run: &Value,
    batch_id: &str,
    tasks: &[Value],
    team: &Value,
    completed: &BTreeMap<String, Value>,
    limits: Limits,
) -> Result<TaskWorkflowPlan, String> {
    let project_run_id = string(project_run, "id")?;
    if batch_id.trim().is_empty() || tasks.is_empty() || tasks.len() > 50 {
        return Err("A legacy task batch needs an identity and 1–50 tasks".into());
    }
    let mut task_nodes = BTreeMap::new();
    let mut by_id = BTreeMap::new();
    let mut target_sessions = BTreeMap::new();
    let mut bindings = Map::new();
    let mut requests = Map::new();
    let mut metadata = Map::new();
    for task in tasks {
        let id = string(task, "id")?.to_owned();
        if task_nodes.contains_key(&id) {
            return Err(format!("Duplicate task ID {id}"));
        }
        if task["projectRunId"]
            .as_str()
            .is_some_and(|scope| scope != project_run_id)
        {
            return Err(format!("Task {id} belongs to another project run"));
        }
        if task["status"] == "completed" || completed.contains_key(&id) {
            return Err(format!(
                "Task {id} already has accepted evidence; do not dispatch it again"
            ));
        }
        let member_id = string(task, "assignedMemberId")?;
        let member = team["members"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|member| member["id"] == member_id && member["enabled"] == true)
            .ok_or_else(|| format!("Task {id} selects an unavailable member"))?;
        if let Some(allowed) = member["allowedTaskTypes"]
            .as_array()
            .filter(|allowed| !allowed.is_empty())
        {
            if !allowed
                .iter()
                .any(|kind| kind == "*" || *kind == task["taskType"])
            {
                return Err(format!("Task {id} is not allowed for member {member_id}"));
            }
        }
        string(task, "title")?;
        string(task, "objective")?;
        let node_id = key(&id);
        let display = member["displayName"]
            .as_str()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(member_id);
        let duplicates = team["members"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|member| {
                member["enabled"] == true
                    && member["displayName"]
                        .as_str()
                        .filter(|name| !name.trim().is_empty())
                        .or(member["id"].as_str())
                        == Some(display)
            })
            .count();
        let role = if duplicates > 1 {
            format!(
                "{display} · {}",
                &format!("{:x}", Sha256::digest(member_id.as_bytes()))[..12]
            )
        } else {
            display.to_owned()
        };
        if bindings
            .get(&role)
            .is_some_and(|binding: &Value| binding["memberId"] != member_id)
        {
            return Err(
                "Configured member labels collided while preparing workflow bindings".into(),
            );
        }
        if task_nodes.values().any(|value| value == &node_id) {
            return Err("Task identities collided while preparing the workflow".into());
        }
        if let Some(session) = task["targetSessionId"].as_str() {
            if session.trim().is_empty() {
                return Err(format!("Task {id} has an empty continuation session"));
            }
            target_sessions.insert(node_id.clone(), session.to_owned());
        }
        let request = OrchestrationPromptBuilder::delegated_task(task, team, &[]);
        let request = if matches!(task["status"].as_str(), Some("failed" | "cancelled")) {
            format!("An explicit retry was requested for this unfinished task. Preserve existing work. The task status and execution references below describe the previous attempt; finish the remaining work and submit for this new workflow instance.\n\n{request}")
        } else {
            request
        };
        requests.insert(node_id.clone(), json!(request));
        metadata.insert(node_id.clone(),json!({"taskId":id,"title":task["title"],"assignedMemberId":member_id,"attempt":task["attempt"].as_u64().unwrap_or(1)}));
        bindings.insert(role, json!({"memberId":member_id}));
        task_nodes.insert(id.clone(), node_id);
        by_id.insert(id, task);
    }
    let mut dependencies: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut successors: BTreeMap<String, Vec<String>> = tasks
        .iter()
        .map(|task| (task["id"].as_str().unwrap().to_owned(), vec![]))
        .collect();
    let mut accepted = Map::new();
    for task in tasks {
        let id = task["id"].as_str().unwrap();
        let mut seen = BTreeSet::new();
        let mut pending = vec![];
        let raw = task.get("dependencies").filter(|value| !value.is_null());
        if raw.is_some_and(|value| !value.is_array()) {
            return Err(format!("Task {id} dependencies must be an array"));
        }
        for dependency in raw.and_then(Value::as_array).into_iter().flatten() {
            let dependency = dependency
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("Task {id} has an invalid dependency"))?;
            if !seen.insert(dependency) {
                continue;
            }
            if dependency == id {
                return Err(format!("Task {id} depends on itself"));
            }
            if by_id.contains_key(dependency) {
                pending.push(dependency.to_owned());
                successors.get_mut(dependency).unwrap().push(id.to_owned());
            } else {
                let evidence = completed
                    .get(dependency)
                    .filter(|evidence| {
                        evidence["taskId"] == dependency
                            && evidence["projectRunId"] == project_run_id
                            && evidence["status"] == "completed"
                            && evidence.get("result").is_some()
                            && (evidence["resultMessageId"]
                                .as_str()
                                .is_some_and(|id| !id.is_empty())
                                || evidence["runId"].as_str().is_some_and(|id| !id.is_empty()))
                    })
                    .ok_or_else(|| {
                        format!("Task {id} has no accepted evidence for dependency {dependency}")
                    })?;
                accepted.insert(key(dependency), evidence.clone());
            }
        }
        dependencies.insert(id.into(), pending);
    }
    // Reject a cycle before constructing a partial or unreachable graph.
    let mut remaining: BTreeMap<String, usize> = dependencies
        .iter()
        .map(|(id, dependencies)| (id.clone(), dependencies.len()))
        .collect();
    let mut ready: Vec<String> = tasks
        .iter()
        .filter(|task| remaining[task["id"].as_str().unwrap()] == 0)
        .map(|task| task["id"].as_str().unwrap().into())
        .collect();
    let mut visited = 0;
    while let Some(id) = ready.pop() {
        visited += 1;
        for target in &successors[&id] {
            let count = remaining.get_mut(target).unwrap();
            *count -= 1;
            if *count == 0 {
                ready.push(target.clone());
            }
        }
    }
    if visited != tasks.len() {
        return Err("The legacy task dependencies contain a cycle".into());
    }
    let gateway = |id: &str| format!("dispatch_{}", &task_nodes[id]);
    let producer = |id: &str| {
        if successors[id].len() > 1 {
            gateway(id)
        } else {
            task_nodes[id].clone()
        }
    };
    let target = |id: &str| {
        if dependencies[id].len() > 1 {
            format!("join_{}", &task_nodes[id])
        } else {
            task_nodes[id].clone()
        }
    };
    let roots: Vec<_> = tasks
        .iter()
        .filter(|task| dependencies[task["id"].as_str().unwrap()].is_empty())
        .collect();
    let leaves: Vec<_> = tasks
        .iter()
        .filter(|task| successors[task["id"].as_str().unwrap()].is_empty())
        .collect();
    let mut nodes = vec![
        json!({"id":"main","kind":"main","name":"主 Agent","dispatch":"all","exits":roots.iter().enumerate().map(|(index,_)|json!({"id":format!("start_{index}"),"name":format!("派发 {}",index+1)})).collect::<Vec<_>>()}),
    ];
    let mut edges:Vec<Value>=roots.iter().enumerate().map(|(index,task)|json!({"from":["main",format!("start_{index}")],"to":task_nodes[task["id"].as_str().unwrap()]})).collect();
    for task in tasks {
        let id = task["id"].as_str().unwrap();
        let node_id = &task_nodes[id];
        let mut prompt = format!("{{{{input.requests.{node_id}}}}}");
        let mut seen = BTreeSet::new();
        for dependency in task["dependencies"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !seen.insert(dependency) {
                continue;
            }
            if let Some(source) = task_nodes.get(dependency) {
                prompt.push_str(&format!("\n\nCompleted dependency:\n{{{{input.metadata.{source}}}}}\nResult:\n{{{{steps.{source}.latest.result}}}}"));
            } else {
                prompt.push_str(&format!(
                    "\n\nPreviously completed dependency:\n{{{{input.completed.{} }}}}",
                    key(dependency)
                ));
            }
        }
        prompt.push_str("\n\nSubmit the named outlet 完成 with result.summary containing the task outcome, checks and any remaining blockers.");
        let role = bindings
            .iter()
            .find(|(_, binding)| binding["memberId"] == task["assignedMemberId"])
            .map(|(role, _)| role)
            .unwrap();
        let mut node = json!({"id":node_id,"kind":"agent","name":task["title"],"role":role,"prompt":prompt,"outputs":{"summary":"text"},"exits":[{"id":"done","name":"完成"}]});
        if task["allowedPaths"]
            .as_array()
            .is_some_and(|paths| !paths.is_empty())
        {
            node["workspace"] = json!({"allowedPaths":task["allowedPaths"]});
        }
        let explicit = task
            .get("verificationTemplates")
            .filter(|ids| !ids.is_null());
        if explicit.is_some_and(|ids| !ids.is_array()) {
            return Err(format!("Task {id} verificationTemplates must be an array"));
        }
        let mut checks = explicit.and_then(Value::as_array).cloned();
        for criterion in task["acceptanceCriteria"].as_array().into_iter().flatten() {
            if let Some(template) = criterion
                .get("commandTemplateId")
                .filter(|value| !value.is_null())
            {
                let template = template
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        format!("Task {id} has an invalid acceptance command template")
                    })?;
                let checks = checks.get_or_insert_with(Vec::new);
                if !checks.iter().any(|id| id == template) {
                    checks.push(json!(template));
                }
            }
        }
        if let Some(ids) = checks {
            if !node["workspace"].is_object() {
                node["workspace"] = json!({});
            }
            node["workspace"]["verificationTemplates"] = json!(ids);
        }
        nodes.push(node);
        if dependencies[id].len() > 1 {
            nodes.push(json!({"id":target(id),"kind":"join","name":format!("{} · 等待依赖",task["title"].as_str().unwrap()),"scope":"main","sources":dependencies[id].iter().map(|source|producer(source)).collect::<Vec<_>>(),"exits":[{"id":"done","name":"依赖齐备"}]}));
            edges.push(json!({"from":[target(id),"done"],"to":node_id}));
        }
        let destinations: Vec<_> = successors[id]
            .iter()
            .map(|successor| target(successor))
            .collect();
        if destinations.len() > 1 {
            nodes.push(json!({"id":gateway(id),"kind":"dispatch","name":format!("{} · 分发",task["title"].as_str().unwrap()),"exits":destinations.iter().enumerate().map(|(index,_)|json!({"id":format!("to_{index}"),"name":format!("交付 {}",index+1)})).collect::<Vec<_>>()}));
            edges.push(json!({"from":[node_id,"done"],"to":gateway(id)}));
            for (index, destination) in destinations.iter().enumerate() {
                edges.push(json!({"from":[gateway(id),format!("to_{index}")],"to":destination}));
            }
        } else {
            let destination = destinations.first().cloned().unwrap_or_else(|| {
                if leaves.len() > 1 {
                    "return_join".into()
                } else {
                    "$return".into()
                }
            });
            edges.push(json!({"from":[node_id,"done"],"to":destination}));
        }
    }
    if leaves.len() > 1 {
        nodes.push(json!({"id":"return_join","kind":"join","name":"收齐任务结果","scope":"main","sources":leaves.iter().map(|task|producer(task["id"].as_str().unwrap())).collect::<Vec<_>>(),"exits":[{"id":"done","name":"任务齐备"}]}));
        edges.push(json!({"from":["return_join","done"],"to":"$return"}));
    }
    let definition:Definition=serde_json::from_value(json!({"schemaVersion":1,"id":format!("legacy-{batch_id}"),"name":project_run["goal"].as_str().unwrap_or("团队任务"),"entry":"main","inputs":{"requests":"json","metadata":"json","completed":"json"},"nodes":nodes,"edges":edges,"limits":limits})).map_err(|error|error.to_string())?;
    definition.validate()?;
    Ok(TaskWorkflowPlan {
        definition,
        inputs: json!({"requests":requests,"metadata":metadata,"completed":accepted}),
        bindings: Value::Object(bindings),
        task_nodes,
        target_sessions,
    })
}

#[cfg(test)]
#[path = "workflow_plan_tests.rs"]
mod tests;
