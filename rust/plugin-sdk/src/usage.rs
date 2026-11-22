use std::collections::HashMap;
use serde_json::{json, Value};

pub fn acp_prompt_usage(usage: &Value) -> Option<Value> {
    let input = usage["inputTokens"].as_u64();
    let output = usage["outputTokens"].as_u64();
    if input.is_none() && output.is_none() { return None; }
    let read = usage["cachedReadTokens"].as_u64();
    let mut write = usage["cachedWriteTokens"].as_u64();
    let includes_cache = match (input, output, read, usage["totalTokens"].as_u64()) {
        (Some(input), Some(output), Some(read), Some(total)) => {
            let base = u128::from(input) + u128::from(output);
            let total = u128::from(total);
            if total == base && read <= input {
                Some(true)
            } else if total == base + u128::from(read) + u128::from(write.unwrap_or(0)) {
                write = Some(write.unwrap_or(0));
                Some(false)
            } else if read > input {
                Some(false)
            } else {
                None
            }
        }
        (Some(input), _, Some(read), _) if read > input => Some(false),
        _ => None,
    };
    Some(json!({
        "kind":"usage", "usageScope":"turn", "inputTokensIncludesCache":includes_cache,
        "inputTokens":input, "outputTokens":output, "cachedInputTokens":read,
        "cacheCreationInputTokens":write, "reasoningOutputTokens":usage["thoughtTokens"], "raw":usage
    }))
}

#[cfg(test)]
#[test]
fn prompt_usage_preserves_exclusive_input_and_missing_cache() {
    let usage = acp_prompt_usage(&json!({
        "inputTokens":2327, "outputTokens":139, "cachedReadTokens":20736, "totalTokens":23202
    })).unwrap();
    assert_eq!(usage["inputTokensIncludesCache"], false);
    assert_eq!(usage["cachedInputTokens"], 20736);
    assert_eq!(usage["cacheCreationInputTokens"], 0);

    let inclusive = acp_prompt_usage(&json!({
        "inputTokens":23063, "outputTokens":139, "cachedReadTokens":20736, "totalTokens":23202
    })).unwrap();
    assert_eq!(inclusive["inputTokensIncludesCache"], true);

    let unknown = acp_prompt_usage(&json!({
        "inputTokens":2327, "outputTokens":139, "totalTokens":2466
    })).unwrap();
    assert!(unknown["cachedInputTokens"].is_null());
}

/// One accumulator per run/session. Repeated native snapshots replace a request.
#[derive(Default)]
pub struct TurnUsage { requests: HashMap<String, Value> }

impl TurnUsage {
    pub fn update(&mut self, key: &str, usage: &Value) -> Value {
        self.requests.insert(key.to_string(), usage.clone());
        let mut total = json!({"kind":"usage", "usageScope":"turn", "inputTokensIncludesCache":false});
        for field in ["inputTokens", "outputTokens", "cachedInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens"] {
            // Unknown is not zero: only report a total if every request reports it.
            total[field] = self.requests.values().try_fold(0u64, |sum, event| {
                sum.checked_add(event[field].as_u64()?)
            }).map(Value::from).unwrap_or(Value::Null);
        }
        total
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn totals_replace_repeated_requests_and_preserve_unknown_counters() {
        let mut usage = TurnUsage::default();
        let first = json!({"inputTokens":10,"outputTokens":2,"cachedInputTokens":3,"cacheCreationInputTokens":0});
        usage.update("one", &first);
        assert_eq!(usage.update("one", &first)["inputTokens"], 10);
        let total = usage.update("two", &json!({"inputTokens":20,"outputTokens":4,"cachedInputTokens":5}));
        assert_eq!(total["inputTokens"], 30);
        assert_eq!(total["outputTokens"], 6);
        assert_eq!(total["cachedInputTokens"], 8);
        assert!(total["cacheCreationInputTokens"].is_null());
        assert!(total.get("contextUsed").is_none());
    }
}
