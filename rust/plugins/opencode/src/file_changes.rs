//! Successful native file operations, independent of truncated tool summaries.
use serde_json::{json, Value};

pub(super) fn completed(part: &Value, raw: &Value) -> Vec<Value> {
    let state = &part["state"];
    if state["status"] != "completed" {
        return vec![];
    }
    let tool = part["tool"].as_str().unwrap_or("");
    if !["write", "edit", "apply_patch", "multiedit"].contains(&tool) {
        return vec![];
    }
    let metadata = &state["metadata"];
    let input = &state["input"];
    let path = metadata["filediff"]["file"].as_str()
        .or_else(|| metadata["filepath"].as_str())
        .or_else(|| input["filePath"].as_str())
        .filter(|path| !path.is_empty());
    let Some(path) = path else { return vec![] };
    let patch = metadata["filediff"]["patch"].as_str()
        .or_else(|| metadata["diff"].as_str());
    let created = tool == "write" && metadata["exists"] == false;
    let mut event = json!({
        "kind":"file", "path":path, "callId":part["callID"],
        "changeType":if created { "added" } else { "modified" },
        "diff":patch, "additions":metadata["filediff"]["additions"],
        "deletions":metadata["filediff"]["deletions"], "raw":raw
    });
    if tool == "write" {
        if let Some(after) = input["content"].as_str() {
            // An overwrite only supplies AFTER. Unknown previous content must
            // never be presented as an empty file or counted as an addition.
            let mut snapshot = json!({"after":after});
            if created { snapshot["before"] = json!(""); }
            event["snapshot"] = snapshot;
        }
    }
    vec![event]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_keep_the_native_path_and_creation_evidence_before_summary_truncation() {
        let content = "动画".repeat(20_000);
        let mut part = json!({"type":"tool","tool":"write","callID":"write-1","state":{
            "status":"completed","input":{"content":content,"filePath":"D:/项目/动画.svg"},
            "metadata":{"exists":false,"filepath":"D:/项目/动画.svg"}
        }});
        let created = completed(&part, &part);
        assert_eq!(created[0]["path"], "D:/项目/动画.svg");
        assert_eq!(created[0]["snapshot"]["after"], content);
        assert_eq!(created[0]["snapshot"]["before"], "");
        part["state"]["metadata"]["exists"] = json!(true);
        let overwritten = completed(&part, &part);
        assert!(overwritten[0]["snapshot"].get("before").is_none());
        assert_eq!(overwritten[0]["changeType"], "modified");
        for status in ["running", "error", "pending"] {
            part["state"]["status"] = json!(status);
            assert!(completed(&part, &part).is_empty());
        }
    }

    #[test]
    fn edits_use_the_actual_native_file_patch_not_the_replacement_snippet() {
        let patch = "--- a/a.ts\n+++ b/a.ts\n@@ -8 +8 @@\n-old\n+new\n";
        let part = json!({"tool":"edit","callID":"edit-1","state":{"status":"completed",
            "input":{"filePath":"a.ts","oldString":"old","newString":"new"},
            "metadata":{"filediff":{"file":"a.ts","patch":patch,"additions":1,"deletions":1}}
        }});
        let events = completed(&part, &part);
        assert_eq!(events[0]["diff"], patch);
        assert_eq!(events[0]["additions"], 1);
        assert!(events[0].get("snapshot").is_none());
        assert!(completed(&json!({"tool":"read","state":{"status":"completed","input":{"filePath":"a.ts"}}}), &Value::Null).is_empty());
    }
}
