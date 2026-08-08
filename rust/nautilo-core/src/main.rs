//! Nautilo core daemon — Rust port of @agenthub/core-daemon.
//!
//! Entry behavior mirrors packages/core-daemon/src/index.ts:
//!   nautilo-core           -> prints a one-line health JSON and exits
//!   nautilo-core --serve   -> starts the IPC gateway, prints the ready line
//!                             {"service":"core-daemon","status":"ok","version":...,"socketPath":...}

mod adapters;
mod application;
mod database;
mod domain;
mod errors;
mod ipc_gateway;
mod process_runtime;
mod runtime;
mod win_command;

use std::path::PathBuf;

use serde_json::json;

const VERSION: &str = "0.1.0";

fn health() -> serde_json::Value {
    json!({ "service": "core-daemon", "status": "ok", "version": VERSION })
}

fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("AGENTHUB_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".agenthub")
}

fn default_socket_path(data_dir: &std::path::Path) -> String {
    if cfg!(windows) {
        "\\\\.\\pipe\\agenthub-core".to_string()
    } else {
        data_dir.join("core.sock").to_string_lossy().into_owned()
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let serve = std::env::args().any(|arg| arg == "--serve");
    if !serve {
        println!("{}", health());
        return Ok(());
    }

    let data_dir = data_dir();
    std::fs::create_dir_all(&data_dir)?;
    let socket_path = std::env::var("AGENTHUB_SOCKET").unwrap_or_else(|_| default_socket_path(&data_dir));
    let token_path = std::env::var("AGENTHUB_TOKEN_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir.join("core.token"));

    // Storage and services come up before the gateway accepts requests,
    // matching the TS startup order.
    let daemon = application::core_daemon::Daemon::new(data_dir).await?;
    let router = daemon.router();

    let (gateway, accept_task) = ipc_gateway::Gateway::start(socket_path, token_path, router)?;
    println!(
        "{}",
        json!({
            "service": "core-daemon",
            "status": "ok",
            "version": VERSION,
            "socketPath": gateway.socket_path(),
        })
    );
    use std::io::Write;
    let _ = std::io::stdout().flush();

    tokio::signal::ctrl_c().await?;
    let _ = daemon.audit.flush();
    gateway.cleanup();
    accept_task.abort();
    Ok(())
}
