//! Nautilo core daemon — Rust port of @agenthub/core-daemon.
//!
//! Entry behavior mirrors packages/core-daemon/src/index.ts:
//!   nautilo-core           -> prints a one-line health JSON and exits
//!   nautilo-core --serve   -> starts the IPC gateway, prints the ready line
//!                             {"service":"core-daemon","status":"ok","version":...,"socketPath":...}

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adapters;
mod application;
mod database;
mod domain;
mod errors;
mod ipc_gateway;
mod paths;
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

    // The shell holds this daemon's stdout pipe open for its whole lifetime.
    // If the shell is killed (crash/taskkill), the read end breaks and the
    // next heartbeat write fails — self-exit instead of living on as an
    // orphan that keeps the data directory locked (a killed shell used to
    // leave one daemon behind per restart).
    let (shell_closed, mut shell_closed_receiver) = tokio::sync::oneshot::channel::<()>();
    let heartbeat = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let mut out = std::io::stdout();
            if writeln!(out).is_err() {
                let _ = shell_closed.send(());
                return;
            }
        }
    });

    // Keep the SQLite WAL bounded: writers only append to the WAL, so without
    // an idle checkpoint it grows without limit while the main DB stays small.
    // Checkpoint when the connection is free so it never stalls an active run.
    {
        let daemon = daemon.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                daemon.checkpoint_wal();
            }
        });
    }

    // Both a normal stop and a dead shell take the same cleanup path. Do not
    // process::exit from the heartbeat: that skips resident CLI termination.
    let shutdown_result = tokio::select! {
        result = tokio::signal::ctrl_c() => result,
        _ = &mut shell_closed_receiver => Ok(()),
    };
    accept_task.abort();
    gateway.cleanup();
    adapters::codex::app_server::shutdown_codex_app_server_pools().await;
    heartbeat.abort();
    let _ = daemon.audit.flush();
    shutdown_result?;
    Ok(())
}
