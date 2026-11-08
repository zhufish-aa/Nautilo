//! Session callbacks outlive a foreground turn, without reopening that run.
use super::*;
use std::collections::VecDeque;

#[derive(Clone, Eq, Hash, PartialEq)]
pub(super) struct MessageKey {
    pub message_id: String,
    pub subagent_dispatch_id: Option<String>,
}
pub(super) struct BufferedMessage {
    pub text: String,
    pub message_id: Option<String>,
    pub subagent_dispatch_id: Option<String>,
}

struct EventQueue {
    foreground: bool,
    draining: bool,
    events: VecDeque<AdapterEvent>,
}
/// A resident adapter can publish late frames before the foreground receiver
/// has drained. Queue those frames until its buffers and journal are handed
/// over, then keep one ordered writer for this originating turn.
pub(super) struct SessionEventGate {
    queue: Mutex<EventQueue>,
    write: Arc<dyn Fn(AdapterEvent) + Send + Sync>,
}
impl SessionEventGate {
    fn push(&self, event: AdapterEvent) {
        self.queue.lock().unwrap().events.push_back(event);
        self.drain();
    }
    fn open(&self) {
        self.queue.lock().unwrap().foreground = false;
        self.drain();
    }
    fn drain(&self) {
        {
            let mut queue = self.queue.lock().unwrap();
            if queue.foreground || queue.draining {
                return;
            }
            queue.draining = true;
        }
        loop {
            let event = {
                let mut queue = self.queue.lock().unwrap();
                match queue.events.pop_front() {
                    Some(event) => event,
                    None => {
                        queue.draining = false;
                        return;
                    }
                }
            };
            (self.write)(event);
        }
    }
}
pub(super) struct ForegroundHandoff(Arc<SessionEventGate>);
impl Drop for ForegroundHandoff {
    fn drop(&mut self) {
        self.0.open();
    }
}

pub(super) struct SessionCallbacks {
    pub handoff: ForegroundHandoff,
    pub events: Arc<dyn Fn(AdapterEvent) + Send + Sync>,
    pub interaction:
        Arc<dyn Fn(Value) -> crate::adapters::BoxFuture<anyhow::Result<Value>> + Send + Sync>,
    pub tool: Arc<dyn Fn(Value) -> crate::adapters::BoxFuture<anyhow::Result<Value>> + Send + Sync>,
}
#[derive(Clone)]
pub(super) struct NativeOrigin {
    pub run: Value,
    pub context: RunContext,
}

