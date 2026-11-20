//! Session file changes are a projection of successful receipts. Tool previews
//! may be truncated; never use their missing paths or snippets as full files.
use super::*;
use std::collections::BTreeMap;

pub(super) fn read(db: &rusqlite::Connection, session: &str) -> Result<Value> {
    let mut query = db.prepare("SELECT data FROM runtime_events WHERE session_id=?1 AND json_extract(data,'$.type') IN ('file.changed','tool.started','tool.finished','run.diff_updated') ORDER BY sequence DESC LIMIT 2000")?;
    let mut events = query.query_map([session], |row|row.get::<_,String>(0))?
        .map(|row| Ok(serde_json::from_str::<Value>(&row?)?)).collect::<Result<Vec<_>>>()?;
    // Repaired receipts keep their native timestamps, although appended later.
    events.sort_by(|a,b| a["timestamp"].as_str().cmp(&b["timestamp"].as_str())
        .then_with(|| a["sequence"].as_i64().cmp(&b["sequence"].as_i64())));
    let session_value = Repositories::new(db).sessions().get(session)?;
    let root = session_value.as_ref().and_then(|value|value["nativeWorkingDirectory"].as_str()).map(str::to_string)
        .or_else(||session_value.as_ref().and_then(|value|value["projectId"].as_str())
            .and_then(|id|Repositories::new(db).projects().get(id).ok().flatten())
            .and_then(|project|project["rootPath"].as_str().map(str::to_string))).unwrap_or_default();
    Ok(project(&events, &root))
}

fn key(path: &str, root: &str) -> String {
    let path = path.replace('\\', "/");
    let prefix = format!("{}/", root.replace('\\', "/").trim_end_matches('/'));
    if !root.is_empty() && path.get(..prefix.len()).is_some_and(|value|value.eq_ignore_ascii_case(&prefix)) {
        path[prefix.len()..].to_string()
    } else { path }
}

fn merge_snapshot(entry: &mut Value, snapshot: &Value) {
    if !entry["before"].is_string() && snapshot["before"].is_string() {
        entry["before"] = snapshot["before"].clone();
    }
    if snapshot["after"].is_string() {
        entry["after"] = snapshot["after"].clone();
        entry["truncated"] = json!(snapshot["truncated"] == true);
        entry.as_object_mut().unwrap().remove("patch");
    }
}

fn file_event(files: &mut BTreeMap<String,Value>, payload: &Value, root: &str) {
    let Some(path) = payload["path"].as_str().filter(|path|!path.is_empty()) else { return };
    let key = key(path,root);
    let entry = files.entry(key).or_insert_with(||json!({"path":path}));
    if payload["changeType"].is_string() { entry["changeType"] = payload["changeType"].clone(); }
    if let Some(patch) = payload["diff"].as_str().filter(|patch|!patch.is_empty()) {
        let next = entry["after"].as_str().filter(|_|entry["truncated"]!=true)
            .and_then(|before|apply_patch(before,patch));
        if let Some(after) = next {
            entry["after"] = json!(after);
            entry.as_object_mut().unwrap().remove("patch");
        } else {
            entry["patch"] = json!(patch);
            entry.as_object_mut().unwrap().remove("after");
        }
    }
    merge_snapshot(entry,&payload["fileSnapshot"]);
}

fn project(events: &[Value], root: &str) -> Value {
    let mut files = BTreeMap::new();
    let mut receipts = std::collections::HashSet::new();
    for event in events {
        let payload = &event["payload"];
        if event["type"] == "tool.finished" && payload["success"] != false {
            let diff = &payload["fileDiff"];
            if ["edit","write"].contains(&diff["operation"].as_str().unwrap_or("")) {
                if let Some(path) = diff["path"].as_str().filter(|path|!path.is_empty()) {
                    let entry = files.entry(key(path,root)).or_insert_with(||json!({"path":path}));
                    merge_snapshot(entry,diff);
                }
            }
        }
        if event["type"] == "file.changed" {
            let duplicate = payload["callId"].is_string() && !receipts.insert(json!([
                payload["callId"],payload["path"],payload["diff"],payload["fileSnapshot"]]).to_string());
            if !duplicate { file_event(&mut files,payload,root); }
        }
        if event["type"] == "run.diff_updated" {
            if let Some(patch) = payload["diff"].as_str() {
                let mut path = String::new(); let mut section = String::new();
                for line in patch.lines().chain(std::iter::once("diff --git ")) {
                    if line.starts_with("diff --git ") {
                        if !path.is_empty() { file_event(&mut files,&json!({"path":path,"diff":section}),root); }
                        path.clear(); section.clear();
                    }
                    if let Some(next) = line.strip_prefix("+++ b/") { path = next.into(); }
                    if path.is_empty() { if let Some(previous) = line.strip_prefix("--- a/") { path = previous.into(); } }
                    section.push_str(line); section.push('\n');
                }
            }
        }
    }
    let mut used = 0;
    let files = files.into_values().filter(|file| {
        !(file["before"].is_string() && file["before"]==file["after"] && file["truncated"]!=true)
    }).take(100).take_while(|file|{ used+=file.to_string().len(); used<2_000_000 }).collect::<Vec<_>>();
    json!({"files":files})
}

