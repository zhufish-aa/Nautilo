//! Nautilo native provider plugin for Trae — port of provider-plugin-trae.
//!
//! Drives both Trae CLIs: the official ACP-native `traecli` (ndjson JSON-RPC
//! via `traecli acp serve`) and the open-source `trae-cli` (plain stdout).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod native_experience;
mod native_api;
mod models;
mod quota;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, watch};

use agenthub_plugin_sdk::jsonrpc::{JsonRpcClient, JsonRpcEvent};
use agenthub_plugin_sdk::process::{self, ProcessEvent, ProcessHandle, ProcessRequest};
use agenthub_plugin_sdk::session_pool::{self, SessionPool};
use agenthub_plugin_sdk::runtime_tools::{bypass_loopback_proxy, RuntimeTools, ToolRoute};
use agenthub_plugin_sdk::{DaemonChannel, ProviderPlugin};

mod local_mcp;

fn descriptor() -> Value {
    let manifest: Value = serde_json::from_str(include_str!("../agenthub-plugin.json"))
        .expect("valid bundled Trae manifest");
    manifest["descriptor"].clone()
}

fn str_of(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn base_args(instance: &Value) -> Vec<String> {
    instance
        .get("baseArgs")
        .and_then(Value::as_array)
        .map(|args| args.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

async fn capture(command: &str, args: &[String]) -> (String, Option<i32>) {
    let env: HashMap<String, String> = std::env::vars().collect();
    let mut started = match process::start(&ProcessRequest {
        command: command.to_string(),
        args: args.to_vec(),
        env: Some(env),
        inherit_env: true,
        timeout_ms: Some(8_000),
        idle_timeout_ms: Some(4_000),
        max_output_bytes: Some(512 * 1024),
        ..Default::default()
    }) {
        Ok(started) => started,
        Err(error) => return (error.to_string(), None),
    };
    let mut text = String::new();
    let mut code = None;
    while let Some(event) = started.events.recv().await {
        match event {
            ProcessEvent::Stdout(chunk) | ProcessEvent::Stderr(chunk) => text.push_str(&chunk),
            ProcessEvent::Exit { exit_code, .. } => code = exit_code,
            _ => {}
        }
    }
    (text, code)
}

struct TraeBinary {
    executable: String,
    mode: String,
    version: String,
    help: String,
}

/// `acp` in the help means the official ACP-native CLI; a `run` subcommand
/// means the open-source trae-agent.
async fn probe_trae_binary(executable: &str, base_args: &[String]) -> Option<TraeBinary> {
    let mut args = base_args.to_vec();
    args.push("--version".to_string());
    let (version, version_code) = capture(executable, &args).await;
    if version_code != Some(0) {
        return None;
    }
    let mut args = base_args.to_vec();
    args.push("--help".to_string());
    let (help, help_code) = capture(executable, &args).await;
    if help_code != Some(0) {
        return None;
    }
    let acp = regex::Regex::new(r"(?i)\bacp\b").ok()?.is_match(&help);
    let cli = regex::Regex::new(r"(?m)^\s*run(\s|,|$)").ok()?.is_match(&help);
    let mode = if acp { "acp" } else if cli { "cli" } else { return None };
    Some(TraeBinary { executable: executable.into(), mode: mode.to_string(), version: version.trim().to_string(), help })
}

async fn selected_trae_binary(instance: &Value) -> Option<TraeBinary> {
    let executable = instance["executable"].as_str().filter(|value| !value.is_empty()).unwrap_or("trae-cli");
    let args = base_args(instance);
    match probe_trae_binary(executable, &args).await {
        None if executable == "trae-cli" && args.is_empty() => probe_trae_binary("traecli", &args).await,
        detected => detected,
    }
}

struct TraePlugin {
    interactions: std::sync::Mutex<Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>>,
    daemon: Mutex<Option<Arc<dyn DaemonChannel>>>,
    runs: Arc<ActiveRuns>,
    pool: SessionPool<AcpResident>,
}

type ActiveRuns = Mutex<HashMap<String, ActiveRun>>;

struct ActiveRun {
    local_session: Option<String>,
    process: Option<ActiveProcess>,
}

struct ActiveProcess {
    handle: ProcessHandle,
    prompt: Option<(String, watch::Sender<bool>)>,
}

impl TraePlugin {
    fn new() -> Self {
        Self { interactions: Mutex::new(None), daemon:Mutex::new(None), runs: Arc::default(), pool: SessionPool::default() }
    }
}

#[async_trait::async_trait]
impl ProviderPlugin for TraePlugin {
    async fn native_resources(&self, instance: &Value, cwd: &str, _session: &Value) -> anyhow::Result<Vec<Value>> {
        use agenthub_plugin_sdk::native_resources::{strings, toml, yaml, Resources};
        let mut resources = Resources::new(instance, cwd);
        let args = strings(&instance["baseArgs"]);
        let profile = args.windows(2).find(|pair|pair[0] == "--profile").map(|pair|pair[1])
            .or_else(||args.iter().find_map(|arg| arg.strip_prefix("--profile=")));
        let home = resources.path("TRAE_HOME").unwrap_or_else(||resources.home.join(".trae"));
        let path = profile.map(|profile|home.join(format!("{profile}.traecli.toml"))).unwrap_or_else(||home.join("traecli.toml"));
        resources.mcp(&path, &toml(&path)["mcp_servers"], &[]);
        let project_config = (!cwd.is_empty()).then(||["trae_config.yaml", "trae_config.yml", "trae_config.json"]
            .into_iter().map(|name|resources.cwd.join(name)).find(|path|path.is_file())).flatten();
        let path = resources.path("TRAE_CONFIG_FILE").or(project_config).unwrap_or_else(||home.join("trae_cli.yaml"));
        let config = yaml(&path);
        resources.mcp(&path, &config["mcp_servers"], &[]);
        resources.mcp(&path, &config["mcpServers"], &[]);
        Ok(resources.finish())
    }
    fn descriptor(&self) -> Value {
        descriptor()
    }

    fn capabilities(&self)->Value {
        agenthub_plugin_sdk::capabilities::with_profile(json!({
            "structuredOutput": true,
            "textOutput": true,
            "interactiveStdin": false,
            "nativeResume": true,
            "pty": false
        }),native_experience::declarations())
    }

    fn set_interaction_channel(&self, channel: Arc<dyn agenthub_plugin_sdk::InteractionChannel>) {
        *self.interactions.lock().unwrap() = Some(channel);
    }

    fn set_daemon_channel(&self, channel: Arc<dyn DaemonChannel>) {
        *self.daemon.lock().unwrap() = Some(channel);
    }

    async fn detect(&self, instance: &Value) -> Value {
        let executable = instance["executable"].as_str().filter(|e| !e.is_empty()).unwrap_or("trae-cli");
        match selected_trae_binary(instance).await {
            Some(probed) => json!({
                "installed": true,
                "compatible": true,
                "executable": probed.executable,
                "version": probed.version,
                "help": probed.help.chars().take(16_384).collect::<String>()
            }),
            None => json!({
                "installed": false,
                "executable": executable,
                "error": "未识别为 Trae CLI：请安装官方 TRAE CLI（traecli，企业版）或开源 trae-agent（trae-cli），或在实例设置中指定可执行文件路径"
            }),
        }
    }

    async fn connection_protocol(&self, request: &Value) -> anyhow::Result<Value> {
        let binary = selected_trae_binary(&request["instance"]).await.ok_or_else(||anyhow::anyhow!("未找到可用的 Trae CLI"))?;
        Ok(json!(if modern_cli(&binary) { "responses" } else { "anthropic" }))
    }

    async fn account_quota(&self, instance: &Value, context: &Value) -> anyhow::Result<Value> {
        quota::read(instance, context).await
    }

    async fn list_models(&self, instance: &Value, context: &Value) -> anyhow::Result<Value> {
        if instance["providerOptions"]["baseUrl"].as_str().is_some_and(|url| !url.trim().is_empty()) {
            anyhow::bail!("models_unavailable");
        }
        models::read(instance, context).await
    }

    async fn start(&self, run_id: &str, request: Value, resume: Option<String>) -> anyhow::Result<mpsc::UnboundedReceiver<Value>> {
        let (sender, receiver) = mpsc::unbounded_channel::<Value>();
        let interactions = self.interactions.lock().unwrap().clone();
        let daemon = self.daemon.lock().unwrap().clone();
        let runs = self.runs.clone();
        let run_id = run_id.to_string();
        let local_session = request["localSessionId"].as_str().filter(|id| !id.is_empty()).map(str::to_string);
        let pool = self.pool.clone();
        {
            let mut active = runs.lock().unwrap();
            anyhow::ensure!(!active.contains_key(&run_id), "Trae run is already active");
            anyhow::ensure!(local_session.is_none() || !active.values().any(|run| run.local_session == local_session),
                "Trae session already has an active turn");
            active.insert(run_id.clone(), ActiveRun { local_session, process: None });
        }
        tokio::spawn(async move {
            let result = run(request, resume, sender.clone(), interactions, daemon, &runs, &run_id, &pool).await;
            let process = runs.lock().unwrap().remove(&run_id).and_then(|run| run.process);
            if let Some(process) = process { process.handle.cancel().await; }
            if let Err(error) = result {
                let _ = sender.send(json!({ "kind": "error", "message": error.to_string() }));
                let _ = sender.send(json!({ "kind": "exit", "exitCode": 1 }));
            }
        });
        Ok(receiver)
    }

    async fn cancel(&self, run_id: &str) {
        let process = self.runs.lock().unwrap().remove(run_id).and_then(|run| run.process);
        if let Some(process) = process {
            if let Some((session_id, cancelled)) = process.prompt {
                process.handle.write(&format!("{}\n", json!({
                    "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session_id }
                })));
                let _ = cancelled.send(true);
                // An interrupted ACP worker must not accept another prompt,
                // even if it acknowledged cancellation and kept stdin open.
                process.handle.end_stdin();
                if tokio::time::timeout(Duration::from_millis(1200), process.handle.wait()).await.is_ok() {
                    return;
                }
            }
            process.handle.cancel().await;
        }
    }

    async fn release_session(&self, request: &Value) -> anyhow::Result<()> {
        let Some(session) = request["localSessionId"].as_str() else { return Ok(()); };
        // Same lock order as the successful turn handoff: once released, an
        // in-flight turn must never put its worker back into the pool.
        let (resident, processes) = {
            let mut active = self.runs.lock().unwrap();
            let ids: Vec<_> = active.iter().filter(|(_, run)| run.local_session.as_deref() == Some(session))
                .map(|(id, _)| id.clone()).collect();
            let processes: Vec<_> = ids.iter().filter_map(|id| active.remove(id).and_then(|run| run.process)).collect();
            (self.pool.retire(session), processes)
        };
        if let Some(resident) = resident { resident.close().await; }
        for process in processes { process.handle.cancel().await; }
        Ok(())
    }

    async fn dispose(&self) {
        let processes: Vec<_> = self.runs.lock().unwrap().drain().filter_map(|(_, run)| run.process).collect();
        for worker in self.pool.drain() { worker.close().await; }
        for process in processes { process.handle.cancel().await; }
    }
}

async fn register_process(runs: &ActiveRuns, run_id: &str, process: ProcessHandle) -> anyhow::Result<()> {
    let registered = {
        let mut runs = runs.lock().unwrap();
        if let Some(slot) = runs.get_mut(run_id) {
            slot.process = Some(ActiveProcess { handle: process.clone(), prompt: None });
            true
        } else { false }
    };
    if !registered { process.cancel().await; anyhow::bail!("Trae run was cancelled before startup completed"); }
    Ok(())
}

async fn run(
    mut request: Value,
    resume: Option<String>,
    sender: mpsc::UnboundedSender<Value>,
    interactions: Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>,
    daemon: Option<Arc<dyn DaemonChannel>>,
    runs: &ActiveRuns,
    run_id: &str,
    pool: &SessionPool<AcpResident>,
) -> anyhow::Result<()> {
    let key = request["localSessionId"].as_str().filter(|id| !id.is_empty()).map(str::to_string);
    // Includes executable, cwd, bindings, environment and credentials, but
    // excludes the prompt and attachments. In particular, never reuse a dead
    // per-turn API proxy or a worker from a different configured account.
    let identity = session_pool::identity(&request);
    if let Some((previous, mut worker)) = key.as_deref().and_then(|key| pool.take(key)) {
        if previous == identity && worker.session_id.as_deref() == resume.as_deref() && resume.is_some()
            && worker.handle().is_some_and(ProcessHandle::is_alive) {
            worker.stop_idle_reader().await;
            if worker.handle().is_some_and(ProcessHandle::is_alive) {
                if let Some(tools) = &worker.tools {tools.bind(ToolRoute::Run(run_id.to_owned()));}
                return run_acp_turn(&request, resume, sender, interactions, runs, run_id, pool, key, identity,
                    Some(worker), None, None).await;
            }
        }
        worker.close().await;
    }
    let Some(binary) = selected_trae_binary(&request["instance"]).await else {
        anyhow::bail!("未找到可用的 Trae CLI（traecli 或 trae-cli）");
    };
    if let Some(id) = &resume {
        anyhow::ensure!(id.starts_with("nautilo-trae:") == (binary.mode == "cli"), "Trae session belongs to a different execution mode");
    }
    request["instance"]["executable"] = json!(binary.executable);
    let mut server_name = "nautilo_runtime".to_owned();
    while request["mcpServers"].as_array().is_some_and(|servers|servers.iter().any(|server|server["name"]==server_name)) {
        server_name.push('_');
    }
    let tools = RuntimeTools::start(
        &request, daemon, ToolRoute::Run(run_id.to_owned()), &server_name, |name| name,
    ).await?;
    if let Some(tools) = &tools {
        tools.append_to(&mut request);
    }
    local_mcp::relay_builtin_servers(&mut request, tools.as_ref().map(|_| server_name.as_str()))?;
    if binary.mode == "cli" { prepare_open_source_connection(&mut request)?; }
    else { prepare_connection(&mut request, modern_cli(&binary))?; }
    request["instance"]["baseArgs"] = json!(permission_args(
        base_args(&request["instance"]), request["permissionMode"].as_str(), &binary,
    )?);
    let instance = request["instance"].clone();
    if binary.mode == "cli" {
        prepare_open_source_runtime(&mut request, resume.as_deref())?;
        let instance = request["instance"].clone();
        let _ = sender.send(json!({ "kind": "status", "phase": "turn_started" }));
        let result = plain_run(&instance, &request, sender, runs, run_id).await;
        drop(tools);
        return result;
    }
    let fallback = if modern_cli(&binary) { "--acp" } else { "acp" };
    run_acp_turn(&request, resume, sender, interactions, runs, run_id, pool, key, identity,
        None, Some((&instance, fallback)),tools).await
}

fn modern_cli(binary: &TraeBinary) -> bool {
    regex::Regex::new(r"(?m)^\s*exec\s").unwrap().is_match(&binary.help)
}

fn permission_args(args: Vec<String>, mode: Option<&str>, binary: &TraeBinary) -> anyhow::Result<Vec<String>> {
    let Some(mode) = mode.filter(|mode| !matches!(*mode, "" | "inherit")) else { return Ok(args); };
    anyhow::ensure!(matches!(mode, "default" | "auto" | "bypass_permissions"), "TRAE 不支持权限模式 {mode}");
    anyhow::ensure!(binary.mode == "acp" && modern_cli(binary) && binary.help.contains("--permission-mode"),
        "此权限模式需要支持 --permission-mode 的 TRAE 企业版 CLI 2.0");
    let mut updated = Vec::with_capacity(args.len() + 2);
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        anyhow::ensure!(!matches!(arg.as_str(), "-y" | "--yolo" | "--dangerously-bypass-approvals-and-sandbox"),
            "请先从 Trae 启动参数移除 {arg}，再在 Nautilo 选择权限模式");
        if arg == "--permission-mode" {
            anyhow::ensure!(args.next().is_some_and(|value| !value.starts_with('-')), "TRAE --permission-mode 缺少参数值");
        } else if !arg.starts_with("--permission-mode=") {
            updated.push(arg);
        }
    }
    updated.extend(["--permission-mode".into(), mode.into()]);
    Ok(updated)
}

fn prepare_open_source_runtime(request: &mut Value, resume: Option<&str>) -> anyhow::Result<()> {
    use std::path::PathBuf;
    let id = request["localSessionId"].as_str().ok_or_else(||anyhow::anyhow!("Trae session identity is missing"))?.to_string();
    anyhow::ensure!(!id.is_empty() && id.chars().all(|c|c.is_ascii_alphanumeric() || c=='-' || c=='_'),"Invalid Trae session identity");
    let session = format!("nautilo-trae:{id}");
    if let Some(resume) = resume { anyhow::ensure!(resume == session, "Trae session belongs to a different execution mode"); }
    let root = request.pointer("/env/NAUTILO_CONNECTION_DIRECTORY").and_then(Value::as_str).map(PathBuf::from)
        .or_else(||std::env::var("AGENTHUB_DATA_DIR").ok().map(PathBuf::from))
        .unwrap_or_else(||agenthub_plugin_sdk::native_config::home(&HashMap::new()).join(".nautilo"));
    let directory = root.join("trae-agent").join(&id);
    let bridge = directory.join("bridge");
    std::fs::create_dir_all(&bridge)?;
    let code = include_str!("../../../../packages/provider-plugin-trae/resources/sitecustomize.py");
    let script = bridge.join("sitecustomize.py");
    if std::fs::read_to_string(&script).ok().as_deref() != Some(code) { std::fs::write(script, code)?; }
    let images: Vec<_> = agenthub_plugin_sdk::images::read_request_images(request)?.into_iter().map(|image|image.path.to_string_lossy().into_owned()).collect();
    if !request["env"].is_object() { request["env"] = json!({}); }
    let mut paths = vec![bridge];
    if let Some(path) = request["env"]["PYTHONPATH"].as_str() { paths.extend(std::env::split_paths(path)); }
    request["env"]["PYTHONPATH"] = json!(std::env::join_paths(paths)?.to_string_lossy());
    request["env"]["NAUTILO_TRAE_BRIDGE"] = json!("1");
    request["env"]["NAUTILO_TRAE_STATE"] = json!(directory.join("conversation.json").to_string_lossy());
    request["env"]["NAUTILO_TRAE_SESSION_ID"] = json!(session);
    request["env"]["NAUTILO_TRAE_RESUME"] = json!(if resume.is_some() {"1"} else {"0"});
    request["env"]["NAUTILO_TRAE_IMAGES"] = json!(serde_json::to_string(&images)?);
    request["env"]["NAUTILO_TRAE_MCP_SERVERS"] = json!(request["mcpServers"].to_string());
    request["env"]["NAUTILO_TRAE_TRAJECTORY"] = json!(directory.join("trajectory.json").to_string_lossy());
    if let Some(effort) = request["reasoningEffort"].as_str().map(str::to_string) { request["env"]["NAUTILO_TRAE_EFFORT"] = json!(effort); }
    Ok(())
}

fn prepare_open_source_connection(request: &mut Value) -> anyhow::Result<()> {
    if request.pointer("/instance/providerOptions/runtimeConnectionId").is_none() { return Ok(()) }
    let root = request.pointer("/env/NAUTILO_CONNECTION_DIRECTORY").and_then(Value::as_str).ok_or_else(||anyhow::anyhow!("API connection directory is missing"))?;
    let session = request["localSessionId"].as_str().unwrap_or("default");
    anyhow::ensure!(!session.is_empty() && session.chars().all(|c|c.is_ascii_alphanumeric() || c=='-' || c=='_'), "Invalid session identity");
    let directory = std::path::PathBuf::from(root).join("trae-agent").join(session);
    std::fs::create_dir_all(&directory)?;
    let base = request.pointer("/instance/providerOptions/baseUrl").and_then(Value::as_str).unwrap_or("").trim_end_matches('/');
    let base = json!(base.strip_suffix("/v1").unwrap_or(base));
    // The plugin declares the native Anthropic wire; the host supplies a local
    // bridge when the saved connection speaks Chat or Responses.
    let config = open_source_configuration(request, base.clone())?;
    let file = directory.join("trae_config.yaml");
    std::fs::write(&file,serde_json::to_string_pretty(&config)?)?;
    request["env"]["TRAE_CONFIG_FILE"] = json!(file.to_string_lossy());
    request["env"]["NAUTILO_TRAE_TRAJECTORY"] = json!(directory.join("trajectory.json").to_string_lossy());
    request["env"]["ANTHROPIC_BASE_URL"] = base;
    request["env"]["ANTHROPIC_API_KEY"] = request["env"]["NAUTILO_CONNECTION_API_KEY"].clone();
    Ok(())
}

fn open_source_configuration(request: &Value, base: Value) -> anyhow::Result<Value> {
    use std::path::PathBuf;
    let cwd = PathBuf::from(request["cwd"].as_str().unwrap_or("."));
    let explicit = request.pointer("/env/TRAE_CONFIG_FILE").and_then(Value::as_str);
    let source = explicit.map(|path| {let path=PathBuf::from(path);if path.is_absolute(){path}else{cwd.join(path)}})
        .or_else(||["trae_config.yaml", "trae_config.yml", "trae_config.json"].iter().map(|name|cwd.join(name)).find(|path|path.exists()));
    let mut config: Value = if let Some(path) = source {
        let text = std::fs::read_to_string(path)?;
        serde_yaml::from_str(&text).map_err(|_|anyhow::anyhow!("Unable to parse the native Trae configuration"))?
    } else {json!({})};
    anyhow::ensure!(config.is_object(), "Native Trae configuration must be an object");
    let mut agent = json!({"enable_lakeview":true,"max_steps":200,
        "tools":["bash","str_replace_based_edit_tool","sequentialthinking","task_done"]});
    if let Some(native) = config.pointer("/agents/trae_agent") {agenthub_plugin_sdk::native_config::merge(&mut agent, native.clone());}
    let native_model = agent["model"].as_str().and_then(|name|config["models"].get(name)).cloned().unwrap_or_else(||json!({}));
    let mut model = json!({"max_tokens":16_384,"temperature":0.5,"top_p":1.0,"top_k":0,"parallel_tool_calls":true,"max_retries":1});
    agenthub_plugin_sdk::native_config::merge(&mut model, native_model);
    model["model_provider"] = json!("nautilo"); model["model"] = request["model"].clone();
    agent["model"] = json!("selected");
    for section in ["agents", "model_providers", "models"] {
        if config.get(section).is_none() { config[section] = json!({}); }
        anyhow::ensure!(config[section].is_object(), "Native Trae {section} must be an object");
    }
    config["agents"]["trae_agent"] = agent.clone();
    config["model_providers"]["nautilo"] = json!({"provider":"anthropic","api_key":"","base_url":base});
    config["models"]["selected"] = model;
    if agent["enable_lakeview"] != false {
        if config.get("lakeview").is_none() { config["lakeview"] = json!({}); }
        anyhow::ensure!(config["lakeview"].is_object(), "Native Trae lakeview must be an object");
        config["lakeview"]["model"] = json!("selected");
    }
    Ok(config)
}

/// Versioned native config belongs to this plugin. Never edit the user's
/// Trae profile or place a provider secret in a file or command argument.
fn prepare_connection(request: &mut Value, modern: bool) -> anyhow::Result<()> {
    if request.pointer("/instance/providerOptions/runtimeConnectionId").is_none() { return Ok(()) }
    let root = request.pointer("/env/NAUTILO_CONNECTION_DIRECTORY").and_then(Value::as_str).ok_or_else(||anyhow::anyhow!("API connection directory is missing"))?;
    let session = request["localSessionId"].as_str().unwrap_or("default");
    anyhow::ensure!(!session.is_empty() && session.chars().all(|c|c.is_ascii_alphanumeric() || c=='-' || c=='_'), "Invalid local session identity");
    let home = std::path::PathBuf::from(root).join("trae").join(session);
    let dir = home.join(".trae");
    std::fs::create_dir_all(&dir)?;
    let base = request.pointer("/instance/providerOptions/baseUrl").cloned().unwrap_or(Value::Null);
    let model = request["model"].clone();
    if modern {
        let effort = request["reasoningEffort"].as_str().filter(|v|!v.is_empty()).map(|v|format!("model_reasoning_effort = {}\n",json!(v))).unwrap_or_default();
        std::fs::write(dir.join("traecli.toml"), format!("model = {model}\n{effort}model_provider = \"nautilo\"\n\n[model_providers.nautilo]\nname = \"Nautilo\"\nbase_url = {base}\nenv_key = \"NAUTILO_CONNECTION_API_KEY\"\nwire_api = \"responses\"\n"))?;
    } else {
        let models = request.pointer("/instance/models").and_then(Value::as_array).cloned().unwrap_or_default().iter().filter(|m|m["enabled"]!=false).map(|m|json!({
            "name":format!("nautilo/{}",m["id"].as_str().unwrap_or("")),"context_window":m["contextWindow"].as_u64().unwrap_or(128_000),
            "claude":{"model":m["id"],"base_url":base,"api_key":"${NAUTILO_CONNECTION_API_KEY}","max_tokens":16_384}
        })).collect::<Vec<_>>();
        let alias = format!("nautilo/{}",model.as_str().unwrap_or(""));
        let config = json!({"model":{"name":alias},"models":models,"disable_model_failover":true,"failover_models":[]});
        // JSON is valid YAML and preserves arbitrary model IDs exactly.
        let text = serde_json::to_string_pretty(&config)?;
        std::fs::write(dir.join("traecli.yaml"), &text)?;
        std::fs::write(dir.join("trae_cli.yaml"), &text)?;
        // Early 1.x builds used the roaming config directory instead.
        let roaming = home.join("AppData/Roaming/trae_cli");
        std::fs::create_dir_all(&roaming)?;
        std::fs::write(roaming.join("trae_cli.yaml"), &text)?;
        // Invocation overrides take precedence over project model defaults.
        let mut args = base_args(&request["instance"]);
        args.extend(["-c".into(),format!("model.name={alias}"),"-c".into(),"disable_model_failover=true".into()]);
        request["instance"]["baseArgs"] = json!(args);
        // ACP model values are native aliases, while claude.model and the
        // host's immutable session retain the exact upstream model ID.
        request["model"] = json!(alias);
    }
    request["env"]["HOME"] = json!(home.to_string_lossy());
    request["env"]["USERPROFILE"] = json!(home.to_string_lossy());
    request["env"]["TRAE_HOME"] = json!(dir.to_string_lossy());
    request["env"]["APPDATA"] = json!(home.join("AppData/Roaming").to_string_lossy());
    request["env"]["LOCALAPPDATA"] = json!(home.join("AppData/Local").to_string_lossy());
    request["env"]["XDG_CONFIG_HOME"] = json!(home.join(".config").to_string_lossy());
    Ok(())
}

// ---------------------------------------------------------------- plain CLI

fn trae_cli_args(instance: &Value, request: &Value) -> Vec<String> {
    let mut args = base_args(instance);
    args.push("run".to_string());
    args.push(request.get("prompt").and_then(Value::as_str).unwrap_or("").to_string());
    args.push("--working-dir".to_string());
    args.push(request.get("cwd").and_then(Value::as_str).unwrap_or("").to_string());
    if let Some(path) = request.pointer("/env/NAUTILO_TRAE_TRAJECTORY").and_then(Value::as_str) {
        args.extend(["--trajectory-file".into(),path.into()]);
    }
    if instance.pointer("/providerOptions/runtimeConnectionId").is_some() {
        args.extend(["--provider".into(),"nautilo".into(),"--model".into(),request["model"].as_str().unwrap_or("").into(),
            "--config-file".into(),request["env"]["TRAE_CONFIG_FILE"].as_str().unwrap_or("").into()]);
        return args;
    }
    if let Some(model) = request.get("model").and_then(Value::as_str).map(str::trim).filter(|m| !m.is_empty()) {
        match model.find('/') {
            Some(slash) if slash > 0 => {
                args.push("--provider".to_string());
                args.push(model[..slash].to_string());
                args.push("--model".to_string());
                args.push(model[slash + 1..].to_string());
            }
            _ => {
                args.push("--model".to_string());
                args.push(model.to_string());
            }
        }
    }
    args
}

/// Strips ANSI escapes and trailing panel chrome from trae-cli console output.
fn clean_trae_cli_text(value: &str) -> String {
    let ansi = regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap();
    let plain = ansi.replace_all(value, "");
    plain
        .lines()
        .map(|line| line.trim_end())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

async fn plain_run(instance: &Value, request: &Value, sender: mpsc::UnboundedSender<Value>, runs: &ActiveRuns, run_id: &str) -> anyhow::Result<()> {
    let mut env: HashMap<String, String> = request
        .get("env")
        .and_then(Value::as_object)
        .map(|env| env.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default();
    env.insert("PYTHONUNBUFFERED".to_string(), "1".to_string());
    bypass_loopback_proxy(&mut env);
    env.insert("PYTHONUTF8".to_string(), "1".to_string());
    env.insert("PYTHONIOENCODING".to_string(), "utf-8".to_string());
    let executable = str_of(instance, "executable").filter(|e| !e.is_empty()).unwrap_or_else(|| "trae-cli".to_string());
    let args = trae_cli_args(instance, request);
    let started = process::start(&ProcessRequest {
        command: executable,
        args,
        cwd: request.get("cwd").and_then(Value::as_str).map(str::to_string),
        env: Some(env),
        timeout_ms: request.get("timeoutMs").and_then(Value::as_u64),
        idle_timeout_ms: request.get("idleTimeoutMs").and_then(Value::as_u64),
        max_output_bytes: Some(request.get("maxOutputBytes").and_then(Value::as_u64).map(|v| v as usize).unwrap_or(20 * 1024 * 1024)),
        ..Default::default()
    })?;
    register_process(runs, run_id, started.handle.clone()).await?;
    started.handle.end_stdin();
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut pending = String::new();
    let mut bridge_ready = false;
    let mut streamed_message = false;
    let mut streamed_usage = false;
    let fallback_message_id = format!("trae-cli-message:{run_id}");
    let mut events = started.events;
    while let Some(event) = events.recv().await {
        match event {
            ProcessEvent::Stdout(text) => {
                pending.push_str(&text);
                while let Some(end) = pending.find('\n') {
                    let line: String = pending.drain(..=end).collect();
                    if let Some(frame) = line.trim().strip_prefix("@nautilo-event:") {
                        let event: Value = serde_json::from_str(frame)?;
                        if event["kind"] == "nautilo_ready" { bridge_ready = true; continue; }
                        streamed_message |= event["kind"] == "message";
                        streamed_usage |= event["kind"] == "usage" && event["usageScope"] == "turn";
                        let _ = sender.send(event);
                    } else {
                        stdout.push_str(&line);
                        let _ = sender.send(json!({"kind":"raw","stream":"stdout","text":line}));
                    }
                }
            }
            ProcessEvent::Stderr(text) => {
                stderr.push_str(&text);
                let _ = sender.send(json!({ "kind": "raw", "stream": "stderr", "text": text }));
            }
            ProcessEvent::Exit { exit_code, .. } => {
                let text = clean_trae_cli_text(&stdout);
                if exit_code == Some(0) {
                    anyhow::ensure!(bridge_ready, "Trae did not load the conversation bridge; check that the configured executable uses the native Python environment");
                    if let Some(path) = request.pointer("/env/NAUTILO_TRAE_TRAJECTORY").and_then(Value::as_str) {
                        let trajectory: Value = serde_json::from_slice(&std::fs::read(path)?)?;
                        anyhow::ensure!(trajectory["success"]==true,"Trae Agent did not complete the task; check the configured model and execution result");
                        let answer = trajectory["final_result"].as_str().or_else(||trajectory["llm_interactions"].as_array()?.iter().rev().find_map(|i|i["response"]["content"].as_str())).unwrap_or("");
                        anyhow::ensure!(!answer.trim().is_empty(),"Trae Agent returned no assistant response");
                        if !streamed_message { let _ = sender.send(json!({"kind":"message","phase":"completed","messageId":fallback_message_id,"text":answer})); }
                        if !streamed_usage {
                            for event in trajectory_usage(&trajectory) {
                                let _ = sender.send(event);
                            }
                        }
                    } else if !text.is_empty() {
                        let _ = sender.send(json!({ "kind": "message", "phase": "completed", "messageId": fallback_message_id, "text": text }));
                    }
                    let _ = sender.send(json!({ "kind": "status", "phase": "turn_completed" }));
                } else {
                    let detail = {
                        let cleaned = clean_trae_cli_text(&stderr);
                        if !cleaned.is_empty() {
                            cleaned
                        } else if !text.is_empty() {
                            text
                        } else {
                            format!("trae-cli exited with {}", exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()))
                        }
                    };
                    let _ = sender.send(json!({ "kind": "status", "phase": "turn_failed" }));
                    // Python prints the exception reason at the end of a
                    // traceback. Preserve that reason rather than only paths.
                    let detail = detail.chars().rev().take(2_000).collect::<String>().chars().rev().collect::<String>();
                    let _ = sender.send(json!({ "kind": "error", "message": detail }));
                }
                let _ = sender.send(json!({ "kind": "exit", "exitCode": exit_code }));
                return Ok(());
            }
            ProcessEvent::Error(message) => {
                let _ = sender.send(json!({ "kind": "error", "message": message }));
            }
            ProcessEvent::Timeout { reason } => {
                let _ = sender.send(json!({ "kind": "timeout", "reason": reason }));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- ACP transport

#[derive(Default)]
struct TraeAcpParseState {
    message_id: String,
    thinking_id_prefix: String,
    thinking_sequence: usize,
    thinking_id: Option<String>,
    tool_names: HashMap<String, String>,
    tool_calls: HashMap<String, Value>,
}

impl TraeAcpParseState {
    fn new(run_id: &str) -> Self {
        Self {
            message_id: format!("trae-message:{run_id}"),
            thinking_id_prefix: format!("trae-thinking:{run_id}"),
            ..Default::default()
        }
    }

    fn open_thinking(&mut self) -> &str {
        self.thinking_id.get_or_insert_with(|| {
            self.thinking_sequence += 1;
            format!("{}:{}", self.thinking_id_prefix, self.thinking_sequence)
        })
    }

    fn finish_thinking(&mut self) -> Option<Value> {
        self.thinking_id.take().map(|id| {
            json!({"kind":"thinking","phase":"completed","messageId":id,"text":""})
        })
    }

    fn after_thinking(&mut self, event: Value) -> Vec<Value> {
        self.finish_thinking().into_iter().chain([event]).collect()
    }
}

fn trajectory_usage(trajectory: &Value) -> Vec<Value> {
    let mut turn = agenthub_plugin_sdk::usage::TurnUsage::default();
    let mut last = None;
    let mut total = None;
    for (index, call) in trajectory["llm_interactions"].as_array().into_iter().flatten().enumerate() {
        let usage = &call["response"]["usage"];
        let input = usage["input_tokens"].as_u64();
        let output = usage["output_tokens"].as_u64();
        if input.is_none() && output.is_none() { continue; }
        let read = usage["cache_read_input_tokens"].as_u64();
        let write = usage["cache_creation_input_tokens"].as_u64();
        let uncached = match call["provider"].as_str() {
            Some("openai") => input.zip(read).and_then(|(input, read)| input.checked_sub(read)),
            Some("anthropic") => input,
            _ => None,
        };
        let context = uncached.zip(read).zip(write)
            .and_then(|((input, read), write)| input.checked_add(read)?.checked_add(write));
        let request = json!({"kind":"usage","usageScope":"context","inputTokensIncludesCache":false,
            "inputTokens":uncached,"outputTokens":output,"cachedInputTokens":read,"cacheCreationInputTokens":write,
            "reasoningOutputTokens":usage["reasoning_tokens"],"contextUsed":context});
        total = Some(turn.update(&index.to_string(), &request));
        last = Some(request);
    }
    last.into_iter().chain(total).collect()
}

#[test]
fn trajectory_normalizes_openai_and_anthropic_cache_buckets() {
    let events = trajectory_usage(&json!({"llm_interactions":[
        {"provider":"openai","response":{"usage":{"input_tokens":100,"output_tokens":5,"cache_read_input_tokens":80,"cache_creation_input_tokens":0}}},
        {"provider":"anthropic","response":{"usage":{"input_tokens":10,"output_tokens":3,"cache_read_input_tokens":60,"cache_creation_input_tokens":5}}}
    ]}));
    assert_eq!(events[0]["contextUsed"], 75);
    assert_eq!(events[1]["inputTokens"], 30);
    assert_eq!(events[1]["cachedInputTokens"], 140);
    assert_eq!(events[1]["cacheCreationInputTokens"], 5);
    assert!(trajectory_usage(&Value::Null).is_empty());
}

/// The ACP transport survives foreground prompts. The SDK reader keeps framing
/// stdout for this process; an idle reader drains notifications between turns.
struct AcpResident {
    rpc: Arc<JsonRpcClient>,
    process: Option<ProcessHandle>,
    session_id: Option<String>,
    idle_reader: Option<tokio::task::JoinHandle<()>>,
    output: Arc<Mutex<AcpOutput>>,
    tools: Option<RuntimeTools>,
}

struct AcpOutput { bytes: usize, max: usize }

fn acp_output_limit(request: &Value) -> usize {
    request["maxOutputBytes"].as_u64()
        .map(|limit| usize::try_from(limit).unwrap_or(usize::MAX))
        .unwrap_or(256 * 1024 * 1024)
}

impl AcpResident {
    fn new(started: process::StartedProcess, max: usize) -> Self {
        let process = started.handle;
        let kill = process.clone();
        let mut events = started.events;
        let (tx, rx) = mpsc::unbounded_channel();
        let output = Arc::new(Mutex::new(AcpOutput { bytes: 0, max }));
        let budget = output.clone();
        // Limit actual process bytes before the JSON reader can accumulate an
        // unterminated line. A resident worker resets the count on each turn.
        tokio::spawn(async move {
            let mut exceeded = false;
            while let Some(event) = events.recv().await {
                if let ProcessEvent::Stdout(text) | ProcessEvent::Stderr(text) = &event {
                    if exceeded { continue; }
                    exceeded = {
                        let mut budget = budget.lock().unwrap();
                        budget.bytes = budget.bytes.saturating_add(text.len());
                        budget.bytes > budget.max
                    };
                    if exceeded {
                        let _ = tx.send(ProcessEvent::Timeout { reason: "max_output".into() });
                        kill.cancel().await;
                        continue;
                    }
                }
                if tx.send(event).is_err() { break; }
            }
        });
        let rpc = Arc::new(JsonRpcClient::new(process.clone(), rx));
        Self { rpc, process: Some(process), session_id: None, idle_reader: None, output, tools:None }
    }

    fn handle(&self) -> Option<&ProcessHandle> { self.process.as_ref() }

    fn begin_budget(&self, max: usize) {
        *self.output.lock().unwrap() = AcpOutput { bytes: 0, max };
    }

    fn exceeded_output(&self) -> bool {
        let output = self.output.lock().unwrap();
        output.bytes > output.max
    }

    fn start_idle_reader(&mut self) {
        self.begin_budget(256 * 1024 * 1024);
        let rpc = self.rpc.clone();
        self.idle_reader = Some(tokio::spawn(async move {
            // ACP updates belong to the outstanding session/prompt. An
            // unlabelled update outside it must not start the next reply.
            while let Some(event) = rpc.next_event().await {
                if !discard_idle_event(&rpc, event) { break; }
            }
        }));
    }

    async fn stop_idle_reader(&mut self) {
        if let Some(reader) = self.idle_reader.take() {
            reader.abort();
            let _ = reader.await;
        }
    }

    async fn close(mut self) {
        self.stop_idle_reader().await;
        if let Some(process) = self.process.as_ref() {
            process.end_stdin();
            if tokio::time::timeout(Duration::from_millis(900), process.wait()).await.is_err() {
                process.cancel().await;
            }
        }
        self.process.take();
    }
}

impl Drop for AcpResident {
    fn drop(&mut self) {
        if let Some(reader) = self.idle_reader.take() { reader.abort(); }
        if let Some(process) = self.process.take() {
            // A deadline can drop an in-progress setup or prompt future.
            tokio::spawn(async move { process.cancel().await; });
        }
    }
}

fn discard_idle_event(rpc: &JsonRpcClient, event: JsonRpcEvent) -> bool {
    match event {
        JsonRpcEvent::Request { id, method, .. } => match method.as_str() {
            "session/request_permission" => rpc.respond(&id, json!({"outcome":{"outcome":"cancelled"}})),
            "elicitation/create" => rpc.respond(&id, json!({"action":"cancel"})),
            _ => rpc.respond_error(&id, -32601, &format!("Nautilo does not support ACP request {method}")),
        },
        JsonRpcEvent::Transport(ProcessEvent::Exit { .. }) => return false,
        _ => {}
    }
    true
}

async fn next_acp_event(rpc: &JsonRpcClient, idle: Duration) -> anyhow::Result<Option<JsonRpcEvent>> {
    let event = tokio::time::timeout(idle, rpc.next_event()).await.map_err(|_| AcpLimit("idle"))?;
    if matches!(&event, Some(JsonRpcEvent::Transport(ProcessEvent::Timeout { reason })) if reason == "max_output") {
        return Err(AcpLimit("max_output").into());
    }
    Ok(event)
}

#[derive(Debug)]
struct AcpLimit(&'static str);
impl std::fmt::Display for AcpLimit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Trae ACP exceeded its per-turn {} limit", self.0)
    }
}
impl std::error::Error for AcpLimit {}

#[allow(clippy::too_many_arguments)]
async fn run_acp_turn(
    request: &Value,
    resume: Option<String>,
    sender: mpsc::UnboundedSender<Value>,
    interactions: Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>,
    runs: &ActiveRuns,
    run_id: &str,
    pool: &SessionPool<AcpResident>,
    key: Option<String>,
    identity: Value,
    mut worker: Option<AcpResident>,
    launch: Option<(&Value, &str)>,
    tools: Option<RuntimeTools>,
) -> anyhow::Result<()> {
    let total = Duration::from_millis(request["timeoutMs"].as_u64().unwrap_or(30 * 60_000));
    let operation = execute_acp_turn(request, resume, &sender, interactions, runs, run_id, &mut worker, launch);
    let result = tokio::time::timeout(total, operation).await.unwrap_or_else(|_| Err(AcpLimit("timeout").into()));
    let exit_code = match result {
        Ok(code) => code,
        Err(error) => {
            if let Some(worker) = worker.take() { worker.close().await; }
            if let Some(limit) = error.downcast_ref::<AcpLimit>() {
                let _ = sender.send(json!({"kind":"timeout","reason":limit.0}));
            }
            return Err(error);
        }
    };
    if let Some(mut worker) = worker {
        if tools.is_some() {worker.tools=tools;}
        if let Some(tools) = &worker.tools {tools.suspend();}
        {
            let mut active = runs.lock().unwrap();
            if let Some(key) = key.filter(|_| exit_code == 0 && !sender.is_closed() && worker.handle().is_some_and(ProcessHandle::is_alive)) {
                if active.remove(run_id).is_some() {
                    // Keep put/retire atomic with removal from the active map.
                    worker.start_idle_reader();
                    pool.put(key, identity, worker);
                    let _ = sender.send(json!({"kind":"exit","exitCode":0}));
                    return Ok(());
                }
            }
        }
        worker.close().await;
    }
    let _ = sender.send(json!({"kind":"exit","exitCode":exit_code}));
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn execute_acp_turn(
    request: &Value,
    resume: Option<String>,
    sender: &mpsc::UnboundedSender<Value>,
    interactions: Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>,
    runs: &ActiveRuns,
    run_id: &str,
    worker: &mut Option<AcpResident>,
    launch: Option<(&Value, &str)>,
) -> anyhow::Result<i32> {
    let reused = worker.is_some();
    let max = acp_output_limit(request);
    let idle = Duration::from_millis(request["idleTimeoutMs"].as_u64().unwrap_or(30 * 60_000));
    if let Some(worker) = worker.as_ref() { worker.begin_budget(max); }
    if let Some((instance, fallback)) = launch {
        let mut env: HashMap<String, String> = request
            .get("env").and_then(Value::as_object)
            .map(|env| env.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
            .unwrap_or_default();
        env.insert("PYTHONUNBUFFERED".to_string(), "1".to_string());
        bypass_loopback_proxy(&mut env);
        let executable = str_of(instance, "executable").filter(|e| !e.is_empty()).unwrap_or_else(|| "traecli".to_string());
        let cwd = request.get("cwd").and_then(Value::as_str);
        let spawn = |entry: &[&str]| {
            let mut args = base_args(instance);
            args.extend(entry.iter().map(|s| s.to_string()));
            // All limits are enforced for each ACP turn, not against the age
            // of the resident CLI process.
            process::start(&ProcessRequest { command: executable.clone(), args, cwd: cwd.map(str::to_string),
                env: Some(env.clone()), ..Default::default() }).map(|started| AcpResident::new(started, max))
        };
        let initialize = json!({
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": { "readTextFile": false, "writeTextFile": false },
                "elicitation": if interactions.is_some() { json!({"form": {}}) } else { Value::Null }
            },
            "clientInfo": { "name": "Nautilo", "version": "0.1.0" }
        });
        *worker = Some(spawn(&["acp", "serve"])?);
        register_process(runs, run_id, worker.as_ref().unwrap().handle().unwrap().clone()).await?;
        if let Err(primary) = initialize_acp(&worker.as_ref().unwrap().rpc, &initialize).await {
            if worker.as_ref().unwrap().exceeded_output() { return Err(AcpLimit("max_output").into()); }
            worker.take().unwrap().close().await;
            *worker = Some(spawn(&[fallback])?);
            register_process(runs, run_id, worker.as_ref().unwrap().handle().unwrap().clone()).await?;
            if let Err(fallback_error) = initialize_acp(&worker.as_ref().unwrap().rpc, &initialize).await {
                if worker.as_ref().unwrap().exceeded_output() { return Err(AcpLimit("max_output").into()); }
                anyhow::bail!("TRAE CLI ACP 启动失败（acp serve: {primary}；{fallback}: {fallback_error}）");
            }
        }
        let worker = worker.as_mut().unwrap();
        let rpc = &worker.rpc;
        let session_method = if resume.is_some() { "session/load" } else { "session/new" };
        let mcp_servers = acp_mcp_servers(request);
        let session_params = match &resume {
            Some(session) => json!({ "sessionId": session, "cwd": cwd, "mcpServers": mcp_servers }),
            None => json!({ "cwd": cwd, "mcpServers": mcp_servers }),
        };
        let (session_request_id, session_result) = rpc.request_with_id(session_method, session_params);
        drop(session_result);
        // session/load replays history before responding. It is never the
        // output of the new prompt. Handle genuine setup requests separately.
        let response = loop {
            match next_acp_event(rpc, idle).await? {
                Some(JsonRpcEvent::Response { id, result, error }) if same_id(&id, &json!(session_request_id)) => {
                    if let Some(error) = error { anyhow::bail!(acp_error_message(&error)); }
                    break result.ok_or_else(|| anyhow::anyhow!("Trae ACP {session_method} returned no result"))?;
                }
                Some(JsonRpcEvent::Request { id, method, params }) => {
                    tokio::select! {
                        _ = worker.handle().unwrap().wait() => anyhow::bail!("TRAE CLI ACP closed during {session_method}"),
                        _ = answer_acp_request(rpc, &id, &method, &params, &interactions, run_id) => {}
                    }
                }
                Some(JsonRpcEvent::Transport(ProcessEvent::Exit { .. })) | None => {
                    anyhow::bail!("TRAE CLI ACP closed before {session_method} completed");
                }
                Some(_) => {}
            }
        };
        let session_id = response["sessionId"].as_str().filter(|id| !id.is_empty()).map(str::to_string).or(resume);
        let Some(session_id) = session_id else { anyhow::bail!("TRAE CLI ACP did not return a session id"); };
        let _ = sender.send(json!({"kind":"session","providerSessionId":session_id}));
        if let Err(error) = apply_acp_config(rpc, &session_id, &response, request).await {
            if worker.exceeded_output() { return Err(AcpLimit("max_output").into()); }
            return Err(error);
        }
        worker.session_id = Some(session_id);
    }

    let worker = worker.as_ref().ok_or_else(|| anyhow::anyhow!("TRAE CLI ACP process is missing"))?;
    let process = worker.handle().unwrap();
    let rpc = &worker.rpc;
    let session_id = worker.session_id.as_deref().unwrap();
    if reused {
        register_process(runs, run_id, process.clone()).await?;
    }
    // Close the small handoff gap after stopping the previous idle reader.
    // Do not spend a timer tick here if the queue is already empty.
    while let Ok(Some(event)) = tokio::time::timeout(Duration::ZERO, rpc.next_event()).await {
        if !discard_idle_event(rpc, event) { anyhow::bail!("TRAE CLI ACP exited before the next prompt"); }
    }
    anyhow::ensure!(process.is_alive(), "TRAE CLI ACP exited before the next prompt");
    if reused { let _ = sender.send(json!({"kind":"session","providerSessionId":session_id})); }
    let _ = sender.send(json!({"kind":"status","phase":"runtime_ready",
        "raw":{"providerId":"trae","transport":"acp","reused":reused,"pid":process.pid}}));
    let prompt = agenthub_plugin_sdk::images::acp_prompt(request)?;
    let (cancel, mut cancelled) = watch::channel(false);
    let prompt_id = {
        let mut active = runs.lock().unwrap();
        let Some(entry) = active.get_mut(run_id).and_then(|run| run.process.as_mut()) else { return Ok(130); };
        // Queue the prompt before cancellation can address this session.
        let (id, _) = rpc.request_with_id("session/prompt", json!({"sessionId":session_id,"prompt":prompt}));
        entry.prompt = Some((session_id.to_string(), cancel));
        id
    };
    let _ = sender.send(json!({"kind":"status","phase":"turn_started"}));
    let mut state = TraeAcpParseState::new(run_id);
    let mut message_streamed = false;

    while let Some(event) = next_acp_event(rpc, idle).await? {
        match event {
            JsonRpcEvent::Notification { method, params } if method == "session/update" && params["sessionId"].as_str().is_none_or(|id| id == session_id) => {
                let update = params.get("update").cloned().unwrap_or(Value::Null);
                for item in parse_trae_acp_update(&update, &mut state) {
                    message_streamed |= item["kind"] == "message";
                    if sender.send(item).is_err() { return Ok(130); }
                }
            }
            JsonRpcEvent::Request { id, method, params } => {
                if params["sessionId"].as_str().is_some_and(|id| id != session_id) {
                    rpc.respond_error(&id, -32602, "Unexpected TRAE session ID");
                    continue;
                }
                tokio::select! {
                    biased;
                    _ = cancelled.wait_for(|value| *value) => {
                        match method.as_str() {
                            "session/request_permission" => rpc.respond(&id, json!({"outcome":{"outcome":"cancelled"}})),
                            "elicitation/create" => rpc.respond(&id, json!({"action":"cancel"})),
                            _ => rpc.respond_error(&id, -32601, &format!("Nautilo does not support ACP request {method}")),
                        }
                    }
                    _ = process.wait() => break,
                    _ = answer_acp_request(rpc, &id, &method, &params, &interactions, run_id) => {}
                }
            }
            JsonRpcEvent::Response { id, result, error } if same_id(&id, &json!(prompt_id)) => {
                if message_streamed {
                    let _ = sender.send(json!({"kind":"message","phase":"completed","messageId":state.message_id,"text":""}));
                }
                if let Some(thinking) = state.finish_thinking() {
                    let _ = sender.send(thinking);
                }
                if let Some(usage) = result.as_ref().and_then(|value| agenthub_plugin_sdk::usage::acp_prompt_usage(&value["usage"])) {
                    let _ = sender.send(usage);
                }
                let was_cancelled = *cancelled.borrow() || result.as_ref().is_some_and(|result| result["stopReason"] == "cancelled");
                let phase = if was_cancelled { "turn_cancelled" } else if error.is_some() { "turn_failed" } else { "turn_completed" };
                let _ = sender.send(json!({"kind":"status","phase":phase}));
                let exit_code = if was_cancelled { 130 } else { i32::from(error.is_some()) };
                if let Some(error) = error.filter(|_| !was_cancelled) {
                    let message = if error.to_string().contains("keyring") && request.pointer("/instance/providerOptions/runtimeConnectionId").is_some() {
                        "当前安装的 Trae CLI 在执行自定义 API 前仍要求原生登录，但没有找到其登录凭据。请完成此 CLI 的登录，或为 Trae 插件指定支持直接 API 的 trae-agent 可执行文件。".to_string()
                    } else { acp_error_message(&error) };
                    let _ = sender.send(json!({"kind":"error","message":message}));
                }
                return Ok(exit_code);
            }
            JsonRpcEvent::Transport(ProcessEvent::Stdout(text)) => {
                let _ = sender.send(json!({"kind":"raw","stream":"stdout","text":text}));
            }
            JsonRpcEvent::Transport(ProcessEvent::Stderr(text)) => {
                let _ = sender.send(json!({"kind":"raw","stream":"stderr","text":text}));
            }
            JsonRpcEvent::Transport(ProcessEvent::Exit { exit_code, .. }) => {
                if *cancelled.borrow() { break; }
                anyhow::bail!("TRAE CLI ACP exited before session/prompt completed (exit code: {exit_code:?})");
            }
            JsonRpcEvent::Transport(ProcessEvent::Error(message)) => {
                let _ = sender.send(json!({"kind":"error","message":message}));
            }
            JsonRpcEvent::Transport(ProcessEvent::Timeout { reason }) => {
                let _ = sender.send(json!({"kind":"timeout","reason":reason}));
            }
            _ => {}
        }
    }
    if *cancelled.borrow() { return Ok(130); }
    anyhow::bail!("TRAE CLI ACP closed before session/prompt completed")
}

async fn initialize_acp(rpc: &JsonRpcClient, initialize: &Value) -> anyhow::Result<()> {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        rpc.request("initialize", initialize.clone()),
    ).await;
    let result = match result {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            let diagnostic = tokio::time::timeout(std::time::Duration::from_millis(100), async {
                while let Some(event) = rpc.next_event().await {
                    if let JsonRpcEvent::Transport(ProcessEvent::Stderr(text)) = event {
                        if let Some(hint) = acp_startup_hint(&text) { return Some(hint); }
                    }
                }
                None
            }).await.ok().flatten();
            anyhow::bail!("{}", diagnostic.map(str::to_owned).unwrap_or_else(|| error.to_string()));
        }
        Err(_) => anyhow::bail!("ACP 握手超时"),
    };
    anyhow::ensure!(result["protocolVersion"] == initialize["protocolVersion"], "TRAE CLI 返回了不兼容的 ACP 协议版本");
    Ok(())
}

fn acp_startup_hint(stderr: &str) -> Option<&'static str> {
    if stderr.contains("Profile config file") && stderr.contains("does not exist") {
        Some("TRAE CLI 找不到命名配置档。请检查 Harness 的 --profile 参数和 TRAE_HOME 下对应的 .traecli.toml 文件。")
    } else if stderr.contains("TRAE_HOME points to") && stderr.contains("does not exist") {
        Some("TRAE_HOME 指向的目录不存在。请检查 TRAE CLI 的企业配置目录。")
    } else {
        None
    }
}

fn acp_error_message(error: &Value) -> String {
    let message = error["message"].as_str().or_else(|| error.as_str());
    if message.is_some_and(|message| message.eq_ignore_ascii_case("Authentication required")) {
        return "TRAE CLI 需要企业账号登录。请在终端使用此 Harness 配置的 TRAE CLI 登录，再回到 Nautilo 重试。TRAE CLI 2.0 可用 `traecli login status` 查看登录状态。".into();
    }
    message.map(str::to_owned).unwrap_or_else(|| error.to_string())
}

fn same_id(left: &Value, right: &Value) -> bool {
    left == right
}

fn acp_mcp_servers(request: &Value) -> Vec<Value> {
    let mut servers = vec![];
    for server in request.get("mcpServers").and_then(Value::as_array).cloned().unwrap_or_default() {
        let transport = server.get("transport").and_then(Value::as_str).unwrap_or("");
        let name = server.get("name").and_then(Value::as_str).unwrap_or("mcp");
        if transport == "http" {
            if let Some(url) = server.get("url").and_then(Value::as_str) {
                let headers: Vec<Value> = server
                    .get("headers")
                    .and_then(Value::as_object)
                    .map(|h| h.iter().map(|(name, value)| json!({ "name": name, "value": value })).collect())
                    .unwrap_or_default();
                servers.push(json!({ "type": "http", "name": name, "url": url, "headers": headers }));
            }
        } else if transport == "stdio" {
            if let Some(command) = server.get("command").and_then(Value::as_str) {
                let env: Vec<Value> = server
                    .get("env")
                    .and_then(Value::as_object)
                    .map(|e| e.iter().map(|(name, value)| json!({ "name": name, "value": value })).collect())
                    .unwrap_or_default();
                servers.push(json!({
                    "name": name,
                    "command": command,
                    "args": server.get("args").cloned().unwrap_or_else(|| json!([])),
                    "env": env
                }));
            }
        }
    }
    servers
}

/// Applies session model / reasoning effort through ACP configOptions.
async fn apply_acp_config(rpc: &JsonRpcClient, session_id: &str, response: &Value, request: &Value) -> anyhow::Result<()> {
    let mut options = response.get("configOptions").and_then(Value::as_array).cloned().unwrap_or_default();
    for (key, category) in [("model", "model"), ("reasoningEffort", "thought_level")] {
        let Some(value) = request[key].as_str().filter(|v| !v.is_empty()) else { continue };
        let option = acp_config_option(&options, category);
        if option.is_some_and(|option| option["currentValue"] == value) { continue; }
        if let Some(id) = option.and_then(|o| o.get("id")).and_then(Value::as_str) {
            let result = rpc
                .request("session/set_config_option", json!({ "sessionId": session_id, "configId": id, "value": value }))
                .await.map_err(|error| anyhow::anyhow!("Trae rejected {id}={value}: {error}"))?;
            if let Some(updated) = result["configOptions"].as_array() { options = updated.clone(); }
        } else {
            let is_model = category == "model";
            let marker = if is_model {"NAUTILO_BRIDGE_MODEL"} else {"NAUTILO_BRIDGE_EFFORT"};
            if request["env"][marker].as_str() == Some(value) { continue; }
            if is_model && response.pointer("/models/currentModelId").and_then(Value::as_str) == Some(value) { continue; }
            if is_model && response.pointer("/models/availableModels").and_then(Value::as_array)
                .is_some_and(|models|models.iter().any(|model|model["modelId"] == value)) {
                rpc.request("session/set_model",json!({"sessionId":session_id,"modelId":value})).await?;
            } else {
                anyhow::bail!("Trae did not advertise a way to apply {}={value}", if is_model {"model"} else {"reasoning effort"});
            }
        }
    }
    Ok(())
}

fn acp_config_option<'a>(options: &'a [Value], category: &str) -> Option<&'a Value> {
    options.iter().find(|item| item["category"] == category).or_else(|| {
        options.iter().filter(|item| {
            !matches!(item["category"].as_str(), Some("model" | "model_config" | "mode" | "thought_level"))
        }).find(|item| {
            let names = ["id", "name", "label"].map(|key| item[key].as_str().unwrap_or("").to_ascii_lowercase());
            if category == "model" {
                names.iter().any(|name| name == "model")
            } else {
                names.iter().any(|name| ["thinking", "reasoning", "effort"].iter().any(|hint| name.contains(hint)))
            }
        })
    })
}

async fn answer_acp_request(
    rpc: &JsonRpcClient,
    id: &Value,
    method: &str,
    params: &Value,
    interactions: &Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>,
    run_id: &str,
) {
    if method == "session/request_permission" {
        answer_acp_permission(rpc, id, params, interactions, run_id).await;
    } else if method == "elicitation/create" && params["mode"].as_str().unwrap_or("form") == "form" {
        let Some(channel) = interactions else {
            rpc.respond_error(id, -32601, "Nautilo has no active question channel");
            return;
        };
        let input = match agenthub_plugin_sdk::acp_form::form(params, "TRAE 提问") {
            Ok(input) => input,
            Err(error) => { rpc.respond_error(id, -32602, &error.to_string()); return; }
        };
        let reply = channel.ask(run_id, input).await;
        match agenthub_plugin_sdk::acp_form::form_answer(params, &reply) {
            Ok(result) => rpc.respond(id, result),
            Err(error) => rpc.respond_error(id, -32602, &error.to_string()),
        }
    } else {
        rpc.respond_error(id, -32601, &format!("Nautilo does not support ACP request {method}"));
    }
}

async fn answer_acp_permission(
    rpc: &JsonRpcClient,
    id: &Value,
    params: &Value,
    interactions: &Option<Arc<dyn agenthub_plugin_sdk::InteractionChannel>>,
    run_id: &str,
) {
    let options = params.get("options").and_then(Value::as_array).cloned().unwrap_or_default();
    if let Some(channel) = interactions {
        let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let detail = tool_call
            .get("rawInput")
            .map(|input| serde_json::to_string_pretty(input).unwrap_or_default().chars().take(4_000).collect::<String>());
        let mapped_options: Vec<Value> = options
            .iter()
            .filter_map(|option| {
                let option_id = option
                    .get("optionId")
                    .and_then(Value::as_str)
                    .or_else(|| option.get("id").and_then(Value::as_str))?;
                Some(json!({
                    "id": option_id,
                    "label": option.get("name").and_then(Value::as_str)
                        .or_else(|| option.get("label").and_then(Value::as_str))
                        .unwrap_or(option_id),
                    "intent": if option["kind"].as_str().is_some_and(|kind| kind.starts_with("reject")) { "reject" } else { "approve" }
                }))
            })
            .collect();
        let response = channel
            .ask(
                run_id,
                json!({
                    "kind": "approval",
                    "title": tool_call.get("title").and_then(Value::as_str).unwrap_or("Trae permission"),
                    "detail": detail.map(Value::String).unwrap_or(Value::Null),
                    "options": &mapped_options
                }),
            )
            .await;
        if response.get("outcome").and_then(Value::as_str) == Some("selected") {
            if let Some(option_id) = response["optionId"].as_str().filter(|id| mapped_options.iter().any(|option| option["id"] == *id)) {
                rpc.respond(id, json!({ "outcome": { "outcome": "selected", "optionId": option_id } }));
                return;
            }
        }
    }
    rpc.respond(id, json!({ "outcome": { "outcome": "cancelled" } }));
}

// ---------------------------------------------------------------- ACP parsing

const TOOL_INPUT_IDENTITY_KEYS: [&str; 8] =
    ["path", "file_path", "filePath", "target_path", "targetPath", "query", "pattern", "glob"];

fn printable(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
        Value::String(_) => None,
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(printable).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
                return Some(text.to_string());
            }
            if let Some(content) = map.get("content") {
                if let Some(nested) = printable(content) {
                    return Some(nested);
                }
            }
            serde_json::to_string_pretty(value).ok()
        }
        other => Some(other.to_string()),
    }
}

