//! Real Git, database, verification processes and RunService; only model turns
//! are controlled by Probe. Every repository belongs to this test's UUID root.
use super::*;
use crate::runtime::git::git_command::run_git;
use crate::runtime::git_workflow_service::GitWorkflowService;
use crate::runtime::verification_engine::VerificationEngine;

static GIT_TEST_SLOTS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> =
    std::sync::OnceLock::new();

impl Fixture {
    fn export_workspace_fixture(&self, label: &str, run: &WorkflowRun) {
        if let Some(path) = std::env::var_os("NAUTILO_WORKFLOW_QA_STATE") {
            let db = self.db.lock().unwrap();
            let repos = Repositories::new(&db.raw);
            let artifacts = repos.artifacts().list(Some(&run.id), None, None).unwrap();
            let approvals = repos.approvals().list(None, None).unwrap();
            std::fs::write(
                format!(
                    "{}.workspace-{label}.json",
                    std::path::Path::new(&path).display()
                ),
                json!({"run":public_view(run),"artifacts":artifacts,"approvals":approvals})
                    .to_string(),
            )
            .unwrap();
        }
    }
    pub(super) async fn git_project(
        &self,
        isolated: bool,
        templates: Value,
        commit: bool,
    ) -> std::path::PathBuf {
        // Real Git checkouts are expensive under Windows indexing/antivirus.
        // Bound only test I/O; each graph still exercises its own parallel nodes.
        let slot = GIT_TEST_SLOTS
            .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(3)))
            .clone()
            .acquire_owned()
            .await
            .unwrap();
        *self.git_test_slot.lock().unwrap() = Some(slot);
        let root = self.root.join("project");
        std::fs::create_dir_all(&root).unwrap();
        let cwd = root.to_str().unwrap();
        run_git(cwd, &["init", "-b", "main"], false).await.unwrap();
        run_git(cwd, &["config", "core.autocrlf", "false"], false)
            .await
            .unwrap();
        std::fs::write(root.join("base.txt"), "original\n").unwrap();
        run_git(cwd, &["add", "-A"], false).await.unwrap();
        run_git(
            cwd,
            &[
                "-c",
                "user.name=Workflow fixture",
                "-c",
                "user.email=workflow@local",
                "commit",
                "-m",
                "base",
            ],
            false,
        )
        .await
        .unwrap();
        {
            let db = self.db.lock().unwrap();
            let repos = Repositories::new(&db.raw);
            let mut project = repos.projects().get("project").unwrap().unwrap();
            project["rootPath"] = json!(root);
            project["repositoryType"] = json!("git");
            project["workspaceMode"] = json!(if isolated { "git_isolated" } else { "direct" });
            project["verificationTemplates"] = templates;
            repos.projects().save(&project, &now_iso()).unwrap();
            let mut agent = repos.agents().get("agent").unwrap().unwrap();
            agent["providerOptions"]["writeFiles"] = json!(true);
            agent["providerOptions"]["commitFiles"] = json!(commit);
            repos.agents().save(&agent, &now_iso()).unwrap();
        }
        let redaction = RedactionService::default();
        let events = Arc::new(EventService::new(self.db.clone(), redaction.clone()));
        let policies = Arc::new(CommandPolicyService::new(self.db.clone()).unwrap());
        self.service
            .set_git_workflows(Arc::new(GitWorkflowService::new(
                self.db.clone(),
                events,
                self.root.join("worktrees").to_str().unwrap(),
                VerificationEngine::new(self.db.clone(), redaction, policies),
            )));
        root
    }

    fn start_graph(&self, definition: Value) -> WorkflowRun {
        let result = self
            .service
            .start(&json!({
                "sessionId":"main-session", "requestId":Uuid::new_v4().to_string(),
                "definition":definition, "inputs":{"question":"investigate"},
                "bindings":{"Explorer":{"agentInstanceId":"agent"}}
            }))
            .unwrap();
        assert!(
            result["workspace"].get("project").is_none(),
            "Private project configuration must not leak"
        );
        self.service.get(result["id"].as_str().unwrap()).unwrap()
    }

    fn start_write(&self, policy: Option<Value>) -> WorkflowRun {
        let mut definition = simple_definition();
        definition["nodes"][1]["prompt"] = json!("write:base.txt");
        if let Some(policy) = policy {
            definition["nodes"][1]["workspace"] = policy;
        }
        self.start_graph(definition)
    }

    pub(super) async fn workspace_until(
        &self,
        id: &str,
        predicate: impl Fn(&WorkflowRun) -> bool,
    ) -> WorkflowRun {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
        while tokio::time::Instant::now() < deadline {
            self.service.drive(id).await.unwrap();
            let run = self.service.get(id).unwrap();
            for child in run
                .instances
                .iter()
                .filter_map(|instance| instance.child_run_id.as_deref())
            {
                self.service.drive(child).await.unwrap();
            }
            if predicate(&run) {
                return run;
            }
            if ["needs_decision", "failed"].contains(&run.status.as_str()) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
        panic!("Workspace did not reach expected state: {}", {
            let run = self.service.get(id).unwrap();
            json!({"status":run.status,"error":run.error,"workspace":run.workspace,"instances":run.instances,"lastEvents":run.events.iter().rev().take(4).collect::<Vec<_>>()})
        });
    }
}

