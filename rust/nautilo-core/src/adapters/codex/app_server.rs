//! Codex app-server run loop — port of adapters/codex/app-server-run.ts.
//! Speaks JSON-RPC over stdio to `codex app-server --stdio`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::adapters::codex::events::{parse_codex_app_server_notification, with_subagent_dispatch};
use crate::adapters::codex::image_gen::{
    codex_image_generation_tool, execute_codex_image_generation, is_codex_image_generation_configured,
    CODEX_IMAGE_GENERATION_TOOL_NAME,
};
use crate::adapters::codex::{
    build_codex_mcp_config_args, build_codex_provider_config_args, codex_permission_config, resolve_codex_invocation,
};
use crate::adapters::json_rpc_process::{JsonRpcProcessClient, JsonRpcProcessEvent};
use crate::adapters::plan_interaction::{extract_interaction_plan, is_plan_exit_tool};
use crate::adapters::{AdapterEvent, AdapterRun, AdapterStartRequest, TimeoutKind};
use crate::errors::{CoreError, CoreResult, ErrorCode};
use crate::process_runtime::{ProcessEvent, ProcessRequest, ProcessRuntime, TimeoutReason};

const CODEX_WEB_SEARCH_MODE: &str = "live";
const CODEX_MODEL_CATALOG_PREFIX: &str = "agenthub-codex-model-";
const CODEX_MODEL_CATALOG_CONTEXT_WINDOW: i64 = 272_000;
const CODEX_MODEL_REASONING_EFFORTS: [&str; 4] = ["low", "medium", "high", "xhigh"];
const CODEX_APPROVAL_DECISIONS: [&str; 4] = ["accept", "acceptForSession", "decline", "cancel"];

pub fn codex_app_server_initialize_params() -> Value {
    json!({
        "clientInfo": { "name": "Nautilo", "version": "0.1.0" },
        "capabilities": { "experimentalApi": true }
    })
}

fn codex_web_search_enabled(instance: &Value) -> bool {
    let options = instance.get("providerOptions");
    let mode = options.and_then(|o| o.get("webSearchMode")).and_then(Value::as_str);
    if mode == Some("off") || mode == Some("official") {
        return false;
    }
    options.and_then(|o| o.get("webSearch")).and_then(Value::as_bool) != Some(false)
}

fn thread_options(request: &AdapterStartRequest, include_dynamic_tools: bool) -> CoreResult<Map<String, Value>> {
    let (approval, sandbox) = codex_permission_config(&request.instance, Some(request)).unwrap_or(("never", "workspace-write"));
    let mut options = Map::new();
    options.insert("cwd".to_string(), json!(request.cwd));
    if let Some(model) = request.model.as_deref().filter(|m| !m.is_empty()) {
        options.insert("model".to_string(), json!(model));
    }
    if let Some(tier) = request.service_tier.as_deref().filter(|t| !t.is_empty()) {
        options.insert("serviceTier".to_string(), json!(tier));
    }
    options.insert("approvalPolicy".to_string(), json!(approval));
    options.insert("sandbox".to_string(), json!(sandbox));
    if include_dynamic_tools {
        if let Some(tools) = build_codex_dynamic_tools(request.runtime_tools.as_ref(), is_codex_image_generation_configured(request))? {
            options.insert("dynamicTools".to_string(), tools);
        }
    }
    Ok(options)
}

fn build_codex_dynamic_tools(tools: Option<&Value>, include_image_generation: bool) -> CoreResult<Option<Value>> {
    let mut source: Vec<Value> = tools.and_then(Value::as_array).cloned().unwrap_or_default();
    if include_image_generation {
        source.retain(|tool| tool.get("name").and_then(Value::as_str) != Some(CODEX_IMAGE_GENERATION_TOOL_NAME));
        source.push(codex_image_generation_tool());
    }
    if source.is_empty() {
        return Ok(None);
    }
    let mut result = vec![];
    for tool in &source {
        let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(CoreError::reason(ErrorCode::IpcInvalidRequest, format!("Invalid Codex dynamic tool name: {name}")));
        }
        result.push(json!({
            "type": "function",
            "name": name,
            "description": tool.get("description").cloned().unwrap_or(Value::Null),
            "inputSchema": tool.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object" }))
        }));
    }
    Ok(Some(Value::Array(result)))
}

pub fn build_codex_turn_input(prompt: &str, local_image_paths: &[String]) -> Value {
    let mut input = vec![json!({ "type": "text", "text": prompt })];
    for path in local_image_paths {
        input.push(json!({ "type": "localImage", "path": path, "detail": "auto" }));
    }
    Value::Array(input)
}

