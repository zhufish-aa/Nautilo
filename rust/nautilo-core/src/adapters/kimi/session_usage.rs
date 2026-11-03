//! Session usage fallback — port of adapters/kimi/session-usage.ts.
//! Reads Kimi's provider-owned wire log only when ACP omits usage_update.

use std::path::Path;

use serde_json::Value;

use crate::adapters::AdapterEvent;

const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

pub async fn read_kimi_session_usage(
    provider_session_id: &str,
    context_window: Option<i64>,
    kimi_home: Option<&str>,
) -> Option<AdapterEvent> {
    let home = kimi_home
        .map(str::to_string)
        .or_else(|| std::env::var("KIMI_CODE_HOME").ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| Path::new(".").to_path_buf()).join(".kimi-code").to_string_lossy().into_owned());
    // The wire log's maxTokens is the REMAINING context, so the denominator
    // must be the window the CLI itself runs with — its own config.toml, not
    // the desktop's model catalog (catalogs go stale: K3-256k catalogs 256k
    // while the CLI runs k3 at 1M, which clamped every reading to 0).
    let context_window = read_cli_configured_window(Path::new(&home)).or(context_window);
    let context_window = context_window?;
    let wire_path = find_wire_path(Path::new(&home).join("sessions"), provider_session_id).await?;
    let text = read_tail(&wire_path).await?;
    let used = parse_kimi_wire_context_used(&text, context_window)?;
    Some(AdapterEvent::Usage {
        usage_scope: Some("context".to_string()),
        usage_key: None,
        input_tokens_includes_cache: None,
        cache_creation_input_tokens: None,
        reported_cost: None,
        estimated_cost: None,
        currency: None,
        input_tokens: None,
        cached_input_tokens: None,
        output_tokens: None,
        reasoning_output_tokens: None,
        context_used: Some(used),
        context_window: Some(context_window),
        raw: None,
    })
}

/// Reads `max_context_size` from the CLI's own config.toml (plain line scan;
/// the file is small and the key is top-level).
fn read_cli_configured_window(home: &Path) -> Option<i64> {
    let text = std::fs::read_to_string(home.join("config.toml")).ok()?;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') || !line.starts_with("max_context_size") {
            continue;
        }
        if let Some(value) = line.split_once('=').and_then(|(_, raw)| raw.trim().trim_matches('"').parse::<i64>().ok()) {
            if value > 0 {
                return Some(value);
            }
        }
    }
    None
}

pub fn parse_kimi_wire_context_used(text: &str, context_window: i64) -> Option<i64> {
    let mut used: Option<i64> = None;
    let mut saw_request = false;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else { continue };
        match event.get("type").and_then(Value::as_str) {
            Some("llm.request") => {
                if let Some(max_tokens) = event.get("maxTokens").and_then(Value::as_i64) {
                    used = Some((context_window - max_tokens).max(0));
                    saw_request = true;
                }
            }
            Some("usage.record") if saw_request => {
                let usage = event.get("usage").cloned().unwrap_or(Value::Null);
                let increment: i64 = ["inputOther", "inputCacheRead", "inputCacheCreation", "output"]
                    .iter()
                    .map(|key| usage.get(*key).and_then(Value::as_i64).unwrap_or(0))
                    .sum();
                used = Some(used.unwrap_or(0) + increment);
            }
            _ => {}
        }
    }
    used.map(|value| value.clamp(0, context_window))
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