fn command(id: &str, scope: &str, program: &str) -> Value {
    json!({"id":id,"name":id,"command":"node","args":["-e",program],"scopes":[scope],"required":true,"timeoutMs":10000})
}
fn waiting_merge(run: &WorkflowRun) -> bool {
    run.workspace
        .as_ref()
        .is_some_and(|workspace| workspace.stage == "waiting_merge")
}

#[tokio::test]
async fn workflow_workspace_isolates_native_commits_and_waits_for_merge_review() {
    for self_commit in [false, true] {
        let fixture = Fixture::new(Behavior::Submit, false);
        let project = fixture.git_project(true, json!([]), self_commit).await;
        let run = fixture.start_write(None);
        let waiting = fixture.workspace_until(&run.id, waiting_merge).await;
        if !self_commit {
            fixture.export_workspace_fixture("merge", &waiting);
        }
        assert_eq!(waiting.status, "finalizing");
        assert_eq!(
            std::fs::read_to_string(project.join("base.txt")).unwrap(),
            "original\n"
        );
        let node = waiting
            .instances
            .iter()
            .find(|instance| instance.node_id == "explore")
            .unwrap();
        assert_eq!(node.acceptance.as_ref().unwrap().status, "passed");
        let cwd = node.workspace.as_ref().unwrap().context["workspacePath"]
            .as_str()
            .unwrap();
        assert_ne!(
            std::fs::canonicalize(cwd).unwrap(),
            std::fs::canonicalize(&project).unwrap()
        );
        assert_eq!(fixture.probe.directories.lock().unwrap().as_slice(), [cwd]);
        fixture
            .service
            .control(&json!({"runId":run.id,"action":"approve_merge"}))
            .unwrap();
        let done = fixture
            .workspace_until(&run.id, |run| run.status == "completed")
            .await;
        assert_eq!(
            done.workspace.as_ref().unwrap().outcome.as_ref().unwrap()["merge"]["merged"],
            true
        );
        assert_eq!(
            std::fs::read_to_string(project.join("base.txt")).unwrap(),
            "written base.txt\n"
        );
        assert!(run_git(
            project.to_str().unwrap(),
            &["status", "--porcelain=v1"],
            false
        )
        .await
        .unwrap()
        .stdout
        .trim()
        .is_empty());
    }
}

#[tokio::test]
async fn workflow_workspace_declined_merge_retains_result_and_user_edits() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let project = fixture.git_project(true, json!([]), false).await;
    std::fs::write(project.join("user-draft.txt"), "do not touch").unwrap();
    let run = fixture.start_write(None);
    fixture.workspace_until(&run.id, waiting_merge).await;
    fixture
        .service
        .control(&json!({"runId":run.id,"action":"reject_merge"}))
        .unwrap();
    let done = fixture
        .workspace_until(&run.id, |run| run.status == "completed")
        .await;
    let workspace = done.workspace.as_ref().unwrap();
    assert_eq!(workspace.stage, "retained");
    assert_eq!(
        std::fs::read_to_string(project.join("user-draft.txt")).unwrap(),
        "do not touch"
    );
    assert_eq!(
        std::fs::read_to_string(project.join("base.txt")).unwrap(),
        "original\n"
    );
    assert_eq!(
        std::fs::read_to_string(
            std::path::Path::new(workspace.context["workspacePath"].as_str().unwrap())
                .join("base.txt")
        )
        .unwrap(),
        "written base.txt\n"
    );
}

