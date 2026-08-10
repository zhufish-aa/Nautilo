//! IPC route table — port of application/ipc-handlers.ts.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::application::core_daemon::Daemon;
use crate::database::Repositories;
use crate::errors::{not_found, now_iso, CoreResult};
use crate::ipc_gateway::Router;

pub fn register_handlers(router: &mut Router, daemon: &Arc<Daemon>) {
    router.register("health.get", |_| async { Ok(json!({ "status": "ok", "version": crate::VERSION })) });

    // ---- projects
    reg(router, daemon, "project.list", |d, _| d.projects.list().map(Value::Array));
    reg(router, daemon, "project.add", |d, input| d.projects.add(&input));
    reg(router, daemon, "project.upsert", |d, input| {
        let now = now_iso();
        Repositories::new(&d.db.lock().unwrap().raw).projects().save(&input, &now)?;
        Ok(input)
    });
    reg_str(router, daemon, "project.remove", "projectId", |d, id| d.projects.remove(id));
    reg_str(router, daemon, "project.scan", "projectId", |d, id| d.projects.scan(id));

    // ---- agents (CRUD only; detect/models land with the adapter registry)
    reg(router, daemon, "agent.list", |d, _| {
        Repositories::new(&d.db.lock().unwrap().raw).agents().list_default().map(Value::Array)
    });
    reg(router, daemon, "agent.upsert", |d, input| {
        let now = input
            .get("updatedAt")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(now_iso);
        Repositories::new(&d.db.lock().unwrap().raw).agents().save(&input, &now)?;
        Ok(input)
    });

    // ---- teams
    reg(router, daemon, "team.list", |d, _| d.teams.list().map(Value::Array));
    reg_str(router, daemon, "team.get", "teamId", |d, id| d.teams.get(id));
    reg(router, daemon, "team.upsert", |d, input| d.teams.upsert(&input));
    reg_str(router, daemon, "team.remove", "teamId", |d, id| d.teams.remove(id));

    // ---- capabilities
    reg(router, daemon, "capability.list", |d, _| d.capabilities.list().map(Value::Array));
    reg(router, daemon, "capability.upsert", |d, input| d.capabilities.upsert(&input));
    reg_str(router, daemon, "capability.remove", "capabilityId", |d, id| d.capabilities.remove(id));

    // ---- policies
    reg(router, daemon, "policy.list", |d, _| d.command_policies.list().map(Value::Array));
    reg(router, daemon, "policy.upsert", |d, input| d.command_policies.save(&input));
    reg(router, daemon, "policy.evaluate", |d, input| d.command_policies.evaluate(&input));

    // ---- approvals
    reg(router, daemon, "approval.list", |d, input| {
        d.approvals.list(
            input.get("status").and_then(Value::as_str),
            input.get("projectRunId").and_then(Value::as_str),
        )
        .map(Value::Array)
    });
    reg(router, daemon, "approval.resolve", |d, input| {
        d.approvals.resolve(
            input.get("approvalId").and_then(Value::as_str).unwrap_or(""),
            input.get("decision").and_then(Value::as_str).unwrap_or(""),
            input.get("scope").unwrap_or(&Value::Null),
        )
    });

    // ---- credentials
    reg(router, daemon, "credential.set", |d, input| {
        d.credentials.set(
            input.get("agentInstanceId").and_then(Value::as_str).unwrap_or(""),
            &json!({
                "apiKey": input.get("apiKey").cloned().unwrap_or(Value::Null),
                "envName": input.get("envName").cloned().unwrap_or(Value::Null),
            }),
        )?;
        Ok(json!({ "stored": true }))
    });
    reg_str(router, daemon, "credential.status", "agentInstanceId", |d, id| {
        Ok(json!({ "stored": d.credentials.has(id)? }))
    });
    reg_str(router, daemon, "credential.delete", "agentInstanceId", |d, id| {
        Ok(json!({ "removed": d.credentials.remove(id)? }))
    });

    // ---- audit / metrics
    reg(router, daemon, "audit.list", |d, input| {
        d.audit
            .list(
                input.get("limit").and_then(Value::as_i64),
                input.get("resourceId").and_then(Value::as_str),
            )
            .map(Value::Array)
    });
    reg(router, daemon, "metrics.get", |d, input| {
        d.metrics.snapshot(input.get("projectId").and_then(Value::as_str))
    });

    // ---- sessions
    reg(router, daemon, "session.list", |d, input| {
        d.sessions
            .list(
                input.get("projectId").and_then(Value::as_str).unwrap_or(""),
                input.get("memberId").and_then(Value::as_str),
            )
            .map(Value::Array)
    });
    reg_str(router, daemon, "session.get", "sessionId", |d, id| d.sessions.get(id));
    reg(router, daemon, "session.create", |d, input| d.sessions.create(&input));
    reg(router, daemon, "session.upsert", |d, input| d.sessions.upsert(&input));
    reg_str(router, daemon, "session.delete", "sessionId", |d, id| d.sessions.delete(id));
    reg_str(router, daemon, "session.followUp.list", "sessionId", |d, id| d.sessions.follow_up_list(id));

    // ---- runs / tasks / artifacts / verifications (read side)
    reg(router, daemon, "run.list", |d, input| {
        let session_id = input.get("sessionId").and_then(Value::as_str);
        let project_run_id = input.get("projectRunId").and_then(Value::as_str);
        let runs = Repositories::new(&d.db.lock().unwrap().raw)
            .runs()
            .list()?
            .into_iter()
            .filter(|run| {
                (session_id.is_none() || run.get("sessionId").and_then(Value::as_str) == session_id)
                    && (project_run_id.is_none() || run.get("projectRunId").and_then(Value::as_str) == project_run_id)
            })
            .collect();
        Ok(Value::Array(runs))
    });
    reg_str(router, daemon, "run.get", "runId", |d, id| {
        Repositories::new(&d.db.lock().unwrap().raw).runs().get(id)?.ok_or_else(|| not_found("run", id))
    });
    reg_str(router, daemon, "task.list", "projectRunId", |d, id| {
        Repositories::new(&d.db.lock().unwrap().raw).tasks().list(id).map(Value::Array)
    });
    reg_str(router, daemon, "projectRun.list", "projectId", |d, id| {
        Repositories::new(&d.db.lock().unwrap().raw).project_runs().list(id).map(Value::Array)
    });
    reg_str(router, daemon, "projectRun.get", "projectRunId", |d, id| d.orchestration.get(id));
    reg(router, daemon, "orchestration.start", |d, input| d.orchestration.start(&input));
    reg(router, daemon, "orchestration.resolveDelegation", |d, input| {
        d.orchestration.resolve_delegation(
            input.get("projectRunId").and_then(Value::as_str).unwrap_or(""),
            input.get("approved").and_then(Value::as_bool).unwrap_or(false),
            input.get("scope").and_then(Value::as_str),
        )
    });
    {
        let daemon = daemon.clone();
        router.register("orchestration.resolveMerge", move |input| {
            let daemon = daemon.clone();
            async move {
                daemon
                    .orchestration
                    .resolve_merge(
                        input.get("projectRunId").and_then(Value::as_str).unwrap_or(""),
                        input.get("approved").and_then(Value::as_bool).unwrap_or(false),
                        input.get("scope").and_then(Value::as_str),
                    )
                    .await
                    .map_err(anyhow::Error::new)
            }
        });
    }
    reg(router, daemon, "orchestration.recover", |d, input| {
        d.orchestration.recover(
            input.get("projectRunId").and_then(Value::as_str).unwrap_or(""),
            input.get("memberId").and_then(Value::as_str).unwrap_or(""),
            input.get("mode").and_then(Value::as_str).unwrap_or("resume"),
        )
    });
    {
        let daemon = daemon.clone();
        router.register("orchestration.cancel", move |input| {
            let daemon = daemon.clone();
            async move {
                daemon
                    .orchestration
                    .cancel(input.get("projectRunId").and_then(Value::as_str).unwrap_or(""))
                    .await
                    .map_err(anyhow::Error::new)
            }
        });
    }
    reg(router, daemon, "artifact.list", |d, input| {
        Repositories::new(&d.db.lock().unwrap().raw)
            .artifacts()
            .list(
                input.get("projectRunId").and_then(Value::as_str),
                input.get("taskId").and_then(Value::as_str),
                input.get("sessionId").and_then(Value::as_str),
            )
            .map(Value::Array)
    });
    reg(router, daemon, "verification.list", |d, input| {
        Repositories::new(&d.db.lock().unwrap().raw)
            .verifications()
            .list(
                input.get("projectRunId").and_then(Value::as_str).unwrap_or(""),
                input.get("taskId").and_then(Value::as_str),
            )
            .map(Value::Array)
    });

    // ---- provider detection / catalog / model discovery
    reg(router, daemon, "provider.catalog", |d, _| {
        Ok(Value::Array(d.adapters.list().iter().map(|adapter| adapter.descriptor()).collect()))
    });
    {
        let daemon = daemon.clone();
        router.register("provider.detect", move |input| {
            let daemon = daemon.clone();
            async move {
                daemon
                    .agents
                    .detect(
                        input.get("providerId").and_then(Value::as_str).unwrap_or(""),
                        input.get("executable").and_then(Value::as_str),
                    )
                    .await
                    .map_err(anyhow::Error::new)
            }
        });
    }
    {
        let daemon = daemon.clone();
        router.register("provider.models", move |input| {
            let daemon = daemon.clone();
            async move {
                daemon
                    .agents
                    .list_models(
                        input.get("providerId").and_then(Value::as_str).unwrap_or(""),
                        input.get("executable").and_then(Value::as_str),
                        input.get("agentInstanceId").and_then(Value::as_str),
                        input.get("baseUrl").and_then(Value::as_str),
                        input.get("apiKey").and_then(Value::as_str),
                        input.get("apiType").and_then(Value::as_str),
                    )
                    .await
                    .map_err(anyhow::Error::new)
            }
        });
    }

    // ---- run lifecycle / messaging (async)
    {
        let daemon = daemon.clone();
        router.register("session.send", move |input| {
            let daemon = daemon.clone();
            async move { daemon.sessions.send(&input).await.map_err(anyhow::Error::new) }
        });
    }
    {
        let daemon = daemon.clone();
        router.register("session.followUp", move |input| {
            let daemon = daemon.clone();
            async move { daemon.sessions.follow_up(&input).await.map_err(anyhow::Error::new) }
        });
    }
    reg(router, daemon, "session.followUp.cancel", |d, input| d.sessions.follow_up_cancel(&input));
    {
        let daemon = daemon.clone();
        router.register("run.cancel", move |input| {
            let daemon = daemon.clone();
            async move {
                let run_id = input.get("runId").and_then(Value::as_str).unwrap_or("").to_string();
                daemon.runs.cancel(&run_id).await.map_err(anyhow::Error::new)?;
                Ok(json!({ "cancelled": true }))
            }
        });
    }

    // ---- interactions
    reg(router, daemon, "interaction.list", |d, input| {
        Ok(Value::Array(d.interactions.list(
            input.get("sessionId").and_then(Value::as_str),
            input.get("status").and_then(Value::as_str),
        )))
    });
    reg(router, daemon, "interaction.respond", |d, input| {
        d.interactions.respond(
            input.get("interactionId").and_then(Value::as_str).unwrap_or(""),
            &json!({
                "outcome": input.get("outcome").cloned().unwrap_or(Value::Null),
                "optionId": input.get("optionId").cloned().unwrap_or(Value::Null),
                "answers": input.get("answers").cloned().unwrap_or(Value::Null)
            }),
        )
    });

    // ---- provider plugins
    reg(router, daemon, "plugin.list", |d, _| Ok(Value::Array(d.plugins.list())));
    {
        let daemon = daemon.clone();
        router.register("plugin.registry", move |input| {
            let daemon = daemon.clone();
            async move {
                daemon
                    .plugins
                    .fetch_registry(input.get("registryUrl").and_then(Value::as_str))
                    .await
                    .map_err(anyhow::Error::new)
            }
        });
    }
    {
        let daemon = daemon.clone();
        router.register("plugin.install", move |input| {
            let daemon = daemon.clone();
            async move {
                let source = input.get("source").cloned().unwrap_or(Value::Null);
                match source.get("kind").and_then(Value::as_str) {
                    Some("local") => daemon
                        .plugins
                        .install_local(source.get("path").and_then(Value::as_str).unwrap_or(""))
                        .await
                        .map_err(anyhow::Error::new),
                    Some("registry") => daemon
                        .plugins
                        .install_from_registry(
                            source.get("pluginId").and_then(Value::as_str).unwrap_or(""),
                            source.get("registryUrl").and_then(Value::as_str),
                        )
                        .await
                        .map_err(anyhow::Error::new),
                    _ => Err(anyhow::anyhow!("invalid plugin source")),
                }
            }
        });
    }
    {
        let daemon = daemon.clone();
        router.register("plugin.uninstall", move |input| {
            let daemon = daemon.clone();
            async move {
                daemon
                    .plugins
                    .uninstall(input.get("pluginId").and_then(Value::as_str).unwrap_or(""))
                    .await
                    .map_err(anyhow::Error::new)
            }
        });
    }
    {
        let daemon = daemon.clone();
        router.register("plugin.setEnabled", move |input| {
            let daemon = daemon.clone();
            async move {
                daemon
                    .plugins
                    .set_enabled(
                        input.get("pluginId").and_then(Value::as_str).unwrap_or(""),
                        input.get("enabled").and_then(Value::as_bool).unwrap_or(false),
                    )
                    .await
                    .map_err(anyhow::Error::new)
            }
        });
    }

    // ---- capability imports
    reg(router, daemon, "capability.parseImport", |d, input| d.capability_imports.parse(&input));
    reg(router, daemon, "capability.discoverMcp", |d, input| Ok(d.capability_imports.discover_mcp(&input)));
    reg(router, daemon, "capability.scanSkills", |d, input| d.capability_imports.scan_skills(&input));
    reg(router, daemon, "capability.importMany", |d, input| d.capability_imports.import_many(&input));

    // ---- slash commands
    reg_str(router, daemon, "slashCommand.list", "sessionId", |d, id| {
        d.slash_commands.list(id).map(Value::Array)
    });
    {
        let daemon = daemon.clone();
        router.register("slashCommand.execute", move |input| {
            let daemon = daemon.clone();
            async move {
                daemon
                    .slash_commands
                    .execute(
                        input.get("sessionId").and_then(Value::as_str).unwrap_or(""),
                        input.get("commandId").and_then(Value::as_str).unwrap_or(""),
                        input.get("argument").and_then(Value::as_str),
                    )
                    .await
                    .map_err(anyhow::Error::new)
            }
        });
    }
    {
        let daemon = daemon.clone();
        router.register("slashCommand.continue", move |input| {
            let daemon = daemon.clone();
            async move { daemon.slash_commands.continue_command(&input).await.map_err(anyhow::Error::new) }
        });
    }

    // ---- artifacts / recovery / diagnostics
    reg(router, daemon, "artifact.read", |d, input| {
        crate::application::artifact_read::read_workspace_artifact(&d.db, &input)
    });
    reg(router, daemon, "recovery.list", |d, _| d.recovery.list().map(Value::Array));
    reg(router, daemon, "diagnostics.export", |d, input| {
        d.diagnostics.export(
            input.get("projectId").and_then(Value::as_str),
            input.get("projectRunId").and_then(Value::as_str),
        )
    });

    // ---- event subscriptions (async: event.wait blocks)
    {
        let daemon = daemon.clone();
        router.register("event.subscribe", move |input| {
            let daemon = daemon.clone();
            async move {
                daemon
                    .subscriptions
                    .subscribe(
                        input.get("projectRunId").and_then(Value::as_str).map(str::to_string),
                        input.get("sessionId").and_then(Value::as_str).map(str::to_string),
                    )
                    .map_err(anyhow::Error::new)
            }
        });
    }
    {
        let daemon = daemon.clone();
        router.register("event.replay", move |input| {
            let daemon = daemon.clone();
            async move {
                let subscription_id = input.get("subscriptionId").and_then(Value::as_str).unwrap_or("");
                let after_sequence = input.get("afterSequence").and_then(Value::as_i64).unwrap_or(0);
                // A full replay re-reads the journal; cancel orphaned
                // interaction requests first so stale pending cards don't
                // resurrect in the renderer.
                if after_sequence == 0 {
                    if let Some(session_id) = daemon.subscriptions.session_scope(subscription_id) {
                        daemon.interactions.heal_orphaned(&session_id);
                        daemon.sessions.heal_follow_ups(&session_id);
                    }
                }
                daemon
                    .subscriptions
                    .replay(subscription_id, after_sequence)
                    .map_err(anyhow::Error::new)
            }
        });
    }
    {
        let daemon = daemon.clone();
        router.register("event.wait", move |input| {
            let daemon = daemon.clone();
            async move {
                let subscription_id = input.get("subscriptionId").and_then(Value::as_str).unwrap_or("");
                let after_sequence = input.get("afterSequence").and_then(Value::as_i64).unwrap_or(0);
                if after_sequence == 0 {
                    if let Some(session_id) = daemon.subscriptions.session_scope(subscription_id) {
                        daemon.interactions.heal_orphaned(&session_id);
                        daemon.sessions.heal_follow_ups(&session_id);
                    }
                }
                daemon
                    .subscriptions
                    .wait(
                        subscription_id,
                        after_sequence,
                        input.get("timeoutMs").and_then(Value::as_u64),
                    )
                    .await
                    .map_err(anyhow::Error::new)
            }
        });
    }
}

/// Register a synchronous handler taking the raw input value.
fn reg(
    router: &mut Router,
    daemon: &Arc<Daemon>,
    method: &str,
    handler: impl Fn(&Arc<Daemon>, Value) -> CoreResult<Value> + Send + Sync + 'static,
) {
    let daemon = daemon.clone();
    router.register(method, move |input| {
        let result = handler(&daemon, input);
        async move { result.map_err(anyhow::Error::new) }
    });
}

/// Register a synchronous handler whose input is a single string field.
fn reg_str(
    router: &mut Router,
    daemon: &Arc<Daemon>,
    method: &str,
    field: &str,
    handler: impl Fn(&Arc<Daemon>, &str) -> CoreResult<Value> + Send + Sync + 'static,
) {
    let field = field.to_string();
    reg(router, daemon, method, move |d, input| {
        let id = input.get(&field).and_then(Value::as_str).unwrap_or("").to_string();
        handler(d, &id)
    });
}
