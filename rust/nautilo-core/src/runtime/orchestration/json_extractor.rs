//! JSON extraction — port of runtime/orchestration/json-extractor.ts.

use serde_json::Value;

/// Extracts the last balanced JSON object from a provider's text response.
pub fn extract_json_object(text: &str) -> anyhow::Result<Value> {
    let trimmed = text.trim();
    // Strip a single surrounding Markdown fence.
    let unfenced = {
        let without_prefix = regex::Regex::new(r"(?i)^```(?:json)?\s*")
            .map(|re| re.replace(trimmed, "").to_string())
            .unwrap_or_else(|_| trimmed.to_string());
        regex::Regex::new(r"\s*```$")
            .map(|re| re.replace(&without_prefix, "").to_string())
            .unwrap_or_else(|_| without_prefix)
    };
    if let Ok(value) = serde_json::from_str::<Value>(unfenced.trim()) {
        if value.is_object() {
            return Ok(value);
        }
    }

    let mut candidates: Vec<String> = vec![];
    let mut start: Option<usize> = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, character) in text.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => {
                if depth == 0 {
                    start = Some(index);
                }
                depth += 1;
            }
            '}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    if let Some(start) = start {
                        candidates.push(text[start..=index].to_string());
                    }
                }
            }
            _ => {}
        }
    }
    for candidate in candidates.iter().rev() {
        if let Ok(value) = serde_json::from_str::<Value>(candidate) {
            if value.is_object() {
                return Ok(value);
            }
        }
    }
    anyhow::bail!("No valid JSON object was found in the Agent response")
}