#[tokio::test]
async fn workflow_workspace_failed_candidate_does_not_contaminate_integration() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let project = fixture
        .git_project(
            true,
            json!([command("merged-check", "merge", "process.exit(7)")]),
            false,
        )
        .await;
    let run = fixture.start_write(None);
    let failed = fixture
        .workspace_until(&run.id, |run| run.status == "needs_decision")
        .await;
    let workspace = failed.workspace.as_ref().unwrap();
    assert_eq!(
        std::fs::read_to_string(project.join("base.txt")).unwrap(),
        "original\n"
    );
    assert_eq!(
        std::fs::read_to_string(
            std::path::Path::new(workspace.context["workspacePath"].as_str().unwrap())
                .join("base.txt")
        )
        .unwrap(),
        "original\n"
    );
    let node = failed
        .instances
        .iter()
        .find(|instance| instance.node_id == "explore")
        .unwrap();
    assert_eq!(node.status, "failed");
    assert!(
        node.workspace.as_ref().unwrap().outcome.as_ref().unwrap()["candidatePath"].is_string()
    );
}

#[tokio::test]
async fn workflow_workspace_path_limits_include_the_agents_own_commits() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let project = fixture.git_project(false, json!([]), true).await;
    let run = fixture.start_write(Some(json!({"allowedPaths":["allowed/**"]})));
    let failed = fixture
        .workspace_until(&run.id, |run| run.status == "needs_decision")
        .await;
    assert_eq!(
        failed.workspace.as_ref().unwrap().context["workspaceMode"],
        "git_isolated"
    );
    assert_eq!(
        std::fs::read_to_string(project.join("base.txt")).unwrap(),
        "original\n"
    );
    let node = failed
        .instances
        .iter()
        .find(|instance| instance.node_id == "explore")
        .unwrap();
    assert_eq!(node.acceptance.as_ref().unwrap().status, "failed");
    assert!(
        node.workspace.as_ref().unwrap().outcome.as_ref().unwrap()["pathViolations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|path| path == "base.txt")
    );
}

#[tokio::test]
async fn workflow_workspace_selected_checks_cannot_omit_required_project_checks() {
    let fixture = Fixture::new(Behavior::Submit, false);
    fixture
        .git_project(
            true,
            json!([
                command("chosen", "task", "process.exit(0)"),
                command("required", "task", "process.exit(9)")
            ]),
            false,
        )
        .await;
    let run = fixture.start_write(Some(json!({"verificationTemplates":["chosen"]})));
    let failed = fixture
        .workspace_until(&run.id, |run| run.status == "needs_decision")
        .await;
    let node = failed
        .instances
        .iter()
        .find(|instance| instance.node_id == "explore")
        .unwrap();
    let results =
        &node.workspace.as_ref().unwrap().outcome.as_ref().unwrap()["verificationResults"];
    assert_eq!(results.as_array().unwrap().len(), 2);
    assert_eq!(results[1]["commandTemplateId"], "required");
    assert_eq!(results[1]["passed"], false);
}

#[tokio::test]
async fn workflow_workspace_empty_selection_skips_optional_checks_and_keeps_required_checks() {
    for required in [false, true] {
        for custom in [false, true] {
            let fixture = Fixture::new(Behavior::Submit, false);
            let mut optional = command(
                "optional",
                "task",
                "require('fs').writeFileSync('optional-ran','yes');process.exit(7)",
            );
            optional["required"] = json!(false);
            let mut templates = vec![optional];
            if required {
                templates.push(command(
                    "required",
                    "task",
                    "require('fs').writeFileSync('required-ran','yes')",
                ));
            }
            let project = fixture.git_project(false, json!(templates), false).await;
            let run = fixture.start_write(custom.then(|| json!({"verificationTemplates":[]})));
            let done = fixture
                .workspace_until(&run.id, |run| run.status == "completed")
                .await;
            assert_eq!(
                project.join("optional-ran").exists(),
                !custom,
                "An explicit empty choice was confused with inherited checks"
            );
            assert_eq!(
                project.join("required-ran").exists(),
                required,
                "A required project check was omitted"
            );
            let node = done
                .instances
                .iter()
                .find(|node| node.node_id == "explore")
                .unwrap();
            let checks = node.workspace.as_ref().unwrap().outcome.as_ref().unwrap()
                ["verificationResults"]
                .as_array()
                .unwrap();
            assert_eq!(checks.len(), usize::from(!custom) + usize::from(required));
            assert_eq!(node.acceptance.as_ref().unwrap().status, "passed");
        }
    }
}