/// Supplies a short-lived catalog for custom endpoints so the selected model
/// is described as search-capable (see the TS docstring).
pub fn build_codex_custom_model_catalog(instance: &Value, requested_model: Option<&str>) -> Option<Value> {
    let base_url = instance
        .get("providerOptions")
        .and_then(|o| o.get("baseUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let _ = base_url;
    let mut configured: Map<String, Value> = Map::new();
    for model in instance.get("models").and_then(Value::as_array).cloned().unwrap_or_default() {
        let id = model.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if !id.is_empty() {
            configured.insert(id, model);
        }
    }
    if let Some(selected) = requested_model.map(str::trim).filter(|s| !s.is_empty()) {
        if !configured.contains_key(selected) {
            configured.insert(selected.to_string(), json!({}));
        }
    }
    if configured.is_empty() {
        return None;
    }
    let models: Vec<Value> = configured
        .iter()
        .map(|(id, model)| {
            let efforts: Vec<String> = model
                .get("reasoningEfforts")
                .and_then(Value::as_array)
                .map(|efforts| {
                    let mut seen = std::collections::HashSet::new();
                    efforts
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|e| !e.is_empty())
                        .filter(|e| seen.insert(e.to_string()))
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .filter(|e: &Vec<String>| !e.is_empty())
                .unwrap_or_else(|| CODEX_MODEL_REASONING_EFFORTS.iter().map(|e| e.to_string()).collect());
            let context_window = model
                .get("contextWindow")
                .and_then(Value::as_i64)
                .filter(|w| *w > 0)
                .unwrap_or(CODEX_MODEL_CATALOG_CONTEXT_WINDOW);
            json!({
                "prefer_websockets": false,
                "support_verbosity": false,
                // Codex 0.146 deserializes these catalog fields as enums rather
                // than nullable values; null makes app-server exit early.
                "default_verbosity": "low",
                "apply_patch_tool_type": "freeform",
                "web_search_tool_type": "text",
                "input_modalities": ["text", "image"],
                "supports_image_detail_original": false,
                "truncation_policy": { "mode": "tokens", "limit": 10_000 },
                "supports_parallel_tool_calls": true,
                "context_window": context_window,
                "max_context_window": context_window,
                "auto_compact_token_limit": null,
                "reasoning_summary_format": "experimental",
                "default_reasoning_summary": "auto",
                "slug": id,
                "display_name": model.get("displayName").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).unwrap_or(id),
                "description": "Nautilo custom endpoint model.",
                "default_reasoning_level": efforts.first(),
                "supported_reasoning_levels": efforts.iter().map(|effort| json!({ "effort": effort, "description": format!("Reasoning effort: {effort}") })).collect::<Vec<_>>(),
                "shell_type": "shell_command",
                "visibility": "list",
                "minimal_client_version": "0.0.1",
                "supported_in_api": true,
                "availability_nux": null,
                "upgrade": null,
                "priority": 1,
                "base_instructions": "",
                "model_messages": null,
                "include_skills_usage_instructions": false,
                "supports_reasoning_summary_parameter": true,
                "supports_search_tool": codex_web_search_enabled(instance),
                "service_tiers": [],
                "additional_speed_tiers": [],
                "supports_reasoning_summaries": true,
                "effective_context_window_percent": 95,
                "experimental_supported_tools": [],
                "use_responses_lite": false,
                "auto_review_model_override": null,
                "tool_mode": null,
                "multi_agent_version": null
            })
        })
        .collect();
    Some(json!({ "models": models }))
}

fn create_codex_custom_model_catalog_file(instance: &Value, requested_model: Option<&str>) -> CoreResult<Option<(String, PathBufCleanup)>> {
    let Some(catalog) = build_codex_custom_model_catalog(instance, requested_model) else {
        return Ok(None);
    };
    let directory = std::env::temp_dir().join(format!("{CODEX_MODEL_CATALOG_PREFIX}{}", Uuid::new_v4()));
    std::fs::create_dir_all(&directory).map_err(|e| CoreError::reason(ErrorCode::RunStartFailed, e.to_string()))?;
    let path = directory.join("models.json");
    if let Err(error) = std::fs::write(&path, catalog.to_string()) {
        let _ = std::fs::remove_dir_all(&directory);
        return Err(CoreError::reason(ErrorCode::RunStartFailed, format!("Failed to prepare Codex custom model catalog: {error}")));
    }
    Ok(Some((path.to_string_lossy().into_owned(), PathBufCleanup(directory))))
}

/// Removes the catalog's temp directory when dropped (process close).
pub struct PathBufCleanup(std::path::PathBuf);

impl PathBufCleanup {
    pub fn cleanup(self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn build_codex_app_server_args(
    instance: &Value,
    environment: Option<&HashMap<String, String>>,
    mcp_servers: Option<&[Value]>,
    model_catalog_path: Option<&str>,
) -> CoreResult<Vec<String>> {
    let mut args: Vec<String> = vec![];
    if let Some(profile) = instance.get("profile").and_then(Value::as_str).filter(|p| !p.is_empty()) {
        args.push("--profile".to_string());
        args.push(profile.to_string());
    }
    args.extend([
        "app-server".to_string(),
        "--stdio".to_string(),
        "--enable".to_string(),
        "image_generation".to_string(),
        // Headless runs never touch Codex desktop apps (the built-in
        // `codex_apps` MCP); when it fails to start it blocks every turn until
        // a ~30s timeout fires. Disable the feature outright.
        "--disable".to_string(),
        "apps".to_string(),
    ]);
    if codex_web_search_enabled(instance) {
        args.push("--config".to_string());
        args.push(format!("web_search={}", json!(CODEX_WEB_SEARCH_MODE)));
    }
    if let Some(path) = model_catalog_path {
        args.push("--config".to_string());
        args.push(format!("model_catalog_json={}", json!(path)));
    }
    // Chat mode is handled by the compat path; discovery/app-server calls
    // stay on the supported Responses wire format.
    args.extend(build_codex_provider_config_args(instance, environment, Some("responses"))?);
    args.extend(build_codex_mcp_config_args(mcp_servers.unwrap_or(&[])));
    Ok(args)
}

/// One resident `codex app-server` connection, reused across turns of an
/// agent instance. This mirrors the official Codex desktop app, which keeps a
/// single `codex.exe app-server` process alive for the app's lifetime: every
/// turn creates or resumes a thread over the same JSON-RPC connection instead
/// of cold-starting a CLI process per message.
pub struct PooledCodexAppServer {
    pub rpc: Arc<JsonRpcProcessClient>,
    /// One turn at a time per instance: Nautilo serializes per session, but
    /// sessions of the same instance can otherwise run in parallel and would
    /// collide on the same RPC stream.
    pub turn_lock: tokio::sync::Mutex<()>,
    initialized: AtomicBool,
    instance_key: String,
    /// Hash of the instance/credentials/executable the process was started
    /// with; a config edit evicts the stale connection so the next turn
    /// cold-starts a fresh one with the new settings.
    config_fingerprint: u64,
    /// Temp model catalog created at cold start; removed with the process.
    catalog_cleanup: Mutex<Option<PathBufCleanup>>,
}

static CODEX_APP_SERVER_POOL: LazyLock<Mutex<HashMap<String, Arc<PooledCodexAppServer>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn codex_instance_key(request: &AdapterStartRequest) -> String {
    request
        .instance
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            request
                .instance
                .get("executable")
                .and_then(Value::as_str)
                .unwrap_or("codex")
                .to_string()
        })
}

/// Returns the resident app-server connection for this agent instance,
/// starting one on first use. Dead connections are replaced transparently.
/// Process spawn is synchronous and fast (the child streams in the background),
/// so this stays a plain function callable from the sync adapter start path.
pub fn acquire_codex_app_server(request: &AdapterStartRequest) -> CoreResult<Arc<PooledCodexAppServer>> {
    let key = codex_instance_key(request);
    let fingerprint = codex_config_fingerprint(request);
    // Hold the pool lock across the cold start: two parallel runs of the same
    // instance would otherwise each spawn a process and orphan one of them.
    let mut pool = CODEX_APP_SERVER_POOL.lock().unwrap();
    if let Some(existing) = pool.get(&key) {
        if existing.config_fingerprint == fingerprint && existing.rpc.process_handle().is_alive() {
            return Ok(existing.clone());
        }
        // Config changed or the process died: replace the stale entry.
        if let Some(cleanup) = existing.catalog_cleanup.lock().unwrap().take() {
            cleanup.cleanup();
        }
        pool.remove(&key);
    }

    // Cold start: build the same `codex app-server --stdio` command line the
    // per-run path used, but without turn-scoped timeouts -- a resident
    // process must outlive one turn. Per-turn bounds are enforced by the pump.
    // Use the instance's full configured model list (not the per-run
    // model): a reused resident process serves every model switch, so
    // the catalog must not depend on the first turn's selection.
    let model_catalog = create_codex_custom_model_catalog_file(&request.instance, None)?;
    let args = match build_codex_app_server_args(
        &request.instance,
        request.env.as_ref(),
        request.mcp_servers.as_deref(),
        model_catalog.as_ref().map(|(path, _)| path.as_str()),
    ) {
        Ok(args) => args,
        Err(error) => {
            if let Some((_, cleanup)) = model_catalog {
                cleanup.cleanup();
            }
            return Err(error);
        }
    };
    let executable = request.instance.get("executable").and_then(Value::as_str).unwrap_or("codex").to_string();
    let path_env = request.env.as_ref().and_then(|env| env.get("PATH").cloned());
    let (command, args) = resolve_codex_invocation(&executable, &args, path_env.as_deref());
    let started = ProcessRuntime::start(&ProcessRequest {
        command,
        args,
        cwd: Some(request.cwd.clone()),
        env: request.env.clone(),
        timeout_ms: None,
        idle_timeout_ms: None,
        max_output_bytes: Some(request.max_output_bytes.unwrap_or(20 * 1024 * 1024)),
    })
    .map_err(|e| CoreError::reason(ErrorCode::RunStartFailed, e.to_string()))?;
    let rpc = Arc::new(JsonRpcProcessClient::new(started.handle, started.events));
    let pooled = Arc::new(PooledCodexAppServer {
        rpc,
        turn_lock: tokio::sync::Mutex::new(()),
        initialized: AtomicBool::new(false),
        catalog_cleanup: Mutex::new(model_catalog.map(|(_, cleanup)| cleanup)),
        config_fingerprint: fingerprint,
        instance_key: key.clone(),
    });
    pool.insert(key, pooled.clone());
    Ok(pooled)
}

fn codex_config_fingerprint(request: &AdapterStartRequest) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    let mut hash_str = |value: &str| value.hash(&mut hasher);
    hash_str(request.instance.get("executable").and_then(Value::as_str).unwrap_or(""));
    hash_str(request.instance.get("profile").and_then(Value::as_str).unwrap_or(""));
    if let Some(opts) = request.instance.get("providerOptions") {
        opts.to_string().hash(&mut hasher);
    }
    if let Some(servers) = &request.mcp_servers {
        json!(servers).to_string().hash(&mut hasher);
    }
    if let Some(env) = &request.env {
        let mut keys: Vec<&String> = env.keys().collect();
        keys.sort();
        for key in keys {
            key.hash(&mut hasher);
            env[key].hash(&mut hasher);
        }
    }
    hasher.finish()
}


/// Drops the pool entry for a connection that can no longer be reused (a
/// killed process), so the next turn cold-starts a fresh one.
pub fn discard_codex_app_server(pooled: &Arc<PooledCodexAppServer>) {
    let key = &pooled.instance_key;
    let mut pool = CODEX_APP_SERVER_POOL.lock().unwrap();
    if let Some(existing) = pool.get(key) {
        if Arc::ptr_eq(existing, pooled) {
            pool.remove(key);
        }
    }
    // The temp model catalog dies with the process it was started for.
    if let Some(cleanup) = pooled.catalog_cleanup.lock().unwrap().take() {
        cleanup.cleanup();
    }
}

/// Starts (or reuses) `codex app-server --stdio` and drives one thread turn
/// over JSON-RPC. On normal completion the resident process stays alive for
/// the next turn; errors and per-turn timeouts kill it and evict the pool
/// entry so the following run cold-starts a clean connection.
pub fn start_codex_app_server(request: AdapterStartRequest, resume_session: Option<String>) -> CoreResult<AdapterRun> {
    let pooled = acquire_codex_app_server(&request)?;
    let rpc = pooled.rpc.clone();
    let (sender, receiver) = mpsc::unbounded_channel::<AdapterEvent>();
    let state = Arc::new(Mutex::new(AppServerState::default()));

    let pump = {
        let rpc = rpc.clone();
        let state = state.clone();
        let sender = sender.clone();
        let request = request.clone();
        let pooled = pooled.clone();
        async move {
            let _turn_guard = pooled.turn_lock.lock().await;
            let already_initialized = pooled.initialized.load(Ordering::SeqCst);
            let turn_timeout = request.timeout_ms.unwrap_or(30 * 60_000);
            let result = tokio::time::timeout(
                std::time::Duration::from_millis(turn_timeout),
                run_turn(rpc.clone(), &request, resume_session, state.clone(), sender.clone(), already_initialized),
            )
            .await;
            match result {
                Ok(Ok(())) => {
                    // Normal completion keeps the resident process warm for the
                    // next turn; mark the connection initialized so the next
                    // turn skips the JSON-RPC handshake.
                    pooled.initialized.store(true, Ordering::SeqCst);
                }
                Ok(Err(error)) => {
                    let _ = sender.send(AdapterEvent::Error { message: error.to_string() });
                    if !state.lock().unwrap().finished {
                        pooled.rpc.process_handle().cancel().await;
                        discard_codex_app_server(&pooled);
                    }
                }
                Err(_elapsed) => {
                    let _ = sender.send(AdapterEvent::Timeout { reason: TimeoutKind::Timeout });
                    pooled.rpc.process_handle().cancel().await;
                    discard_codex_app_server(&pooled);
                }
            }
        }
    };
    tokio::spawn(pump);

    // steer / cancel talk to the RPC client shared with the pump.
    let steer_rpc = rpc.clone();
    let steer_state = state.clone();
    let cancel_state = state.clone();
    let cancel_pooled = pooled.clone();
    let mut run = AdapterRun::new(
        receiver,
        move || {
            let pooled = cancel_pooled.clone();
            let state = cancel_state.clone();
            Box::pin(async move {
                let (thread_id, turn_id) = {
                    let state = state.lock().unwrap();
                    (state.thread_id.clone(), state.turn_id.clone())
                };
                if let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) {
                    pooled.rpc.notify("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id }));
                }
                // Give the turn a moment to wind down; only kill (and evict
                // the pooled connection) if it is genuinely stuck.
                tokio::time::sleep(std::time::Duration::from_millis(3_000)).await;
                let finished = state.lock().unwrap().finished;
                if !finished && pooled.rpc.process_handle().is_alive() {
                    pooled.rpc.process_handle().cancel().await;
                    discard_codex_app_server(&pooled);
                }
            }) as crate::adapters::BoxFuture<()>
        },
        move |input| {
            rpc.process_write(&input);
        },
    );
    run = run.with_steer(Arc::new(move |input: String| {
        let rpc = steer_rpc.clone();
        let state = steer_state.clone();
        Box::pin(async move {
            let (thread_id, turn_id, finished) = {
                let state = state.lock().unwrap();
                (state.thread_id.clone(), state.turn_id.clone(), state.finished)
            };
            let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) else {
                return Err(CoreError::reason(ErrorCode::IpcInvalidRequest, "No active Codex turn is available to steer"));
            };
            if finished {
                return Err(CoreError::reason(ErrorCode::IpcInvalidRequest, "No active Codex turn is available to steer"));
            }
            let response = rpc
                .request("turn/steer", json!({
                    "threadId": thread_id,
                    "expectedTurnId": turn_id,
                    "input": build_codex_turn_input(&input, &[])
                }))
                .await
                .map_err(|e| CoreError::reason(ErrorCode::IpcInternalError, e.to_string()))?;
            if let Some(next) = response.get("turnId").and_then(Value::as_str) {
                state.lock().unwrap().turn_id = Some(next.to_string());
            }
            Ok(())
        }) as crate::adapters::BoxFuture<CoreResult<()>>
    }));
    Ok(run)
}