/// Apply a provider patch only when every original line and hunk count agree.
/// Otherwise retain the native patch; never manufacture a full-file comparison.
fn apply_patch(before: &str, patch: &str) -> Option<String> {
    let original = before.lines().collect::<Vec<_>>();
    let mut output = Vec::new(); let mut cursor = 0; let mut hunks = 0;
    let lines = patch.lines().collect::<Vec<_>>(); let mut i = 0;
    let mut newline = before.ends_with('\n');
    while i < lines.len() {
        let line = lines[i]; i+=1;
        if !line.starts_with("@@ -") { continue; }
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let range = |value: &str| -> Option<(usize,usize)> {
            let mut parts = value.get(1..)?.split(',');
            Some((parts.next()?.parse().ok()?,parts.next().map(str::parse).transpose().ok()?.unwrap_or(1)))
        };
        let (start, old_count) = range(fields.get(1)?)?;
        let (_, new_count) = range(fields.get(2)?)?;
        let offset = if old_count==0 { start } else { start.checked_sub(1)? };
        if offset < cursor || offset > original.len() { return None; }
        output.extend(original[cursor..offset].iter().map(|line|line.to_string())); cursor=offset;
        let mut old=0; let mut new=0;
        while i<lines.len() && !lines[i].starts_with("@@ ") {
            let line=lines[i]; i+=1;
            match line.as_bytes().first().copied() {
                Some(b' ' | b'-') => {
                    if original.get(cursor).copied()!=line.get(1..) { return None; }
                    cursor+=1; old+=1;
                    if line.starts_with(' ') { output.push(line[1..].into()); new+=1; }
                }
                Some(b'+') => { output.push(line[1..].into()); new+=1; }
                Some(b'\\') => { if lines.get(i.wrapping_sub(2)).is_some_and(|line|!line.starts_with('-')) { newline=false; } }
                _=>break,
            }
        }
        if old!=old_count || new!=new_count { return None; }
        hunks+=1;
    }
    if hunks==0 { return None; }
    output.extend(original[cursor..].iter().map(|line|line.to_string()));
    let mut result=output.join("\n");
    if newline && !output.is_empty() { result.push('\n'); }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opencode_creation_edit_and_overwrite_keep_the_initial_baseline_and_latest_file() {
        let result=project(&[
            json!({"type":"file.changed","payload":{"path":"D:/项目/动画.svg","changeType":"added","fileSnapshot":{"before":"","after":"<svg>\nold\n</svg>\n"}}}),
            json!({"type":"file.changed","payload":{"path":"D:/项目/动画.svg","changeType":"modified","diff":"--- a/a.svg\n+++ b/a.svg\n@@ -2 +2 @@\n-old\n+animated\n"}}),
            json!({"type":"file.changed","payload":{"path":"D:/项目/动画.svg","fileSnapshot":{"after":"<svg>final</svg>\n"}}})
        ],"D:/项目");
        assert_eq!(result["files"][0]["before"],"");
        assert_eq!(result["files"][0]["after"],"<svg>final</svg>\n");
        assert!(result["files"][0].get("patch").is_none());
    }
    #[test]
    fn patch_validation_preserves_unknown_baselines_and_rejects_stale_full_content() {
        let patch="--- a/a.ts\n+++ b/a.ts\n@@ -2 +2 @@\n-old\n+new\n";
        assert_eq!(apply_patch("head\nold\ntail\n",patch).as_deref(),Some("head\nnew\ntail\n"));
        assert!(apply_patch("head\nother\ntail\n",patch).is_none());
        let result=project(&[json!({"type":"file.changed","payload":{"path":"a.ts","changeType":"modified","fileSnapshot":{"after":"replacement"}}})],"");
        assert!(result["files"][0].get("before").is_none());
        assert_eq!(result["files"][0]["after"],"replacement");
    }
    #[test]
    fn metadata_only_receipts_keep_content_and_identical_files_are_not_changes() {
        let tool=json!({"type":"tool.finished","payload":{"success":true,"fileDiff":{"path":"a.ts","operation":"write","before":"one","after":"two"}}});
        let receipt=json!({"type":"file.changed","payload":{"path":"a.ts","changeType":"modified"}});
        let result=project(&[tool.clone(),receipt],"");
        assert_eq!(result["files"][0]["after"],"two");
        let unchanged=json!({"type":"file.changed","payload":{"path":"a.ts","fileSnapshot":{"after":"one"}}});
        assert_eq!(project(&[tool,unchanged],"")["files"],json!([]));
        let running=json!({"type":"tool.started","payload":{"fileDiff":{"path":"unwritten.ts","operation":"write","before":"","after":"not written yet"}}});
        assert_eq!(project(&[running],"")["files"],json!([]));
    }
}
