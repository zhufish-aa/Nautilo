//! Git workflow service — port of runtime/git-workflow-service.ts.
//! Git/verification use cases used by orchestration; no planner logic here.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::database::{Database, Repositories};
use crate::errors::{not_found, now_iso, CoreError, CoreResult, ErrorCode};

fn git_fail(error: anyhow::Error) -> CoreError {
    CoreError::reason(ErrorCode::IpcInternalError, error.to_string())
}
use crate::runtime::artifact_service::{artifact_input, ArtifactService};
use crate::runtime::event_service::EventService;
use crate::runtime::git::{change_collector, merge_queue, path_policy, repository_service, worktree_service::WorktreeService};
use crate::runtime::verification_engine::{VerificationContext, VerificationEngine};

pub struct GitWorkflowService {
    db: Arc<Mutex<Database>>,
    events: Arc<EventService>,
    worktrees: WorktreeService,
    artifacts: ArtifactService,
    verification: VerificationEngine,
}

impl GitWorkflowService {
    pub fn new(db: Arc<Mutex<Database>>, events: Arc<EventService>, worktree_root: &str, verification: VerificationEngine) -> Self {
        let artifacts = ArtifactService::new(db.clone());
        Self { db, events, worktrees: WorktreeService::new(worktree_root), artifacts, verification }
    }

    fn require_project(&self, project_id: &str) -> CoreResult<Value> {
        Repositories::new(&self.db.lock().unwrap().raw)
            .projects()
            .get(project_id)?
            .ok_or_else(|| not_found("project", project_id))
    }

    pub async fn initialize_run(&self, project_run: &Value) -> CoreResult<Value> {
        let project = self.require_project(project_run.get("projectId").and_then(Value::as_str).unwrap_or(""))?;
        let isolated = project_run.get("workspaceMode").and_then(Value::as_str) == Some("git_isolated")
            && project.get("repositoryType").and_then(Value::as_str) == Some("git");
        if !isolated {
            return Ok(with_shared_workspace(project_run, &project));
        }
        let result = async {
            let repository = repository_service::inspect(project.get("rootPath").and_then(Value::as_str).unwrap_or("")).await.map_err(git_fail)?;
            let Some(head_commit) = repository.head_commit else {
                return Ok(with_shared_workspace(project_run, &project));
            };
            let info = self
                .worktrees
                .create_run(&project, project_run.get("id").and_then(Value::as_str).unwrap_or(""))
                .await?;
            let mut updated = project_run.as_object().cloned().unwrap_or_default();
            updated.insert("workspacePath".to_string(), json!(info.path));
            updated.insert("branchName".to_string(), json!(info.branch_name));
            updated.insert("baseCommit".to_string(), json!(info.base_commit));
            updated.insert("baseBranch".to_string(), json!(repository.branch));
            Ok::<Value, anyhow::Error>(Value::Object(updated))
        }
        .await;
        // Git is an optional isolation capability; failures fall back to the
        // shared workspace rather than blocking the run.
        Ok(result.unwrap_or_else(|_| with_shared_workspace(project_run, &project)))
    }

