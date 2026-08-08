//! Codex image generation bridge — port of adapters/codex/image-generation.ts.

use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::adapters::AdapterStartRequest;
use crate::errors::{CoreError, CoreResult, ErrorCode};

pub const CODEX_IMAGE_GENERATION_TOOL_NAME: &str = "image_gen";

pub fn codex_image_generation_tool() -> Value {
    json!({
        "name": CODEX_IMAGE_GENERATION_TOOL_NAME,
        "description": "Generate an image through the configured Nautilo image endpoint and save it in the current workspace. Use this for image generation requests.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["prompt"],
            "properties": {
                "prompt": { "type": "string", "minLength": 1, "description": "The image prompt." },
                "model": { "type": "string", "description": "GPT Image model id, default gpt-image-2." },
                "size": { "type": "string", "description": "Image size such as 1024x1024, 1536x1024, or auto." },
                "quality": { "type": "string", "enum": ["low", "medium", "high", "auto"] },
                "background": { "type": "string", "enum": ["transparent", "opaque", "auto"] },
                "output_format": { "type": "string", "enum": ["png", "jpeg", "webp"] },
                "filename": { "type": "string", "description": "Optional output filename; it is kept inside output/imagegen." }
            }
        }
    })
}

fn env_value(request: &AdapterStartRequest, key: &str) -> Option<String> {
    request.env.as_ref()?.get(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

pub fn is_codex_image_generation_configured(request: &AdapterStartRequest) -> bool {
    let configured = request
        .instance
        .get("providerOptions")
        .and_then(|o| o.get("baseUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    configured.is_some()
        || env_value(request, "OPENAI_BASE_URL").is_some()
        || env_value(request, "OPENAI_API_KEY").is_some()
        || env_value(request, "CODEX_API_KEY").is_some()
}

fn image_endpoint(request: &AdapterStartRequest) -> CoreResult<String> {
    let from_instance = request
        .instance
        .get("providerOptions")
        .and_then(|o| o.get("baseUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let api_key = env_value(request, "OPENAI_API_KEY").or_else(|| env_value(request, "CODEX_API_KEY"));
    let base = from_instance
        .or_else(|| env_value(request, "OPENAI_BASE_URL"))
        .or_else(|| api_key.map(|_| "https://api.openai.com/v1".to_string()))
        .ok_or_else(|| CoreError::reason(ErrorCode::IpcInvalidRequest, "image_gen needs a configured image API base URL or OPENAI_API_KEY"))?;
    let base = base.trim_end_matches('/');
    if !(base.to_lowercase().starts_with("http://") || base.to_lowercase().starts_with("https://")) {
        return Err(CoreError::reason(ErrorCode::IpcInvalidRequest, "image_gen received an invalid image API base URL"));
    }
    Ok(format!("{base}/images/generations"))
}

fn fail(reason: impl Into<String>) -> CoreError {
    CoreError::reason(ErrorCode::VerificationFailed, reason.into())
}

pub async fn execute_codex_image_generation(request: &AdapterStartRequest, arguments: &Value) -> CoreResult<Value> {
    let input = match arguments {
        Value::String(text) => serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!({})),
        other => other.clone(),
    };
    let prompt = input.get("prompt").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let Some(prompt) = prompt else {
        return Err(fail("image_gen requires a non-empty prompt"));
    };
    let model = input.get("model").and_then(Value::as_str).unwrap_or("gpt-image-2").to_string();
    if !model.starts_with("gpt-image-") {
        return Err(fail("image_gen model must be a GPT Image model"));
    }
    let size = input.get("size").and_then(Value::as_str).unwrap_or("auto");
    let quality = input.get("quality").and_then(Value::as_str).unwrap_or("medium");
    let background = input.get("background").and_then(Value::as_str);
    let output_format = match input.get("output_format").and_then(Value::as_str).map(str::to_lowercase).as_deref() {
        None => "png",
        Some("jpg") | Some("jpeg") => "jpeg",
        Some("png") => "png",
        Some("webp") => "webp",
        Some(_) => return Err(fail("image_gen output_format must be png, jpeg, or webp")),
    };
    if background == Some("transparent") && model == "gpt-image-2" {
        return Err(fail("gpt-image-2 does not support transparent output; use a chroma-key prompt or gpt-image-1.5 explicitly"));
    }

    let mut payload = Map::new();
    payload.insert("model".to_string(), json!(model));
    payload.insert("prompt".to_string(), json!(prompt));
    payload.insert("n".to_string(), json!(1));
    payload.insert("size".to_string(), json!(size));
    payload.insert("quality".to_string(), json!(quality));
    payload.insert("output_format".to_string(), json!(output_format));
    if let Some(background) = background {
        payload.insert("background".to_string(), json!(background));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10 * 60))
        .build()
        .map_err(|e| fail(e.to_string()))?;
    let mut http = client
        .post(image_endpoint(request)?)
        .header("accept", "application/json")
        .header("content-type", "application/json");
    if let Some(key) = env_value(request, "OPENAI_API_KEY").or_else(|| env_value(request, "CODEX_API_KEY")) {
        http = http.header("authorization", format!("Bearer {key}"));
    }
    let response = http.json(&Value::Object(payload)).send().await.map_err(|e| fail(e.to_string()))?;
    let status = response.status();
    let body_text = response.text().await.map_err(|e| fail(e.to_string()))?;
    let body: Value = serde_json::from_str(&body_text).unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = body
            .get("error")
            .and_then(|e| e.get("message").or_else(|| e.get("code")))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| body_text.chars().take(500).collect());
        return Err(fail(format!("Image API request failed ({}): {detail}", status.as_u16())));
    }
    let first = body.get("data").and_then(Value::as_array).and_then(|d| d.first()).cloned().unwrap_or(Value::Null);
    let base64_data = first.get("b64_json").and_then(Value::as_str).map(str::to_string);
    let remote_url = first.get("url").and_then(Value::as_str).map(str::to_string);
    let bytes: Vec<u8> = match (base64_data, remote_url) {
        (Some(b64), _) => BASE64.decode(b64).map_err(|e| fail(e.to_string()))?,
        (None, Some(url)) => {
            let response = client.get(&url).send().await.map_err(|e| fail(e.to_string()))?;
            if !response.status().is_success() {
                return Err(fail(format!("Image API image download failed ({})", response.status().as_u16())));
            }
            response.bytes().await.map_err(|e| fail(e.to_string()))?.to_vec()
        }
        (None, None) => return Err(fail("Image API returned no image data")),
    };
    if bytes.is_empty() {
        return Err(fail("Image API returned an empty image"));
    }

    let (path, name) = allocate_output_path(&request.cwd, input.get("filename").and_then(Value::as_str), output_format)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, &bytes))
        .map_err(|e| fail(e.to_string()))?;
    let mime = if output_format == "jpeg" { "image/jpeg" } else { "image/png" };
    let mime = if output_format == "webp" { "image/webp" } else { mime };
    Ok(json!({
        "path": path,
        "name": name,
        "mimeType": mime,
        "content": format!("Image generated and saved to {path}")
    }))
}

