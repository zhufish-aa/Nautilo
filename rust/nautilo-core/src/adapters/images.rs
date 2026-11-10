use base64::Engine;
use serde_json::{json, Value};
use super::AdapterStartRequest;

pub fn prompt_blocks(request: &AdapterStartRequest, anthropic: bool) -> anyhow::Result<Vec<Value>> {
    let mut content = vec![json!({"type":"text","text":request.prompt})];
    for name in request.local_image_paths.as_deref().unwrap_or(&[]) {
        let mime = match name.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
            "png"=>"image/png", "jpg"|"jpeg"=>"image/jpeg", "webp"=>"image/webp", "gif"=>"image/gif",
            _=>anyhow::bail!("Unsupported image attachment: {name}")
        };
        let path = std::path::Path::new(name);
        let path = if path.is_absolute() {path.to_path_buf()} else {std::path::Path::new(&request.cwd).join(path)};
        let bytes = std::fs::read(&path).map_err(|error|anyhow::anyhow!("Unable to read image {}: {error}",path.display()))?;
        anyhow::ensure!(!bytes.is_empty(),"Image attachment is empty: {}",path.display());
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        content.push(if anthropic { json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}}) }
            else {json!({"type":"image","mimeType":mime,"data":data})});
    }
    Ok(content)
}

/// Prompt-mode CLIs keep attachment paths in their native conversation history.
pub fn prompt_with_image_files(request: &AdapterStartRequest) -> anyhow::Result<String> {
    if request.local_image_paths.as_ref().is_none_or(|paths|paths.is_empty()) { return Ok(request.prompt.clone()); }
    prompt_blocks(request, false)?; // Validate before starting a paid request.
    let mut prompt = format!("{}\n\nAttached images (inspect them with your native file/image reader):\n", request.prompt);
    for name in request.local_image_paths.as_deref().unwrap_or(&[]) {
        let path = std::path::Path::new(name);
        let path = if path.is_absolute() {path.to_path_buf()} else {std::path::Path::new(&request.cwd).join(path)};
        prompt.push_str(&format!("- {}\n",serde_json::to_string(&path.to_string_lossy())?));
    }
    Ok(prompt)
}