#[derive(Default)]
struct AppServerState {
    thread_id: Option<String>,
    turn_id: Option<String>,
    finished: bool,
    /// Child agent thread id → the collab tool call item that spawned it.
    child_threads: HashMap<String, String>,
}

async fn run_turn(
    rpc: Arc<JsonRpcProcessClient>,
    request: &AdapterStartRequest,
    resume_session: Option<String>,
    state: Arc<Mutex<AppServerState>>,
    sender: mpsc::UnboundedSender<AdapterEvent>,
    already_initialized: bool,
) -> anyhow::Result<()> {
    if !already_initialized {
        rpc.request("initialize", codex_app_server_initialize_params()).await?;
        rpc.notify("initialized", json!({}));
    }
    let mut thread_params = thread_options(request, true)?;
    let method = if resume_session.is_some() { "thread/resume" } else { "thread/start" };
    if let Some(session) = &resume_session {
        thread_params.insert("threadId".to_string(), json!(session));
    }
    let thread_response = rpc.request(method, Value::Object(thread_params)).await?;
    let thread_id = thread_response
        .get("thread")
        .and_then(|t| t.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| resume_session.clone())
        .filter(|id| !id.is_empty());
    let Some(thread_id) = thread_id else {
        anyhow::bail!("Codex app-server did not return a thread id");
    };
    state.lock().unwrap().thread_id = Some(thread_id.clone());
    let _ = sender.send(AdapterEvent::Session { provider_session_id: thread_id.clone(), raw: None });

    let compact = request.provider_command.as_deref() == Some("compact");
    if compact && resume_session.is_none() {
        anyhow::bail!("Codex thread compaction requires an existing provider session");
    }
    if compact {
        // Manual compaction is a dedicated RPC, not a chat turn.
        rpc.request("thread/compact/start", json!({ "threadId": thread_id })).await?;
    } else {
        let turn_response = rpc
            .request("turn/start", json!({
                "threadId": thread_id,
                "input": build_codex_turn_input(&request.prompt, request.local_image_paths.as_deref().unwrap_or(&[])),
                "cwd": request.cwd,
                "model": request.model.as_deref().filter(|m| !m.is_empty()),
                "serviceTier": request.service_tier.as_deref().filter(|t| !t.is_empty()),
                "effort": request.reasoning_effort.as_deref().filter(|e| !e.is_empty()),
                "summary": "auto"
            }))
            .await?;
        let turn_id = turn_response.get("turn").and_then(|t| t.get("id")).and_then(Value::as_str).map(str::to_string);
        state.lock().unwrap().turn_id = turn_id;
    }

    loop {
        let Some(event) = rpc.next_event().await else {
            break;
        };
        match event {
            JsonRpcProcessEvent::Notification { method, params } => {
                let item = params.get("item").cloned().unwrap_or(Value::Null);
                if (method == "item/started" || method == "item/completed")
                    && item.get("type").and_then(Value::as_str) == Some("collabAgentToolCall")
                {
                    // A collab spawn names its child threads; subscribe so
                    // their items arrive, correlated to the dispatch item id.
                    let dispatch_id = item.get("id").and_then(Value::as_str).map(str::to_string);
                    let receivers = item.get("receiverThreadIds").and_then(Value::as_array).cloned().unwrap_or_default();
                    for receiver in receivers {
                        let Some(child_id) = receiver.as_str() else { continue };
                        let Some(dispatch_id) = &dispatch_id else { continue };
                        let mut state = state.lock().unwrap();
                        if !state.child_threads.contains_key(child_id) {
                            let rpc = rpc.clone();
                            let child = child_id.to_string();
                            tokio::spawn(async move {
                                let _ = rpc.request("thread/subscribe", json!({ "threadId": child })).await;
                            });
                        }
                        state.child_threads.insert(child_id.to_string(), dispatch_id.clone());
                    }
                }
                let events = parse_codex_app_server_notification(&method, &params);
                let event_thread_id = params.get("threadId").and_then(Value::as_str).map(str::to_string);
                let dispatch = event_thread_id
                    .filter(|id| *id != thread_id)
                    .and_then(|id| state.lock().unwrap().child_threads.get(&id).cloned());
                for event in match dispatch {
                    Some(dispatch_id) => with_subagent_dispatch(events, &dispatch_id),
                    None => events,
                } {
                    if sender.send(event).is_err() {
                        return Ok(());
                    }
                }
                if compact && method == "thread/compacted" {
                    state.lock().unwrap().finished = true;
                    let _ = sender.send(AdapterEvent::Message {
                        text: "Codex 上下文已压缩".to_string(),
                        phase: None,
                        message_id: None,
                        subagent_dispatch_id: None,
                        raw: None,
                    });
                    // Do NOT kill the resident app-server: reuse it for the next turn (matches the official Codex desktop app).
                    let _ = sender.send(AdapterEvent::Exit { exit_code: Some(0), signal: None });
                    return Ok(());
                }
                if method == "turn/completed" {
                    state.lock().unwrap().finished = true;
                    // Do NOT kill the resident app-server: reuse it for the next turn (matches the official Codex desktop app).
                    let _ = sender.send(AdapterEvent::Exit { exit_code: Some(0), signal: None });
                    return Ok(());
                }
            }
            JsonRpcProcessEvent::Request { id, method, params } => {
                match method.as_str() {
                    "item/tool/call" => {
                        for emitted in handle_dynamic_tool_call(&rpc, request, &id, &params).await {
                            if sender.send(emitted).is_err() {
                                return Ok(());
                            }
                        }
                    }
                    "item/tool/requestUserInput" => handle_request_user_input(&rpc, request, &id, &params).await,
                    "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                        handle_codex_approval(&rpc, request, &id, &params, &method).await
                    }
                    _ => rpc.respond_error(&id, -32601, &format!("Nautilo does not support app-server request {method}")),
                }
            }
            JsonRpcProcessEvent::Transport(process_event) => {
                let finished = state.lock().unwrap().finished;
                match process_event {
                    ProcessEvent::Stdout(text) => {
                        let _ = sender.send(AdapterEvent::Raw { stream: "stdout".to_string(), text });
                    }
                    ProcessEvent::Stderr(text) => {
                        let _ = sender.send(AdapterEvent::Raw { stream: "stderr".to_string(), text });
                    }
                    ProcessEvent::Exit { exit_code, signal } => {
                        if !finished {
                            let _ = sender.send(AdapterEvent::Exit { exit_code, signal });
                        }
                        return Ok(());
                    }
                    ProcessEvent::Error(message) => {
                        let _ = sender.send(AdapterEvent::Error { message });
                    }
                    ProcessEvent::Timeout { reason } => {
                        let kind = match reason {
                            TimeoutReason::Timeout => TimeoutKind::Timeout,
                            TimeoutReason::Idle => TimeoutKind::Idle,
                            TimeoutReason::MaxOutput => TimeoutKind::MaxOutput,
                        };
                        let _ = sender.send(AdapterEvent::Timeout { reason: kind });
                    }
                }
            }
            JsonRpcProcessEvent::Response { .. } => {}
        }
    }
    Ok(())
}

