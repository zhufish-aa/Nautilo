//! The plugin executable entrypoint: reads HostMessages on stdin, drives the
//! author's ProviderPlugin, writes protocol frames on stdout.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};

use crate::{emit, DaemonChannel, HostMessage, InteractionChannel, ProviderPlugin, PROVIDER_API_VERSION};

struct ActiveRun {
    cancel: tokio::sync::oneshot::Sender<()>,
}

struct WireInteractionChannel {
    writer: Arc<Mutex<tokio::io::Stdout>>,
    pending: Arc<std::sync::Mutex<HashMap<i64, tokio::sync::oneshot::Sender<Value>>>>,
    next_id: Arc<std::sync::atomic::AtomicI64>,
}
struct PendingWireGuard {pending:Arc<std::sync::Mutex<HashMap<i64,tokio::sync::oneshot::Sender<Value>>>>,id:i64,writer:Arc<Mutex<tokio::io::Stdout>>}
impl Drop for PendingWireGuard {fn drop(&mut self){
    if self.pending.lock().unwrap().remove(&self.id).is_some(){
        let writer=self.writer.clone();let id=self.id;
        if let Ok(runtime)=tokio::runtime::Handle::try_current(){runtime.spawn(async move{write_frame(&writer,&serde_json::json!({"type":"cancel_reverse_call","id":id})).await;});}
    }
}}

impl WireInteractionChannel {
    fn roundtrip(
        &self,
        frame: Value,
        fallback: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send>> {
        let id = frame.get("id").and_then(Value::as_i64).unwrap_or(0);
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.pending.lock().unwrap().insert(id, sender);
        let writer = self.writer.clone();
        let guard=PendingWireGuard{pending:self.pending.clone(),id,writer:writer.clone()};
        Box::pin(async move {
            let _guard=guard;
            write_frame(&writer, &frame).await;
            receiver.await.unwrap_or_else(|_| fallback)
        })
    }
}

impl InteractionChannel for WireInteractionChannel {
    fn ask(
        &self,
        run_id: &str,
        input: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let future = self.roundtrip(emit::interaction(id, run_id, &input), serde_json::json!({ "outcome": "cancelled" }));
        Box::pin(future)
    }
}

impl DaemonChannel for WireInteractionChannel {
    fn hold_session(&self,binding:&str,active:bool)->std::pin::Pin<Box<dyn std::future::Future<Output=()>+Send+'_>> {
        let writer=self.writer.clone();let frame=serde_json::json!({"type":"session_binding","bindingId":binding,"active":active});
        Box::pin(async move {write_frame(&writer,&frame).await;})
    }
    fn publish_session(&self,binding:&str,event:Value)->std::pin::Pin<Box<dyn std::future::Future<Output=()>+Send+'_>> {
        let writer=self.writer.clone();let frame=serde_json::json!({"type":"session_event","bindingId":binding,"event":event});
        Box::pin(async move {write_frame(&writer,&frame).await;})
    }
    fn ask_session(&self,binding:&str,input:Value)->std::pin::Pin<Box<dyn std::future::Future<Output=Value>+Send+'_>> {
        let id=self.next_id.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
        self.roundtrip(serde_json::json!({"type":"session_interaction","id":id,"bindingId":binding,"input":input}),serde_json::json!({"outcome":"cancelled"}))
    }
    fn call_session_tool(&self,binding:&str,name:&str,arguments:Value)->std::pin::Pin<Box<dyn std::future::Future<Output=Value>+Send+'_>> {
        let id=self.next_id.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
        self.roundtrip(serde_json::json!({"type":"session_tool","id":id,"bindingId":binding,"name":name,"arguments":arguments}),serde_json::json!({"success":false,"content":"Session tool channel closed"}))
    }
    fn ask(
        &self,
        run_id: &str,
        input: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        InteractionChannel::ask(self, run_id, input)
    }

    fn call_tool(
        &self,
        run_id: &str,
        name: &str,
        arguments: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let future = self.roundtrip(
            emit::tool_call(id, run_id, name, &arguments),
            serde_json::json!({ "success": false, "content": "daemon tool channel closed" }),
        );
        Box::pin(future)
    }
}

