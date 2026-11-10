use std::collections::HashMap;
use serde_json::{json, Value};

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
