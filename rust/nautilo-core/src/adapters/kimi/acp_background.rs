//! Keep one ordered ACP reader and native subagent-wire watcher between turns.
use super::{Resident, KIMI_SUBAGENT_POLL_MS};
use crate::adapters::{
    json_rpc_process::{JsonRpcProcessClient, JsonRpcProcessEvent},
    AdapterEvent, AdapterStartRequest, TimeoutKind,
};
use crate::process_runtime::{ProcessEvent, TimeoutReason};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

pub(super) async fn resume(native: &mut Resident) -> anyhow::Result<()> {
    let result = native.rpc.pause_events().await;
    if let Some(task) = native.background.take() {
        let _ = task.await;
    }
    result
}

pub(super) async fn park(
    native: &mut Resident,
    request: &AdapterStartRequest,
) -> anyhow::Result<()> {
    let mut callbacks = request.clone();
    callbacks.request_interaction = callbacks.session_interaction.clone();
    callbacks.execute_runtime_tool = callbacks.session_tool.clone();
    *native.callbacks.lock().unwrap() = callbacks.clone();
    let events = callbacks
        .session_events
        .clone()
        .unwrap_or_else(|| Arc::new(|_| {}));
    let session = native
        .session
        .as_ref()
        .and_then(|s| s["sessionId"].as_str())
        .unwrap_or("")
        .to_string();
    let pipeline = native.pipeline.clone();
    let weak_rpc = Arc::downgrade(&native.rpc);
    let (output, mut input) = tokio::sync::mpsc::unbounded_channel();
    native.background = Some(tokio::spawn(async move {
        loop {
            let active = pipeline.lock().await.has_active();
            let event = tokio::select! {
                event = input.recv() => event,
                _ = tokio::time::sleep(Duration::from_millis(KIMI_SUBAGENT_POLL_MS)), if active => {
                    for event in pipeline.lock().await.poll().await { events(event); }
                    continue;
                }
            };
            let Some(event) = event else {
                for event in pipeline.lock().await.flush() {
                    events(event);
                }
                break;
            };
            match event {
                JsonRpcProcessEvent::Notification { method, params }
                    if method == "session/update" && owns(&params, &session) =>
                {
                    for event in pipeline.lock().await.update(&params["update"]).await {
                        events(event);
                    }
                }
                JsonRpcProcessEvent::Request { id, method, params } => {
                    if let Some(rpc) = weak_rpc.upgrade() {
                        respond(rpc, id, method, params, &callbacks, &session);
                    }
                }
                JsonRpcProcessEvent::Transport(transport) => {
                    let exit = matches!(transport, ProcessEvent::Exit { .. });
                    if exit {
                        for event in pipeline.lock().await.flush() {
                            events(event);
                        }
                    }
                    if let Some(event) = process_event(transport) {
                        events(event);
                    }
                    if exit {
                        break;
                    }
                }
                _ => {}
            }
        }
    }));
    native
        .rpc
        .observe_idle(Arc::new(move |event| {
            let _ = output.send(event);
        }))
        .await
}

pub(super) fn owns(params: &Value, session: &str) -> bool {
    params["sessionId"].as_str().is_none_or(|id| id == session)
}

pub(super) fn respond(
    rpc: Arc<JsonRpcProcessClient>,
    id: Value,
    method: String,
    params: Value,
    request: &AdapterStartRequest,
    session: &str,
) {
    if method != "session/request_permission" {
        rpc.respond_error(
            &id,
            -32601,
            &format!("Nautilo does not support ACP request {method}"),
        );
        return;
    }
    if !owns(&params, session) {
        rpc.respond_error(&id, -32602, "Unknown ACP session");
        return;
    }
    let options = params["options"].as_array().cloned().unwrap_or_default();
    let mut interaction =
        super::super::normalize_kimi_permission_interaction(&params["toolCall"], &options);
    interaction["nativeRequestId"] = json!(id
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| id.to_string()));
    let handler = request.request_interaction.clone();
    tokio::spawn(async move {
        let answer = async {
            let Some(handler) = handler else {
                return json!({"outcome":{"outcome":"cancelled"}});
            };
            let response = handler(interaction)
                .await
                .unwrap_or_else(|_| json!({"outcome":"cancelled"}));
            if response["outcome"] == "selected" {
                if let Some(option) = response["optionId"]
                    .as_str()
                    .filter(|option| options.iter().any(|entry| entry["optionId"] == *option))
                {
                    return json!({"outcome":{"outcome":"selected","optionId":option}});
                }
            }
            json!({"outcome":{"outcome":"cancelled"}})
        };
        let process = rpc.process_handle();
        tokio::select! {result=answer=>rpc.respond(&id,result),_=process.wait()=>{}}
    });
}

fn process_event(event: ProcessEvent) -> Option<AdapterEvent> {
    Some(match event {
        ProcessEvent::Stdout(text) => AdapterEvent::Raw {
            stream: "stdout".into(),
            text,
        },
        ProcessEvent::Stderr(text) => AdapterEvent::Raw {
            stream: "stderr".into(),
            text,
        },
        ProcessEvent::Exit { exit_code, signal } => AdapterEvent::Exit { exit_code, signal },
        ProcessEvent::Error(message) => AdapterEvent::Error { message },
        ProcessEvent::Timeout { reason } => AdapterEvent::Timeout {
            reason: match reason {
                TimeoutReason::Timeout => TimeoutKind::Timeout,
                TimeoutReason::Idle => TimeoutKind::Idle,
                TimeoutReason::MaxOutput => TimeoutKind::MaxOutput,
            },
        },
    })
}