/// Runs the plugin main loop. The binary's main() is just:
/// `plugin_sdk::serve(MyPlugin::new()).await`
pub async fn serve<P: ProviderPlugin + 'static>(plugin: P) {
    let plugin = Arc::new(plugin);
    let stdout = tokio::io::stdout();
    let writer = Arc::new(Mutex::new(stdout));
    let active: Arc<Mutex<HashMap<String, ActiveRun>>> = Arc::new(Mutex::new(HashMap::new()));
    let interactions: Arc<std::sync::Mutex<HashMap<i64, tokio::sync::oneshot::Sender<Value>>>> =
        Arc::new(std::sync::Mutex::new(HashMap::new()));
    let channel = Arc::new(WireInteractionChannel {
        writer: writer.clone(),
        pending: interactions.clone(),
        next_id: Arc::new(std::sync::atomic::AtomicI64::new(1)),
    });
    plugin.set_interaction_channel(channel.clone());
    plugin.set_daemon_channel(channel);

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(message) = HostMessage::parse(trimmed) else {
            continue;
        };
        match message {
            HostMessage::Handshake { api_version } => {
                if api_version != PROVIDER_API_VERSION {
                    let frame = json_err("handshake", &format!(
                        "plugin API version mismatch (host {api_version}, plugin {PROVIDER_API_VERSION})"
                    ));
                    write_frame(&writer, &frame).await;
                    std::process::exit(2);
                }
                let mut capabilities=plugin.capabilities();capabilities["nativeExperienceVersion"]=serde_json::json!(1);capabilities["terminalPlan"]=serde_json::json!(plugin.native_terminal_supported());
                let frame = emit::ready(&plugin.descriptor(), &capabilities);
                write_frame(&writer, &frame).await;
            }
            HostMessage::Call { id, method, input } => {
                let plugin = plugin.clone();
                let writer = writer.clone();
                let active = active.clone();
                tokio::spawn(async move {
                    let frame = match method.as_str() {
                        "detect" => emit::response(id, plugin.detect(&input).await),
                        "steer" => match plugin.steer(input["runId"].as_str().unwrap_or(""),input["input"].as_str().unwrap_or("")).await {
                            Ok(()) => emit::response(id,serde_json::json!({"accepted":true})),
                            Err(error) => emit::failure(id,&error.to_string()),
                        },
                        "harnessPlugins" => match plugin.harness_plugins(&input["instance"], &input["context"], &input["operation"]).await {
                            Ok(value) => emit::response(id, value),
                            Err(error) => emit::failure(id, &error.to_string()),
                        },
                        "listModes" => match plugin.list_modes(&input["instance"], &input["context"]).await {
                            Ok(value) => emit::response(id, value),
                            Err(error) => emit::failure(id, &error.to_string()),
                        },
                        "connectionProtocol" => match plugin.connection_protocol(&input).await {
                            Ok(protocol) => emit::response(id, protocol),
                            Err(error) => emit::failure(id, &error.to_string()),
                        },
                        "listModels" => match plugin
                            // The host sends {instance, context} — unwrap them;
                            // passing the whole frame as the instance hid every
                            // instance option (endpoint, executable) from plugins.
                            .list_models(input.get("instance").unwrap_or(&input), input.get("context").unwrap_or(&Value::Null))
                            .await
                        {
                            Ok(catalog) => emit::response(id, catalog),
                            Err(error) => emit::failure(id, &error.to_string()),
                        },
                        "releaseSession" => match plugin.release_session(&input).await {Ok(())=>emit::response(id,Value::Null),Err(error)=>emit::failure(id,&error.to_string())},
                        "readSessionHistory" => match plugin.read_session_history(&input["request"],input["providerSessionId"].as_str().unwrap_or("")).await {Ok(history)=>emit::response(id,history.unwrap_or(Value::Null)),Err(error)=>emit::failure(id,&error.to_string())},
                        "resumeTerminalEvents" => match plugin.resume_terminal_events(&input["request"],input["providerSessionId"].as_str().unwrap_or(""),&input["snapshot"]).await {Ok(())=>emit::response(id,Value::Null),Err(error)=>emit::failure(id,&error.to_string())},
                        "terminalPlan" => match plugin.terminal_plan(&input["request"],input["resume"].as_str().map(str::to_string)).await {Ok(plan)=>emit::response(id,plan),Err(error)=>emit::failure(id,&error.to_string())},
                        "closeTerminal" => {plugin.close_terminal(input["token"].as_str().unwrap_or("")).await;emit::response(id,Value::Null)},
                        "dispose" => {
                            plugin.dispose().await;
                            // Kill every child process before exiting —
                            // otherwise they outlive the plugin as orphans
                            // and keep the provider session locked.
                            let run_ids: Vec<String> = active.lock().await.keys().cloned().collect();
                            for run_id in run_ids {
                                plugin.cancel(&run_id).await;
                            }
                            emit::response(id, Value::Null)
                        }
                        other => emit::failure(id, &format!("unknown method: {other}")),
                    };
                    write_frame(&writer, &frame).await;
                    if method == "dispose" {
                        std::process::exit(0);
                    }
                });
            }
            HostMessage::Start { run_id, resume, request } => {
                let plugin = plugin.clone();
                let writer = writer.clone();
                let active = active.clone();
                tokio::spawn(async move {
                    let (cancel_sender, mut cancel_receiver) = tokio::sync::oneshot::channel::<()>();
                    active.lock().await.insert(run_id.clone(), ActiveRun { cancel: cancel_sender });
                    let events = plugin.start(&run_id, request, resume).await;
                    match events {
                        Ok(events) => forward_run_events(
                            &writer, &run_id, events, &mut cancel_receiver, plugin.cancel(&run_id),
                        ).await,
                        Err(error) => {
                            write_frame(
                                &writer,
                                &emit::event(&run_id, &serde_json::json!({ "kind": "error", "message": error.to_string() })),
                            )
                            .await;
                            write_frame(
                                &writer,
                                &emit::event(&run_id, &serde_json::json!({ "kind": "exit", "exitCode": 1 })),
                            )
                            .await;
                        }
                    }
                    active.lock().await.remove(&run_id);
                });
            }
            HostMessage::Cancel { run_id } => {
                let sender = active.lock().await.remove(&run_id).map(|run| run.cancel);
                if let Some(sender) = sender {
                    let _ = sender.send(());
                }
            }
            HostMessage::Steer { run_id, input } => {
                let plugin = plugin.clone();
                tokio::spawn(async move {
                    let _ = plugin.steer(&run_id, &input).await;
                });
            }
            HostMessage::InteractionResponse { id, response } => {
                let sender = interactions.lock().unwrap().remove(&id);
                if let Some(sender) = sender {
                    let _ = sender.send(response);
                }
            }
            HostMessage::ToolResponse { id, result } => {
                let sender = interactions.lock().unwrap().remove(&id);
                if let Some(sender) = sender {
                    let _ = sender.send(result);
                }
            }
        }
    }
    // stdin EOF: the daemon is gone. Kill every child process so they do
    // not linger as orphans and keep the provider session locked.
    let run_ids: Vec<String> = active.lock().await.keys().cloned().collect();
    for run_id in run_ids {
        plugin.cancel(&run_id).await;
    }
    // Providers may keep an idle native server after a completed turn.
    // EOF must release those too, just like an explicit dispose request.
    plugin.dispose().await;
}