impl RunService {
    /// Main-agent partial output is committed on a stopped/closed foreground
    /// stream; child output must stay buffered for its native completion.
    pub(super) fn handoff_message_buffers(
        &self,
        run: &Value,
        session: &Value,
        context: &RunContext,
    ) -> Vec<Value> {
        let run_id = run["id"].as_str().unwrap_or("");
        let partial = self
            .message_buffers
            .lock()
            .unwrap()
            .remove(run_id)
            .unwrap_or_default();
        let mut messages = Vec::new();
        for (key, buffered) in partial {
            if buffered.subagent_dispatch_id.is_some() {
                self.message_buffers
                    .lock()
                    .unwrap()
                    .entry(format!("{run_id}:background"))
                    .or_default()
                    .insert(key, buffered);
            } else if !buffered.text.is_empty() {
                if let Some(message) = self.persist(
                    run,
                    session,
                    &AdapterEvent::Message {
                        text: buffered.text,
                        phase: Some("completed".into()),
                        message_id: buffered.message_id,
                        subagent_dispatch_id: None,
                        raw: None,
                    },
                    context,
                ) {
                    messages.push(message);
                }
            }
        }
        messages
    }
    fn flush_background_messages(&self, run: &Value, session: &Value, context: &RunContext) {
        let key = format!("{}:background", run["id"].as_str().unwrap_or(""));
        let partial = self
            .message_buffers
            .lock()
            .unwrap()
            .remove(&key)
            .unwrap_or_default();
        for (_, buffered) in partial {
            if !buffered.text.is_empty() {
                self.persist(
                    run,
                    session,
                    &AdapterEvent::Message {
                        text: buffered.text,
                        phase: Some("completed".into()),
                        message_id: buffered.message_id,
                        subagent_dispatch_id: buffered.subagent_dispatch_id,
                        raw: None,
                    },
                    context,
                );
            }
        }
    }
    pub(super) fn queue_native_origin(&self, run_id: &str, event: AdapterEvent) -> bool {
        let gate = self
            .session_event_gates
            .lock()
            .unwrap()
            .get(run_id)
            .and_then(std::sync::Weak::upgrade);
        if let Some(gate) = gate {
            gate.push(event);
            true
        } else {
            false
        }
    }
    pub(crate) async fn release_native_session(&self, session: &Value) -> CoreResult<()> {
        let session_id = session["id"].as_str().unwrap_or("");
        let agent = {
            let db = self.db.lock().unwrap();
            crate::application::session_service::effective_agent_id(&db.raw, session)
                .ok()
                .and_then(|id| Repositories::new(&db.raw).agents().get(&id).ok().flatten())
        };
        let mut runs = std::collections::HashSet::new();
        self.native_origins
            .lock()
            .unwrap()
            .retain(|(id, _, _), origin| {
                if id == session_id {
                    if let Some(id) = origin.run["id"].as_str() {
                        runs.insert(id.to_string());
                    }
                    false
                } else {
                    true
                }
            });
        self.message_buffers
            .lock()
            .unwrap()
            .retain(|key, _| !runs.contains(key.trim_end_matches(":background")));
        if let Some(interactions) = self.interactions.read().unwrap().as_ref() {
            interactions.cancel_for_session(session_id);
        }
        if let Some(agent) = agent {
            if let Some(adapter) = self
                .adapters
                .find(agent["providerId"].as_str().unwrap_or(""))
            {
                adapter
                    .release_session(&AdapterStartRequest {
                        instance: agent,
                        local_session_id: Some(session_id.into()),
                        ..Default::default()
                    })
                    .await?;
            }
        }
        Ok(())
    }
    /// Native ids remain stable when a child/tool continues across a new user
    /// turn. Preserve its originating run instead of assigning the latest run.
    pub(super) fn native_origin(
        &self,
        run: &Value,
        session: &Value,
        event: &AdapterEvent,
        context: &RunContext,
    ) -> Option<NativeOrigin> {
        let (parent, id) = match event {
            AdapterEvent::Message {
                subagent_dispatch_id,
                message_id,
                ..
            } => (
                subagent_dispatch_id.as_ref().map(|id| format!("call:{id}")),
                message_id.as_ref().map(|id| format!("message:{id}")),
            ),
            AdapterEvent::Thinking {
                subagent_dispatch_id,
                message_id,
                ..
            } => (
                subagent_dispatch_id.as_ref().map(|id| format!("call:{id}")),
                message_id.as_ref().map(|id| format!("thinking:{id}")),
            ),
            AdapterEvent::Tool {
                subagent_dispatch_id,
                call_id,
                ..
            }
            | AdapterEvent::Command {
                subagent_dispatch_id,
                call_id,
                ..
            } => (
                subagent_dispatch_id.as_ref().map(|id| format!("call:{id}")),
                call_id.as_ref().map(|id| format!("call:{id}")),
            ),
            _ => return None,
        };
        let scope = json!([
            run["agentInstanceId"],
            run["connectionId"],
            run["connectionRevision"]
        ])
        .to_string();
        let provider_session=session["providerSessionId"].as_str().unwrap_or("").to_string();
        let session = session["id"].as_str().unwrap_or("").to_string();
        let native_turn=match event {
            AdapterEvent::Message{raw,..}|AdapterEvent::Thinking{raw,..}|AdapterEvent::Tool{raw,..}|AdapterEvent::Command{raw,..}=>raw.as_ref().and_then(|raw|raw["nativeTurnId"].as_str()).map(str::to_string),_=>None,
        };
        let existing = {let origins=self.native_origins.lock().unwrap();parent
            .as_ref()
            .and_then(|id| origins.get(&(session.clone(), scope.clone(), id.clone())))
            .or_else(|| {
                id.as_ref()
                    .and_then(|id| origins.get(&(session.clone(), scope.clone(), id.clone())))
            })
            .or_else(||native_turn.as_ref().and_then(|turn|origins.get(&(session.clone(),scope.clone(),format!("native-turn:{turn}")))))
            .cloned()};
        let origin = existing.unwrap_or_else(|| {
            if run["origin"]=="native-terminal" {
                if let Some(turn)=&native_turn {
                    let db=self.db.lock().unwrap();let repo=crate::database::Repositories::new(&db.raw);
                    let id=super::native_history::native_run_id(&session,&provider_session,turn);
                    let mut native=repo.runs().get(&id).ok().flatten().unwrap_or_else(||run.clone());
                    native["id"]=json!(id);native["mode"]=json!("foreground");native["nativeTurnId"]=json!(turn);
                    native["providerSessionId"]=json!(provider_session);
                    if native["status"].is_null(){native["status"]=json!("running");native["startedAt"]=json!(crate::errors::now_iso());}
                    let _=repo.runs().save(&native);
                    return NativeOrigin{run:native,context:context.clone()};
                }
            }
            NativeOrigin {
            run: run.clone(),
            context: context.clone(),
        }});
        let mut origins=self.native_origins.lock().unwrap();
        if let Some(id) = id {
            origins.entry((session.clone(), scope.clone(), id)).or_insert_with(||origin.clone());
        }
        if let Some(turn)=native_turn {origins.entry((session,scope,format!("native-turn:{turn}"))).or_insert_with(||origin.clone());}
        (origin.run["id"]!=run["id"]).then_some(origin)
    }

