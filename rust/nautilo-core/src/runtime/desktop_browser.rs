use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::hmac;
use serde_json::{json, Value};

/// Only an Electron-launched daemon advertises a desktop browser. Each client
/// receives a credential for its own conversation, never the desktop IPC key.
pub fn server(session_id: &str) -> Option<Value> {
    let port: u16 = std::env::var("NAUTILO_BROWSER_PORT").ok()?.parse().ok()?;
    let token = std::fs::read_to_string(std::env::var_os("AGENTHUB_TOKEN_PATH")?).ok()?;
    if port == 0 || token.trim().is_empty() || session_id.is_empty()
        || !session_id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')) {
        return None;
    }
    let key = hmac::Key::new(hmac::HMAC_SHA256, token.trim().as_bytes());
    let message = format!("nautilo-browser-v1/{port}/{session_id}");
    let signature = URL_SAFE_NO_PAD.encode(hmac::sign(&key, message.as_bytes()).as_ref());
    Some(json!({
        "name": "nautilo_browser", "transport": "http", "desktopBrowser": true,
        "url": format!("http://127.0.0.1:{port}/mcp/{session_id}"),
        "headers": { "Authorization": format!("Bearer {signature}") }
    }))
}