async fn handle_dynamic_tool_call(
    rpc: &Arc<JsonRpcProcessClient>,
    request: &AdapterStartRequest,
    id: &Value,
    params: &Value,
) -> Vec<AdapterEvent> {
    let tool = params.get("tool").and_then(Value::as_str).unwrap_or("").to_string();
    if is_plan_exit_tool(&tool) && request.request_interaction.is_some() {
        let handler = request.request_interaction.clone().unwrap();
        let response = handler(json!({
            "kind": "plan_approval",
            "title": "计划已就绪",
            "plan": extract_interaction_plan(params.get("arguments").unwrap_or(params)),
            "options": [
                { "id": "approve", "label": "Approve", "intent": "approve" },
                { "id": "revise", "label": "Revise", "intent": "revise" }
            ]
        }))
        .await;
        match response {
            Ok(response) => {
                let approved = response.get("outcome").and_then(Value::as_str) == Some("selected")
                    && response.get("optionId").and_then(Value::as_str) == Some("approve");
                rpc.respond(id, json!({
                    "success": approved,
                    "contentItems": [{ "type": "inputText", "text": if approved {
                        "The user approved the plan. Exit plan mode and begin implementation."
                    } else {
                        "The user wants to continue refining the plan."
                    } }]
                }));
            }
            Err(error) => {
                rpc.respond(id, json!({
                    "success": false,
                    "contentItems": [{ "type": "inputText", "text": error.to_string() }]
                }));
            }
        }
        return vec![];
    }
    if tool == CODEX_IMAGE_GENERATION_TOOL_NAME {
        match execute_codex_image_generation(request, params.get("arguments").unwrap_or(&Value::Null)).await {
            Ok(result) => {
                rpc.respond(id, json!({
                    "success": true,
                    "contentItems": [{ "type": "inputText", "text": result.get("content").cloned().unwrap_or(Value::Null) }]
                }));
                return vec![AdapterEvent::Artifact {
                    artifact_type: "image".to_string(),
                    name: result.get("name").and_then(Value::as_str).unwrap_or("image.png").to_string(),
                    mime_type: result.get("mimeType").and_then(Value::as_str).map(str::to_string),
                    data: None,
                    path: result.get("path").and_then(Value::as_str).map(str::to_string),
                    raw: Some(params.clone()),
                }];
            }
            Err(error) => {
                rpc.respond(id, json!({
                    "success": false,
                    "contentItems": [{ "type": "inputText", "text": error.to_string() }]
                }));
                return vec![];
            }
        }
    }
    if tool.is_empty() || request.execute_runtime_tool.is_none() {
        rpc.respond(id, json!({
            "success": false,
            "contentItems": [{ "type": "inputText", "text": format!("Nautilo runtime tool is unavailable: {}", if tool.is_empty() { "unknown" } else { tool.as_str() }) }]
        }));
        return vec![];
    }
    let execute = request.execute_runtime_tool.clone().unwrap();
    let call = json!({
        "providerId": request.instance.get("providerId").cloned().unwrap_or(Value::Null),
        "callId": params.get("callId").and_then(Value::as_str).filter(|s| !s.is_empty()),
        "name": tool,
        "arguments": params.get("arguments").cloned().unwrap_or(Value::Null)
    });
    match execute(call).await {
        Ok(result) => {
            rpc.respond(id, json!({
                "success": result.get("success").and_then(Value::as_bool).unwrap_or(false),
                "contentItems": [{ "type": "inputText", "text": result.get("content").cloned().unwrap_or(Value::Null) }]
            }));
        }
        Err(error) => {
            rpc.respond(id, json!({
                "success": false,
                "contentItems": [{ "type": "inputText", "text": error.to_string() }]
            }));
        }
    }
    vec![]
}

