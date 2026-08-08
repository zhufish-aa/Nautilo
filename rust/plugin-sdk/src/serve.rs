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
        Box::pin(async move {
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
    plugin.set_interaction_channel(Arc::new(WireInteractionChannel {
        writer: writer.clone(),
        pending: interactions.clone(),
        next_id: Arc::new(std::sync::atomic::AtomicI64::new(1)),
    }));

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
                let frame = emit::ready(&plugin.descriptor(), &plugin.capabilities());
                write_frame(&writer, &frame).await;
            }
            HostMessage::Call { id, method, input } => {
                let plugin = plugin.clone();
                let writer = writer.clone();
                tokio::spawn(async move {
                    let frame = match method.as_str() {
                        "detect" => emit::response(id, plugin.detect(&input).await),
                        "listModels" => match plugin
                            .list_models(&input, &Value::Null)
                            .await
                        {
                            Ok(catalog) => emit::response(id, catalog),
                            Err(error) => emit::failure(id, &error.to_string()),
                        },
                        "dispose" => {
                            plugin.dispose().await;
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
                    let events = plugin.start(request, resume).await;
                    match events {
                        Ok(mut events) => {
                            loop {
                                tokio::select! {
                                    event = events.recv() => {
                                        match event {
                                            Some(event) => {
                                                let is_exit = event.get("kind").and_then(Value::as_str) == Some("exit");
                                                write_frame(&writer, &emit::event(&run_id, &event)).await;
                                                if is_exit {
                                                    break;
                                                }
                                            }
                                            None => break,
                                        }
                                    }
                                    _ = &mut cancel_receiver => {
                                        plugin.cancel(&run_id).await;
                                        // Drain remaining events briefly so the
                                        // provider can report its cancellation.
                                        while let Ok(Some(event)) = tokio::time::timeout(
                                            std::time::Duration::from_millis(1_500),
                                            events.recv(),
                                        ).await {
                                            let is_exit = event.get("kind").and_then(Value::as_str) == Some("exit");
                                            write_frame(&writer, &emit::event(&run_id, &event)).await;
                                            if is_exit {
                                                break;
                                            }
                                        }
                                        break;
                                    }
                                }
                            }
                        }
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
}

fn json_err(_context: &str, message: &str) -> Value {
    serde_json::json!({ "type": "fatal", "error": message })
}

async fn write_frame(writer: &Arc<Mutex<tokio::io::Stdout>>, frame: &Value) {
    let mut payload = serde_json::to_vec(frame).unwrap_or_default();
    payload.push(b'\n');
    let mut guard = writer.lock().await;
    let _ = guard.write_all(&payload).await;
    let _ = guard.flush().await;
}
