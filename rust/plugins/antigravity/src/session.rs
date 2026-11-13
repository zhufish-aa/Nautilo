use crate::{config, events::Events, interactions, rpc::Client, runtime_tools::RuntimeTools};
use agenthub_plugin_sdk::{
    jsonrpc::{JsonRpcClient, JsonRpcEvent},
    process::{self, ProcessEvent},
    DaemonChannel,
};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, watch};

pub struct Session {
    pub rpc: Arc<Client>,
    pub state: tokio::sync::Mutex<Value>,
    pub identity: Value,
    pub native_id: String,
    pub gate: tokio::sync::Mutex<()>,
    pub foreground: Arc<Mutex<Option<mpsc::UnboundedSender<Value>>>>,
    parser: Arc<Mutex<Events>>,
    pump: tokio::task::JoinHandle<()>,
    cancel_callbacks: watch::Sender<u64>,
    _tools: Option<RuntimeTools>,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.pump.abort();
        let p = self.rpc.process_handle();
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                p.cancel().await;
            });
        }
    }
}

impl Session {
    pub async fn open(
        request: &Value,
        resume: Option<&str>,
        channel: Option<Arc<dyn DaemonChannel>>,
    ) -> anyhow::Result<Self> {
        let mut servers = config::mcp_servers(request)?;
        let runtime_tools = request["runtimeTools"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let tools = if runtime_tools.is_empty() {
            None
        } else {
            let channel = channel
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Nautilo runtime tools have no session channel"))?;
            let bridge = RuntimeTools::start(runtime_tools, channel).await?;
            let mut name = "nautilo-runtime".to_owned();
            while servers.iter().any(|server| server["name"] == name) {
                name.push('_');
            }
            servers.push(json!({"type":"http","name":name,"url":bridge.url,"headers":[]}));
            Some(bridge)
        };
        // Await host setup before spawning agy, so cancelled startup cannot leave an orphan.
        let background = if let (Some(host), Some(binding)) =
            (crate::raw_channel(), request["sessionBindingId"].as_str())
        {
            Some(agenthub_plugin_sdk::session_sink(host, binding.into()).await)
        } else {
            None
        };
        let process = process::start(&config::process_request(request)?)?;
        let rpc = Arc::new(Client::new(JsonRpcClient::new(
            process.handle,
            process.events,
        )));
        let foreground = Arc::new(Mutex::new(None::<mpsc::UnboundedSender<Value>>));
        let parser = Arc::new(Mutex::new(Events::new()));
        let replay = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (cancel_callbacks, mut callback_generation) = watch::channel(0);
        let pump = {
            let rpc = rpc.clone();
            let foreground = foreground.clone();
            let parser = parser.clone();
            let replay = replay.clone();
            tokio::spawn(async move {
                let mut callbacks = tokio::task::JoinSet::new();
                loop {
                    let event = tokio::select! {
                        biased;
                        _=callback_generation.changed()=>{callbacks.abort_all();continue;},
                        event=rpc.next_event()=>event,
                        _=callbacks.join_next(),if !callbacks.is_empty()=>continue,
                    };
                    let Some(event) = event else { break };
                    let deliver = |event: Value| {
                        let target = foreground
                            .lock()
                            .unwrap()
                            .clone()
                            .or_else(|| background.clone());
                        if let Some(target) = target {
                            let _ = target.send(event);
                        }
                    };
                    match event {
                        JsonRpcEvent::Notification { method, params }
                            if method == "session/update" =>
                        {
                            if !replay.load(std::sync::atomic::Ordering::Acquire) {
                                for event in parser.lock().unwrap().update(&params["update"]) {
                                    deliver(event);
                                }
                            }
                        }
                        JsonRpcEvent::Request { id, method, params } => {
                            let rpc = rpc.clone();
                            let channel = channel.clone();
                            callbacks.spawn(async move {
                                interactions::respond(&rpc, &id, &method, &params, channel).await;
                            });
                        }
                        JsonRpcEvent::Transport(ProcessEvent::Stderr(text)) => {
                            deliver(json!({"kind":"raw","stream":"stderr","text":text}))
                        }
                        JsonRpcEvent::Response { id, .. } => {
                            rpc.projected(&id);
                        }
                        JsonRpcEvent::Transport(ProcessEvent::Exit { .. }) => break,
                        JsonRpcEvent::Transport(ProcessEvent::Error(message)) => {
                            deliver(json!({"kind":"error","message":message}));
                            break;
                        }
                        _ => {}
                    }
                }
                callbacks.abort_all();
                rpc.closed();
            })
        };
        let mut result = Self {
            rpc,
            state: tokio::sync::Mutex::new(Value::Null),
            identity: config_identity(request),
            native_id: String::new(),
            gate: Default::default(),
            foreground,
            parser,
            pump,
            cancel_callbacks,
            _tools: tools,
        };
        let initialized = timed(result.rpc.request("initialize", config::initialize()), 30).await?;
        anyhow::ensure!(
            initialized["protocolVersion"] == 1,
            "Antigravity returned an unsupported ACP version"
        );
        let method = if resume.is_some() {
            if initialized
                .pointer("/agentCapabilities/sessionCapabilities/resume")
                .is_some()
            {
                "session/resume"
            } else {
                anyhow::ensure!(
                    initialized
                        .pointer("/agentCapabilities/loadSession")
                        .and_then(Value::as_bool)
                        == Some(true),
                    "Antigravity cannot resume this native session"
                );
                "session/load"
            }
        } else {
            "session/new"
        };
        let mut params = json!({"cwd":request["cwd"],"mcpServers":servers});
        if let Some(id) = resume {
            params["sessionId"] = json!(id);
        }
        // session/load replays history. Already-rendered history is never a new turn.
        replay.store(resume.is_some(), std::sync::atomic::Ordering::Release);
        let mut state = timed(result.rpc.request(method, params), 60).await?;
        replay.store(false, std::sync::atomic::Ordering::Release);
        if let Some(id) = resume {
            if !state["sessionId"].is_string() {
                state["sessionId"] = json!(id);
            }
        }
        anyhow::ensure!(
            state["sessionId"].as_str().is_some_and(|s| !s.is_empty()),
            "Antigravity returned no native session ID"
        );
        result.native_id = state["sessionId"].as_str().unwrap().to_owned();
        *result.state.get_mut() = state;
        Ok(result)
    }

    pub async fn turn(
        &self,
        request: &Value,
        sender: mpsc::UnboundedSender<Value>,
        reused: bool,
    ) -> anyhow::Result<()> {
        let _gate = self.gate.lock().await;
        anyhow::ensure!(
            self.rpc.process_handle().is_alive(),
            "Antigravity native process is no longer running"
        );
        self.parser.lock().unwrap().begin_turn();
        *self.foreground.lock().unwrap() = Some(sender.clone());
        let result=async{
            let mut state=self.state.lock().await;
            let id=state["sessionId"].as_str().unwrap_or("").to_owned();
            sender.send(json!({"kind":"session","providerSessionId":id}))?;
            sender.send(json!({"kind":"status","phase":"runtime_ready","raw":{"providerId":"antigravity","transport":"acp","reused":reused,"pid":self.rpc.process_handle().pid}}))?;
            timed(config::apply(&self.rpc,&mut state,request),30).await?;
            drop(state);
            let prompt=agenthub_plugin_sdk::images::acp_prompt(request)?;
            let future=self.rpc.request("session/prompt",json!({"sessionId":id,"prompt":prompt}));
            let response=if let Some(ms)=request["timeoutMs"].as_u64().filter(|n|*n>0) {
                match tokio::time::timeout(Duration::from_millis(ms),future).await {
                    Ok(response)=>response?,
                    Err(_)=>{self.rpc.notify("session/cancel",json!({"sessionId":id}));anyhow::bail!("Antigravity turn exceeded its configured time limit");}
                }
            }else{future.await?};
            let cancelled=response["stopReason"]=="cancelled";
            for event in self.parser.lock().unwrap().finish(cancelled){sender.send(event)?;}
            if response["usage"].is_object(){sender.send(json!({"kind":"usage","usageScope":"turn","inputTokensIncludesCache":true,
                "inputTokens":response["usage"]["inputTokens"],"outputTokens":response["usage"]["outputTokens"],"cachedInputTokens":response["usage"]["cachedReadTokens"],"raw":response["usage"]}))?;}
            sender.send(json!({"kind":"status","phase":if cancelled{"cancelled"}else{"turn_completed"},"raw":response}))?;
            Ok(())
        }.await;
        self.foreground.lock().unwrap().take();
        result
    }
    pub async fn cancel(&self) {
        self.cancel_callbacks.send_modify(|value| *value += 1);
        self.rpc
            .notify("session/cancel", json!({"sessionId":self.native_id}));
    }
    pub async fn close(&self) {
        self.cancel_callbacks.send_modify(|value| *value += 1);
        let _ = timed(
            self.rpc
                .request("session/close", json!({"sessionId":self.native_id})),
            3,
        )
        .await;
        self.rpc.process_handle().cancel().await;
    }
}

pub fn config_identity(request: &Value) -> Value {
    let mut identity = agenthub_plugin_sdk::session_pool::identity(request);
    // ACP applies these without re-launching the process.
    if let Some(map) = identity.as_object_mut() {
        for k in ["model", "reasoningEffort"] {
            map.remove(k);
        }
    }
    identity
}
pub async fn timed<T>(
    f: impl std::future::Future<Output = anyhow::Result<T>>,
    seconds: u64,
) -> anyhow::Result<T> {
    tokio::time::timeout(Duration::from_secs(seconds), f)
        .await
        .map_err(|_| anyhow::anyhow!("Antigravity ACP request timed out after {seconds}s"))?
}
