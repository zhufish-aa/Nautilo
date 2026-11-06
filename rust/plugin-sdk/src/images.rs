//! Local image validation shared by native provider plugins.
use std::path::PathBuf;
use serde_json::Value;
use base64::Engine;

pub fn acp_prompt(request: &Value) -> anyhow::Result<Vec<Value>> {
    let mut content = vec![serde_json::json!({"type":"text","text":request["prompt"]})];
    for image in read_request_images(request)? {
        content.push(serde_json::json!({"type":"image","mimeType":image.mime_type,
            "data":base64::engine::general_purpose::STANDARD.encode(image.bytes)}));
    }
    Ok(content)
}

/// Text-only CLIs can still use their native image-reading tool. Keep validated
/// attachment references in the prompt rather than silently dropping them.
pub fn prompt_with_image_files(request: &Value) -> anyhow::Result<String> {
    let mut prompt = request["prompt"].as_str().unwrap_or("").to_string();
    let images = read_request_images(request)?;
    if !images.is_empty() {
        prompt.push_str("\n\nAttached images (use your native file/image reader to inspect them):\n");
        for image in images { prompt.push_str(&format!("- {}\n", serde_json::to_string(&image.path.to_string_lossy())?)); }
    }
    Ok(prompt)
}

pub fn image_mime(path: &str) -> Option<&'static str> {
    match path.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

pub struct LocalImage {
    pub path: PathBuf,
    pub mime_type: &'static str,
    pub bytes: Vec<u8>,
}

pub fn read_request_images(request: &Value) -> anyhow::Result<Vec<LocalImage>> {
    let cwd = PathBuf::from(request["cwd"].as_str().unwrap_or("."));
    request["localImagePaths"].as_array().into_iter().flatten().map(|value| {
        let name = value.as_str().ok_or_else(|| anyhow::anyhow!("Invalid image attachment path"))?;
        let mime_type = image_mime(name).ok_or_else(|| anyhow::anyhow!("Unsupported image attachment format: {name}"))?;
        let path = PathBuf::from(name);
        let path = if path.is_absolute() { path } else { cwd.join(path) };
        let bytes = std::fs::read(&path).map_err(|error| anyhow::anyhow!("Unable to read image attachment {}: {error}", path.display()))?;
        anyhow::ensure!(!bytes.is_empty(), "Image attachment is empty: {}", path.display());
        Ok(LocalImage { path, mime_type, bytes })
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_attachment_is_an_error_instead_of_an_empty_prompt() {
        let dir = std::env::temp_dir().join(format!("nautilo-missing-image-{}", std::process::id()));
        assert!(read_request_images(&json!({"cwd":dir,"localImagePaths":["missing.png"]})).is_err());
        assert_eq!(image_mime("photo.JPEG"), Some("image/jpeg"));
        assert_eq!(image_mime("photo.webp"), Some("image/webp"));
        assert_eq!(image_mime("photo.txt"), None);
    }
}
