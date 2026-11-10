use super::{api_json, parse_opencode_part, urlencoding, OpenCodePlugin};
use serde_json::{json, Value};

pub(super) async fn read(
    plugin: &OpenCodePlugin,
    request: &Value,
    session: &str,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !session.is_empty(),
        "A native OpenCode session is required for history reconciliation"
    );
    let _opening = plugin.opening.lock().await;
    let server = plugin.server_for(request).await?;
    let info = api_json(
        &server.base_url,
        &server.cwd,
        &format!("/session/{}", urlencoding(session)),
        "GET",
        None,
    )
    .await?;
    anyhow::ensure!(
        info["id"].as_str() == Some(session),
        "OpenCode returned another native session"
    );
    let statuses = api_json(
        &server.base_url,
        &server.cwd,
        "/session/status",
        "GET",
        None,
    )
    .await?;
    let statuses = statuses
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("OpenCode session status is unavailable"))?;
    let before_idle = statuses
        .get(session)
        .is_none_or(|status| status["type"] == "idle");
    let messages = api_json(
        &server.base_url,
        &server.cwd,
        &format!("/session/{}/message", urlencoding(session)),
        "GET",
        None,
    )
    .await?;
    let after = api_json(
        &server.base_url,
        &server.cwd,
        "/session/status",
        "GET",
        None,
    )
    .await?;
    let after = after
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("OpenCode session status is unavailable"))?;
    let settled = before_idle
        && after
            .get(session)
            .is_none_or(|status| status["type"] == "idle");
    normalize(session, &messages, settled)
}