/// item/tool/requestUserInput — Codex's structured question tool.
async fn handle_request_user_input(rpc: &Arc<JsonRpcProcessClient>, request: &AdapterStartRequest, id: &Value, params: &Value) {
    let Some(handler) = request.request_interaction.clone() else {
        rpc.respond_error(id, -32601, "Nautilo does not support app-server request item/tool/requestUserInput");
        return;
    };
    let questions: Vec<Value> = params
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|question| {
            let mut mapped = Map::new();
            mapped.insert(
                "id".to_string(),
                question.get("id").cloned().filter(|v| v.is_string()).unwrap_or_else(|| json!(Uuid::new_v4().to_string())),
            );
            if let Some(header) = question.get("header").and_then(Value::as_str) {
                mapped.insert("header".to_string(), json!(header));
            }
            mapped.insert("question".to_string(), question.get("question").cloned().unwrap_or_else(|| json!("")));
            for flag in ["isOther", "isSecret"] {
                if question.get(flag).and_then(Value::as_bool) == Some(true) {
                    mapped.insert(flag.to_string(), json!(true));
                }
            }
            let options: Vec<Value> = question
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|option| {
                            let label = option.get("label").and_then(Value::as_str)?;
                            let mut mapped = Map::new();
                            mapped.insert("id".to_string(), json!(label));
                            mapped.insert("label".to_string(), json!(label));
                            if let Some(description) = option.get("description").and_then(Value::as_str) {
                                mapped.insert("description".to_string(), json!(description));
                            }
                            Some(Value::Object(mapped))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !options.is_empty() {
                mapped.insert("options".to_string(), Value::Array(options));
            }
            Value::Object(mapped)
        })
        .collect();
    let outcome: anyhow::Result<Value> = async {
        if looks_like_plan_approval_question(params.get("title"), &questions) {
            let question = questions.first().cloned().unwrap_or(Value::Null);
            let options = with_plan_option_intents(question.get("options").and_then(Value::as_array).cloned().unwrap_or_default());
            let response = handler(json!({
                "kind": "plan_approval",
                "title": "计划已就绪",
                "plan": extract_interaction_plan(params),
                "options": options
            }))
            .await?;
            if response.get("outcome").and_then(Value::as_str) == Some("cancelled") || response.get("optionId").is_none() {
                return Ok(json!({ "answers": {} }));
            }
            let option_id = response.get("optionId").and_then(Value::as_str).unwrap_or("");
            let selected = options
                .iter()
                .find(|option| option.get("id").and_then(Value::as_str) == Some(option_id));
            let label = selected.and_then(|o| o.get("label")).and_then(Value::as_str).map(str::to_string);
            let question_id = question.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            return Ok(json!({ "answers": { question_id: { "answers": label.map(|l| vec![l]).unwrap_or_default() } } }));
        }
        let response = handler(json!({ "kind": "question", "title": "请求用户输入", "questions": questions })).await?;
        if response.get("outcome").and_then(Value::as_str) == Some("cancelled") {
            return Ok(json!({ "answers": {} }));
        }
        let mut answers = Map::new();
        for question in &questions {
            let id = question.get("id").and_then(Value::as_str).unwrap_or("");
            let values = response
                .get("answers")
                .and_then(|a| a.get(id))
                .cloned()
                .unwrap_or_else(|| json!([]));
            answers.insert(id.to_string(), json!({ "answers": values }));
        }
        Ok(json!({ "answers": Value::Object(answers) }))
    }
    .await;
    match outcome {
        Ok(payload) => rpc.respond(id, payload),
        Err(error) => rpc.respond_error(id, -32000, &error.to_string()),
    }
}