#[tokio::test]
async fn workflow_workspace_invalid_verification_is_rejected_before_model_execution() {
    let fixture = Fixture::new(Behavior::Submit, false);
    fixture.git_project(true, json!([]), false).await;
    let mut definition = simple_definition();
    definition["nodes"][1]["workspace"] =
        json!({"mode":"isolated","verificationTemplates":["missing-check"]});
    let error=fixture.service.start(&json!({"sessionId":"main-session","requestId":"invalid-workspace-check","definition":definition,"inputs":{"question":"validate before dispatch"},"bindings":{"Explorer":{"agentInstanceId":"agent"}}})).unwrap_err();
    assert!(error.to_string().contains("missing-check"));
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 0);
    assert!(workflows::pending(&fixture.db.lock().unwrap().raw)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn workflow_workspace_parallel_changes_reach_downstream_after_acceptance() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let project = fixture.git_project(true, json!([]), false).await;
    let agent = |id: &str, prompt: &str| json!({"id":id,"kind":"agent","role":"Explorer","prompt":prompt,"outputs":{"summary":"text"},"exits":[{"id":"done","name":"完成"}]});
    let definition = json!({"schemaVersion":1,"id":"parallel-workspace","entry":"main","inputs":{"question":"text"},"nodes":[
        {"id":"main","kind":"main","exits":[{"id":"a","name":"A"},{"id":"b","name":"B"}]},
        agent("a","write:a.txt"),agent("b","write:b.txt"),
        {"id":"join","kind":"join","scope":"main","exits":[{"id":"done","name":"收齐"}]},
        agent("reader","read:a.txt")
    ],"edges":[
        {"from":["main","a"],"to":"a"},{"from":["main","b"],"to":"b"},
        {"from":["a","done"],"to":"join"},{"from":["b","done"],"to":"join"},
        {"from":["join","done"],"to":"reader"},{"from":["reader","done"],"to":"$return"}
    ]});
    let run = fixture.start_graph(definition);
    let waiting = fixture.workspace_until(&run.id, waiting_merge).await;
    let integration = std::path::Path::new(
        waiting.workspace.as_ref().unwrap().context["workspacePath"]
            .as_str()
            .unwrap(),
    );
    for path in ["a.txt", "b.txt"] {
        assert!(integration.join(path).is_file());
        assert!(!project.join(path).exists());
    }
    assert_eq!(
        fixture.probe.observations.lock().unwrap().as_slice(),
        ["written a.txt\n"]
    );
    let directories = fixture.probe.directories.lock().unwrap();
    assert_eq!(directories.len(), 3);
    assert_eq!(
        directories
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        3
    );
}

