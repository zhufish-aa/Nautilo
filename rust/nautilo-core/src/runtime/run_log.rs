//! Minimal JSON-lines file log for diagnosing run lifecycle issues.
//!
//! Writes to `<data_dir>/logs/daemon.log` (data_dir = AGENTHUB_DATA_DIR,
//! falling back to `~/.agenthub`). Append-only and best-effort: logging
//! failures never affect daemon operation. Each line is a JSON object
//! with a millisecond `ts` field.

use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn log(event: Value) {
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path()) else {
        return;
    };
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut line = event.clone();
    line["ts"] = json!(ts);
    let _ = writeln!(file, "{}", line);
    let _ = file.flush();
}

/// Convenience: log a run-scoped lifecycle event with optional extras.
pub fn run_event(run_id: &str, what: &str, extra: Value) {
    log(json!({ "event": what, "runId": run_id, "extra": extra }));
}

fn log_path() -> PathBuf {
    let mut dir = if let Some(d) = std::env::var_os("AGENTHUB_DATA_DIR") {
        PathBuf::from(d)
    } else {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".agenthub")
    };
    dir.push("logs");
    let _ = std::fs::create_dir_all(&dir);
    dir.push("daemon.log");
    dir
}
