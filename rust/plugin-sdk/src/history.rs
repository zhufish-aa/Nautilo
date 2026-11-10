//! Native history snapshots retain provider identities. Consumers must not
//! match messages by text or replay a transcript as a recovery prompt.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub fn validate(snapshot: &Value, session: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        snapshot["schemaVersion"] == 1,
        "Unsupported native history schema"
    );
    anyhow::ensure!(
        snapshot["providerSessionId"].as_str() == Some(session),
        "Native history belongs to another session"
    );
    anyhow::ensure!(
        snapshot["settled"].is_boolean(),
        "Native history must report whether its main session is settled"
    );
    let messages = snapshot["messages"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Native history messages are missing"))?;
    let activities = snapshot["activities"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Native history activities are missing"))?;
    let mut seen = HashSet::new();
    for (kind, entries) in [("message", messages), ("activity", activities)] {
        for entry in entries {
            if let Some(status)=entry.get("turnStatus") {
                anyhow::ensure!(matches!(status.as_str(),Some("running"|"completed"|"failed"|"cancelled")),"Unknown native turn status");
            }
            let id = entry["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Native history entry has no native ID"))?;
            anyhow::ensure!(
                seen.insert((kind, id)),
                "Duplicate native history identity: {id}"
            );
            anyhow::ensure!(
                entry["messageId"].as_str().is_some_and(|id| !id.is_empty()),
                "Native history entry has no parent message ID"
            );
            if kind == "message" {
                anyhow::ensure!(
                    matches!(entry["role"].as_str(), Some("user" | "assistant")),
                    "Unsupported native history role"
                );
                anyhow::ensure!(
                    entry["text"].is_string(),
                    "Native history message has no text snapshot"
                );
                anyhow::ensure!(
                    entry["completed"].is_boolean(),
                    "Native history message completion is unknown"
                );
                let mut file_ids = HashSet::new();
                for file in entry["files"].as_array().into_iter().flatten() {
                    let id = file["id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| anyhow::anyhow!("Native history file has no identity"))?;
                    anyhow::ensure!(file_ids.insert(id), "Duplicate native file identity");
                    anyhow::ensure!(
                        file["url"].is_string(),
                        "Native history file has no native reference"
                    );
                }
            } else {
                anyhow::ensure!(
                    matches!(
                        entry["event"]["kind"].as_str(),
                        Some("thinking" | "tool" | "command" | "usage")
                    ),
                    "Unsupported native history activity"
                );
            }
        }
    }
    Ok(())
}

pub fn fingerprints(snapshot: &Value) -> HashMap<String, String> {
    ["messages", "activities"]
        .into_iter()
        .flat_map(|kind| {
            snapshot[kind]
                .as_array()
                .into_iter()
                .flatten()
                .map(move |entry| {
                    (
                        format!("{kind}:{}", entry["id"].as_str().unwrap_or("")),
                        format!("{:x}", Sha256::digest(entry.to_string().as_bytes())),
                    )
                })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_foreign_or_duplicate_native_identity_and_fingerprints_edits() {
        let snapshot = json!({"schemaVersion":1,"providerSessionId":"native","settled":true,"messages":[{"id":"user","messageId":"user","role":"user","text":"same","completed":true}],"activities":[]});
        validate(&snapshot, "native").unwrap();
        assert!(validate(&snapshot, "another").is_err());
        let mut duplicate = snapshot.clone();
        duplicate["messages"]
            .as_array_mut()
            .unwrap()
            .push(snapshot["messages"][0].clone());
        assert!(validate(&duplicate, "native").is_err());
        let mut edited = snapshot.clone();
        edited["messages"][0]["text"] = json!("changed");
        assert_ne!(fingerprints(&snapshot), fingerprints(&edited));
    }
}
