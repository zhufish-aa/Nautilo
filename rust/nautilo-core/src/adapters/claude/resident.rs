//! Claude stream-json stays open across turns, with run-scoped callbacks rebound.
use super::*;
use agenthub_plugin_sdk::process::{self, ProcessEvent, ProcessRequest as NativeRequest};
use agenthub_plugin_sdk::session_pool::{SessionPool, TurnBudget};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    OnceLock,
};
use tokio::sync::{mpsc, watch};

struct Resident {
    session_id: Option<String>,
    process: Option<process::StartedProcess>,
    callbacks: Arc<Mutex<AdapterStartRequest>>,
    bridge: Option<crate::adapters::runtime_mcp_bridge::RuntimeMcpBridge>,
    config: Option<private_config::PrivateClaudeConfig>,
    proxy: Option<api_proxy::ApiProxy>,
    parse_state: SharedClaudeParseState,
}
impl Resident {
    async fn close(mut self) {
        if let Some(process) = self.process.take() {
            process.handle.cancel().await;
        }
        self.bridge.take();
        self.config.take();
        self.proxy.take();
    }
}
impl Drop for Resident {
    fn drop(&mut self) {
        if let Some(process) = self.process.take() {
            let bridge = self.bridge.take();
            let config = self.config.take();
            let proxy = self.proxy.take();
            tokio::spawn(async move {
                process.handle.cancel().await;
                drop((bridge, config, proxy));
            });
        }
    }
}
fn pool() -> &'static SessionPool<Resident> {
    static POOL: OnceLock<SessionPool<Resident>> = OnceLock::new();
    POOL.get_or_init(Default::default)
}

async fn open(mut request: AdapterStartRequest, resume: Option<&str>) -> anyhow::Result<Resident> {
    let callbacks = Arc::new(Mutex::new(request.clone()));
    let executor = callbacks.clone();
    let execute: crate::adapters::runtime_mcp_bridge::ToolExecutor = Arc::new(move |input| {
        let execute = executor.lock().unwrap().execute_runtime_tool.clone();
        Box::pin(async move {
            match execute {
                Some(execute) => execute(input).await,
                None => anyhow::bail!("No active runtime tool callback"),
            }
        })
    });
    let permissions = callbacks.clone();
    let permission: crate::adapters::runtime_mcp_bridge::PermissionPromptHandler =
        Arc::new(move |name, input| {
            let ask = permissions.lock().unwrap().request_interaction.clone();
            Box::pin(async move {
                match ask {
                    Some(ask) => build_claude_permission_prompt_handler(ask)(name, input).await,
                    None => Ok(json!({"behavior":"deny","message":"No active permission handler"})),
                }
            })
        });
    let proxy = api_proxy::ApiProxy::prepare(&mut request)?;
    let tools = request
        .runtime_tools
        .as_ref()
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let bridge = Some(start_runtime_mcp_bridge(
        "claude-code",
        tools,
        Some(execute),
        Some(permission),
    )?);
    let mut args = match resume {
        Some(id) => {
            build_claude_resume_args(&request.instance, id, &request.prompt, Some(&request))
        }
        None => build_claude_start_args(&request.instance, &request.prompt, Some(&request)),
    };
    args.pop();
    args.extend(claude_runtime_mcp_args(
        bridge.as_ref().map(|bridge| bridge.url.as_str()),
        request.mcp_servers.as_deref().unwrap_or(&[]),
    ));
    args.extend(claude_permission_prompt_tool_args(&request, true));
    if let Some(path) = request.output_schema_path.as_deref().or_else(|| {
        request
            .instance
            .pointer("/providerOptions/outputSchemaPath")
            .and_then(Value::as_str)
    }) {
        let schema: Value = serde_json::from_slice(&std::fs::read(
            std::path::Path::new(&request.cwd).join(path),
        )?)?;
        args.extend(["--json-schema".into(), schema.to_string()]);
    }
    args.extend(["--input-format".into(), "stream-json".into()]);
    // Private config's argv parser deliberately excludes a final prompt.
    args.push(String::new());
    let mut config = private_config::materialize(args)?;
    config.args.pop();
    let mut env = request.env.clone().unwrap_or_default();
    if request.reasoning_effort.is_some() {
        env.entry("CLAUDE_CODE_ALWAYS_ENABLE_EFFORT".into())
            .or_insert_with(|| "1".into());
    }
    let started = process::start(&NativeRequest {
        command: request.instance["executable"]
            .as_str()
            .unwrap_or("claude")
            .into(),
        args: config.args.clone(),
        cwd: Some(request.cwd.clone()),
        env: Some(env),
        ..Default::default()
    })?;
    if let Err(error) = config.record_child(started.handle.pid) {
        started.handle.cancel().await;
        return Err(error.into());
    }
    Ok(Resident {
        session_id: None,
        process: Some(started),
        callbacks,
        bridge,
        config: Some(config),
        proxy,
        parse_state: create_claude_parse_state(),
    })
}

