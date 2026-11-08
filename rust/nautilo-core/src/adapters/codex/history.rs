//! Read-only app-server history. This transport never loads/resumes a thread,
//! starts a turn, or contacts the TUI's writer process.
use super::app_server::{build_codex_app_server_args, codex_app_server_initialize_params};
use super::events::parse_codex_app_server_notification;
use crate::adapters::json_rpc_process::{JsonRpcProcessClient, JsonRpcProcessEvent};
use crate::adapters::{AdapterEvent, AdapterStartRequest};
use crate::process_runtime::{ProcessRequest, ProcessRuntime};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, LazyLock, Mutex},
};

static READERS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<Option<Reader>>>>>> =
    LazyLock::new(Default::default);
struct Reader {
    identity: String,
    rpc: Arc<JsonRpcProcessClient>,
}
fn key(request: &AdapterStartRequest) -> String {
    json!([request.instance["id"], request.local_session_id]).to_string()
}
async fn call(rpc: &JsonRpcProcessClient, method: &str, params: Value) -> anyhow::Result<Value> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        rpc.request(method, params),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Codex history read timed out: {method}"))?
}
pub async fn release(request: &AdapterStartRequest) {
    let slot = READERS.lock().unwrap().remove(&key(request));
    if let Some(slot) = slot {
        if let Some(reader) = slot.lock().await.take() {
            reader.rpc.process_handle().cancel().await;
        }
    }
}
pub async fn shutdown() {
    let readers: Vec<_> = READERS.lock().unwrap().drain().map(|(_, v)| v).collect();
    for slot in readers {
        if let Some(reader) = slot.lock().await.take() {
            reader.rpc.process_handle().cancel().await;
        }
    }
}
pub async fn read(request: &AdapterStartRequest, session: &str) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !session.is_empty(),
        "Codex history requires a native thread ID"
    );
    let env: BTreeMap<_, _> = request
        .env
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect();
    let identity = json!([request.instance, request.cwd, env]).to_string();
    let slot = READERS
        .lock()
        .unwrap()
        .entry(key(request))
        .or_default()
        .clone();
    let mut reader = slot.lock().await;
    if reader
        .as_ref()
        .is_some_and(|r| r.identity != identity || !r.rpc.process_handle().is_alive())
    {
        if let Some(old) = reader.take() {
            old.rpc.process_handle().cancel().await;
        }
    }
    if reader.is_none() {
        let args =
            build_codex_app_server_args(&request.instance, request.env.as_ref(), None, None)?;
        let started = ProcessRuntime::start(&ProcessRequest {
            command: request.instance["executable"]
                .as_str()
                .unwrap_or("codex")
                .into(),
            args,
            cwd: Some(request.cwd.clone()),
            env: request.env.clone(),
            timeout_ms: None,
            idle_timeout_ms: None,
            max_output_bytes: None,
        })?;
        let rpc = Arc::new(JsonRpcProcessClient::new(started.handle, started.events));
        if let Err(error) = call(&rpc, "initialize", codex_app_server_initialize_params()).await {
            rpc.process_handle().cancel().await;
            return Err(error);
        }
        rpc.notify("initialized", json!({}));
        let weak = Arc::downgrade(&rpc);
        rpc.observe_idle(Arc::new(move |event| {
            if let (JsonRpcProcessEvent::Request { id, .. }, Some(rpc)) = (event, weak.upgrade()) {
                rpc.respond_error(&id, -32601, "This connection only reads persisted history");
            }
        }))
        .await?;
        *reader = Some(Reader { identity, rpc });
    }
    let rpc = &reader.as_ref().unwrap().rpc;
    let metadata = call(
        rpc,
        "thread/read",
        json!({"threadId":session,"includeTurns":false}),
    )
    .await?;
    anyhow::ensure!(
        metadata["thread"]["id"].as_str() == Some(session),
        "Codex returned a different native thread"
    );
    let mut turns = Vec::new();
    let mut cursor = Value::Null;
    let mut seen = HashSet::new();
    loop {
        let page=call(rpc,"thread/turns/list",json!({"threadId":session,"itemsView":"full","sortDirection":"desc","limit":100,"cursor":cursor})).await?;
        let data = page["data"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Codex returned no persisted turns"))?;
        turns.extend(data.iter().cloned());
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
        anyhow::ensure!(
            seen.insert(cursor.to_string()),
            "Codex repeated its history cursor"
        );
    }
    turns.reverse();
    let lifecycle = read_lifecycle(request, session, &metadata["thread"])
        .await
        .unwrap_or_default();
    apply_lifecycle(&mut turns, &lifecycle, request.native_terminal_live);
    let mut snapshot = normalize(session, &turns, None)?;
    if request.native_terminal_live == Some(false) {
        // The PTY owner observed exit+EOF. A TUI killed mid-turn cannot
        // continue writing this root thread; retain its prefix as incomplete.
        for kind in ["messages", "activities"] {
            for entry in snapshot[kind].as_array_mut().unwrap() {
                if entry["turnStatus"] == "running" {
                    entry["turnStatus"] = json!("failed");
                    if entry["role"] == "assistant" {
                        entry["completed"] = json!(false);
                    }
                }
            }
        }
        snapshot["settled"] = json!(true);
    }
    Ok(snapshot)
}