fn allocate_output_path(cwd: &str, requested: Option<&str>, format: &str) -> CoreResult<(String, String)> {
    let output_dir = Path::new(cwd).join("output").join("imagegen");
    std::fs::create_dir_all(&output_dir).map_err(|e| fail(e.to_string()))?;
    let extension = if format == "jpeg" { ".jpg" } else { ".png" };
    let extension = if format == "webp" { ".webp" } else { extension };
    let raw_name = requested
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|name| Path::new(name).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("generated-{}-{}{}", chrono::Utc::now().timestamp_millis(), &Uuid::new_v4().to_string()[..8], extension));
    let stem = Path::new(&raw_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| raw_name.clone());
    let stem: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let stem = if stem.is_empty() { "generated-image".to_string() } else { stem };
    let mut candidate = output_dir.join(format!("{stem}{extension}"));
    while candidate.exists() {
        candidate = output_dir.join(format!("{stem}-{}{extension}", &Uuid::new_v4().to_string()[..8]));
    }
    // The output must stay inside the workspace.
    let workspace = std::fs::canonicalize(cwd).unwrap_or_else(|_| Path::new(cwd).to_path_buf());
    let absolute = std::fs::canonicalize(&output_dir).unwrap_or(output_dir.clone());
    if !absolute.starts_with(&workspace) {
        return Err(fail("image_gen output path escaped the workspace"));
    }
    let name = candidate.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok((candidate.to_string_lossy().into_owned(), name))
}