fn tool_input(value: &Value) -> Value {
    let Some(source) = value.as_object() else {
        return value.clone();
    };
    let mut prioritized = Map::new();
    for key in TOOL_INPUT_IDENTITY_KEYS {
        if let Some(entry) = source.get(key) {
            prioritized.insert(key.to_string(), entry.clone());
        }
    }
    for (key, entry) in source {
        if !prioritized.contains_key(key) {
            prioritized.insert(key.clone(), entry.clone());
        }
    }
    Value::Object(prioritized)
}

fn merge_tool_input(previous: Option<&Value>, current: &Value) -> Value {
    match (previous, current.as_object()) {
        (Some(Value::Object(prev)), Some(curr)) => {
            let mut merged = prev.clone();
            for (key, entry) in curr {
                merged.insert(key.clone(), entry.clone());
            }
            tool_input(&Value::Object(merged))
        }
        _ => current.clone(),
    }
}

fn tool_input_identity(value: &Value) -> Option<String> {
    let input = value.as_object()?;
    let identity: Vec<(String, String)> = TOOL_INPUT_IDENTITY_KEYS
        .iter()
        .filter_map(|key| {
            let entry = input.get(*key)?.as_str()?.trim();
            if entry.is_empty() {
                None
            } else {
                Some((key.to_string(), entry.to_string()))
            }
        })
        .collect();
    if identity.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&identity).unwrap_or_default())
    }
}