fn normalize(session: &str, entries: &Value, settled: bool) -> anyhow::Result<Value> {
    let mut messages = vec![];
    let mut activities = vec![];
    for entry in entries
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("OpenCode returned an invalid history snapshot"))?
    {
        let info = &entry["info"];
        anyhow::ensure!(
            info["sessionID"].as_str() == Some(session),
            "OpenCode history contains a foreign session"
        );
        let id = info["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| anyhow::anyhow!("OpenCode history message is missing its native ID"))?;
        let role = info["role"].as_str().unwrap_or("");
        if !["user", "assistant"].contains(&role) {
            continue;
        }
        let parts = entry["parts"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("OpenCode history message is missing its parts"))?;
        for part in parts {
            anyhow::ensure!(
                part["sessionID"].as_str() == Some(session)
                    && part["messageID"].as_str() == Some(id),
                "OpenCode history part belongs to another message or session"
            );
        }
        let timestamp = info
            .pointer("/time/created")
            .cloned()
            .unwrap_or(Value::Null);
        let turn = if role == "user" {
            json!(id)
        } else {
            info["parentID"].clone()
        };
        if role == "user" {
            let text = parts
                .iter()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let files:Vec<_>=parts.iter().filter(|p|p["type"] == "file").map(|p|json!({"id":p["id"],"url":p["url"],"mime":p["mime"],"filename":p["filename"]})).collect();
            messages.push(json!({"id":id,"messageId":id,"role":"user","text":text,"partIds":parts.iter().filter_map(|p|p["id"].as_str()).collect::<Vec<_>>(),"nativeTurnId":turn,"timestampMs":timestamp,"completed":true,"files":files}));
            continue;
        }
        for part in parts {
            let Some(part_id) = part["id"].as_str().filter(|id| !id.is_empty()) else {
                anyhow::bail!("OpenCode history part has no native ID");
            };
            if part["type"] == "text" {
                messages.push(json!({"id":part_id,"messageId":id,"role":"assistant","text":part["text"].as_str().unwrap_or(""),"partIds":[part_id],"nativeTurnId":turn,"timestampMs":part.pointer("/time/start").cloned().unwrap_or_else(||timestamp.clone()),"completed":info["error"].is_null() && (part.pointer("/time/end").is_some() || info.pointer("/time/completed").is_some()),"files":[]}));
            } else {
                for event in parse_opencode_part(part, part, None)
                    .into_iter()
                    .filter(|event| {
                        ["thinking", "tool", "command", "usage"]
                            .contains(&event["kind"].as_str().unwrap_or(""))
                    })
                {
                    activities.push(json!({"id":part_id,"messageId":id,"nativeTurnId":turn,"timestampMs":timestamp,"completed":info["error"].is_null() && info.pointer("/time/completed").is_some(),"event":event}));
                }
            }
        }
    }
    let mut statuses = std::collections::HashMap::<String, &str>::new();
    for entry in entries.as_array().into_iter().flatten() {
        let info = &entry["info"];
        if info["role"] == "user" {
            if let Some(id) = info["id"].as_str() {
                statuses.insert(id.into(), if settled { "completed" } else { "running" });
            }
        } else if info["role"] == "assistant" {
            if let Some(turn) = info["parentID"].as_str() {
                let status = if !info["error"].is_null() {
                    if info["error"]["name"] == "MessageAbortedError" {
                        "cancelled"
                    } else {
                        "failed"
                    }
                } else if matches!(info["finish"].as_str(), Some("stop" | "length"))
                    || settled && info.pointer("/time/completed").is_some()
                {
                    "completed"
                } else {
                    "running"
                };
                statuses.insert(turn.into(), status);
            }
        }
    }
    for entry in messages.iter_mut().chain(activities.iter_mut()) {
        entry["turnStatus"] = json!(statuses
            .get(entry["nativeTurnId"].as_str().unwrap_or(""))
            .copied()
            .unwrap_or("running"));
    }
    let snapshot = json!({"schemaVersion":1,"providerSessionId":session,"settled":settled,"messages":messages,"activities":activities});
    agenthub_plugin_sdk::history::validate(&snapshot, session)?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_native_error_never_becomes_a_successful_completion_marker() {
        let snapshot=normalize("s",&json!([{"info":{"id":"a","sessionID":"s","parentID":"u","role":"assistant","error":{"name":"ProviderError"},"time":{"completed":10}},"parts":[{"id":"p","messageID":"a","sessionID":"s","type":"text","text":"partial","time":{"end":10}}]}]),true).unwrap();
        assert_eq!(snapshot["messages"][0]["text"], "partial");
        assert_eq!(snapshot["messages"][0]["completed"], false);
    }
    #[test]
    fn native_ids_roles_parts_and_file_references_survive_history_normalization() {
        let snapshot=normalize("s",&json!([
            {"info":{"id":"user","sessionID":"s","role":"user","time":{"created":10}},"parts":[{"id":"input","messageID":"user","sessionID":"s","type":"text","text":"hello"},{"id":"file","messageID":"user","sessionID":"s","type":"file","url":"file:///workspace/image.png","mime":"image/png","filename":"image.png"}]},
            {"info":{"id":"assistant","parentID":"user","sessionID":"s","role":"assistant","time":{"created":20,"completed":30}},"parts":[{"id":"output","messageID":"assistant","sessionID":"s","type":"text","text":"reply","time":{"end":30}},{"id":"tool","callID":"call","messageID":"assistant","sessionID":"s","type":"tool","tool":"read","state":{"status":"completed","input":{"path":"a"},"output":"read result"}}]}
        ]),true).unwrap();
        assert_eq!(snapshot["messages"][0]["id"], "user");
        assert_eq!(snapshot["messages"][0]["files"][0]["id"], "file");
        assert_eq!(snapshot["messages"][1]["id"], "output");
        assert_eq!(snapshot["messages"][1]["nativeTurnId"], "user");
        assert_eq!(snapshot["activities"][0]["event"]["callId"], "call");
        assert!(normalize(
            "other",
            &json!([{"info":{"id":"user","sessionID":"s","role":"user"},"parts":[]}]),
            true
        )
        .is_err());
    }
}
