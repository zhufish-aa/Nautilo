//! Session usage fallback — port of adapters/kimi/session-usage.ts.
//! Reads Kimi's own wire log when ACP omits context or turn usage.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::adapters::AdapterEvent;

const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

pub async fn read_kimi_session_usage(
    provider_session_id: &str,
    context_window: Option<i64>,
    kimi_home: Option<&str>,
    model: Option<&str>,
) -> Option<AdapterEvent> {
    let home = native_home(kimi_home)?;
    let context_window = read_cli_configured_window(&home, model).await.or(context_window);
    let wire_path = find_wire_path(home.join("sessions"), provider_session_id).await?;
    let text = read_tail(&wire_path).await?;
    let (used, cached) = parse_kimi_wire_context(&text)?;
    Some(AdapterEvent::Usage {
        usage_scope: Some("context".to_string()),
        usage_key: None,
        input_tokens_includes_cache: None,
        cache_creation_input_tokens: None,
        reported_cost: None,
        estimated_cost: None,
        currency: None,
        input_tokens: None,
        cached_input_tokens: cached,
        output_tokens: None,
        reasoning_output_tokens: None,
        context_used: Some(used),
        context_window,
        raw: None,
    })
}

pub(super) async fn kimi_wire_path(session_id: &str, kimi_home: Option<&str>) -> Option<PathBuf> {
    find_wire_path(native_home(kimi_home)?.join("sessions"), session_id).await.map(PathBuf::from)
}

fn native_home(kimi_home: Option<&str>) -> Option<PathBuf> {
    kimi_home.map(PathBuf::from)
        .or_else(|| std::env::var_os("KIMI_CODE_HOME").filter(|value| !value.is_empty()).map(PathBuf::from))
        .or_else(|| dirs::home_dir().map(|home| home.join(".kimi-code")))
}

pub(super) async fn read_kimi_wire_turn(path: &Path, offset: u64) -> Option<AdapterEvent> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let length = file.metadata().await.ok()?.len().checked_sub(offset)?;
    if length == 0 || length > MAX_READ_BYTES { return None; }
    file.seek(std::io::SeekFrom::Start(offset)).await.ok()?;
    let mut text = String::new();
    file.take(length).read_to_string(&mut text).await.ok()?;
    parse_kimi_wire_turn(&text)
}

fn parse_kimi_wire_turn(text: &str) -> Option<AdapterEvent> {
    let reports: Vec<_> = text.lines().filter_map(|line| {
        let event = serde_json::from_str::<Value>(line).ok()?;
        (event["type"] == "usage.record" && event["usageScope"] == "turn").then(|| event["usage"].clone())
    }).collect();
    if reports.is_empty() { return None; }
    let sum = |key: &str| reports.iter().try_fold(0_i64, |total, usage| {
        total.checked_add(usage[key].as_i64().filter(|count| *count >= 0)?)
    });
    Some(AdapterEvent::Usage {
        usage_scope: Some("turn".into()), usage_key: None, input_tokens_includes_cache: Some(false),
        input_tokens: sum("inputOther"), output_tokens: sum("output"), cached_input_tokens: sum("inputCacheRead"),
        cache_creation_input_tokens: sum("inputCacheCreation"), reasoning_output_tokens: None,
        reported_cost: None, estimated_cost: None, currency: None, context_used: None, context_window: None, raw: None,
    })
}

#[test]
fn wire_counts_every_report_in_the_turn_and_keeps_missing_cache_unknown() {
    let text = r#"{"type":"usage.record","usageScope":"turn","usage":{"inputOther":10,"output":4,"inputCacheRead":100,"inputCacheCreation":0}}
{"type":"usage.record","usageScope":"turn","usage":{"inputOther":20,"output":6,"inputCacheRead":300}}"#;
    assert!(matches!(parse_kimi_wire_turn(text), Some(AdapterEvent::Usage {
        input_tokens: Some(30), output_tokens: Some(10), cached_input_tokens: Some(400),
        cache_creation_input_tokens: None, input_tokens_includes_cache: Some(false), ..
    })));
    assert!(parse_kimi_wire_turn("").is_none());
}

async fn read_cli_configured_window(home: &Path, model: Option<&str>) -> Option<i64> {
    let text = tokio::fs::read_to_string(home.join("config.toml")).await.ok()?;
    let config: Value = toml_edit::de::from_str(&text).ok()?;
    let model = model.or(config["default_model"].as_str())?;
    config["models"][model]["max_context_size"].as_i64().filter(|count| *count > 0)
}

fn parse_kimi_wire_context(text: &str) -> Option<(i64, Option<i64>)> {
    for line in text.lines().rev() {
        let Ok(event) = serde_json::from_str::<Value>(line) else { continue };
        match event["type"].as_str() {
            Some("token_counting.measured" | "token_counting.turn_recorded") => {
                return event["tokens"].as_i64().filter(|count| *count >= 0).map(|count| (count, None));
            }
            Some("usage.record") if event["usageScope"] != "session" => {
                let usage = &event["usage"];
                let total = ["inputOther", "inputCacheRead", "inputCacheCreation", "output"]
                    .into_iter().try_fold(0_i64, |total, name| {
                        total.checked_add(usage[name].as_i64().filter(|count| *count >= 0)?)
                    })?;
                return Some((total, usage["inputCacheRead"].as_i64()));
            }
            _ => {},
        }
    }
    None
}

async fn find_wire_path(sessions_root: std::path::PathBuf, provider_session_id: &str) -> Option<String> {
    let mut entries = tokio::fs::read_dir(sessions_root).await.ok()?;
    while let Ok(Some(workspace)) = entries.next_entry().await {
        let candidate = workspace.path().join(provider_session_id).join("agents").join("main").join("wire.jsonl");
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

async fn read_tail(path: &str) -> Option<String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let size = file.metadata().await.ok()?.len();
    let length = size.min(MAX_READ_BYTES);
    if size > length {
        file.seek(std::io::SeekFrom::Start(size - length)).await.ok()?;
    }
    let mut buffer = vec![0u8; length as usize];
    file.read_exact(&mut buffer).await.ok()?;
    let text = String::from_utf8_lossy(&buffer).into_owned();
    // Drop the first partial line when reading a tail slice.
    if size > length {
        return text.split_once('\n').map(|(_, rest)| rest.to_string());
    }
    Some(text)
}