fn first_string(input: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| input.get(*key).and_then(Value::as_str).map(str::to_string))
}

fn file_diff(tool_name: &str, value: Option<&Value>) -> Option<Value> {
    let normalized: String = tool_name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let is_edit = normalized == "edit"
        || normalized.starts_with("edit_")
        || normalized.starts_with("editing_")
        || normalized.ends_with("_edit")
        || normalized.ends_with("_edit_file");
    let is_write = normalized == "write"
        || normalized.starts_with("write_")
        || normalized.starts_with("writing_")
        || normalized.ends_with("_write")
        || normalized.ends_with("_write_file");
    if !is_edit && !is_write {
        return None;
    }
    let input = value?.as_object()?;
    let path = first_string(input, &TOOL_INPUT_IDENTITY_KEYS.iter().copied().collect::<Vec<_>>());
    let build = |operation: &str, before: &str, after: &str| {
        let mut diff = Map::new();
        diff.insert("operation".to_string(), json!(operation));
        if let Some(path) = &path {
            diff.insert("path".to_string(), json!(path));
        }
        diff.insert("before".to_string(), json!(before));
        diff.insert("after".to_string(), json!(after));
        Value::Object(diff)
    };
    if is_write {
        let content = first_string(input, &["content", "text", "data"])?;
        return Some(build("write", "", &content));
    }
    let before = first_string(input, &["old_string", "oldString", "old_text", "oldText", "before"])?;
    let after = first_string(input, &["new_string", "newString", "new_text", "newText", "after"])?;
    Some(build("edit", &before, &after))
}