    fn bound_session(&self, expected: &Value, agent: &Value) -> Option<Value> {
        let db = self.db.lock().unwrap();
        let current = Repositories::new(&db.raw)
            .sessions()
            .get(expected["id"].as_str()?)
            .ok()??;
        if current["connectionId"] != expected["connectionId"]
            || current["connectionRevision"] != expected["connectionRevision"]
        {
            return None;
        }
        let id = crate::application::session_service::effective_agent_id(&db.raw, &current).ok()?;
        (Some(id.as_str()) == agent["id"].as_str()).then_some(current)
    }

    pub(super) fn session_callbacks(
        self: &Arc<Self>,
        session: &Value,
        agent: &Value,
        run: &Value,
        context: &RunContext,
    ) -> SessionCallbacks {
        let service = Arc::downgrade(self);
        let expected = session.clone();
        let instance = agent.clone();
        let mut origin = run.clone();
        origin["backgroundEvent"] = json!(true);
        let background_context = context.clone();
        let events = Arc::new(move |event: AdapterEvent| {
            let Some(service) = service.upgrade() else {
                return;
            };
            let Some(current) = service.bound_session(&expected, &instance) else {
                return;
            };
            match &event {
                AdapterEvent::Exit { exit_code, signal } => {
                    service.flush_background_messages(&origin, &current, &background_context);
                    let _=service.events.append(&origin,&current,"provider.runtime_closed",json!({"providerId":instance["providerId"],"exitCode":exit_code,"signal":signal}));
                }
                AdapterEvent::Error { message } => {
                    let _=service.events.append(&origin,&current,"provider.background_error",json!({"providerId":instance["providerId"],"message":service.redaction.text(message)}));
                }
                AdapterEvent::Timeout { reason } => {
                    let _=service.events.append(&origin,&current,"provider.background_error",json!({"providerId":instance["providerId"],"message":format!("Native background runtime exceeded {} limit",reason.as_str())}));
                }
                _ => {
                    service.persist(&origin, &current, &event, &background_context);
                }
            }
        });

        let gate = Arc::new(SessionEventGate {
            queue: Mutex::new(EventQueue {
                foreground: true,
                draining: false,
                events: VecDeque::new(),
            }),
            write: events,
        });
        {
            let mut gates = self.session_event_gates.lock().unwrap();
            gates.retain(|_, gate| gate.strong_count() != 0);
            gates.insert(
                run["id"].as_str().unwrap_or("").into(),
                Arc::downgrade(&gate),
            );
        }
        let handoff = ForegroundHandoff(gate.clone());
        let service = Arc::downgrade(self);
        let expected = session.clone();
        let instance = agent.clone();
        let events = Arc::new(move |event: AdapterEvent| {
            // Native cancellation must dismiss a waiting question immediately,
            // even while the foreground journal is still draining.
            if let AdapterEvent::Status { phase, raw } = &event {
                if phase == "extension_ui"
                    && raw.as_ref().is_some_and(|raw| raw["method"] == "cancel")
                {
                    if let (Some(service), Some(native_id)) = (
                        service.upgrade(),
                        raw.as_ref()
                            .and_then(|raw| raw.pointer("/raw/targetId"))
                            .and_then(Value::as_str),
                    ) {
                        if service.bound_session(&expected, &instance).is_some() {
                            if let Some(interactions) =
                                service.interactions.read().unwrap().as_ref()
                            {
                                interactions.cancel_session_native(
                                    expected["id"].as_str().unwrap_or(""),
                                    native_id,
                                );
                            }
                        }
                    }
                }
            }
            gate.push(event);
        });

        let service = Arc::downgrade(self);
        let expected = session.clone();
        let instance = agent.clone();
        let interaction = Arc::new(move |input: Value| {
            let service = service.upgrade();
            let expected = expected.clone();
            let instance = instance.clone();
            Box::pin(async move {
                let service =
                    service.ok_or_else(|| anyhow::anyhow!("Native session was released"))?;
                let current = service
                    .bound_session(&expected, &instance)
                    .ok_or_else(|| anyhow::anyhow!("Native session binding changed"))?;
                let interactions = service.interactions.read().unwrap().clone();
                match interactions {
                    Some(interactions) => Ok(interactions
                        .request(
                            &current,
                            None,
                            instance["providerId"].as_str().unwrap_or(""),
                            input,
                        )
                        .await),
                    None => Ok(json!({"outcome":"cancelled"})),
                }
            }) as crate::adapters::BoxFuture<anyhow::Result<Value>>
        });

        let service = Arc::downgrade(self);
        let expected = session.clone();
        let instance = agent.clone();
        let context = json!({"projectRunId":context.project_run_id,"taskId":context.task_id});
        let tool = Arc::new(move |input: Value| {
            let service = service.upgrade();
            let expected = expected.clone();
            let instance = instance.clone();
            let context = context.clone();
            Box::pin(async move {
                let service =
                    service.ok_or_else(|| anyhow::anyhow!("Native session was released"))?;
                let current = service
                    .bound_session(&expected, &instance)
                    .ok_or_else(|| anyhow::anyhow!("Native session binding changed"))?;
                let binding = service
                    .runtime_tool_provider
                    .read()
                    .unwrap()
                    .as_ref()
                    .and_then(|provider| provider.for_run(&current, &context, &instance));
                match binding {
                    Some(binding) => (binding.execute)(input).await,
                    None => anyhow::bail!("This session has no runtime tool binding"),
                }
            }) as crate::adapters::BoxFuture<anyhow::Result<Value>>
        });
        SessionCallbacks {
            handoff,
            events,
            interaction,
            tool,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Arc<RunService>, Value, Value, Value) {
        let db = Arc::new(Mutex::new(
            Database::open(std::path::Path::new(":memory:")).unwrap(),
        ));
        let now = now_iso();
        let agent = json!({"id":"a","providerId":"pi","displayName":"Pi","executable":"pi","baseArgs":[],"enabled":true,"status":"available"});
        let session = json!({"id":"s","projectId":"p","agentInstanceId":"a","status":"idle","createdAt":now,"updatedAt":now});
        let run = json!({"id":"r1","sessionId":"s","agentInstanceId":"a","mode":"headless_structured","status":"completed","startedAt":now,"endedAt":now});
        {
            let db = db.lock().unwrap();
            let repos = Repositories::new(&db.raw);
            repos
                .projects()
                .save(
                    &json!({"id":"p","name":"test","rootPath":std::env::temp_dir()}),
                    &now,
                )
                .unwrap();
            repos.agents().save(&agent, &now).unwrap();
            repos.sessions().save(&session).unwrap();
            repos.runs().save(&run).unwrap();
        }
        let events = Arc::new(EventService::new(db.clone(), Default::default()));
        let credentials = Arc::new(CredentialService::new(db.clone(), &std::env::temp_dir()));
        let policies = Arc::new(CommandPolicyService::new(db.clone()).unwrap());
        let approvals = Arc::new(ApprovalService::new(db.clone()));
        let audit = AuditService::new(db.clone(), Default::default());
        (
            RunService::new(
                db,
                AdapterRegistry::with_builtins(),
                events,
                credentials,
                policies,
                approvals,
                Default::default(),
                audit,
            ),
            agent,
            session,
            run,
        )
    }
    fn tool(id: &str, phase: &str) -> AdapterEvent {
        AdapterEvent::Tool {
            call_id: Some(id.into()),
            name: "Task".into(),
            phase: Some(phase.into()),
            input: None,
            output: Some(json!("late result")),
            success: Some(true),
            file_diff: None,
            subagent_dispatch_id: None,
            raw: None,
        }
    }
    #[tokio::test]
    async fn ptc_metadata_survives_large_code_and_remains_redacted_structured_json() {
        let (service, _, session, run) = fixture();
        let code = "x".repeat(270_000);
        let execution = json!({"partial":true,"calls":[
            {"callId":"large","name":"run_code","input":{"code":code,"apiKey":"private-fixture"},"status":"running"},
            {"callId":"small","parentCallId":"large","name":"read","input":{"path":"src/main.ts"},"status":"done"}
        ]});
        let event = AdapterEvent::Tool {
            call_id: Some("root".into()), name: "run_code".into(), phase: Some("updated".into()), input: None, output: None,
            success: None, file_diff: None, subagent_dispatch_id: Some("native-child".into()), raw: Some(json!({"codeExecution":execution})),
        };
        service.persist(&run, &session, &event, &RunContext::default());
        let db = service.db.lock().unwrap();
        let events = Repositories::new(&db.raw).events().replay(Some("s"), None, None, None).unwrap();
        let saved = &events.last().unwrap()["payload"]["codeExecution"];
        assert_eq!(saved["calls"][0]["input"]["code"].as_str().unwrap().len(), 270_000);
        assert_eq!(saved["calls"][0]["input"]["apiKey"], "[REDACTED]");
        assert_eq!(saved["calls"][1]["input"]["path"], "src/main.ts");
        assert_eq!(events.last().unwrap()["payload"]["subagentDispatchId"], "native-child");
    }
    #[tokio::test]
    async fn late_native_activity_keeps_its_run_and_cannot_rewrite_foreground_completion() {
        let (service, agent, session, run) = fixture();
        let context = RunContext::default();
        service.persist(&run, &session, &tool("child", "started"), &context);
        let mut next = run.clone();
        next["id"] = json!("r2");
        service.persist(&next, &session, &tool("child", "completed"), &context);
        let callbacks = service.session_callbacks(&session, &agent, &run, &context);
        drop(callbacks.handoff);
        (callbacks.events)(AdapterEvent::Error {
            message: "native background failure".into(),
        });
        (callbacks.events)(AdapterEvent::Exit {
            exit_code: Some(9),
            signal: None,
        });
        let db = service.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        assert_eq!(
            repos.runs().get("r1").unwrap().unwrap()["status"],
            "completed"
        );
        let events = repos.events().replay(Some("s"), None, None, None).unwrap();
        assert!(events.iter().any(|event| event["type"] == "tool.finished"
            && event["runId"] == "r1"
            && event["background"] == true));
        assert!(events.iter().any(
            |event| event["type"] == "provider.background_error" && event["background"] == true
        ));
        assert!(!events.iter().any(|event| event["type"] == "run.failed"));
    }
    #[tokio::test]
    async fn background_message_identity_and_stale_account_bindings_are_preserved() {
        let (service, agent, session, run) = fixture();
        let context = RunContext::default();
        let callbacks = service.session_callbacks(&session, &agent, &run, &context);
        drop(callbacks.handoff);
        let message = |id: &str, text: &str, phase: &str| AdapterEvent::Message {
            text: text.into(),
            phase: Some(phase.into()),
            message_id: Some(id.into()),
            subagent_dispatch_id: None,
            raw: None,
        };
        service.persist(
            &run,
            &session,
            &message("foreground-id", "foreground", "delta"),
            &context,
        );
        (callbacks.events)(message("background-id", "background", "delta"));
        service.persist(
            &run,
            &session,
            &message("foreground-id", "", "completed"),
            &context,
        );
        (callbacks.events)(message("background-id", "", "completed"));
        let mut changed = session.clone();
        changed["connectionId"] = json!("different-account");
        Repositories::new(&service.db.lock().unwrap().raw)
            .sessions()
            .save(&changed)
            .unwrap();
        (callbacks.events)(message(
            "background-id",
            "must not cross accounts",
            "completed",
        ));
        let messages = Repositories::new(&service.db.lock().unwrap().raw)
            .sessions()
            .messages("s")
            .unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["text"], "foreground");
        assert_eq!(messages[1]["text"], "background");
        assert_eq!(messages[1]["background"], true);
        let events = Repositories::new(&service.db.lock().unwrap().raw)
            .events()
            .replay(Some("s"), None, None, None)
            .unwrap();
        assert!(events.iter().any(|event| event["type"] == "agent.message"
            && event["payload"]["providerMessageId"] == "background-id"));
    }