    pub async fn initialize_task(&self, project_run: &Value, task: &Value) -> CoreResult<Value> {
        let project = self.require_project(project_run.get("projectId").and_then(Value::as_str).unwrap_or(""))?;
        let shared = project_run
            .get("workspacePath")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| project.get("rootPath").and_then(Value::as_str).unwrap_or("").to_string());
        let isolated = project_run.get("workspaceMode").and_then(Value::as_str) == Some("git_isolated")
            && project.get("repositoryType").and_then(Value::as_str) == Some("git")
            && project_run.get("branchName").is_some()
            && project_run.get("baseCommit").is_some();
        let fallback = |task: &Value| {
            let mut updated = task.as_object().cloned().unwrap_or_default();
            updated.insert("workspacePath".to_string(), json!(shared));
            updated.insert("updatedAt".to_string(), json!(now_iso()));
            Value::Object(updated)
        };
        if !isolated {
            return Ok(fallback(task));
        }
        match self.worktrees.create_task(&project, project_run, task).await {
            Ok(info) => {
                let mut updated = task.as_object().cloned().unwrap_or_default();
                updated.insert("workspacePath".to_string(), json!(info.path));
                updated.insert("branchName".to_string(), json!(info.branch_name));
                updated.insert("baseCommit".to_string(), json!(info.base_commit));
                updated.insert("updatedAt".to_string(), json!(now_iso()));
                Ok(Value::Object(updated))
            }
            Err(_) => Ok(fallback(task)),
        }
    }

    pub fn working_directory(&self, project_run: &Value, task: Option<&Value>) -> Option<String> {
        if let Some(path) = task.and_then(|t| t.get("workspacePath")).and_then(Value::as_str) {
            return Some(path.to_string());
        }
        if let Some(path) = project_run.get("workspacePath").and_then(Value::as_str) {
            return Some(path.to_string());
        }
        self.require_project(project_run.get("projectId").and_then(Value::as_str).unwrap_or(""))
            .ok()
            .and_then(|project| project.get("rootPath").and_then(Value::as_str).map(str::to_string))
    }

    pub async fn finalize_task(
        &self,
        project_run: &Value,
        task: &Value,
        task_session: &Value,
        main_session: &Value,
    ) -> CoreResult<Value> {
        let project = self.require_project(project_run.get("projectId").and_then(Value::as_str).unwrap_or(""))?;
        let project_run_id = project_run.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let task_id = task.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let isolated = project_run.get("workspaceMode").and_then(Value::as_str) == Some("git_isolated")
            && project.get("repositoryType").and_then(Value::as_str) == Some("git")
            && task.get("workspacePath").is_some()
            && task.get("branchName").is_some()
            && project_run.get("workspacePath").is_some()
            && project_run.get("branchName").is_some();
        let template_ids: Vec<String> = task
            .get("acceptanceCriteria")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|criterion| criterion.get("commandTemplateId").and_then(Value::as_str).map(str::to_string))
            .collect();
        if !isolated {
            let workspace = task
                .get("workspacePath")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| project.get("rootPath").and_then(Value::as_str).unwrap_or("").to_string());
            let results = self
                .verify(&project, &workspace, task_session, &project_run_id, Some(&task_id), "task", Some(template_ids))
                .await?;
            return Ok(if VerificationEngine::passed(&results) {
                task_finalize_ok(task, vec![], results, None)
            } else {
                task_finalize_failure(task, "verification", "Required verification failed", vec![], results)
            });
        }

        let workspace = task.get("workspacePath").and_then(Value::as_str).unwrap_or("").to_string();
        let files = change_collector::collect(&workspace).await.unwrap_or_default();
        let paths: Vec<String> = files.iter().filter_map(|f| f.get("path").and_then(Value::as_str).map(str::to_string)).collect();
        let allowed: Vec<String> = task
            .get("allowedPaths")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        let violations = path_policy::validate(&workspace, &paths, &allowed);
        let diff_artifact = if files.is_empty() {
            None
        } else {
            Some(self.save_diff(&project_run_id, Some(&task_id), task_session, task.get("title").and_then(Value::as_str).unwrap_or("task"), &files)?)
        };
        self.emit_files(task_session, &project_run_id, Some(&task_id), &files, diff_artifact.as_ref());
        if !violations.is_empty() {
            let mut patched = task.as_object().cloned().unwrap_or_default();
            if let Some(artifact) = &diff_artifact {
                patched.insert("diffArtifactId".to_string(), artifact.get("id").cloned().unwrap_or(Value::Null));
            }
            patched.insert("pathViolations".to_string(), json!(violations));
            return Ok(task_finalize_failure(
                &Value::Object(patched),
                "path",
                &format!("Changed paths are outside allowedPaths: {}", violations.join(", ")),
                files,
                vec![],
            ));
        }

        let verification_results = self
            .verify(&project, &workspace, task_session, &project_run_id, Some(&task_id), "task", Some(template_ids))
            .await?;
        if !VerificationEngine::passed(&verification_results) {
            let patched = with_result_ids(task, diff_artifact.as_ref(), &verification_results);
            return Ok(task_finalize_failure(&patched, "verification", "Required task verification failed", files, verification_results));
        }

        let result_commit = self
            .worktrees
            .commit_all(&workspace, &format!("agenthub({task_id}): {}", task.get("title").and_then(Value::as_str).unwrap_or("")))
            .await
            .ok()
            .flatten()
            .or_else(|| task.get("resultCommit").and_then(Value::as_str).map(str::to_string));
        let Some(result_commit) = result_commit else {
            let patched = with_result_ids(task, diff_artifact.as_ref(), &verification_results);
            return Ok(task_finalize_ok(&patched, files, verification_results, None));
        };
        if let Some(base_commit) = task.get("baseCommit").and_then(Value::as_str) {
            let _ = self
                .save_commit_diff(
                    &project_run_id,
                    Some(&task_id),
                    task_session,
                    task.get("title").and_then(Value::as_str).unwrap_or("task"),
                    &workspace,
                    base_commit,
                    &result_commit,
                )
                .await;
        }
        let task_branch = task.get("branchName").and_then(Value::as_str).unwrap_or("");
        let run_branch = project_run.get("branchName").and_then(Value::as_str).unwrap_or("");
        let run_workspace = project_run.get("workspacePath").and_then(Value::as_str).unwrap_or("");
        let _ = self.events.append_for_session(
            main_session,
            &json!({ "projectRunId": project_run_id, "taskId": task_id }),
            "git.merge_started",
            json!({ "sourceBranch": task_branch, "targetBranch": run_branch, "taskId": task_id }),
        );
        let merged = merge_queue::merge_task(run_workspace, task_branch, run_branch).await.map_err(git_fail)?;
        if !merged.merged {
            let conflict_paths: Vec<Value> = merged.conflicts.iter().filter_map(|c| c.get("path").cloned()).collect();
            let _ = self.events.append_for_session(
                main_session,
                &json!({ "projectRunId": project_run_id, "taskId": task_id }),
                "git.conflict",
                json!({ "sourceBranch": task_branch, "targetBranch": run_branch, "paths": conflict_paths, "taskId": task_id }),
            );
            let mut patched = with_result_ids(task, diff_artifact.as_ref(), &verification_results)
                .as_object()
                .cloned()
                .unwrap_or_default();
            patched.insert("resultCommit".to_string(), json!(result_commit));
            patched.insert("conflicts".to_string(), Value::Array(merged.conflicts.clone()));
            return Ok(task_finalize_failure(
                &Value::Object(patched),
                "conflict",
                &format!(
                    "Merge conflict: {}",
                    merged.conflicts.iter().filter_map(|c| c.get("path").and_then(Value::as_str)).collect::<Vec<_>>().join(", ")
                ),
                files,
                verification_results,
            ));
        }

        let merge_verification = self.verify(&project, run_workspace, main_session, &project_run_id, Some(&task_id), "merge", None).await?;
        if !VerificationEngine::passed(&merge_verification) {
            if let Some(previous) = &merged.previous_commit {
                let _ = merge_queue::rollback(run_workspace, previous).await;
            }
            let all: Vec<Value> = verification_results.into_iter().chain(merge_verification).collect();
            let mut patched = with_result_ids(task, diff_artifact.as_ref(), &all).as_object().cloned().unwrap_or_default();
            patched.insert("resultCommit".to_string(), json!(result_commit));
            return Ok(task_finalize_failure(
                &Value::Object(patched),
                "verification",
                "Post-merge verification failed; isolated run branch was rolled back",
                files,
                all,
            ));
        }
        let _ = self.events.append_for_session(
            main_session,
            &json!({ "projectRunId": project_run_id, "taskId": task_id }),
            "git.merge_finished",
            json!({ "sourceBranch": task_branch, "targetBranch": run_branch, "commit": merged.commit, "taskId": task_id }),
        );
        let all: Vec<Value> = verification_results.into_iter().chain(merge_verification).collect();
        let mut patched = with_result_ids(task, diff_artifact.as_ref(), &all).as_object().cloned().unwrap_or_default();
        patched.insert("resultCommit".to_string(), json!(result_commit));
        Ok(task_finalize_ok(&Value::Object(patched), files, all, merged.commit))
    }

    pub async fn finalize_run(&self, project_run: &Value, main_session: &Value) -> CoreResult<Value> {
        let project = self.require_project(project_run.get("projectId").and_then(Value::as_str).unwrap_or(""))?;
        let project_run_id = project_run.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let workspace = self.working_directory(project_run, None).unwrap_or_default();
        let isolated = project_run.get("workspaceMode").and_then(Value::as_str) == Some("git_isolated")
            && project.get("repositoryType").and_then(Value::as_str) == Some("git")
            && project_run.get("baseCommit").is_some()
            && project_run.get("branchName").is_some();
        let files = if isolated { change_collector::collect(&workspace).await.unwrap_or_default() } else { vec![] };
        let diff_artifact = if files.is_empty() {
            None
        } else {
            Some(self.save_diff(
                &project_run_id,
                None,
                main_session,
                project_run.get("goal").and_then(Value::as_str).unwrap_or("run"),
                &files,
            )?)
        };
        self.emit_files(main_session, &project_run_id, None, &files, diff_artifact.as_ref());
        let verification_results = self.verify(&project, &workspace, main_session, &project_run_id, None, "run", None).await?;
        if !VerificationEngine::passed(&verification_results) {
            let mut details = Map::new();
            details.insert("projectRunId".to_string(), json!(project_run_id));
            return Err(CoreError::details(ErrorCode::VerificationFailed, details));
        }
        // Never create a first commit or commit the user's shared working tree
        // as a side effect of the non-isolated fallback.
        let goal = project_run.get("goal").and_then(Value::as_str).unwrap_or("");
        let result_commit = if isolated {
            self.worktrees.commit_all(&workspace, &format!("agenthub: {}", goal.chars().take(72).collect::<String>())).await.ok().flatten()
        } else {
            None
        };
        let head = if isolated {
            repository_service::inspect(&workspace).await.ok().and_then(|state| state.head_commit)
        } else {
            None
        };
        let base_commit = project_run.get("baseCommit").and_then(Value::as_str);
        if let (Some(base), Some(head)) = (base_commit, head.as_deref()) {
            if head != base {
                let _ = self.save_commit_diff(&project_run_id, None, main_session, goal, &workspace, base, head).await;
            }
        }
        let needs_merge_approval = base_commit.is_some() && head.is_some() && head.as_deref() != base_commit;
        let mut updated = project_run.as_object().cloned().unwrap_or_default();
        updated.insert(
            "resultCommit".to_string(),
            result_commit.map(Value::String).or_else(|| head.map(Value::String)).unwrap_or(Value::Null),
        );
        Ok(json!({
            "projectRun": Value::Object(updated),
            "files": files,
            "verificationResults": verification_results,
            "needsMergeApproval": needs_merge_approval
        }))
    }

    pub async fn merge_final(&self, project_run: &Value, main_session: &Value) -> CoreResult<Value> {
        let project = self.require_project(project_run.get("projectId").and_then(Value::as_str).unwrap_or(""))?;
        let project_run_id = project_run.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let applicable = project_run.get("workspaceMode").and_then(Value::as_str) == Some("git_isolated")
            && project.get("repositoryType").and_then(Value::as_str) == Some("git")
            && project_run.get("branchName").is_some()
            && project_run.get("baseBranch").is_some();
        if !applicable {
            return Ok(project_run.clone());
        }
        let repository = repository_service::inspect(project.get("rootPath").and_then(Value::as_str).unwrap_or("")).await.map_err(git_fail)?;
        let base_branch = project_run.get("baseBranch").and_then(Value::as_str).unwrap_or("");
        if repository.branch != base_branch {
            let mut details = Map::new();
            details.insert("reason".to_string(), json!("base_branch_changed"));
            details.insert("expected".to_string(), json!(base_branch));
            details.insert("actual".to_string(), json!(repository.branch));
            return Err(CoreError::details(ErrorCode::MergeConflict, details));
        }
        let branch_name = project_run.get("branchName").and_then(Value::as_str).unwrap_or("");
        let _ = self.events.append_for_session(
            main_session,
            &json!({ "projectRunId": project_run_id }),
            "git.merge_started",
            json!({ "sourceBranch": branch_name, "targetBranch": base_branch }),
        );
        let result = merge_queue::merge_final(project.get("rootPath").and_then(Value::as_str).unwrap_or(""), branch_name, base_branch).await.map_err(git_fail)?;
        if !result.merged {
            let _ = self.events.append_for_session(
                main_session,
                &json!({ "projectRunId": project_run_id }),
                "git.conflict",
                json!({
                    "sourceBranch": branch_name,
                    "targetBranch": base_branch,
                    "paths": result.conflicts.iter().filter_map(|c| c.get("path").cloned()).collect::<Vec<_>>()
                }),
            );
            let mut updated = project_run.as_object().cloned().unwrap_or_default();
            updated.insert("conflicts".to_string(), Value::Array(result.conflicts));
            return Ok(Value::Object(updated));
        }
        let _ = self.events.append_for_session(
            main_session,
            &json!({ "projectRunId": project_run_id }),
            "git.merge_finished",
            json!({ "sourceBranch": branch_name, "targetBranch": base_branch, "commit": result.commit }),
        );
        let mut updated = project_run.as_object().cloned().unwrap_or_default();
        updated.insert("resultCommit".to_string(), result.commit.map(Value::String).unwrap_or(Value::Null));
        updated.remove("conflicts");
        Ok(Value::Object(updated))
    }

    async fn verify(
        &self,
        project: &Value,
        workspace: &str,
        session: &Value,
        project_run_id: &str,
        task_id: Option<&str>,
        scope: &str,
        template_ids: Option<Vec<String>>,
    ) -> CoreResult<Vec<Value>> {
        let events = self.events.clone();
        let finish_events = self.events.clone();
        let session = session.clone();
        let finish_session = session.clone();
        let run_id = project_run_id.to_string();
        let finish_run_id = run_id.clone();
        let task_owned = task_id.map(str::to_string);
        let task_for_events = task_owned.clone();
        let finish_task = task_owned.clone();
        self.verification
            .run(
                project,
                workspace,
                VerificationContext {
                    project_run_id: run_id.clone(),
                    task_id: task_owned,
                    session_id: session.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                    scope: scope.to_string(),
                    template_ids,
                    on_started: Some(Box::new(move |template, verification_id| {
                        let _ = events.append_for_session(
                            &session,
                            &json!({ "projectRunId": run_id, "taskId": task_for_events }),
                            "verification.started",
                            json!({
                                "verificationId": verification_id,
                                "commandTemplateId": template.get("id").cloned().unwrap_or(Value::Null)
                            }),
                        );
                    })),
                    on_finished: Some(Box::new(move |result| {
                        let _ = finish_events.append_for_session(
                            &finish_session,
                            &json!({ "projectRunId": finish_run_id, "taskId": finish_task }),
                            "verification.finished",
                            json!({
                                "verificationId": result.get("id").cloned().unwrap_or(Value::Null),
                                "passed": result.get("passed").cloned().unwrap_or(Value::Null),
                                "exitCode": result.get("exitCode").cloned().unwrap_or(Value::Null),
                                "durationMs": result.get("durationMs").cloned().unwrap_or(Value::Null),
                                "outputArtifactId": result.get("outputArtifactId").cloned().unwrap_or(Value::Null)
                            }),
                        );
                    })),
                },
            )
            .await
    }

    fn save_diff(
        &self,
        project_run_id: &str,
        task_id: Option<&str>,
        session: &Value,
        name: &str,
        files: &[Value],
    ) -> CoreResult<Value> {
        self.artifacts.save(
            &artifact_input(
                "diff",
                &format!("{}.diff.json", name.chars().take(80).collect::<String>()),
                Some(project_run_id),
                task_id,
                session.get("id").and_then(Value::as_str),
                Some(json!({
                    "paths": files.iter().filter_map(|f| f.get("path").cloned()).collect::<Vec<_>>(),
                    "fileCount": files.len()
                })),
            ),
            &json!({ "files": files }).to_string(),
        )
    }

    async fn save_commit_diff(
        &self,
        project_run_id: &str,
        task_id: Option<&str>,
        session: &Value,
        name: &str,
        workspace: &str,
        base_commit: &str,
        head_commit: &str,
    ) -> CoreResult<Value> {
        let content = change_collector::collect_commit_diff(workspace, base_commit, head_commit).await.unwrap_or_default();
        self.artifacts.save(
            &artifact_input(
                "commit",
                &format!("{}.patch", name.chars().take(80).collect::<String>()),
                Some(project_run_id),
                task_id,
                session.get("id").and_then(Value::as_str),
                Some(json!({ "baseCommit": base_commit, "headCommit": head_commit })),
            ),
            &content,
        )
    }

    fn emit_files(&self, session: &Value, project_run_id: &str, task_id: Option<&str>, files: &[Value], artifact: Option<&Value>) {
        for file in files {
            let _ = self.events.append_for_session(
                session,
                &json!({ "projectRunId": project_run_id, "taskId": task_id }),
                "file.changed",
                json!({
                    "path": file.get("path").cloned().unwrap_or(Value::Null),
                    "changeType": file.get("changeType").cloned().unwrap_or(Value::Null)
                }),
            );
        }
        if let Some(artifact) = artifact {
            let _ = self.events.append_for_session(
                session,
                &json!({ "projectRunId": project_run_id, "taskId": task_id }),
                "git.diff_collected",
                json!({
                    "artifactId": artifact.get("id").cloned().unwrap_or(Value::Null),
                    "taskId": task_id,
                    "fileCount": files.len()
                }),
            );
        }
    }
}