/// Parses one ACP `session/update` notification payload (protocol-generic).
fn parse_trae_acp_update(value: &Value, state: &mut TraeAcpParseState) -> Vec<Value> {
    let update_type = value.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
    match update_type {
        "available_commands_update" => {
            let commands: Vec<Value> = value
                .get("availableCommands")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|command| {
                    let name = command.get("name").and_then(Value::as_str)?;
                    let mut mapped = Map::new();
                    mapped.insert("name".to_string(), json!(name));
                    mapped.insert(
                        "description".to_string(),
                        command.get("description").and_then(Value::as_str).map(|d| json!(d)).unwrap_or_else(|| json!(name)),
                    );
                    if let Some(hint) = command.get("input").and_then(|i| i.get("hint")).and_then(Value::as_str) {
                        mapped.insert("inputHint".to_string(), json!(hint));
                    }
                    Some(Value::Object(mapped))
                })
                .collect();
            if commands.is_empty() {
                vec![]
            } else {
                vec![json!({ "kind": "commands", "commands": commands, "raw": value })]
            }
        }
        "usage_update" => vec![json!({
            "kind": "usage",
            "usageScope": "context",
            "contextUsed": value.get("used").cloned().unwrap_or(Value::Null),
            "contextWindow": value.get("size").cloned().unwrap_or(Value::Null),
            "raw": value
        })],
        "agent_message_chunk" => {
            let content = value.get("content").cloned().unwrap_or(Value::Null);
            if content.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(chunk) = content.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    return state.after_thinking(json!({
                        "kind": "message",
                        "phase": "delta",
                        "messageId": state.message_id,
                        "text": chunk,
                        "raw": value
                    }));
                }
            }
            vec![]
        }
        "agent_thought_chunk" => {
            let content = value.get("content").cloned().unwrap_or(Value::Null);
            if content.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(chunk) = content.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    return vec![json!({
                        "kind": "thinking",
                        "phase": "delta",
                        "messageId": state.open_thinking(),
                        "text": chunk,
                        "raw": value
                    })];
                }
            }
            vec![]
        }
        "tool_call" | "tool_call_update" => parse_tool_call(value, state),
        _ => vec![],
    }
}