    fn child_message(text: &str, phase: &str) -> AdapterEvent {
        AdapterEvent::Message {
            text: text.into(),
            phase: Some(phase.into()),
            message_id: Some("message:one".into()),
            subagent_dispatch_id: Some("child:with:colon".into()),
            raw: None,
        }
    }
    #[tokio::test]
    async fn foreground_handoff_keeps_child_prefix_identity_and_frame_order() {
        let (service, agent, session, run) = fixture();
        let context = RunContext::default();
        let mut announced = service.events.subscribe_events();
        let callbacks = service.session_callbacks(&session, &agent, &run, &context);
        // The adapter has already switched to its session callback, but the
        // host has not consumed earlier foreground messages yet.
        (callbacks.events)(child_message("after", "delta"));
        (callbacks.events)(child_message("", "completed"));
        assert!(Repositories::new(&service.db.lock().unwrap().raw)
            .events()
            .replay(Some("s"), None, None, None)
            .unwrap()
            .is_empty());
        service.persist(&run, &session, &child_message("before ", "delta"), &context);
        service.persist(
            &run,
            &session,
            &tool("foreground-tool", "completed"),
            &context,
        );
        assert!(service
            .handoff_message_buffers(&run, &session, &context)
            .is_empty());
        drop(callbacks.handoff);
        let db = service.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let events = repos.events().replay(Some("s"), None, None, None).unwrap();
        let deltas: Vec<_> = events
            .iter()
            .filter(|event| event["type"] == "agent.message_delta")
            .collect();
        // The journal coalesces a stream into a cumulative delta row, while
        // the live broadcasts preserve both sides of the handoff.
        assert_eq!(deltas.len(), 1);
        assert_eq!(deltas[0]["payload"]["text"], "before after");
        assert_eq!(deltas[0]["background"], true);
        let mut live_deltas = Vec::new();
        while let Ok(event) = announced.try_recv() {
            if event["type"] == "agent.message_delta" {
                live_deltas.push(event);
            }
        }
        assert_eq!(live_deltas.len(), 2);
        assert_eq!(live_deltas[0]["payload"]["text"], "before ");
        assert_eq!(live_deltas[1]["payload"]["text"], "before after");
        assert_eq!(
            live_deltas[0]["payload"]["messageId"],
            live_deltas[1]["payload"]["messageId"]
        );
        let final_messages: Vec<_> = events
            .iter()
            .filter(|event| event["type"] == "agent.message")
            .collect();
        assert_eq!(final_messages.len(), 1);
        assert_eq!(final_messages[0]["payload"]["text"], "before after");
        assert_eq!(
            final_messages[0]["payload"]["providerMessageId"],
            deltas[0]["payload"]["messageId"]
        );
        assert!(
            events
                .iter()
                .position(|event| event["type"] == "tool.finished")
                .unwrap()
                < events
                    .iter()
                    .position(|event| event["type"] == "agent.message")
                    .unwrap()
        );
        assert!(
            repos.sessions().messages("s").unwrap().is_empty(),
            "child output stays out of main chat history"
        );
    }
    #[tokio::test]
    async fn native_exit_commits_visible_child_and_background_partial_text() {
        let (service, agent, session, run) = fixture();
        let context = RunContext::default();
        let callbacks = service.session_callbacks(&session, &agent, &run, &context);
        service.persist(&run, &session, &child_message("before ", "delta"), &context);
        (callbacks.events)(child_message("after", "delta"));
        (callbacks.events)(AdapterEvent::Message {
            text: "visible background text".into(),
            phase: Some("delta".into()),
            message_id: Some("background-main".into()),
            subagent_dispatch_id: None,
            raw: None,
        });
        (callbacks.events)(AdapterEvent::Exit {
            exit_code: Some(9),
            signal: None,
        });
        service.handoff_message_buffers(&run, &session, &context);
        drop(callbacks.handoff);
        let db = service.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let events = repos.events().replay(Some("s"), None, None, None).unwrap();
        assert!(events
            .iter()
            .any(|event| event["type"] == "agent.message"
                && event["payload"]["text"] == "before after"));
        assert!(events.iter().any(|event| event["type"] == "agent.message"
            && event["payload"]["text"] == "visible background text"));
        assert_eq!(repos.sessions().messages("s").unwrap().len(), 1);
        assert_eq!(
            repos.runs().get("r1").unwrap().unwrap()["status"],
            "completed"
        );
        assert!(service
            .message_buffers
            .lock()
            .unwrap()
            .values()
            .all(HashMap::is_empty));
    }
}