fn with_shared_workspace(project_run: &Value, project: &Value) -> Value {
    let mut updated = project_run.as_object().cloned().unwrap_or_default();
    updated.insert("workspacePath".to_string(), project.get("rootPath").cloned().unwrap_or(Value::Null));
    updated.remove("branchName");
    updated.remove("baseCommit");
    updated.remove("baseBranch");
    Value::Object(updated)
}

fn with_result_ids(task: &Value, diff_artifact: Option<&Value>, results: &[Value]) -> Value {
    let mut patched = task.as_object().cloned().unwrap_or_default();
    if let Some(artifact) = diff_artifact {
        patched.insert("diffArtifactId".to_string(), artifact.get("id").cloned().unwrap_or(Value::Null));
    }
    patched.insert(
        "verificationResultIds".to_string(),
        Value::Array(results.iter().filter_map(|r| r.get("id").cloned()).collect()),
    );
    Value::Object(patched)
}

fn task_finalize_ok(task: &Value, files: Vec<Value>, results: Vec<Value>, merge_commit: Option<String>) -> Value {
    json!({
        "ok": true,
        "task": task,
        "files": files,
        "verificationResults": results,
        "mergeCommit": merge_commit.map(Value::String).unwrap_or(Value::Null)
    })
}

fn task_finalize_failure(task: &Value, reason: &str, message: &str, files: Vec<Value>, results: Vec<Value>) -> Value {
    json!({
        "ok": false,
        "task": task,
        "reason": reason,
        "message": message,
        "files": files,
        "verificationResults": results
    })
}
