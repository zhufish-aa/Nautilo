//! Secret redaction — port of runtime/security/redaction-service.ts.

use std::sync::{Arc, OnceLock};

use regex::Regex;
use serde_json::Value;

fn secret_field() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(?:api[_-]?key|token|secret|password|authorization|credential)").unwrap())
}

fn secret_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~-]{8,})\b").unwrap())
}

fn safe_telemetry_field() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?:(?:input|output|cachedInput|cacheCreationInput|reasoningOutput)Tokens|inputTokensIncludesCache)$").unwrap())
}

#[derive(Clone)]
pub struct RedactionService {
    values: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
}

impl Default for RedactionService {
    fn default() -> Self {
        Self { values: Arc::new(Vec::new) }
    }
}

impl RedactionService {
    pub fn new(values: Arc<dyn Fn() -> Vec<String> + Send + Sync>) -> Self {
        Self { values }
    }

    pub fn text(&self, value: &str) -> String {
        let mut result = secret_pattern().replace_all(value, "[REDACTED]").into_owned();
        for secret in (self.values)().into_iter().filter(|item| item.len() >= 4) {
            result = result.replace(&secret, "[REDACTED]");
        }
        result
    }

    pub fn value(&self, input: &Value) -> Value {
        self.redact(input, None)
    }

    fn redact(&self, input: &Value, key: Option<&str>) -> Value {
        if let Some(key) = key {
            if !safe_telemetry_field().is_match(key) && secret_field().is_match(key) {
                return Value::String("[REDACTED]".to_string());
            }
        }
        match input {
            Value::String(text) => Value::String(self.text(text)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.redact(item, None)).collect()),
            Value::Object(map) => Value::Object(
                map.iter().map(|(field, value)| (field.clone(), self.redact(value, Some(field)))).collect(),
            ),
            _ => input.clone(),
        }
    }
}

