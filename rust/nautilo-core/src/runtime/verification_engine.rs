//! Verification engine — port of runtime/verification-engine.ts.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::database::{lock, Database, Repositories};
use crate::errors::{now_iso, CoreError, CoreResult, ErrorCode};
use crate::process_runtime::{ProcessEvent, ProcessRequest, ProcessRuntime};
use crate::runtime::artifact_service::{artifact_input, ArtifactService};
use crate::runtime::security::environment_policy::build_environment;
use crate::runtime::security::{CommandPolicyService, RedactionService};

pub struct VerificationContext {
    pub project_run_id: String,
    pub task_id: Option<String>,
    pub session_id: String,
    pub scope: String,
    pub template_ids: Option<Vec<String>>,
    pub on_started: Option<Box<dyn Fn(&Value, &str) + Send>>,
    pub on_finished: Option<Box<dyn Fn(&Value) + Send>>,
}

pub struct VerificationEngine {
    db: Arc<Mutex<Database>>,
    artifacts: ArtifactService,
    command_policies: Arc<CommandPolicyService>,
    redaction: RedactionService,
}

impl VerificationEngine {
    pub fn new(db: Arc<Mutex<Database>>, redaction: RedactionService, command_policies: Arc<CommandPolicyService>) -> Self {
        let artifacts = ArtifactService::new(db.clone());
        Self { db, artifacts, command_policies, redaction }
    }