pub fn launch(request: AdapterStartRequest, resume: Option<String>) -> CoreResult<AdapterRun> {
    let (sender, receiver) = mpsc::unbounded_channel();
    let slot = Arc::new(Mutex::new(None::<process::ProcessHandle>));
    let cancelled = Arc::new(AtomicBool::new(false));
    let pending = Arc::new(AtomicUsize::new(1));
    let (done, done_rx) = watch::channel(false);
    let process_slot = slot.clone();
    let cancel_flag = cancelled.clone();
    let outstanding = pending.clone();
    let prompt_request = request.clone();
    tokio::spawn(async move {
        let result = run(
            request,
            resume,
            sender.clone(),
            process_slot,
            cancel_flag,
            outstanding,
        )
        .await;
        if let Err(error) = &result {
            let _ = sender.send(AdapterEvent::Error {
                message: error.to_string(),
            });
        }
        done.send_replace(true);
        let _ = sender.send(AdapterEvent::Exit {
            exit_code: Some(if result.is_ok() { 0 } else { 1 }),
            signal: None,
        });
    });
    let cancel_slot = slot.clone();
    let cancel_flag = cancelled.clone();
    let steer_slot = slot;
    let run=AdapterRun::new(receiver,move ||Box::pin(async move {
        cancel_flag.store(true,Ordering::Release);
        let handle=cancel_slot.lock().unwrap().clone();
        if let Some(handle)=handle {
            handle.write(&format!("{}\n",json!({"type":"control_request","request_id":uuid::Uuid::new_v4().to_string(),"request":{"subtype":"interrupt"}})));
            let mut done=done_rx;
            if tokio::time::timeout(std::time::Duration::from_secs(3),done.wait_for(|done|*done)).await.is_err() {handle.cancel().await;}
        }
    }),move |_|{}).with_steer(Arc::new(move |text:String| {
        let handle=steer_slot.lock().unwrap().clone(); let pending=pending.clone(); let cancelled=cancelled.clone(); let mut request=prompt_request.clone();
        Box::pin(async move {
            if cancelled.load(Ordering::Acquire) { return Err(crate::errors::invalid("sessionId", "Claude turn is cancelling")); }
            let handle=handle.ok_or_else(||crate::errors::invalid("sessionId", "Claude runtime is still starting"))?;
            request.prompt=text; request.local_image_paths=None;
            let frame=user_frame(&request).map_err(|error|crate::errors::invalid("prompt", &error.to_string()))?;
            pending.fetch_add(1,Ordering::AcqRel); handle.write(&frame); Ok(())
        })
    }));
    Ok(run)
}

fn user_frame(request: &AdapterStartRequest) -> anyhow::Result<String> {
    Ok(format!(
        "{}\n",
        json!({"type":"user","uuid":uuid::Uuid::new_v4().to_string(),"message":{"role":"user","content":crate::adapters::images::prompt_blocks(request,true)?}})
    ))
}