fn looks_like_plan_approval_question(title: Option<&Value>, questions: &[Value]) -> bool {
    if questions.len() != 1 {
        return false;
    }
    let options = questions[0].get("options").and_then(Value::as_array).cloned().unwrap_or_default();
    if options.len() < 2 {
        return false;
    }
    let text = [
        title.and_then(Value::as_str).unwrap_or("").to_string(),
        questions[0].get("header").and_then(Value::as_str).unwrap_or("").to_string(),
        questions[0].get("question").and_then(Value::as_str).unwrap_or("").to_string(),
        options
            .iter()
            .flat_map(|o| {
                vec![
                    o.get("label").and_then(Value::as_str).unwrap_or("").to_string(),
                    o.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
                ]
            })
            .collect::<Vec<_>>()
            .join(" "),
    ]
    .join(" ");
    let has_plan = regex::Regex::new(r"(?i)(plan|计划)").map(|re| re.is_match(&text)).unwrap_or(false);
    let has_action = regex::Regex::new(r"(?i)(approve|implement|build agent|start implementing|switch|批准|执行|开始实现|切换)")
        .map(|re| re.is_match(&text))
        .unwrap_or(false);
    has_plan && has_action
}

fn with_plan_option_intents(options: Vec<Value>) -> Vec<Value> {
    let infer = |option: &Value| -> Option<&'static str> {
        let text = format!(
            "{} {} {}",
            option.get("id").and_then(Value::as_str).unwrap_or(""),
            option.get("label").and_then(Value::as_str).unwrap_or(""),
            option.get("description").and_then(Value::as_str).unwrap_or("")
        )
        .to_lowercase();
        if regex::Regex::new(r"(?i)(reject|deny|decline|cancel|abort|拒绝|取消)").map(|re| re.is_match(&text)).unwrap_or(false) {
            return Some("reject");
        }
        if regex::Regex::new(r"(?i)(revise|refine|keep planning|continue planning|stay.+plan|修改|完善|继续计划)")
            .map(|re| re.is_match(&text))
            .unwrap_or(false)
        {
            return Some("revise");
        }
        if regex::Regex::new(r"(?i)(allow|accept|approve|proceed|implement|build|yes|批准|执行|开始实现|同意)")
            .map(|re| re.is_match(&text))
            .unwrap_or(false)
        {
            return Some("approve");
        }
        None
    };
    let mut inferred: Vec<Value> = options
        .iter()
        .map(|option| {
            let mut mapped = option.as_object().cloned().unwrap_or_default();
            if mapped.get("intent").is_none() {
                if let Some(intent) = infer(option) {
                    mapped.insert("intent".to_string(), json!(intent));
                }
            }
            Value::Object(mapped)
        })
        .collect();
    let has = |intent: &str, options: &[Value]| options.iter().any(|o| o.get("intent").and_then(Value::as_str) == Some(intent));
    if inferred.len() == 2 && !has("approve", &inferred) {
        inferred[0].as_object_mut().unwrap().insert("intent".to_string(), json!("approve"));
    }
    if inferred.len() == 2 && !has("revise", &inferred) && !has("reject", &inferred) {
        inferred[1].as_object_mut().unwrap().insert("intent".to_string(), json!("revise"));
    }
    inferred
}