fn lifecycle_from_records(records: &[(u64, Value)]) -> HashMap<String, &'static str> {
    let mut result = HashMap::new();
    let mut active = None::<String>;
    for (_, record) in records {
        if record["type"] != "event_msg" {
            continue;
        }
        let event = &record["payload"];
        let kind = event["type"].as_str().unwrap_or("");
        let id = event["turn_id"].as_str().map(str::to_string).or_else(|| {
            if kind == "turn_aborted" {
                active.clone()
            } else {
                None
            }
        });
        let Some(id) = id else {
            continue;
        };
        match kind {
            "task_started" => {
                active = Some(id.clone());
                result.insert(id, "inProgress");
            }
            "task_complete" => {
                if active.as_deref() == Some(&id) {
                    active = None;
                }
                result.insert(id, "completed");
            }
            "turn_aborted" => {
                if active.as_deref() == Some(&id) {
                    active = None;
                }
                result.insert(id, "interrupted");
            }
            _ => {}
        }
    }
    result
}
async fn read_lifecycle(
    request: &AdapterStartRequest,
    session: &str,
    thread: &Value,
) -> anyhow::Result<HashMap<String, &'static str>> {
    let Some(path) = thread["path"].as_str() else {
        return Ok(HashMap::new());
    };
    let env = request.env.clone().unwrap_or_default();
    let root = env
        .get("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("CODEX_HOME").map(Into::into))
        .unwrap_or_else(|| {
            env.get("USERPROFILE")
                .or_else(|| env.get("HOME"))
                .map(std::path::PathBuf::from)
                .or_else(dirs::home_dir)
                .unwrap_or_default()
                .join(".codex")
        });
    let root = if root.is_absolute() {
        root
    } else {
        std::path::Path::new(&request.cwd).join(root)
    };
    let path = std::path::Path::new(path).canonicalize()?;
    let root = root.canonicalize()?;
    anyhow::ensure!(
        path.starts_with(root),
        "Codex lifecycle file is outside the selected account"
    );
    let records = agenthub_plugin_sdk::history_files::read_jsonl(&path).await?;
    let header = records
        .iter()
        .find(|(_, r)| r["type"] == "session_meta")
        .ok_or_else(|| anyhow::anyhow!("Codex lifecycle file has no native header"))?;
    anyhow::ensure!(
        header.1["payload"]["id"].as_str() == Some(session),
        "Codex lifecycle belongs to another thread"
    );
    Ok(lifecycle_from_records(&records))
}
fn apply_lifecycle(
    turns: &mut [Value],
    lifecycle: &HashMap<String, &'static str>,
    live: Option<bool>,
) {
    for turn in turns {
        if turn["status"] == "failed" {
            continue;
        }
        if let Some(status) = turn["id"].as_str().and_then(|id| lifecycle.get(id)) {
            turn["status"] = json!(status);
        } else if live.is_some() && turn["status"] == "interrupted" {
            // A reader which does not own the TUI reconstructs an unfinished
            // rollout as interrupted. That is not an observed cancellation.
            turn["status"] = json!("inProgress");
        }
    }
}