async fn run(
    request: AdapterStartRequest,
    resume: Option<String>,
    sender: mpsc::UnboundedSender<AdapterEvent>,
    slot: Arc<Mutex<Option<process::ProcessHandle>>>,
    cancelled: Arc<AtomicBool>,
    pending: Arc<AtomicUsize>,
) -> anyhow::Result<()> {
    let attached = std::time::Instant::now();
    let mut reused = false;
    let wire = crate::adapters::start_request_to_json(&request);
    let identity = agenthub_plugin_sdk::session_pool::identity(&wire);
    let key = request
        .local_session_id
        .clone()
        .or(resume.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut native = if let Some((old, native)) = pool().take(&key) {
        if resume.is_some()
            && native.session_id == resume
            && old == identity
            && native
                .process
                .as_ref()
                .is_some_and(|process| process.handle.is_alive())
        {
            reused = true;
            native
        } else {
            native.close().await;
            open(request.clone(), resume.as_deref()).await?
        }
    } else {
        open(request.clone(), resume.as_deref()).await?
    };
    *native.callbacks.lock().unwrap() = request.clone();
    native.process.as_ref().unwrap().events.pause().await;
    let handle = native.process.as_ref().unwrap().handle.clone();
    *slot.lock().unwrap() = Some(handle.clone());
    let _=sender.send(AdapterEvent::Status{phase:"runtime_ready".into(),raw:Some(json!({"providerId":"claude-code","transport":"stream-json","reused":reused,"pid":handle.pid,"attachMs":attached.elapsed().as_millis()}))});
    if cancelled.load(Ordering::Acquire) {
        native.close().await;
        anyhow::bail!("Claude startup was cancelled");
    }
    handle.write(&user_frame(&request)?);
    let state = native.parse_state.clone();
    let mut budget = TurnBudget::new(&wire);
    let mut buffer = String::new();
    let result: anyhow::Result<()> = async {
        while let Some(event)=budget.recv(&mut native.process.as_mut().unwrap().events).await {
            match event {
                ProcessEvent::Stdout(text)=>{
                    buffer.push_str(&text);
                    anyhow::ensure!(buffer.len()<=64*1024*1024,"Claude protocol frame exceeded limit");
                    while let Some(end)=buffer.find('\n') {
                        let line=buffer[..end].trim().to_string(); buffer.drain(..=end);
                        if line.is_empty(){continue;}
                        let value:Value=match serde_json::from_str(&line){Ok(value)=>value,Err(_)=>{let _=sender.send(AdapterEvent::Raw{stream:"stdout".into(),text:line});continue;}};
                        if value["type"]=="control_request" {
                            let handle=handle.clone();let callbacks=native.callbacks.clone();let sender=sender.clone();
                            tokio::spawn(async move {answer_control_request(value,handle,callbacks,sender).await;});
                            continue;
                        }
                        let terminal=value["type"]=="result" && value["parent_tool_use_id"].is_null();
                        if terminal {native.session_id=value["session_id"].as_str().map(str::to_string);}
                        let last=terminal && pending.fetch_update(Ordering::AcqRel,Ordering::Acquire,|count|count.checked_sub(1)).ok()==Some(1);
                        for event in parse_claude_json_event(&value,&state) {
                            if !last && matches!(&event,AdapterEvent::Status{phase,..} if phase=="turn_completed" || phase=="turn_failed") {continue;}
                            let _=sender.send(event);
                        }
                        if last {anyhow::ensure!(value["is_error"]!=true && !value["subtype"].as_str().is_some_and(|subtype|subtype.starts_with("error")),"Claude returned an unsuccessful result");return Ok(());}
                    }
                },
                ProcessEvent::Stderr(text)=>{let _=sender.send(AdapterEvent::Raw{stream:"stderr".into(),text});},
                ProcessEvent::Error(message)=>anyhow::bail!(message),
                ProcessEvent::Timeout{reason}=>anyhow::bail!("Claude turn exceeded {reason} limit"),
                ProcessEvent::Exit{..}=>anyhow::bail!("Claude process exited before the native turn result"),
            }
        }
        anyhow::bail!("Claude event stream ended before the native turn result")
    }.await;
    if result.is_ok()
        && !cancelled.load(Ordering::Acquire)
        && handle.is_alive()
        && !sender.is_closed()
    {
        let mut idle=request.clone();
        idle.request_interaction=request.session_interaction.clone();
        idle.execute_runtime_tool=request.session_tool.clone();
        *native.callbacks.lock().unwrap()=idle;
        if let Some(publish)=request.session_events.clone() {
            let(sink,mut updates)=mpsc::unbounded_channel();
            tokio::spawn(async move {while let Some(event)=updates.recv().await {publish(event);}});
            let callbacks=native.callbacks.clone();let idle_handle=handle.clone();
            native.process.as_ref().unwrap().events.observe_idle_with_pending(Arc::new(move |event| {
                match event {
                    ProcessEvent::Stdout(text)=>{
                        if let Ok(value)=serde_json::from_str::<Value>(text.trim()) {
                            if value["type"]=="control_request" {
                                let handle=idle_handle.clone();let callbacks=callbacks.clone();let sink=sink.clone();
                                tokio::spawn(async move {answer_control_request(value,handle,callbacks,sink).await;});
                            } else {for event in parse_claude_json_event(&value,&state){let _=sink.send(event);}}
                        } else {let _=sink.send(AdapterEvent::Raw{stream:"stdout".into(),text});}
                    },
                    ProcessEvent::Stderr(text)=>{let _=sink.send(AdapterEvent::Raw{stream:"stderr".into(),text});},
                    ProcessEvent::Exit{exit_code,signal}=>{let _=sink.send(AdapterEvent::Exit{exit_code,signal});},
                    ProcessEvent::Error(message)=>{let _=sink.send(AdapterEvent::Error{message});},
                    ProcessEvent::Timeout{reason}=>{let _=sink.send(AdapterEvent::Error{message:format!("Claude background runtime exceeded {reason} limit")});}
                }
            }),buffer);
        }
        pool().put(key, identity, native);
    } else {
        native.close().await;
    }
    result
}

pub async fn dispose() {
    for native in pool().drain() {
        native.close().await;
    }
}
pub async fn release_session(local_id: &str) {
    if let Some(native) = pool().retire(local_id) {
        native.close().await;
    }
}

async fn answer_control_request(
    value: Value,
    handle: process::ProcessHandle,
    callbacks: Arc<Mutex<AdapterStartRequest>>,
    sender: mpsc::UnboundedSender<AdapterEvent>,
) {
    let id = value["request_id"].clone();
    let subtype = value
        .pointer("/request/subtype")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let handler = callbacks.lock().unwrap().request_interaction.clone();
    let result = if subtype == "can_use_tool" {
        let name = value["request"]["tool_name"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let input = value["request"]["input"].clone();
        match handler {
            Some(handler) => {
                let pending=build_claude_permission_prompt_handler(handler)(json!(name), input);
                tokio::select!{result=pending=>result,_=handle.wait()=>return}
            }
            None => Ok(json!({"behavior":"deny","message":"No active permission handler"})),
        }
    } else {
        Err(anyhow::anyhow!(
            "原生交互 {subtype} 需要原生 CLI，请通过终端继续。"
        ))
    };
    let response = match result {
        Ok(response) => json!({"subtype":"success","request_id":id,"response":response}),
        Err(error) => {
            let _ = sender.send(AdapterEvent::Tool {
                call_id: Some(format!("claude-control-{id}")),
                name: format!("Claude {subtype}"),
                phase: Some("completed".into()),
                input: None,
                output: Some(json!(error.to_string())),
                success: Some(false),
                file_diff: None,
                subagent_dispatch_id: None,
                raw: None,
            });
            json!({"subtype":"error","request_id":id,"error":error.to_string()})
        }
    };
    handle.write(&format!(
        "{}\n",
        json!({"type":"control_response","response":response})
    ));
}
