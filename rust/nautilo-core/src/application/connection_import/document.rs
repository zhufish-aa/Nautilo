//! Bounded, read-only native configuration access. Never execute key helpers.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

pub const FILE_LIMIT: u64 = 4 * 1024 * 1024;

pub struct Documents {
    pub env: HashMap<String, String>,
    pub reports: Vec<Value>,
}
impl Documents {
    pub fn read(&mut self, harness: &str, path: &Path) -> Value {
        if !path.exists() {
            return Value::Null;
        }
        let result = (|| -> Option<Value> {
            if std::fs::metadata(path).ok()?.len() > FILE_LIMIT {
                return None;
            }
            let text = std::fs::read_to_string(path).ok()?;
            let text = text.trim_start_matches('\u{feff}');
            match path.extension().and_then(|x| x.to_str()).unwrap_or("") {
                "toml" => toml_edit::de::from_str::<Value>(text).ok(),
                "yml" | "yaml" => serde_yaml::from_str::<Value>(text).ok(),
                _ => crate::runtime::config_document::json_get(text, &[])
                    .ok()
                    .flatten(),
            }
        })();
        self.reports.push(json!({"harness":harness,"path":path.to_string_lossy(),"status":if result.is_some(){"read"}else{"error"},
            "error":if result.is_some(){Value::Null}else{json!("CONFIG_UNREADABLE")}}));
        result.unwrap_or(Value::Null)
    }
    pub fn key(&self, value: &Value, refs: &Value, directory: &Path) -> Option<String> {
        let raw = value.as_str()?.trim();
        if raw.is_empty() || raw.starts_with('!') || raw.starts_with("sk-ant-oat") {
            return None;
        }
        let env_name = raw
            .strip_prefix("{env:")
            .and_then(|s| s.strip_suffix('}'))
            .or_else(|| raw.strip_prefix("${").and_then(|s| s.strip_suffix('}')));
        if let Some(name) = env_name {
            return refs[name]
                .as_str()
                .or_else(|| self.env.get(name).map(String::as_str))
                .and_then(clean_key);
        }
        if let Some(file) = raw.strip_prefix("{file:").and_then(|s| s.strip_suffix('}')) {
            let path = if let Some(tail) = file.strip_prefix("~/") {
                PathBuf::from(
                    self.env
                        .get("HOME")
                        .or_else(|| self.env.get("USERPROFILE"))?,
                )
                .join(tail)
            } else {
                directory.join(file)
            };
            if std::fs::metadata(&path).ok()?.len() > 64 * 1024 {
                return None;
            }
            return clean_key(&std::fs::read_to_string(path).ok()?);
        }
        if raw.contains("${") || raw.starts_with('{') || raw.contains('\n') {
            return None;
        }
        if raw
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            && raw.contains('_')
        {
            return refs[raw]
                .as_str()
                .or_else(|| self.env.get(raw).map(String::as_str))
                .and_then(clean_key);
        }
        clean_key(raw)
    }
}
pub fn clean_key(raw: &str) -> Option<String> {
    let value = raw.trim();
    (!value.is_empty()
        && !value.starts_with("sk-ant-oat")
        && !value.contains('\n')
        && value.len() <= 32768)
        .then(|| value.to_string())
}
pub fn text<'a>(value: &'a Value, fields: &[&str]) -> Option<&'a str> {
    fields
        .iter()
        .find_map(|field| value[*field].as_str().filter(|s| !s.trim().is_empty()))
}
