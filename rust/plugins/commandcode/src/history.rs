//! This provider's persisted session tree is the source of message identity.
use agenthub_plugin_sdk::history_files::{find_session, read_jsonl};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};

pub async fn read(request: &Value, session: &str) -> anyhow::Result<Value> {
    let root = session_root(request)?;
    let file = find_session(&root, session, 2).await?;
    let mut snapshot = normalize(
        session,
        &read_jsonl(&file)
            .await?
            .into_iter()
            .map(|(_, v)| v)
            .collect::<Vec<_>>(),
    )?;
    if request["nativeTerminalLive"] == false {
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

pub fn normalize(session: &str, records: &[Value]) -> anyhow::Result<Value> {
    let header = records
        .iter()
        .find(|r| r["type"] == "session")
        .ok_or_else(|| anyhow::anyhow!("Native transcript has no session header"))?;
    anyhow::ensure!(
        header["id"].as_str() == Some(session),
        "Native transcript belongs to another session"
    );
    anyhow::ensure!(
        header["version"]
            .as_u64()
            .is_some_and(|v| (2..=3).contains(&v)),
        "Unsupported native transcript version"
    );
    let entries: HashMap<_, _> = records
        .iter()
        .filter_map(|r| Some((r["id"].as_str()?, r)))
        .collect();
    let mut branch = vec![];
    let mut seen = HashSet::new();
    let mut cursor = records
        .iter()
        .rev()
        .find(|r| r["type"] != "session" && r["type"] != "title" && r["id"].is_string())
        .and_then(|r| r["id"].as_str());
    while let Some(id) = cursor {
        anyhow::ensure!(seen.insert(id), "Native session tree contains a cycle");
        let entry = entries
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Native session tree has a missing parent"))?;
        branch.push(*entry);
        cursor = entry["parentId"].as_str();
    }
    branch.reverse();
    let mut messages = vec![];
    let mut activities = vec![];
    let mut turn = String::new();
    let mut statuses: HashMap<String, &str> = HashMap::new();
    let mut results = HashMap::new();
    for entry in &branch {
        for part in entry["message"]["content"].as_array().into_iter().flatten() {
            if part["type"] == "tool_result" {
                if let Some(call) = part["tool_use_id"].as_str() {
                    results.insert(call, part);
                }
            }
        }
    }
    for entry in branch {
        if entry["type"] != "message" {
            continue;
        }
        let id = entry["id"].as_str().unwrap();
        let message = &entry["message"];
        let role = message["role"].as_str().unwrap_or("");
        let actual_user = role == "user"
            && (message["content"].is_string()
                || message["content"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|p| p["type"] != "tool_result")));
        if actual_user && (turn.is_empty() || statuses.get(&turn).copied() != Some("running")) {
            turn = id.into();
            statuses.insert(turn.clone(), "running");
        }
        if turn.is_empty() {
            continue;
        }
        let timestamp = entry["timestamp"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.timestamp_millis())
            .or_else(|| message["timestamp"].as_i64());
        if role == "toolResult" {
            continue;
        }
        if !matches!(role, "user" | "assistant" | "bashExecution") {
            continue;
        }
        if role == "bashExecution" {
            activities.push(json!({"id":id,"messageId":id,"nativeTurnId":turn,"timestampMs":timestamp,"completed":true,"event":{"kind":"command","callId":id,"command":message["command"],"output":message["output"],"exitCode":message["exitCode"],"phase":"completed"}}));
            continue;
        }
        if role == "assistant" {
            let status = match message["stopReason"].as_str() {
                Some("stop" | "length") => "completed",
                Some("error") => "failed",
                Some("aborted") => "cancelled",
                _ => {
                    if message["content"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|p| p["type"] == "tool_use"))
                    {
                        "running"
                    } else {
                        "completed"
                    }
                }
            };
            statuses.insert(turn.clone(), status);
        }
        let content = message.get("content").unwrap_or(&Value::Null);
        let mut text = vec![];
        let mut files = vec![];
        if let Some(value) = content.as_str() {
            text.push(value.to_string());
        }
        for (index, part) in content.as_array().into_iter().flatten().enumerate() {
            match part["type"].as_str(){
                Some("text")=>{anyhow::ensure!(part["text"].is_string(),"Native text blob is unavailable");text.push(part["text"].as_str().unwrap().into());},
                Some("thinking")=>activities.push(json!({"id":format!("{id}:{index}"),"messageId":id,"nativeTurnId":turn,"timestampMs":timestamp,"completed":true,"event":{"kind":"thinking","text":part["thinking"].as_str().unwrap_or(""),"phase":"completed"}})),
                Some("image")=>files.push(json!({"id":format!("{id}:{index}"),"url":part["source"]["data"].as_str().map(|data|format!("data:{};base64,{data}",part["source"]["media_type"].as_str().unwrap_or("application/octet-stream"))).or_else(||part["source"]["url"].as_str().map(str::to_string)).unwrap_or_else(||"native-blob:unavailable".into()),"mime":part["source"]["media_type"],"filename":"Native image"})),
                Some("tool_use")=>{let call=part["id"].as_str().ok_or_else(||anyhow::anyhow!("Native tool call has no ID"))?;let result=results.get(call);let output=result.map(|r|r["content"].clone());activities.push(json!({"id":call,"messageId":id,"nativeTurnId":turn,"timestampMs":timestamp,"completed":result.is_some(),"event":{"kind":"tool","callId":call,"name":part["name"],"input":part["input"],"output":output,"success":result.map(|r|r["is_error"]!=true),"phase":if result.is_some(){"completed"}else{"started"}}}));},_=>{}
            }
        }
        if actual_user || !text.is_empty() || !files.is_empty() {
            messages.push(json!({"id":id,"messageId":id,"role":role,"text":text.join("\n"),"files":files,"nativeTurnId":turn,"timestampMs":timestamp,"completed":true}));
        }
        if message["usage"].is_object() {
            let usage = &message["usage"];
            activities.push(json!({"id":format!("{id}:usage"),"messageId":id,"nativeTurnId":turn,"timestampMs":timestamp,"completed":true,"event":{"kind":"usage","usageScope":"turn","usageKey":id,"inputTokens":usage["input"],"outputTokens":usage["output"],"cachedInputTokens":usage["cacheRead"],"cacheCreationInputTokens":usage["cacheWrite"],"inputTokensIncludesCache":false}}));
        }
    }
    for entry in messages.iter_mut().chain(activities.iter_mut()) {
        entry["turnStatus"] = json!(statuses
            .get(entry["nativeTurnId"].as_str().unwrap_or(""))
            .copied()
            .unwrap_or("running"));
    }
    let snapshot = json!({"schemaVersion":1,"providerSessionId":session,"settled":statuses.values().all(|s|*s!="running"),"messages":messages,"activities":activities});
    agenthub_plugin_sdk::history::validate(&snapshot, session)?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn consecutive_native_inputs_share_the_unfinished_turn() {
        let snapshot=normalize("s",&[json!({"type":"session","id":"s","version":3}),json!({"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"first"}}),json!({"type":"message","id":"u2","parentId":"u1","message":{"role":"user","content":"steer"}}),json!({"type":"message","id":"a","parentId":"u2","message":{"role":"assistant","content":[{"type":"text","text":"answer"}],"stopReason":"stop"}})]).unwrap();
        assert_eq!(snapshot["settled"], true);
        assert!(snapshot["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["nativeTurnId"] == "u1"));
    }

    #[test]
    fn imports_native_identity_and_selected_branch_with_cancelled_turn() {
        let snapshot=normalize("session",&[json!({"type":"session","id":"session","version":3}),json!({"type":"message","id":"u","parentId":null,"message":{"role":"user","content":"same"}}),json!({"type":"message","id":"old-branch","parentId":"u","message":{"role":"assistant","content":[{"type":"text","text":"old"}],"stopReason":"stop"}}),json!({"type":"message","id":"a","parentId":"u","message":{"role":"assistant","content":[{"type":"text","text":"kept"}],"stopReason":"aborted"}})]).unwrap();
        assert_eq!(snapshot["messages"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["messages"][1]["id"], "a");
        assert_eq!(snapshot["messages"][1]["turnStatus"], "cancelled");
        assert_eq!(snapshot["settled"], true);
        assert!(normalize(
            "other",
            &[json!({"type":"session","id":"session","version":3})]
        )
        .is_err());
    }
}

fn session_root(request: &Value) -> anyhow::Result<PathBuf> {
    let env = &request["env"];
    let home = env["USERPROFILE"]
        .as_str()
        .or_else(|| env["HOME"].as_str())
        .map(str::to_string)
        .or_else(|| std::env::var("USERPROFILE").ok())
        .or_else(|| std::env::var("HOME").ok())
        .ok_or_else(|| anyhow::anyhow!("Native account home is unavailable"))?;
    Ok(PathBuf::from(home).join(".commandcode/projects"))
}
