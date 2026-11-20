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
use crate::runtime::security::{ApprovalService, CommandPolicyService, RedactionService};
use sha2::{Digest,Sha256};

pub struct VerificationContext {
    pub project_run_id: String,
    pub task_id: Option<String>,
    pub session_id: String,
    pub scope: String,
    pub template_ids: Option<Vec<String>>,
    pub on_started: Option<Box<dyn Fn(&Value, &str) + Send>>,
    pub on_finished: Option<Box<dyn Fn(&Value) + Send>>,
    pub cancelled: Option<tokio::sync::watch::Receiver<bool>>,
    pub workflow: Option<Value>,
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

    fn selected(&self, project: &Value, context: &VerificationContext) -> CoreResult<Vec<Value>> {
        let registered = project.get("verificationTemplates").and_then(Value::as_array).cloned().unwrap_or_default();
        let selected: Vec<Value> = match &context.template_ids {
            Some(ids) => {
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
        Ok(selected)
    }
    pub fn preflight(&self, project: &Value, workspace: &str, context: &VerificationContext) -> CoreResult<Vec<Value>> {
        let approvals=ApprovalService::new(self.db.clone());
        let mut pending=vec![];
        for template in self.selected(project,context)? {
            let cwd=safe_cwd(workspace,template["relativeCwd"].as_str())?;
            let evaluation=self.command_policies.evaluate(&json!({"policyId":project["policyId"],"command":template["command"],"args":template["args"],"source":"verification"}))?;
            if evaluation["action"] == "blocked" { return Err(CoreError::reason(ErrorCode::CommandBlocked,format!("Verification {} is blocked by the project command policy",template["id"]))); }
            let operation=verification_operation(&template,&cwd);
            if evaluation["action"] == "approval" && !approvals.has_authorization(&operation,project["id"].as_str(),Some(&context.project_run_id),context.task_id.as_deref(),Some(&context.session_id))? {
                pending.push(approvals.request(&json!({"category":"command","operation":operation,"summary":format!("Verify {}: {} {}",template["name"].as_str().unwrap_or("changes"),template["command"].as_str().unwrap_or(""),template["args"]),"projectId":project["id"],"projectRunId":context.project_run_id,"taskId":context.task_id,"sessionId":context.session_id,"requestedBy":"workflow-engine","commandTemplateId":template["id"],"command":template["command"],"args":template["args"],"cwd":cwd}))?);
            }
        }
        Ok(pending)
    }
    pub async fn run(&self, project: &Value, workspace_path: &str, mut context: VerificationContext) -> CoreResult<Vec<Value>> {
        let selected=self.selected(project,&context)?;
        let mut results = vec![];
        for template in selected {
            if context.cancelled.as_ref().is_some_and(|cancel|*cancel.borrow()) { return Err(CoreError::reason(ErrorCode::RecoveryRequired,"Verification was cancelled before the next command")); }
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
            let authorized=action != "approval" || ApprovalService::new(self.db.clone()).authorize(&verification_operation(&template,&cwd),project["id"].as_str(),Some(&context.project_run_id),context.task_id.as_deref(),Some(&context.session_id))?;
            if action == "blocked" || !authorized {
                let mut details = Map::new();
                details.insert("commandTemplateId".to_string(), template.get("id").cloned().unwrap_or(Value::Null));
                details.insert("ruleId".to_string(), evaluation.get("ruleId").cloned().unwrap_or(Value::Null));
                details.insert("completedVerificationIds".into(),json!(results.iter().filter_map(|result:&Value|result["id"].as_str()).collect::<Vec<_>>()));
                return Err(CoreError::details(
                    if action == "blocked" { ErrorCode::CommandBlocked } else { ErrorCode::CommandApprovalRequired },
                    details,
                ));
            }
            let started = std::time::Instant::now();
            let timeout_ms = template.get("timeoutMs").and_then(Value::as_u64).unwrap_or(60_000);
            let policy = self.command_policies.get(project.get("policyId").and_then(Value::as_str).unwrap_or("default"))?;
            let mut receipt = json!({"id":verification_id,"projectRunId":context.project_run_id,"taskId":context.task_id,"commandTemplateId":template["id"],"workflow":context.workflow,"cwd":cwd,"status":"starting","createdAt":now_iso()});
            if context.workflow.is_some() {
                Repositories::new(&lock(&self.db).raw).verifications().save(&receipt)?;
            }
            let process = ProcessRuntime::start(&ProcessRequest {
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
            });
            let started_process = match process {
                Ok(process) => process,
                Err(error) => {
                    if context.workflow.is_some() {
                        receipt["status"] = json!("launch_failed");
                        Repositories::new(&lock(&self.db).raw).verifications().save(&receipt)?;
                    }
                    return Err(CoreError::reason(ErrorCode::IpcInternalError, error.to_string()));
                }
            };
            if context.workflow.is_some() {
                receipt["status"] = json!("running");
                receipt["processId"] = json!(started_process.handle.pid);
                receipt["processIdentity"] = json!(started_process.handle.pid.and_then(|pid| process_identity(pid).ok().flatten()));
                let saved = Repositories::new(&lock(&self.db).raw).verifications().save(&receipt);
                if let Err(error) = saved {
                    started_process.handle.cancel().await;
                    return Err(error);
                }
            }
            let mut events = started_process.events;
            let mut output = String::new();
            let mut exit_code = -1;
            let mut stopped=false;
            loop {
                let event=tokio::select! {
                    event=events.recv()=>event,
                    _=verification_cancelled(&mut context.cancelled), if !stopped=>{
                        stopped=true;started_process.handle.cancel().await;output.push_str("\n[Nautilo] Verification cancelled\n");continue;
                    }
                };
                let Some(event)=event else {break};
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
            if context.workflow.is_some() {
                result.insert("workflow".into(), json!(context.workflow));
                result.insert("status".into(), json!("finished"));
                result.insert("processId".into(), receipt["processId"].clone());
                result.insert("processIdentity".into(), receipt["processIdentity"].clone());
            }
            result.insert("projectRunId".to_string(), json!(context.project_run_id));
            if let Some(task_id) = &context.task_id {
                result.insert("taskId".to_string(), json!(task_id));
            }
            result.insert("commandTemplateId".to_string(), template.get("id").cloned().unwrap_or(Value::Null));
            result.insert("command".to_string(), template.get("command").cloned().unwrap_or(Value::Null));
            result.insert("args".to_string(), template.get("args").cloned().unwrap_or_else(|| json!([])));
            result.insert("cwd".to_string(), json!(cwd));
            result.insert("passed".to_string(), json!(exit_code == 0 && !stopped));
            if stopped { result.insert("cancelled".into(),json!(true)); }
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
            if stopped { break; }
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

/// Read-only identity check. A reused PID alone never proves a process survived.
#[cfg(windows)]
pub(crate) fn process_identity(pid: u32) -> std::io::Result<Option<String>> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            let error = std::io::Error::last_os_error();
            // ERROR_INVALID_PARAMETER means this positive PID does not exist.
            return if pid > 0 && error.raw_os_error() == Some(87) { Ok(None) } else { Err(error) };
        }
        let mut created = FILETIME { dwLowDateTime:0, dwHighDateTime:0 };
        let mut exited = created;
        let mut kernel = created;
        let mut user = created;
        let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
        let failure = std::io::Error::last_os_error();
        CloseHandle(handle);
        if ok == 0 { return Err(failure); }
        if exited.dwLowDateTime != 0 || exited.dwHighDateTime != 0 { return Ok(None); }
        Ok(Some(format!("{:08x}{:08x}",created.dwHighDateTime,created.dwLowDateTime)))
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn process_identity(pid: u32) -> std::io::Result<Option<String>> {
    let info = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(info) => info,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let fields = info.rsplit_once(')').map(|(_, fields)| fields).unwrap_or("").split_whitespace();
    if fields.clone().next() == Some("Z") { return Ok(None); }
    let started = fields.skip(19).next().ok_or_else(|| std::io::Error::other("Process identity missing"))?;
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    Ok(Some(format!("{}:{started}",boot.trim())))
}

#[cfg(all(not(windows), not(target_os = "linux")))]
pub(crate) fn process_identity(_pid: u32) -> std::io::Result<Option<String>> {
    Err(std::io::Error::other("This platform does not provide verifier identity checks"))
}

fn safe_cwd(workspace_path: &str, relative_cwd: Option<&str>) -> CoreResult<String> {
    let root = std::fs::canonicalize(workspace_path).unwrap_or_else(|_| Path::new(workspace_path).to_path_buf());
    let cwd = match relative_cwd {
        Some(relative) => root.join(relative),
        None => root.clone(),
    };
    let cwd=std::fs::canonicalize(&cwd).map_err(|error|CoreError::reason(ErrorCode::PathPolicyViolation,error.to_string()))?;
    if cwd != root && !cwd.starts_with(&root) {
        let mut details = Map::new();
        details.insert("relativeCwd".to_string(), relative_cwd.map(Value::from).unwrap_or(Value::Null));
        return Err(CoreError::details(ErrorCode::PathPolicyViolation, details));
    }
    Ok(cwd.to_string_lossy().into_owned())
}
fn verification_operation(template: &Value, cwd: &str) -> String {
    format!("verification.exec:{:x}",Sha256::digest(json!({"command":template["command"],"args":template["args"],"cwd":cwd}).to_string().as_bytes()))
}
async fn verification_cancelled(cancelled: &mut Option<tokio::sync::watch::Receiver<bool>>) {
    if let Some(cancelled)=cancelled {
        loop {
            if *cancelled.borrow() {return;}
            if cancelled.changed().await.is_err() { std::future::pending::<()>().await; }
        }
    } else { std::future::pending::<()>().await; }
}
