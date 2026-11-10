//! Custom CLI adapter — port of adapters/custom.ts.
//! Runs any user-configured CLI with prompt substitution and optional JSONL
//! structured output.

use serde_json::{json, Value};

use crate::adapters::{
    stream_events, AdapterDetectionResult, AdapterResumeRequest, AdapterRun, AdapterStartRequest, AgentCliAdapter,
};
use crate::errors::{CoreError, CoreResult, ErrorCode};
use crate::process_runtime::{ProcessEvent, ProcessRequest, ProcessRuntime};

fn number_option(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64)
}

pub struct CustomCliAdapter;

impl Default for CustomCliAdapter {
    fn default() -> Self {
        Self
    }
}

impl CustomCliAdapter {
    fn command_args(instance: &Value, prompt: &str) -> Vec<String> {
        let args: Vec<String> = instance
            .get("baseArgs")
            .and_then(Value::as_array)
            .map(|args| args.iter().filter_map(Value::as_str).map(|arg| arg.replace("{prompt}", prompt)).collect())
            .unwrap_or_default();
        let contains_prompt = args.iter().any(|arg| arg.contains(prompt));
        let stdin_mode = instance
            .get("providerOptions")
            .and_then(|o| o.get("inputMode"))
            .and_then(Value::as_str)
            == Some("stdin");
        if contains_prompt || stdin_mode {
            args
        } else {
            args.into_iter().chain(std::iter::once(prompt.to_string())).collect()
        }
    }
}

#[async_trait::async_trait]
impl AgentCliAdapter for CustomCliAdapter {
    fn provider_id(&self) -> &str {
        "custom"
    }

    fn descriptor(&self) -> Value {
        json!({
            "providerId": "custom",
            "name": "Custom CLI",
            "vendor": "Local",
            "capabilities": ["headless_text"]
        })
    }

    fn capabilities(&self) -> crate::adapters::AdapterCapabilities {
        crate::adapters::AdapterCapabilities {
            structured_output: false,
            text_output: true,
            interactive_stdin: true,
            native_resume: false,
            pty: false,
        }
    }

    async fn detect(&self, instance: &Value) -> AdapterDetectionResult {
        let executable = instance.get("executable").and_then(Value::as_str).unwrap_or("").to_string();
        let result = ProcessRuntime::start(&ProcessRequest {
            command: executable.clone(),
            args: vec!["--version".to_string()],
            timeout_ms: Some(8_000),
            idle_timeout_ms: Some(4_000),
            max_output_bytes: Some(512 * 1024),
            ..Default::default()
        });
        let Ok(started) = result else {
            return AdapterDetectionResult {
                installed: false,
                executable: executable.clone(),
                error: result.err().map(|e| e.to_string()),
                ..Default::default()
            };
        };
        let mut events = started.events;
        let mut text = String::new();
        let mut code = None;
        while let Some(event) = events.recv().await {
            match event {
                ProcessEvent::Stdout(chunk) | ProcessEvent::Stderr(chunk) => text.push_str(&chunk),
                ProcessEvent::Exit { exit_code, .. } => code = exit_code,
                _ => {}
            }
        }
        if code != Some(0) {
            return AdapterDetectionResult {
                installed: false,
                executable,
                error: Some(if text.is_empty() {
                    format!("exit {}", code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string()))
                } else {
                    text
                }),
                ..Default::default()
            };
        }
        AdapterDetectionResult {
            installed: true,
            compatible: None,
            executable,
            version: Some(text.trim().to_string()),
            help: None,
            error: None,
        }
    }

    fn start(&self, request: AdapterStartRequest) -> CoreResult<AdapterRun> {
        let options = request.instance.get("providerOptions").cloned().unwrap_or_else(|| json!({}));
        let stdin_mode = options.get("inputMode").and_then(Value::as_str) == Some("stdin");
        let structured = options.get("outputMode").and_then(Value::as_str) == Some("jsonl");
        let context = serde_json::json!({"prompt":request.prompt,"cwd":request.cwd,"model":request.model,
            "reasoningEffort":request.reasoning_effort,"permissionMode":request.permission_mode,
            "serviceTier":request.service_tier,"contextWindow":request.context_window,
            "outputSchemaPath":request.output_schema_path,"localImagePaths":request.local_image_paths});
        let mut env = request.env.clone().unwrap_or_default();
        env.insert("NAUTILO_INPUT_JSON".into(),context.to_string());
        for (key,name) in [("model","NAUTILO_MODEL"),("reasoningEffort","NAUTILO_REASONING_EFFORT"),("permissionMode","NAUTILO_PERMISSION_MODE"),("serviceTier","NAUTILO_SERVICE_TIER")] {
            if let Some(value) = context[key].as_str() { env.insert(name.into(),value.into()); }
        }
        let mut instance = request.instance.clone();
        if let Some(args) = instance["baseArgs"].as_array_mut() {
            for arg in args.iter_mut() { if let Some(text) = arg.as_str() {
                let mut text = text.to_string();
                for (key,value) in context.as_object().unwrap() {
                    if key == "prompt" { continue; }
                    let value = if value.is_null() {String::new()} else {value.as_str().map(str::to_string).unwrap_or_else(||value.to_string())};
                    text = text.replace(&format!("{{{key}}}"), &value);
                }
                *arg = Value::String(text);
            } }
        }
        let started = ProcessRuntime::start(&ProcessRequest {
            command: request.instance.get("executable").and_then(Value::as_str).unwrap_or("").to_string(),
            args: Self::command_args(&instance, &request.prompt),
            cwd: Some(request.cwd.clone()),
            env: Some(env),
            timeout_ms: request.timeout_ms.or(number_option(options.get("timeoutMs"))),
            idle_timeout_ms: request.idle_timeout_ms.or(number_option(options.get("idleTimeoutMs"))),
            max_output_bytes: Some(
                request
                    .max_output_bytes
                    .or_else(|| number_option(options.get("maxOutputBytes")).map(|v| v as usize))
                    .unwrap_or(20 * 1024 * 1024),
            ),
        })
        .map_err(|e| CoreError::reason(ErrorCode::RunStartFailed, e.to_string()))?;
        let handle = started.handle.clone();
        if stdin_mode {
            handle.end_stdin(Some(format!("{}\n", request.prompt)));
        }
        let events = stream_events(started.events, structured, std::sync::Arc::new(|value, _stream| {
            crate::adapters::normalize_json(value)
        }));
        Ok(AdapterRun::from_process(events, &handle))
    }

    fn resume(&self, _request: AdapterResumeRequest) -> CoreResult<AdapterRun> {
        Err(CoreError::reason(ErrorCode::IpcInvalidRequest, "custom does not support native session resume"))
    }
}
