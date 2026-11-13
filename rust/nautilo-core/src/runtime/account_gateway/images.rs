//! Turn-local image attachment validation and materialization.
use super::hash;
use base64::Engine;
use serde_json::{json, Value};

pub(super) fn without_image_data(value: &Value) -> Value {
    match value {
        Value::Array(a) => json!(a.iter().map(without_image_data).collect::<Vec<_>>()),
        Value::Object(o) if o.get("type").and_then(Value::as_str) == Some("image_url") => {
            json!({"type":"text","text":"[Image attached to this native request]"})
        }
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), without_image_data(v)))
                .collect(),
        ),
        _ => value.clone(),
    }
}
pub(super) fn materialize_images(
    messages: &[Value],
    cwd: &str,
) -> anyhow::Result<Option<Vec<String>>> {
    let mut paths = vec![];
    for m in messages {
        for block in m["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["type"] == "image_url")
        {
            let url = block["image_url"]["url"].as_str().unwrap_or("");
            let (meta, data) = url
                .split_once(',')
                .filter(|(meta, _)| meta.starts_with("data:image/") && meta.ends_with(";base64"))
                .ok_or_else(|| {
                    anyhow::anyhow!("Account relay images must use a data:image base64 URL")
                })?;
            let ext = if meta.contains("image/png") {
                "png"
            } else if meta.contains("image/jpeg") {
                "jpg"
            } else if meta.contains("image/webp") {
                "webp"
            } else {
                anyhow::bail!("Unsupported image format")
            };
            anyhow::ensure!(
                data.len() <= 16 * 1024 * 1024 && paths.len() < 8,
                "Image limit exceeded"
            );
            let root = std::env::temp_dir().join("nautilo-account-relay-images");
            std::fs::create_dir_all(&root)?;
            let path = root.join(format!("{}.{ext}", hash(&json!(data))));
            if !path.exists() {
                std::fs::write(
                    &path,
                    base64::engine::general_purpose::STANDARD.decode(data)?,
                )?;
            }
            let _ = cwd;
            paths.push(path.to_string_lossy().into_owned());
        }
    }
    Ok((!paths.is_empty()).then_some(paths))
}

#[cfg(test)]
mod tests {
    use super::without_image_data;
    use serde_json::json;

    #[test]
    fn ordinary_chat_messages_do_not_require_a_type_field() {
        let messages = json!([
            {"role": "system", "content": "Follow the user's request."},
            {"role": "user", "content": "hi"},
            {"role": "user", "content": [{"type": "text", "text": "你好"}]}
        ]);
        assert_eq!(without_image_data(&messages), messages);
    }

    #[test]
    fn mixed_content_preserves_roles_and_replaces_only_image_blocks() {
        let messages = json!([{
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe this image"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,cHJpdmF0ZQ=="}}
            ],
            "metadata": {"label": "image_url", "empty": {}}
        }]);
        let sanitized = without_image_data(&messages);
        assert_eq!(sanitized[0]["role"], "user");
        assert_eq!(sanitized[0]["content"][0], messages[0]["content"][0]);
        assert_eq!(sanitized[0]["content"][1], json!({
            "type": "text", "text": "[Image attached to this native request]"
        }));
        assert_eq!(sanitized[0]["metadata"], messages[0]["metadata"]);
    }
}
