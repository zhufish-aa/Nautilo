//! IPC route table — port of application/ipc-handlers.ts.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::application::core_daemon::Daemon;
use crate::database::Repositories;
use crate::errors::{not_found, now_iso, CoreResult};
use crate::ipc_gateway::Router;

pub fn register_handlers(router: &mut Router, daemon: &Arc<Daemon>) {
    reg(router, daemon, "remote.status", |d, _| d.remote.status().map_err(|e|crate::errors::invalid("remote", &e.to_string())));
    reg(router, daemon, "remote.invite", |d, _| d.remote.invite().map_err(|e|crate::errors::invalid("remote", &e.to_string())));
    reg(router, daemon, "remote.cancelInvite", |d, _| d.remote.cancel_invite().map_err(|e|crate::errors::invalid("remote", &e.to_string())));
    reg(router, daemon, "remote.approve", |d, input| d.remote.approve(input).map_err(|e|crate::errors::invalid("remote", &e.to_string())));
    reg(router, daemon, "remote.reject", |d, input| d.remote.reject(input).map_err(|e|crate::errors::invalid("remote", &e.to_string())));
    reg(router, daemon, "remote.revoke", |d, input| d.remote.revoke(input).map_err(|e|crate::errors::invalid("remote", &e.to_string())));
    reg(router, daemon, "remote.updateDevice", |d, input| d.remote.update_device(input).map_err(|e|crate::errors::invalid("remote", &e.to_string())));
    { let remote=daemon.remote.clone(); router.register("remote.configure",move|input| { let remote=remote.clone(); async move { remote.configure(input).await } }); }
    for method in ["scm.status","scm.diff","scm.mutate","scm.commit","scm.commitDiff","scm.history","scm.file","scm.save"] {
        let daemon=daemon.clone();
        router.register(method,move|input|{let daemon=daemon.clone();async move{
            let cwd=crate::application::source_control::working_directory(&daemon,&input)?;
            let result=match method {"scm.status"=>daemon.source_control.status(&cwd).await,"scm.diff"=>daemon.source_control.diff(&cwd,&input).await,"scm.commit"=>daemon.source_control.commit_details(&cwd,&input).await,"scm.commitDiff"=>daemon.source_control.commit_diff(&cwd,&input).await,"scm.history"=>daemon.source_control.history(&cwd,&input).await,"scm.file"=>daemon.source_control.file(&cwd,&input).await,"scm.save"=>daemon.source_control.save(&cwd,&input).await,_=>daemon.source_control.mutate(&cwd,&input).await};
            result.map(|mut result|{if let Some(error)=result["error"].as_str(){let redacted=daemon.redaction.text(error);result["error"]=json!(redacted);}result}).map_err(|error|anyhow::Error::new(crate::errors::invalid("sourceControl",&daemon.redaction.text(&error.to_string()))))
        }});
    }
    router.register("health.get", |_| async { Ok(json!({ "status": "ok", "version": crate::VERSION, "features":{"sourceControl":1,"sourceControlHistory":1,"sourceControlHistoryPaging":1,"sourceControlEditing":1,"terminalTabs":1} })) });
    reg(router,daemon,"terminal.open",|d,input| {
        let session=input["sessionId"].as_str().map(|id|Repositories::new(&d.db.lock().unwrap().raw).sessions().get(id)).transpose()?.flatten();
        let project_id=input["projectId"].as_str().or_else(||session.as_ref().and_then(|session|session["projectId"].as_str())).unwrap_or("");
        let project=Repositories::new(&d.db.lock().unwrap().raw).projects().get(project_id)?.ok_or_else(||not_found("project",project_id))?;
        let scope=crate::runtime::terminal_service::TerminalService::scope(input["sessionId"].as_str(),project_id);
        let command=if cfg!(windows){"powershell.exe".to_string()}else{std::env::var("SHELL").unwrap_or_else(|_|"/bin/sh".into())};
        let cwd=session.as_ref().and_then(|session|session["nativeWorkingDirectory"].as_str()).unwrap_or_else(||project["rootPath"].as_str().unwrap_or(""));
        d.terminals.open_shell(scope,input["tabId"].as_str().unwrap_or("default").into(),input["restoreOnly"]==true,crate::runtime::terminal_service::TerminalPlan{command,args:if cfg!(windows){vec!["-NoLogo".into()]}else{vec![]},env:None,cwd:cwd.into(),resources:vec![],provider_session_id:None},input["cols"].as_u64().unwrap_or(100).min(1000) as u16,input["rows"].as_u64().unwrap_or(24).min(500) as u16)
    });
    reg(router,daemon,"terminal.list",|d,input|{
        let scope=crate::runtime::terminal_service::TerminalService::scope(input["sessionId"].as_str(),input["projectId"].as_str().unwrap_or(""));
        Ok(d.terminals.list(&scope))
    });
    reg(router,daemon,"terminal.write",|d,input|d.terminals.write(input["terminalId"].as_str().unwrap_or(""),input["data"].as_str().unwrap_or("")));
    reg(router,daemon,"terminal.resize",|d,input|d.terminals.resize(input["terminalId"].as_str().unwrap_or(""),input["cols"].as_u64().unwrap_or(80).min(1000) as u16,input["rows"].as_u64().unwrap_or(24).min(500) as u16));
    {
        let daemon=daemon.clone();
        router.register("terminal.read",move |input|{let daemon=daemon.clone();async move {
            let id=input["terminalId"].as_str().unwrap_or("");
            let mut frame=daemon.terminals.read(id,input["cursor"].as_u64().unwrap_or(0))?;
            if let Some(owner)=daemon.terminals.owner(id) {
                // A history RPC may wait for disk/protocol I/O. Keep terminal
                // keystrokes and screen output independent of that work.
                frame["historySync"]=if input["retrySync"]==true {daemon.runs.reconcile_native_history(&owner,true).await?}
                    else {daemon.runs.native_terminal_status(&owner)?["historySync"].clone()};
            }
            Ok(frame)
        }});
    }
    {
        let daemon=daemon.clone();
        router.register("terminal.stop",move|input|{let daemon=daemon.clone();async move{
            let id=input["terminalId"].as_str().unwrap_or("");daemon.terminals.stop_and_wait(id).await?;
            let mut result=json!({"ok":true});
            if let Some(owner)=daemon.terminals.owner(id){result["historySync"]=daemon.runs.reconcile_native_history(&owner,true).await?;}
            Ok(result)
        }});
    }
    {
        let daemon=daemon.clone();
        router.register("terminal.close",move |input|{let daemon=daemon.clone();async move {
            if let Some(tab)=input["tabId"].as_str(){
                let scope=crate::runtime::terminal_service::TerminalService::scope(input["sessionId"].as_str(),input["projectId"].as_str().unwrap_or(""));
                return daemon.terminals.close_shell(&scope,tab).map_err(anyhow::Error::new);
            }
            let id=input["terminalId"].as_str().unwrap_or("");
            if let Some(owner)=daemon.terminals.owner(id) {
                daemon.terminals.stop_and_wait(id).await?;
                let sync=daemon.runs.reconcile_native_history(&owner,true).await?;
                Ok(json!({"ok":true,"historySync":sync}))
            }else{daemon.terminals.close(id).map_err(anyhow::Error::new)}
        }});
    }
    {
        let daemon=daemon.clone();
        router.register("terminal.status",move |input|{let daemon=daemon.clone();async move {
            let id=input["sessionId"].as_str().unwrap_or("");
            daemon.runs.reconcile_native_history(id,input["retrySync"]==true).await?;
            daemon.runs.native_terminal_status(id).map_err(anyhow::Error::new)
        }});
    }
    {
        let daemon=daemon.clone();
        router.register("terminal.native",move |input|{let daemon=daemon.clone();async move {
            let session_id=input["sessionId"].as_str().unwrap_or("");
            let _ownership=daemon.terminals.lock_session(session_id).await;
            daemon.runs.open_native_terminal_locked(session_id,input["cols"].as_u64().unwrap_or(100).min(1000) as u16,input["rows"].as_u64().unwrap_or(24).min(500) as u16).await.map_err(anyhow::Error::new)
        }});
    }

    reg(router, daemon, "assistant.records", |d, input| crate::database::assistant::records(&d.db.lock().unwrap().raw,&input));
    reg(router, daemon, "assistant.save", |d, input| crate::database::assistant::save(&d.db.lock().unwrap().raw,&input));
    reg(router, daemon, "assistant.sessions", |d, input| crate::database::assistant::sessions(&d.db.lock().unwrap().raw,&input));
    reg(router, daemon, "assistant.excerpts", |d, input| crate::database::assistant::excerpts(&d.db.lock().unwrap().raw,&input));
    {
        let daemon = daemon.clone();
        router.register("assistant.modelStep", move |input| {
            let daemon = daemon.clone();
            async move { crate::runtime::assistant_model::step(&daemon,&input).await.map_err(anyhow::Error::new) }
        });
    }

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
    reg(router, daemon, "agent.upsert", |d, input| d.agents.upsert(&input));
    reg(router,daemon,"agent.runtimeCapabilities",|d,input|{
        let db=d.db.lock().unwrap();let repos=Repositories::new(&db.raw);
        let agent=if let Some(session_id)=input["sessionId"].as_str(){let session=repos.sessions().get(session_id)?.ok_or_else(||not_found("session",session_id))?;let id=crate::application::session_service::effective_agent_id(&db.raw,&session)?;
            let agent=repos.agents().get(&id)?.ok_or_else(||not_found("agent",&id))?;crate::application::connection_service::resolve_session_connection(&db.raw,&session,&agent)?.0
        }else{let id=input["agentInstanceId"].as_str().unwrap_or("");repos.agents().get(id)?.ok_or_else(||not_found("agent",id))?};
        let mut profile=d.adapters.get(agent["providerId"].as_str().unwrap_or(""))?.native_capabilities(&agent);
        if let Some(session)=input["sessionId"].as_str(){
            for (event_type,key) in [("provider.runtime_capabilities","negotiated"),("provider.runtime_ready","lastRuntime")] {
                if let Some(event)=repos.events().latest_type(session,event_type)? {
                    if event["payload"]["providerId"]==agent["providerId"] {profile[key]=event["payload"].clone();profile[key]["observedAt"]=event["timestamp"].clone();}
                }
            }
        }
        Ok(profile)
    });

    // ---- versioned, harness-independent runtime connections
    reg(router, daemon, "requestLog.list", |d,input| d.runs.request_logs.list(&input));
    reg_str(router, daemon, "session.tools", "sessionId", |d,id| d.runs.request_logs.inventory(id));
    reg(router,daemon,"resource.inventory",|d,_|d.resources.inventory());
    reg(router,daemon,"integration.get",|d,_|d.integrations.get());
    reg(router,daemon,"integration.save",|d,input|d.integrations.save(&input));
    reg(router,daemon,"configuration.list",|d,_|d.integrations.list());
    reg(router,daemon,"configuration.capture",|d,input|d.integrations.capture(input["name"].as_str().unwrap_or("")));
    reg(router,daemon,"configuration.import",|d,input|d.integrations.import(&input["preset"]));
    reg_str(router,daemon,"configuration.export","presetId",|d,id|d.integrations.export(id));
    reg_str(router,daemon,"configuration.remove","presetId",|d,id|d.integrations.remove(id));
    reg(router,daemon,"configuration.preview",|d,input|d.integrations.preview(input["presetId"].as_str().unwrap_or(""),input["replace"]==true));
    reg_str(router,daemon,"configuration.apply","planId",|d,id|d.integrations.apply(id));
    reg(router,daemon,"resource.history",|d,_|d.resources.history());
    reg(router,daemon,"resource.preview",|d,input|d.resources.preview(&input));
    reg_str(router,daemon,"resource.apply","planId",|d,id|d.resources.apply(id,false));
    reg_str(router,daemon,"resource.undo","planId",|d,id|d.resources.apply(id,true));
    reg(router, daemon, "connection.list", |d, _| d.connections.list().map(Value::Array));
    reg(router, daemon, "connection.scanNative", |d, _| d.connection_imports.scan());
    reg(router, daemon, "connection.importNative", |d, input| d.connection_imports.import(&input));
    reg(router, daemon, "connection.get", |d, input| d.connections.get(input["connectionId"].as_str().unwrap_or(""), input["revision"].as_u64()));
    reg(router, daemon, "connection.gateway", |d, input| {
        let id = input["connectionId"].as_str().unwrap_or("");
        let enabled = input["enabled"].as_bool().ok_or_else(|| crate::errors::invalid("enabled", "Expected a boolean"))?;
        d.integrations.set_account_route(id, enabled)?;
        d.connections.get(id, None)
    });
    reg(router, daemon, "connection.upsert", |d, input| d.connections.upsert(&input));
    reg_str(router, daemon, "connection.remove", "connectionId", |d, id| d.connections.remove(id));
    {
        let daemon = daemon.clone();
        router.register("connection.models", move |input| {
            let daemon = daemon.clone();
            async move { daemon.connections.models(&input).await.map_err(anyhow::Error::new) }
        });
    }

    // ---- teams
    for method in ["connection.diagnose", "capability.diagnose"] {
        let daemon = daemon.clone();
        router.register(method, move |input| {
            let daemon = daemon.clone();
            async move {
                let result = if method == "connection.diagnose" {
                    daemon.connections.diagnose(&input).await?
                } else {
                    daemon.capabilities.diagnose(input["capabilityId"].as_str().unwrap_or("")).await?
                };
                Ok(daemon.redaction.value(&result))
            }
        });
    }

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
        let records = d.approvals.resolve_many(
            input.get("approvalId").and_then(Value::as_str).unwrap_or(""),
            input.get("decision").and_then(Value::as_str).unwrap_or(""),
            input.get("scope").unwrap_or(&Value::Null),
        )?;
        for record in &records {
            let session = record["sessionId"].as_str().map(|id| Repositories::new(&d.db.lock().unwrap().raw).sessions().get(id)).transpose()?.flatten();
            if let Some(session) = session {
                d.events.append_for_session(&session, &json!({"projectRunId":record["projectRunId"],"taskId":record["taskId"]}), "approval.resolved",
                    json!({"approvalId":record["id"],"decision":record["status"],"scope":record["scope"]}))?;
            }
        }
        Ok(records.into_iter().next().unwrap())
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
    reg(router, daemon, "session.historyBatch", |d, input| {
        Repositories::new(&d.db.lock().unwrap().raw).sessions().history_batch(&input)
    });
    reg(router, daemon, "session.history", |d, input| {
        Repositories::new(&d.db.lock().unwrap().raw).sessions().history(
            input.get("sessionId").and_then(Value::as_str).unwrap_or(""), input.get("cursor"),
        )
    });
    reg_str(router, daemon, "session.get", "sessionId", |d, id| d.sessions.get(id));
    {
        let daemon = daemon.clone();
        router.register("session.generateTitle", move |input| {
            let daemon = daemon.clone();
            async move { daemon.runs.generate_session_title(input["sessionId"].as_str().unwrap_or("")).await.map_err(anyhow::Error::new) }
        });
    }
    reg(router, daemon, "session.create", |d, input| d.sessions.create(&input));
    reg(router, daemon, "session.upsert", |d, input| d.sessions.upsert(&input));
    {
        let daemon=daemon.clone();
        router.register("session.delete",move |input| {let daemon=daemon.clone();async move {
            let snapshots=Repositories::new(&daemon.db.lock().unwrap().raw).sessions().list_all()?;
            let result=daemon.sessions.delete(input["sessionId"].as_str().unwrap_or(""))?;
            for id in result["sessionIds"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                if let Some(session)=snapshots.iter().find(|session|session["id"]==id) {
                    if let Err(error)=daemon.runs.release_native_session(session).await {eprintln!("Native session release failed: {error}");}
                    daemon.terminals.close_scope(&crate::runtime::terminal_service::TerminalService::scope(Some(id),""));
                }
            }
            Ok(result)
        }});
    }
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
    reg(router, daemon, "projectRun.poll", |d, input| {
        let collect = |session_id: &str| -> CoreResult<Value> {
            d.interactions.heal_orphaned(session_id);
            d.sessions.heal_follow_ups(session_id);
            let after_sequence = crate::database::project_poll::last_sequence(&d.db.lock().unwrap().raw, session_id)?;
            let queue = d.sessions.follow_up_list(session_id)?;
            Ok(json!({ "sessionId": session_id, "afterSequence": after_sequence, "items": queue.get("items"),
                "interactions": d.interactions.list(Some(session_id), Some("pending")) }))
        };
        let heal_ids = crate::database::project_poll::heal_ids(&d.db.lock().unwrap().raw, &input)?;
        let mut follow_ups = heal_ids.iter().map(|id| collect(id)).collect::<CoreResult<Vec<_>>>()?;
        let mut snapshot = crate::database::project_poll::read(&d.db.lock().unwrap().raw, &input, follow_ups.clone())?;
        let missing = |snapshot: &Value, authorities: &[Value]| -> Vec<String> {
            snapshot.get("feeds").and_then(Value::as_array).into_iter().flatten()
                .filter(|feed| feed.get("reset").and_then(Value::as_bool) == Some(true)
                    && !authorities.iter().any(|entry| entry.get("sessionId") == feed.get("sessionId")))
                .filter_map(|feed| feed.get("sessionId").and_then(Value::as_str).map(str::to_string)).collect()
        };
        let needed = missing(&snapshot, &follow_ups);
        if !needed.is_empty() {
            for id in needed { follow_ups.push(collect(&id)?); }
            snapshot = crate::database::project_poll::read(&d.db.lock().unwrap().raw, &input, follow_ups.clone())?;
            if !missing(&snapshot, &follow_ups).is_empty() {
                return Err(crate::errors::CoreError::reason(crate::errors::ErrorCode::IpcInternalError, "Project changed during snapshot recovery; retry"));
            }
        }
        Ok(snapshot)
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
    reg(router, daemon, "artifact.changes", |d, input| {
        Repositories::new(&d.db.lock().unwrap().raw).artifacts().changes(&input)
    });
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

    let plugin_daemon = daemon.clone();
    router.register("provider.harnessPlugins", move |input| {
        let daemon = plugin_daemon.clone();
        async move { super::harness_plugins::manage(&daemon, input).await.map_err(anyhow::Error::new) }
    });

    // ---- provider detection / catalog / model discovery
    reg(router, daemon, "provider.catalog", |d, _| {
        Ok(Value::Array(d.adapters.list().iter().map(|adapter| {
            let mut descriptor = adapter.descriptor();
            if d.plugins.manager_for(adapter.provider_id()).is_some() {
                descriptor["harnessPlugins"] = json!(true);
            }
            descriptor
        }).collect()))
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

    {
        let daemon = daemon.clone();
        router.register("provider.modes", move |input| {
            let daemon = daemon.clone();
            async move { daemon.agents.list_modes(input["agentInstanceId"].as_str().unwrap_or(""),input["cwd"].as_str()).await.map_err(anyhow::Error::new) }
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
        router.register("session.followUp.steer", move |input| {
            let daemon = daemon.clone();
            async move { daemon.sessions.follow_up_steer(&input).await.map_err(anyhow::Error::new) }
        });
    }
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
