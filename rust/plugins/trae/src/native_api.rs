use agenthub_plugin_sdk::jsonrpc::JsonRpcClient;
use agenthub_plugin_sdk::process::{self, ProcessRequest};
use serde_json::{json, Value};
use std::time::Duration;

/// Start the selected TRAE CLI's read-only app-server probe. The caller owns
/// the connection until it has finished reading quota or model metadata.
pub async fn open(instance: &Value, context: &Value) -> anyhow::Result<Option<JsonRpcClient>> {
    let mut args = super::base_args(instance);
    // Metadata lookups do not need a worktree.
    if args.iter().any(|arg| matches!(arg.as_str(), "-w" | "--worktree")
        || arg.starts_with("--worktree=") || arg.starts_with("-w=")) {
        return Ok(None);
    }
    let Some(binary) = super::selected_trae_binary(instance).await else {
        anyhow::bail!("找不到已配置的 TRAE CLI");
    };
    if binary.mode != "acp" || !binary.help.lines().any(|line| line.split_whitespace().next() == Some("app-server")) {
        return Ok(None);
    }
    args.extend(["app-server".into(), "--stdio".into()]);
    let env = context["env"].as_object().into_iter().flatten().filter_map(|(key, value)| {
        Some((key.clone(), value.as_str()?.to_owned()))
    }).collect();
    let started = process::start(&ProcessRequest {
        command: binary.executable,
        args,
        env: Some(env),
        timeout_ms: Some(15_000),
        idle_timeout_ms: Some(12_000),
        max_output_bytes: Some(2 * 1024 * 1024),
        ..Default::default()
    }).map_err(|_| anyhow::anyhow!("无法启动 TRAE 企业版元数据查询"))?;
    let rpc = JsonRpcClient::new(started.handle, started.events);
    if rpc.request("initialize", json!({
        "clientInfo": {"name": "nautilo", "title": "Nautilo", "version": env!("CARGO_PKG_VERSION")}
    })).await.is_err() {
        close(rpc).await;
        anyhow::bail!("TRAE 企业版元数据查询握手失败");
    }
    rpc.notify("initialized", Value::Null);
    Ok(Some(rpc))
}

pub async fn close(rpc: JsonRpcClient) {
    let handle = rpc.process_handle();
    handle.end_stdin();
    if tokio::time::timeout(Duration::from_millis(500), handle.wait()).await.is_err() {
        handle.cancel().await;
    }
}

pub fn needs_login(error: &anyhow::Error) -> bool {
    error.to_string().contains("TRAE enterprise authentication required")
}