fn parse_tool_call(update: &Value, state: &mut TraeAcpParseState) -> Vec<Value> {
    let call_id = update.get("toolCallId").and_then(Value::as_str).map(str::to_string);
    let supplied_name = update.get("title").and_then(Value::as_str).map(str::to_string);
    if let (Some(call_id), Some(name)) = (&call_id, &supplied_name) {
        state.tool_names.entry(call_id.clone()).or_insert_with(|| name.clone());
    }
    let name = call_id
        .as_ref()
        .and_then(|id| state.tool_names.get(id).cloned())
        .or(supplied_name)
        .unwrap_or_else(|| "tool".to_string());
    let status = update.get("status").and_then(Value::as_str).unwrap_or("");
    let completed = status == "completed" || status == "failed";
    let input = update.get("rawInput").map(|v| tool_input(v));
    let output = update.get("rawOutput").and_then(printable).or_else(|| update.get("content").and_then(printable));

    if let Some(call_id) = &call_id {
        let previous = state.tool_calls.get(call_id);
        if previous.is_some_and(|p| p["phase"] == "completed") {
            return vec![];
        }
        let first = previous.is_none();
        let previous_input = previous.and_then(|p| p.get("input").cloned());
        let merged_input = match (&input, previous_input.as_ref()) {
            (Some(current), previous) => Some(merge_tool_input(previous, current)),
            (None, previous) => previous.cloned(),
        };
        let next_identity = merged_input.as_ref().and_then(tool_input_identity);
        let previous_identity = previous.and_then(|p| p["inputIdentity"].as_str());
        let duplicate = !first && !completed && previous_identity == next_identity.as_deref();
        // Only the first event starts this tool. Input changes are updates, so
        // the host won't treat them as new boundaries for a later thought.
        let phase = if completed { "completed" } else if first { "started" } else { "updated" };
        let mut next = Map::new();
        next.insert("phase".to_string(), json!(phase));
        next.insert("input".to_string(), merged_input.clone().unwrap_or(Value::Null));
        next.insert("inputIdentity".to_string(), next_identity.map(Value::String).unwrap_or(Value::Null));
        next.insert(
            "output".to_string(),
            output.clone().map(Value::String).or_else(|| previous.as_ref().and_then(|p| p.get("output").cloned())).unwrap_or(Value::Null),
        );
        state.tool_calls.insert(call_id.clone(), Value::Object(next));
        if duplicate {
            return vec![];
        }
        let event = json!({
            "kind": "tool",
            "callId": call_id,
            "name": name,
            "phase": phase,
            "input": merged_input.unwrap_or(Value::Null),
            "output": output.map(Value::String).unwrap_or(Value::Null),
            "success": status != "failed",
            "fileDiff": file_diff(&name, input.as_ref()).unwrap_or(Value::Null),
            "raw": update
        });
        // If ACP omits a start, the first completion still separates the
        // surrounding thoughts. Regular completions and late updates do not.
        return if first { state.after_thinking(event) } else { vec![event] };
    }
    let event = json!({
        "kind": "tool",
        "callId": call_id.map(Value::String).unwrap_or(Value::Null),
        "name": name,
        "phase": if completed { "completed" } else { "started" },
        "input": input.clone().unwrap_or(Value::Null),
        "output": output.map(Value::String).unwrap_or(Value::Null),
        "success": status != "failed",
        "fileDiff": file_diff(&name, input.as_ref()).unwrap_or(Value::Null),
        "raw": update
    });
    if update["sessionUpdate"] == "tool_call" { state.after_thinking(event) } else { vec![event] }
}

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref()==Some("--local-mcp-stdio") {
        if let Err(error)=local_mcp::run_stdio().await {
            eprintln!("Nautilo MCP relay: {error}");
            std::process::exit(1);
        }
        return;
    }
    agenthub_plugin_sdk::serve(TraePlugin::new()).await;
}
#[cfg(test)]
mod audit_tests {
    use super::*;
    #[test]
    fn permissions_inherit_or_set_a_single_enterprise_preset() {
        let mut binary = TraeBinary {
            executable: "traecli".into(), mode: "acp".into(), version: "0.216.0".into(),
            help: "  exec  Run non-interactively\n  --permission-mode <MODE>".into(),
        };
        let args = vec!["--profile".into(), "work".into(), "--permission-mode=auto".into()];
        assert_eq!(permission_args(args.clone(), Some("inherit"), &binary).unwrap(), args);
        assert_eq!(permission_args(args, Some("default"), &binary).unwrap(),
            ["--profile", "work", "--permission-mode", "default"]);
        assert!(permission_args(vec!["--yolo".into()], Some("default"), &binary).is_err());
        binary.mode = "cli".into();
        assert!(permission_args(vec![], Some("auto"), &binary).is_err());
        assert_eq!(permission_args(vec![], Some("inherit"), &binary).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn acp_prefers_model_and_reasoning_categories() {
        let options = [
            json!({"id":"model_context","name":"Model context","category":"model_config"}),
            json!({"id":"reasoning_summary","name":"Reasoning summary","category":"model_config"}),
            json!({"id":"deployment","name":"部署","category":"model"}),
            json!({"id":"depth","name":"深度","category":"thought_level"}),
        ];
        assert_eq!(acp_config_option(&options, "model").unwrap()["id"], "deployment");
        assert_eq!(acp_config_option(&options, "thought_level").unwrap()["id"], "depth");
        assert!(acp_config_option(&options[..1], "model").is_none());
        assert!(acp_config_option(&options[..2], "thought_level").is_none());
        let legacy = [json!({"id":"reasoningEffort","name":"Reasoning effort"})];
        assert!(acp_config_option(&legacy, "thought_level").is_some());
    }
    #[test]
    fn connection_overlay_preserves_native_configuration() {
        let path = std::env::temp_dir().join(format!("nautilo-trae-audit-{}.json", std::process::id()));
        let native = json!({
            "agents":{"trae_agent":{"model":"original","tools":["bash"]},"reviewer":{"model":"original"}},
            "models":{"original":{"model":"original","max_tokens":4000}},
            "model_providers":{"original":{"provider":"openai"}},
            "lakeview":{"model":"original","custom":true},
            "mcp_servers":{"existing":{"command":"fixture"}}
        });
        std::fs::write(&path, native.to_string()).unwrap();
        let result = open_source_configuration(&json!({"cwd":std::env::temp_dir(),"model":"chosen",
            "env":{"TRAE_CONFIG_FILE":path}}), json!("http://127.0.0.1:1234"));
        std::fs::remove_file(path).unwrap();
        let result = result.unwrap();
        assert_eq!(result["agents"]["reviewer"], native["agents"]["reviewer"]);
        assert_eq!(result["agents"]["trae_agent"]["tools"], json!(["bash"]));
        assert_eq!(result["models"]["original"], native["models"]["original"]);
        assert_eq!(result["models"]["selected"]["max_tokens"], 4000);
        assert_eq!(result["models"]["selected"]["model"], "chosen");
        assert_eq!(result["model_providers"]["original"], native["model_providers"]["original"]);
        assert_eq!(result["lakeview"]["custom"], true);
        assert_eq!(result["mcp_servers"], native["mcp_servers"]);
    }
}

#[cfg(test)]
mod acp_tests;