fn json_err(_context: &str, message: &str) -> Value {
    serde_json::json!({ "type": "fatal", "error": message })
}

/// Every started run must end with exactly one terminal event, including a
/// provider that drops its event sender or never reports cancellation.
async fn forward_run_events<W: tokio::io::AsyncWrite + Unpin>(
    writer: &Arc<Mutex<W>>,
    run_id: &str,
    mut events: mpsc::UnboundedReceiver<Value>,
    cancelled: &mut tokio::sync::oneshot::Receiver<()>,
    cancel: impl std::future::Future<Output = ()>,
) {
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Some(event) => {
                    let is_exit = event["kind"] == "exit";
                    write_frame(writer, &emit::event(run_id, &event)).await;
                    if is_exit { return; }
                }
                None => {
                    write_frame(writer, &emit::event(run_id, &serde_json::json!({
                        "kind": "error", "message": "Provider event stream closed before reporting completion"
                    }))).await;
                    write_frame(writer, &emit::event(run_id, &serde_json::json!({
                        "kind": "exit", "exitCode": 1
                    }))).await;
                    return;
                }
            },
            _ = &mut *cancelled => {
                cancel.await;
                // One total deadline, not a fresh timeout for each event.
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(1_500);
                while let Ok(Some(event)) = tokio::time::timeout_at(deadline, events.recv()).await {
                    let is_exit = event["kind"] == "exit";
                    write_frame(writer, &emit::event(run_id, &event)).await;
                    if is_exit { return; }
                }
                write_frame(writer, &emit::event(run_id, &serde_json::json!({
                    "kind": "exit", "exitCode": 130
                }))).await;
                return;
            }
        }
    }
}

async fn write_frame<W: tokio::io::AsyncWrite + Unpin>(writer: &Arc<Mutex<W>>, frame: &Value) {
    let mut payload = serde_json::to_vec(frame).unwrap_or_default();
    payload.push(b'\n');
    let mut guard = writer.lock().await;
    let _ = guard.write_all(&payload).await;
    let _ = guard.flush().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::AsyncReadExt;

    async fn relay(values: Vec<Value>, cancel: bool) -> Vec<Value> {
        let (write, mut read) = tokio::io::duplex(8192);
        let writer = Arc::new(Mutex::new(write));
        let (sender, events) = mpsc::unbounded_channel();
        for value in values { sender.send(value).unwrap(); }
        let (cancel_sender, mut cancelled) = tokio::sync::oneshot::channel();
        if cancel { cancel_sender.send(()).unwrap(); }
        else { drop(sender); }
        forward_run_events(&writer, "run-1", events, &mut cancelled, async {}).await;
        drop(writer);
        let mut output = String::new();
        read.read_to_string(&mut output).await.unwrap();
        output.lines().map(|line| serde_json::from_str::<Value>(line).unwrap()["event"].clone()).collect()
    }

    #[tokio::test]
    async fn missing_exit_fails_instead_of_leaving_run_active() {
        let events = relay(vec![json!({"kind":"message","text":"partial"})], false).await;
        assert_eq!(events[0]["text"], "partial");
        assert_eq!(events[1]["kind"], "error");
        assert_eq!(events[2]["exitCode"], 1);
    }

    #[tokio::test]
    async fn native_exit_is_not_duplicated() {
        let events = relay(vec![json!({"kind":"exit","exitCode":0})], false).await;
        assert_eq!(events, vec![json!({"kind":"exit","exitCode":0})]);
    }

    #[tokio::test]
    async fn cancelled_provider_without_exit_is_settled() {
        let events = relay(vec![], true).await;
        assert_eq!(events, vec![json!({"kind":"exit","exitCode":130})]);
    }
}