#[tokio::test]
async fn workflow_workspace_subflow_shares_integration_and_has_one_final_approval() {
    let fixture = Fixture::new(Behavior::Submit, false);
    fixture.git_project(false, json!([]), false).await;
    let mut child = simple_definition();
    child["nodes"][1]["prompt"] = json!("write:child.txt");
    child["nodes"][1]["workspace"] = json!({"mode":"isolated"});
    fixture.service.save_template(&json!({"id":"workspace-child","revision":0,"name":"Isolated child","definition":child,"layout":{}})).unwrap();
    let definition = json!({"schemaVersion":1,"id":"workspace-parent","entry":"main","inputs":{"question":"text"},"nodes":[
        {"id":"main","kind":"main","exits":[{"id":"go","name":"开始"}]},
        {"id":"call","kind":"call","ref":{"id":"workspace-child","revision":1},"input":{"question":"{{input.question}}"},"exitMap":{"完成":"done"},"exits":[{"id":"done","name":"完成"}]},
        {"id":"reader","kind":"agent","role":"Explorer","prompt":"read:child.txt","outputs":{"summary":"text"},"exits":[{"id":"done","name":"完成"}]}
    ],"edges":[{"from":["main","go"],"to":"call"},{"from":["call","done"],"to":"reader"},{"from":["reader","done"],"to":"$return"}]});
    let run = fixture.start_graph(definition);
    let waiting = fixture.workspace_until(&run.id, waiting_merge).await;
    let child_id = waiting
        .instances
        .iter()
        .find_map(|instance| instance.child_run_id.as_deref())
        .unwrap();
    let child = fixture.service.get(child_id).unwrap();
    assert_eq!(child.status, "completed");
    assert!(child.acceptance.is_none());
    assert_eq!(child.workspace.as_ref().unwrap().owner_run_id, run.id);
    assert_eq!(
        waiting.workspace.as_ref().unwrap().context["workspaceMode"],
        "git_isolated"
    );
    assert_eq!(
        fixture.probe.observations.lock().unwrap().as_slice(),
        ["written child.txt\n"]
    );
    assert_eq!(
        waiting
            .events
            .iter()
            .filter(|event| event.r#type == "workflow.merge_requested")
            .count(),
        1
    );
    assert!(!child
        .events
        .iter()
        .any(|event| event.r#type == "workflow.merge_requested"));
}

#[tokio::test]
async fn workflow_workspace_cancellation_stops_a_real_verification_process() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let project=fixture.git_project(true,json!([command("long-check","task",
        "require('fs').writeFileSync('verification-started',String(process.pid));setInterval(()=>{},1000)")]),false).await;
    let run = fixture.start_write(None);
    let running = fixture
        .workspace_until(&run.id, |run| {
            run.instances.iter().any(|instance| {
                instance.workspace.as_ref().is_some_and(|workspace| {
                    std::path::Path::new(workspace.context["workspacePath"].as_str().unwrap_or(""))
                        .join("verification-started")
                        .is_file()
                })
            })
        })
        .await;
    let node = running
        .instances
        .iter()
        .find(|instance| instance.node_id == "explore")
        .unwrap();
    let cwd = node.workspace.as_ref().unwrap().context["workspacePath"]
        .as_str()
        .unwrap();
    let pid =
        std::fs::read_to_string(std::path::Path::new(cwd).join("verification-started")).unwrap();
    fixture
        .service
        .control(&json!({"runId":run.id,"action":"cancel"}))
        .unwrap();
    let stopped = fixture
        .workspace_until(&run.id, |_| {
            fixture.service.workspace_jobs.lock().unwrap().is_empty()
        })
        .await;
    assert_eq!(stopped.status, "cancelled");
    assert_eq!(
        std::fs::read_to_string(project.join("base.txt")).unwrap(),
        "original\n"
    );
    // The process lifecycle, rather than a UI state alone, proves cancellation.
    let check=tokio::process::Command::new("node").args(["-e",
        "try{process.kill(Number(process.argv[1]),0);process.exit(1)}catch(e){process.exit(e.code==='ESRCH'?0:2)}",&pid]).status().await.unwrap();
    assert!(check.success(), "The verification process is still alive");
    assert!(!workflows::pending(&fixture.db.lock().unwrap().raw)
        .unwrap()
        .contains(&run.id));
}

#[tokio::test]
async fn workflow_workspace_cancelled_orphan_effects_leave_the_pending_queue() {
    let fixture = Fixture::new(Behavior::Submit, false);
    fixture.git_project(true, json!([]), false).await;
    let run = fixture.start_write(None);
    fixture
        .service
        .change(&run.id, |run| {
            run.workspace.as_mut().unwrap().stage = "verifying".into();
            let instance = run
                .instances
                .iter_mut()
                .find(|instance| instance.node_id == "explore")
                .unwrap();
            instance.workspace = Some(crate::runtime::workflow::NodeWorkspace {
                stage: "verifying".into(),
                context: json!({}),
                outcome: None,
                error: None,
            });
            run.cancel(now());
            Ok(())
        })
        .unwrap();
    assert!(workflows::pending(&fixture.db.lock().unwrap().raw)
        .unwrap()
        .contains(&run.id));
    fixture.service.drive(&run.id).await.unwrap();
    let stopped = fixture.service.get(&run.id).unwrap();
    assert_eq!(stopped.workspace.as_ref().unwrap().stage, "uncertain");
    assert_eq!(
        stopped
            .instances
            .iter()
            .find(|instance| instance.node_id == "explore")
            .unwrap()
            .workspace
            .as_ref()
            .unwrap()
            .stage,
        "uncertain"
    );
    assert!(!workflows::pending(&fixture.db.lock().unwrap().raw)
        .unwrap()
        .contains(&run.id));
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn workflow_workspace_preparation_failure_is_reported_without_starting_an_agent() {
    let fixture = Fixture::new(Behavior::Submit, false);
    fixture.git_project(true, json!([]), false).await;
    let run = fixture.start_write(None);
    let node = run
        .instances
        .iter()
        .find(|instance| instance.node_id == "explore")
        .unwrap();
    let target = crate::runtime::git::worktree_service::WorktreeService::new(
        fixture.root.join("worktrees").to_str().unwrap(),
    )
    .workflow_task_path("project", &run.id, &format!("{}-{}", node.id, node.attempt))
    .unwrap();
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("owned-by-someone-else"), "retain").unwrap();
    let failed = fixture
        .workspace_until(&run.id, |run| run.status == "needs_decision")
        .await;
    assert_eq!(
        failed
            .instances
            .iter()
            .find(|instance| instance.node_id == "explore")
            .unwrap()
            .status,
        "failed"
    );
    assert_eq!(fixture.probe.child_turns.load(Ordering::SeqCst), 0);
    assert_eq!(
        std::fs::read_to_string(target.join("owned-by-someone-else")).unwrap(),
        "retain"
    );
}

#[tokio::test]
async fn workflow_workspace_subdirectory_cannot_modify_its_repository_sibling() {
    for committed in [false, true] {
        let fixture = Fixture::new(Behavior::Submit, false);
        let project = fixture.git_project(true, json!([]), committed).await;
        let subdir = project.join("package");
        std::fs::create_dir_all(&subdir).unwrap();
        std::fs::write(subdir.join("entry.txt"), "package").unwrap();
        run_git(project.to_str().unwrap(), &["add", "-A"], false)
            .await
            .unwrap();
        run_git(
            project.to_str().unwrap(),
            &[
                "-c",
                "user.name=Workflow fixture",
                "-c",
                "user.email=workflow@local",
                "commit",
                "-m",
                "package",
            ],
            false,
        )
        .await
        .unwrap();
        {
            let db = fixture.db.lock().unwrap();
            let projects = Repositories::new(&db.raw).projects();
            let mut config = projects.get("project").unwrap().unwrap();
            config["rootPath"] = json!(subdir);
            projects.save(&config, &now_iso()).unwrap();
        }
        let mut definition = simple_definition();
        definition["nodes"][1]["prompt"] = json!("write:../outside.txt");
        let run = fixture.start_graph(definition);
        let failed = fixture
            .workspace_until(&run.id, |run| run.status == "needs_decision")
            .await;
        let node = failed
            .instances
            .iter()
            .find(|instance| instance.node_id == "explore")
            .unwrap();
        assert_eq!(
            failed.workspace.as_ref().unwrap().context["projectRelativePath"],
            "package"
        );
        assert_eq!(
            node.workspace.as_ref().unwrap().outcome.as_ref().unwrap()["pathViolations"],
            json!(["../outside.txt"])
        );
        assert!(!project.join("outside.txt").exists());
    }
}

#[tokio::test]
async fn workflow_workspace_approvals_precede_commands_and_preserve_task_checkpoint() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let project = fixture
        .git_project(
            true,
            json!([
                command(
                    "task-check",
                    "task",
                    "require('fs').appendFileSync('task-check.log','task\\n')"
                ),
                command(
                    "merge-check",
                    "merge",
                    "require('fs').appendFileSync('merge-check.log','merge\\n')"
                )
            ]),
            false,
        )
        .await;
    CommandPolicyService::new(fixture.db.clone()).unwrap().save(&json!({
        "id":"workflow-test","defaultCommandAction":"safe",
        "commandRules":[{"id":"ask-verification","sources":["verification"],"executable":"node","action":"approval"}]
    })).unwrap();
    let run = fixture.start_write(None);
    let waiting = fixture
        .workspace_until(&run.id, |run| {
            run.instances.iter().any(|instance| {
                instance
                    .workspace
                    .as_ref()
                    .is_some_and(|workspace| workspace.stage == "waiting_approval")
            })
        })
        .await;
    fixture.export_workspace_fixture("commands", &waiting);
    let node = waiting
        .instances
        .iter()
        .find(|instance| instance.node_id == "explore")
        .unwrap();
    let id = node.id.clone();
    let cwd = std::path::PathBuf::from(
        node.workspace.as_ref().unwrap().context["workspacePath"]
            .as_str()
            .unwrap(),
    );
    assert!(
        !cwd.join("task-check.log").exists(),
        "Preflight executed an unapproved command"
    );
    let first_approval = node.workspace.as_ref().unwrap().context["approvalIds"][0]
        .as_str()
        .unwrap()
        .to_owned();
    for _ in 0..3 {
        fixture.service.drive(&run.id).await.unwrap();
    }
    fixture
        .service
        .control(&json!({"runId":run.id,"instanceId":id,"action":"approve_verification"}))
        .unwrap();
    let merge_waiting = fixture
        .workspace_until(&run.id, |run| {
            run.instances.iter().any(|instance| {
                instance.workspace.as_ref().is_some_and(|workspace| {
                    workspace.stage == "waiting_approval"
                        && workspace
                            .outcome
                            .as_ref()
                            .is_some_and(|outcome| outcome["taskVerified"] == true)
                })
            })
        })
        .await;
    let node = merge_waiting
        .instances
        .iter()
        .find(|instance| instance.id == id)
        .unwrap();
    assert_ne!(
        node.workspace.as_ref().unwrap().context["approvalIds"][0],
        first_approval
    );
    assert_eq!(
        std::fs::read_to_string(cwd.join("task-check.log")).unwrap(),
        "task\n"
    );
    fixture
        .service
        .control(&json!({"runId":run.id,"instanceId":id,"action":"approve_verification"}))
        .unwrap();
    let verified = fixture.workspace_until(&run.id, waiting_merge).await;
    let integration = std::path::Path::new(
        verified.workspace.as_ref().unwrap().context["workspacePath"]
            .as_str()
            .unwrap(),
    );
    assert_eq!(
        std::fs::read_to_string(integration.join("task-check.log")).unwrap(),
        "task\n",
        "Task verification was repeated after its accepted checkpoint"
    );
    assert_eq!(
        std::fs::read_to_string(integration.join("merge-check.log")).unwrap(),
        "merge\n"
    );
    assert_eq!(
        std::fs::read_to_string(project.join("base.txt")).unwrap(),
        "original\n"
    );
    assert!(Repositories::new(&fixture.db.lock().unwrap().raw)
        .approvals()
        .get(&first_approval)
        .unwrap()
        .unwrap()["consumedAt"]
        .is_string());
}

#[tokio::test]
async fn workflow_workspace_merge_review_does_not_overwrite_later_user_changes() {
    let fixture = Fixture::new(Behavior::Submit, false);
    let project = fixture.git_project(true, json!([]), false).await;
    let run = fixture.start_write(None);
    fixture.workspace_until(&run.id, waiting_merge).await;
    std::fs::write(project.join("base.txt"), "user's later change\n").unwrap();
    fixture
        .service
        .control(&json!({"runId":run.id,"action":"approve_merge"}))
        .unwrap();
    let failed = fixture
        .workspace_until(&run.id, |run| run.status == "needs_decision")
        .await;
    assert_eq!(
        std::fs::read_to_string(project.join("base.txt")).unwrap(),
        "user's later change\n"
    );
    assert_eq!(failed.workspace.as_ref().unwrap().stage, "uncertain");
    let isolated = failed.workspace.as_ref().unwrap().context["workspacePath"]
        .as_str()
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(std::path::Path::new(isolated).join("base.txt")).unwrap(),
        "written base.txt\n"
    );
}