/// item/commandExecution/requestApproval and item/fileChange/requestApproval.
async fn handle_codex_approval(
    rpc: &Arc<JsonRpcProcessClient>,
    request: &AdapterStartRequest,
    id: &Value,
    params: &Value,
    method: &str,
) {
    let is_command = method == "item/commandExecution/requestApproval";
    let Some(handler) = request.request_interaction.clone() else {
        // Fail closed: without a user bridge, deny rather than silently approve.
        rpc.respond(id, json!({ "decision": "decline" }));
        return;
    };
    let available: Vec<&str> = params
        .get("availableDecisions")
        .and_then(Value::as_array)
        .map(|d| d.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let decisions: Vec<&str> = CODEX_APPROVAL_DECISIONS
        .iter()
        .copied()
        .filter(|decision| available.is_empty() || available.contains(decision))
        .collect();
    let title = if is_command { "运行命令" } else { "修改文件" };
    let mut detail_parts: Vec<String> = vec![];
    if is_command {
        if let Some(command) = params.get("command").and_then(Value::as_str) {
            detail_parts.push(command.to_string());
        }
    }
    if let Some(reason) = params.get("reason").and_then(Value::as_str) {
        detail_parts.push(reason.to_string());
    }
    if !is_command {
        if let Some(root) = params.get("grantRoot").and_then(Value::as_str) {
            detail_parts.push(format!("grantRoot: {root}"));
        }
    }

    let detail = if detail_parts.is_empty() { Value::Null } else { json!(detail_parts.join("\n")) };
    let outcome = handler(json!({
        "kind": "approval",
        "title": title,
        "detail": detail,
        "options": decisions.iter().map(|decision| json!({ "id": decision, "label": decision })).collect::<Vec<_>>()
    }))
    .await;
    match outcome {
        Ok(response) => {
            let decision = if response.get("outcome").and_then(Value::as_str) == Some("selected") {
                response.get("optionId").and_then(Value::as_str).unwrap_or("cancel")
            } else {
                "cancel"
            };
            rpc.respond(id, json!({ "decision": decision }));
        }
        Err(error) => rpc.respond_error(id, -32000, &error.to_string()),
    }
}