    pub async fn run(&self, project: &Value, workspace_path: &str, context: VerificationContext) -> CoreResult<Vec<Value>> {
        let registered = project.get("verificationTemplates").and_then(Value::as_array).cloned().unwrap_or_default();
        let selected: Vec<Value> = match &context.template_ids {
            Some(ids) if !ids.is_empty() => {
                let mut chosen = vec![];
                for id in ids {
                    let template = registered.iter().find(|template| template.get("id").and_then(Value::as_str) == Some(id.as_str()));
                    let Some(template) = template else {
                        let mut details = Map::new();
                        details.insert("commandTemplateId".to_string(), json!(id));
                        return Err(CoreError::details(ErrorCode::IpcInvalidRequest, details));
                    };
                    chosen.push(template.clone());
                }
                chosen
            }
            _ => registered
                .into_iter()
                .filter(|template| {
                    template
                        .get("scopes")
                        .and_then(Value::as_array)
                        .is_some_and(|scopes| scopes.iter().any(|scope| scope.as_str() == Some(context.scope.as_str())))
                })
                .collect(),
        };
        let mut results = vec![];
        for template in selected {
            let verification_id = Uuid::new_v4().to_string();
            if let Some(on_started) = &context.on_started {
                on_started(&template, &verification_id);
            }
            let cwd = safe_cwd(workspace_path, template.get("relativeCwd").and_then(Value::as_str))?;
            let evaluation = self.command_policies.evaluate(&json!({
                "policyId": project.get("policyId").cloned().unwrap_or_else(|| json!("default")),
                "command": template.get("command").cloned().unwrap_or(Value::Null),
                "args": template.get("args").cloned().unwrap_or_else(|| json!([])),
                "source": "verification"
            }))?;
            let action = evaluation.get("action").and_then(Value::as_str).unwrap_or("");
            if action == "blocked" || action == "approval" {
                let mut details = Map::new();
                details.insert("commandTemplateId".to_string(), template.get("id").cloned().unwrap_or(Value::Null));
                details.insert("ruleId".to_string(), evaluation.get("ruleId").cloned().unwrap_or(Value::Null));
                return Err(CoreError::details(
                    if action == "blocked" { ErrorCode::CommandBlocked } else { ErrorCode::CommandApprovalRequired },
                    details,
                ));
            }
            let started = std::time::Instant::now();
            let timeout_ms = template.get("timeoutMs").and_then(Value::as_u64).unwrap_or(60_000);
            let policy = self.command_policies.get(project.get("policyId").and_then(Value::as_str).unwrap_or("default"))?;
            let started_process = ProcessRuntime::start(&ProcessRequest {
                command: template.get("command").and_then(Value::as_str).unwrap_or("").to_string(),
                args: template
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|args| args.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default(),
                cwd: Some(cwd.clone()),
                env: Some(build_environment(Some(&policy), Default::default())),
                timeout_ms: Some(timeout_ms),
                idle_timeout_ms: Some(timeout_ms.min(5 * 60_000)),
                max_output_bytes: Some(5 * 1024 * 1024),
            })
            .map_err(|e| CoreError::reason(ErrorCode::IpcInternalError, e.to_string()))?;
            let mut events = started_process.events;
            let mut output = String::new();
            let mut exit_code = -1;
            while let Some(event) = events.recv().await {
                match event {
                    ProcessEvent::Stdout(text) | ProcessEvent::Stderr(text) => output.push_str(&text),
                    ProcessEvent::Exit { exit_code: code, .. } => exit_code = code.unwrap_or(-1),
                    ProcessEvent::Timeout { reason } => output.push_str(&format!("\n[Nautilo] {}\n", reason.as_str())),
                    ProcessEvent::Error(message) => output.push_str(&format!("\n[Nautilo] {message}\n")),
                }
            }
            let output = self.redaction.text(&output);
            let artifact = self.artifacts.save(
                &artifact_input(
                    "test_report",
                    &format!("{}.log", template.get("name").and_then(Value::as_str).unwrap_or("verification")),
                    Some(&context.project_run_id),
                    context.task_id.as_deref(),
                    Some(&context.session_id),
                    Some(json!({
                        "commandTemplateId": template.get("id").cloned().unwrap_or(Value::Null),
                        "exitCode": exit_code
                    })),
                ),
                &output,
            )?;
            let mut result = Map::new();
            result.insert("id".to_string(), json!(verification_id));
            result.insert("projectRunId".to_string(), json!(context.project_run_id));
            if let Some(task_id) = &context.task_id {
                result.insert("taskId".to_string(), json!(task_id));
            }
            result.insert("commandTemplateId".to_string(), template.get("id").cloned().unwrap_or(Value::Null));
            result.insert("command".to_string(), template.get("command").cloned().unwrap_or(Value::Null));
            result.insert("args".to_string(), template.get("args").cloned().unwrap_or_else(|| json!([])));
            result.insert("cwd".to_string(), json!(cwd));
            result.insert("passed".to_string(), json!(exit_code == 0));
            result.insert("required".to_string(), template.get("required").cloned().unwrap_or(json!(true)));
            result.insert("exitCode".to_string(), json!(exit_code));
            result.insert("durationMs".to_string(), json!(started.elapsed().as_millis() as i64));
            result.insert("outputArtifactId".to_string(), artifact.get("id").cloned().unwrap_or(Value::Null));
            result.insert("createdAt".to_string(), json!(now_iso()));
            let result = Value::Object(result);
            Repositories::new(&lock(&self.db).raw).verifications().save(&result)?;
            if let Some(on_finished) = &context.on_finished {
                on_finished(&result);
            }
            let passed = result.get("passed").and_then(Value::as_bool).unwrap_or(false);
            let required = result.get("required").and_then(Value::as_bool).unwrap_or(true);
            results.push(result);
            if !passed && required {
                break;
            }
        }
        Ok(results)
    }

    pub fn passed(results: &[Value]) -> bool {
        results.iter().all(|result| {
            result.get("passed").and_then(Value::as_bool).unwrap_or(false)
                || !result.get("required").and_then(Value::as_bool).unwrap_or(true)
        })
    }
}

fn safe_cwd(workspace_path: &str, relative_cwd: Option<&str>) -> CoreResult<String> {
    let root = std::fs::canonicalize(workspace_path).unwrap_or_else(|_| Path::new(workspace_path).to_path_buf());
    let cwd = match relative_cwd {
        Some(relative) => root.join(relative),
        None => root.clone(),
    };
    if cwd != root && !cwd.starts_with(&root) {
        let mut details = Map::new();
        details.insert("relativeCwd".to_string(), relative_cwd.map(Value::from).unwrap_or(Value::Null));
        return Err(CoreError::details(ErrorCode::PathPolicyViolation, details));
    }
    Ok(cwd.to_string_lossy().into_owned())
}