pub fn normalize(session: &str, turns: &[Value], fallback: Option<i64>) -> anyhow::Result<Value> {
    let mut messages = vec![];
    let mut activities = vec![];
    let mut settled = true;
    for turn in turns {
        let turn_id = turn["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Codex history turn has no ID"))?;
        let status = match turn["status"].as_str() {
            Some("completed") => "completed",
            Some("interrupted") => "cancelled",
            Some("failed") => "failed",
            Some("inProgress") => "running",
            _ => anyhow::bail!("Unknown Codex history turn status"),
        };
        let completed = status != "running";
        settled &= completed;
        let native_time = turn_id.replace('-', "");
        let timestamp = (native_time.len() == 32 && native_time.as_bytes().get(12) == Some(&b'7'))
            .then(|| i64::from_str_radix(&native_time[..12], 16).ok())
            .flatten()
            .or_else(|| turn["startedAt"].as_i64().map(|s| s * 1000))
            .or(fallback);
        for item in turn["items"].as_array().into_iter().flatten() {
            let id = item["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Codex history item has no ID"))?;
            let kind = item["type"].as_str().unwrap_or("");
            if matches!(kind, "userMessage" | "agentMessage" | "plan") {
                let mut files = vec![];
                let text = if kind == "userMessage" {
                    item["content"].as_array().into_iter().flatten().enumerate().filter_map(|(i,part)| {
                    match part["type"].as_str(){
                        Some("text")=>part["text"].as_str().map(str::to_string),
                        Some("localImage"|"localAudio"|"image"|"audio")=>{
                            let url=part["path"].as_str().and_then(|p|reqwest::Url::from_file_path(p).ok()).map(|u|u.to_string())
                                .or_else(||part["url"].as_str().map(str::to_string)).unwrap_or_else(||format!("codex-file:{}",part["fileId"].as_str().unwrap_or("unavailable")));
                            files.push(json!({"id":format!("{id}:{i}"),"url":url,"mime":if part["type"].as_str().unwrap_or("").contains("Audio"){"audio/*"}else{"image/*"},"filename":part["path"].as_str().and_then(|p|std::path::Path::new(p).file_name()).and_then(|p|p.to_str()).unwrap_or("Native attachment")}));None
                        },
                        Some("skill"|"mention")=>Some(format!("${}",part["name"].as_str().unwrap_or(""))),_=>None
                    }
                }).collect::<Vec<_>>().join("\n")
                } else {
                    item["text"].as_str().unwrap_or("").into()
                };
                messages.push(json!({"id":id,"messageId":id,"role":if kind=="userMessage"{"user"}else{"assistant"},"text":text,"files":files,"nativeTurnId":turn_id,"timestampMs":timestamp,"completed":kind=="userMessage"||completed,"turnStatus":status}));
                continue;
            }
            let params = json!({"threadId":session,"turnId":turn_id,"item":item});
            // Snapshot items contain full text even while their turn is active.
            let events = parse_codex_app_server_notification("item/completed", &params);
            for event in events {
                let activity_id = match &event {
                    AdapterEvent::Thinking { message_id, .. } => {
                        message_id.as_deref().unwrap_or(id)
                    }
                    _ => id,
                }
                .to_string();
                let mut value = serde_json::to_value(&event)?;
                if !matches!(
                    value["kind"].as_str(),
                    Some("thinking" | "tool" | "command" | "usage")
                ) {
                    continue;
                }
                let item_complete = item["status"]
                    .as_str()
                    .map(|s| !matches!(s, "inProgress" | "running" | "pending"))
                    .unwrap_or(completed);
                value["phase"] = json!(if item_complete {
                    "completed"
                } else {
                    "started"
                });
                activities.push(json!({"id":activity_id,"messageId":id,"nativeTurnId":turn_id,"timestampMs":timestamp,"completed":item_complete,"turnStatus":status,"event":value}));
            }
        }
    }
    let snapshot = json!({"schemaVersion":1,"providerSessionId":session,"settled":settled,"messages":messages,"activities":activities});
    agenthub_plugin_sdk::history::validate(&snapshot, session)?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_active_external_tui_is_not_cancelled_by_reconstructed_history() {
        let mut turns = vec![json!({"id":"t","status":"interrupted","items":[]})];
        let records = vec![(
            0,
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"t"}}),
        )];
        apply_lifecycle(&mut turns, &lifecycle_from_records(&records), Some(true));
        assert_eq!(turns[0]["status"], "inProgress");
        let mut completed = records;
        completed.push((
            1,
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"t"}}),
        ));
        apply_lifecycle(&mut turns, &lifecycle_from_records(&completed), Some(true));
        assert_eq!(turns[0]["status"], "completed");
        let abort = vec![
            (
                0,
                json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"t"}}),
            ),
            (
                1,
                json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t"}}),
            ),
        ];
        apply_lifecycle(&mut turns, &lifecycle_from_records(&abort), Some(true));
        assert_eq!(turns[0]["status"], "interrupted");
    }
    #[tokio::test]
    async fn readback_only_uses_read_methods_and_keeps_one_reader_across_polls() {
        let Some(node) = std::env::var("NAUTILO_TEST_NODE").ok() else {
            return;
        };
        let root = std::env::temp_dir().join(format!("codex-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let log = root.join("requests.jsonl");
        let data = root.join("turns.json");
        std::fs::write(
            root.join("app-server"),
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../tests/fixtures/codex-history.mjs"
            )),
        )
        .unwrap();
        std::fs::write(&data,json!([{"id":"new","status":"inProgress","startedAt":10,"items":[{"type":"userMessage","id":"u-new","content":[{"type":"text","text":"new native input"}]}]},{"id":"old","status":"completed","startedAt":1,"items":[{"type":"agentMessage","id":"a-old","text":"old reply"}]}]).to_string()).unwrap();
        let mut env: HashMap<String, String> = std::env::vars().collect();
        env.insert(
            "CODEX_HOME".into(),
            root.join("account").to_string_lossy().into_owned(),
        );
        env.insert(
            "NAUTILO_HISTORY_LOG".into(),
            log.to_string_lossy().into_owned(),
        );
        env.insert(
            "NAUTILO_HISTORY_DATA".into(),
            data.to_string_lossy().into_owned(),
        );
        let request = AdapterStartRequest {
            instance: json!({"id":"fixture-reader","executable":node}),
            local_session_id: Some(root.to_string_lossy().into_owned()),
            cwd: root.to_string_lossy().into_owned(),
            env: Some(env),
            native_terminal_live: Some(true),
            ..Default::default()
        };
        for _ in 0..2 {
            let snapshot = read(&request, "native").await.unwrap();
            assert_eq!(snapshot["messages"][0]["id"], "a-old");
            assert_eq!(snapshot["messages"][1]["id"], "u-new");
            assert_eq!(snapshot["settled"], false);
        }
        release(&request).await;
        let requests: Vec<Value> = std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(
            requests
                .iter()
                .filter(|r| r["method"] == "initialize")
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|r| r["method"] == "thread/read")
                .count(),
            2
        );
        assert!(requests.iter().all(|r| matches!(
            r["method"].as_str(),
            Some("initialize" | "initialized" | "thread/read" | "thread/turns/list")
        )));
    }
    #[test]
    fn native_user_assistant_tools_and_turn_outcomes_keep_ids() {
        let snapshot=normalize("thread",&[json!({"id":"turn","status":"inProgress","startedAt":17,"items":[{"id":"u","type":"userMessage","content":[{"type":"text","text":"same"}]},{"id":"a","type":"agentMessage","text":"partial"},{"id":"r","type":"reasoning","summary":["think"],"content":["detail"]},{"id":"c","type":"commandExecution","command":"pwd","status":"inProgress"}]})],None).unwrap();
        assert_eq!(snapshot["settled"], false);
        assert_eq!(snapshot["messages"][0]["id"], "u");
        assert_eq!(snapshot["messages"][1]["completed"], false);
        assert_eq!(snapshot["activities"].as_array().unwrap().len(), 3);
        assert_eq!(snapshot["activities"][1]["id"], "r:content");
        let cancelled=normalize("thread",&[json!({"id":"t2","status":"interrupted","items":[{"id":"a2","type":"agentMessage","text":"kept"}]})],None).unwrap();
        assert_eq!(cancelled["settled"], true);
        assert_eq!(cancelled["messages"][0]["turnStatus"], "cancelled");
    }
}
