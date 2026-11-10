#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use agenthub_plugin_sdk::process::{self, ProcessEvent, ProcessRequest};
use agenthub_plugin_sdk::ProviderPlugin;
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

#[derive(Default)]
struct CodexPlugins(Mutex<()>);

impl CodexPlugins {
    fn request(instance: &Value, context: &Value, args: &[&str]) -> Result<ProcessRequest> {
        let mut flags: Vec<String> = serde_json::from_value(instance["baseArgs"].clone()).unwrap_or_default();
        if let Some(profile) = instance["profile"].as_str().filter(|p| !p.is_empty()) {
            flags.extend(["--profile".into(), profile.into()]);
        }
        flags.extend(args.iter().map(|arg| arg.to_string()));
        Ok(ProcessRequest {
            command: instance["executable"].as_str().unwrap_or("codex").into(),
            args: flags,
            env: Some(serde_json::from_value(context["env"].clone())?),
            timeout_ms: Some(120_000),
            max_output_bytes: Some(12 * 1024 * 1024),
            ..Default::default()
        })
    }

    async fn toggle(instance: &Value, context: &Value, id: &str, enabled: bool) -> Result<Value> {
        let installed = Self::command(instance, context, &["list"]).await?;
        ensure!(installed["installed"].as_array().is_some_and(|rows| rows.iter().any(|row| row["pluginId"] == id)), "Plugin is no longer installed");
        let child = process::start(&Self::request(instance, context, &["app-server"])?)?;
        let rpc = agenthub_plugin_sdk::jsonrpc::JsonRpcClient::new(child.handle.clone(), child.events);
        let result = async {
            rpc.request("initialize", json!({"clientInfo":{"name":"nautilo_plugins","title":"Nautilo","version":"1"}})).await?;
            rpc.notify("initialized", json!({}));
            let response = rpc.request("config/value/write", json!({
                "keyPath": format!("plugins.{}.enabled", serde_json::to_string(id)?),
                "value": enabled, "mergeStrategy": "upsert"
            })).await?;
            Ok(json!({"application":if response["status"] == "okOverridden" { "overridden" } else { "applied" }}))
        }.await;
        child.handle.end_stdin();
        child.handle.cancel().await;
        result
    }

    async fn command(instance: &Value, context: &Value, args: &[&str]) -> Result<Value> {
        let mut flags = vec!["plugin"];
        flags.extend_from_slice(args);
        flags.push("--json");
        let mut child = process::start(&Self::request(instance, context, &flags)?)?;
        child.handle.end_stdin();
        let (mut output, mut errors) = (String::new(), String::new());
        while let Some(event) = child.events.recv().await {
            match event {
                ProcessEvent::Stdout(text) => output.push_str(&text),
                ProcessEvent::Stderr(text) => errors.push_str(&text),
                ProcessEvent::Error(reason) | ProcessEvent::Timeout { reason } => bail!("{reason}"),
                ProcessEvent::Exit { exit_code: Some(0), .. } => return Ok(serde_json::from_str(&output).context("Codex returned an invalid plugin response")?),
                ProcessEvent::Exit { exit_code, .. } => bail!("Codex plugin command failed ({exit_code:?}): {}", errors.trim().chars().take(1200).collect::<String>()),
            }
        }
        bail!("Codex exited without a plugin response")
    }
}

#[async_trait::async_trait]
impl ProviderPlugin for CodexPlugins {
    fn descriptor(&self) -> Value {
        serde_json::from_str::<Value>(include_str!("../agenthub-plugin.json")).unwrap()["descriptor"].clone()
    }
    async fn detect(&self, _: &Value) -> Value { json!({"installed": false}) }
    async fn start(&self, _: &str, _: Value, _: Option<String>) -> Result<mpsc::UnboundedReceiver<Value>> {
        bail!("Management-only plugin")
    }
    async fn harness_plugins(&self, instance: &Value, context: &Value, operation: &Value) -> Result<Value> {
        let _guard = self.0.lock().await;
        match operation["action"].as_str() {
            Some("list") => {
                let result = Self::command(instance, context, &["list", "--available"]).await?;
                let mut items = Vec::new();
                for group in ["installed", "available"] {
                    for row in result[group].as_array().context("Missing Codex plugin list")? {
                        let installed = row["installed"] == true;
                        let mut actions = Vec::new();
                        if installed {
                            actions.push(if row["enabled"] == true { "disable" } else { "enable" });
                            actions.push("remove");
                        }
                        else if row["installPolicy"] != "NOT_AVAILABLE" { actions.push("install"); }
                        items.push(json!({"id":row["pluginId"],"name":row["name"],"source":row["marketplaceName"],
                            "version":row["version"],"installed":installed,"enabled":row["enabled"],"actions":actions}));
                    }
                }
                Ok(json!({"items": items}))
            }
            Some(action @ ("install" | "remove" | "enable" | "disable")) => {
                let id = operation["id"].as_str().context("Missing Codex plugin ID")?;
                let (name, market) = id.split_once('@').context("Expected plugin@marketplace")?;
                for part in [name, market] {
                    ensure!(!part.is_empty() && part.len() <= 256 && !part.starts_with('-') &&
                        part.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)), "Invalid Codex plugin ID");
                }
                if matches!(action, "enable" | "disable") {
                    return Self::toggle(instance, context, id, action == "enable").await;
                }
                Self::command(instance, context, &[if action == "install" { "add" } else { "remove" }, id]).await?;
                Ok(json!({"application":"applied"}))
            }
            _ => bail!("Unsupported Codex plugin operation"),
        }
    }
}

#[tokio::main]
async fn main() { agenthub_plugin_sdk::serve(CodexPlugins::default()).await; }
