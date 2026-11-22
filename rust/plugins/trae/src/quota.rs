use super::native_api;
use serde_json::{json, Value};

pub async fn read(instance: &Value, context: &Value) -> anyhow::Result<Value> {
    let Some(rpc) = native_api::open(instance, context).await? else {
        return Ok(json!({"windows": []}));
    };
    let response = rpc.request("model/internalUsage/read", json!({})).await;
    native_api::close(rpc).await;
    match response {
        Ok(report) => Ok(parse_report(&report)),
        Err(error) if native_api::needs_login(&error) => {
            Ok(json!({"windows": [], "unavailableReason": "sign_in"}))
        }
        Err(error) if error.to_string().eq_ignore_ascii_case("Method not found") => Ok(json!({"windows": []})),
        Err(_) => anyhow::bail!("TRAE 企业版 CLI 未能返回额度，请检查登录、网络和 CLI 版本"),
    }
}

/// The native server reports the weekly basic quota and per-model daily limits.
/// Keep its numbers in their original units, without assigning a currency.
fn parse_report(report: &Value) -> Value {
    let weekly = &report["usage"];
    let mut windows = Vec::new();
    if let Some(window) = window("weekly", None, 10_080, &weekly["usage_percent"],
        &weekly["quota_remaining"], &weekly["quota_limit"], &weekly["reset_time"]) {
        windows.push(window);
    }
    let mut seen = std::collections::HashSet::new();
    for daily in report["dailyUsage"].as_array().into_iter().flatten() {
        let Some(key) = daily["quotaKey"].as_str().filter(|key| !key.trim().is_empty()) else { continue; };
        if !seen.insert(key) { continue; }
        if let Some(window) = window(&format!("daily:{key}"), Some(key), 1_440, &daily["usagePercent"],
            &daily["quotaRemaining"], &daily["quotaLimit"], &daily["resetTime"]) {
            windows.push(window);
        }
    }
    json!({"windows": windows})
}

fn window(id: &str, label: Option<&str>, minutes: u32, used: &Value, remaining: &Value, total: &Value, reset: &Value) -> Option<Value> {
    let used = used.as_f64().filter(|value| (0.0..=100.0).contains(value))?;
    let mut result = json!({"id": id, "usedPercent": used, "windowMinutes": minutes});
    if let Some(label) = label { result["label"] = json!(label); }
    if let (Some(remaining), Some(total)) = (quota_number(remaining), quota_number(total)) {
        result["remainingQuota"] = json!(remaining);
        result["totalQuota"] = json!(total);
    }
    if let Some(epoch) = reset.as_i64().or_else(|| reset.as_str()?.parse().ok()).filter(|value| *value > 0) {
        let time = if epoch >= 100_000_000_000 {
            chrono::DateTime::from_timestamp_millis(epoch)
        } else {
            chrono::DateTime::from_timestamp(epoch, 0)
        };
        if let Some(time) = time { result["resetsAt"] = json!(time.to_rfc3339()); }
    }
    Some(result)
}

fn quota_number(value: &Value) -> Option<String> {
    let text = match value {
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.trim().to_owned(),
        _ => return None,
    };
    let number = text.parse::<f64>().ok()?;
    (number.is_finite() && number >= 0.0 && text.len() <= 64).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_native_quota_without_inventing_missing_values() {
        let report = json!({
            "usage": {"usage_percent": 28.5, "quota_remaining": 143, "quota_limit": 200, "reset_time": 1_700_000_000},
            "dailyUsage": [
                {"quotaKey":"enterprise-model", "usagePercent": 100, "quotaRemaining": "0.00", "quotaLimit": "50.00", "resetTime": 1_700_000_000_000_i64},
                {"quotaKey":"bad", "usagePercent": 101}
            ]
        });
        let windows = parse_report(&report)["windows"].as_array().unwrap().clone();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0]["windowMinutes"], 10080);
        assert_eq!(windows[0]["remainingQuota"], "143");
        assert_eq!(windows[1]["remainingQuota"], "0.00");
        assert_eq!(windows[1]["windowMinutes"], 1440);
        assert_eq!(windows[1]["resetsAt"], windows[0]["resetsAt"]);
        assert_eq!(parse_report(&json!({"usage": null, "dailyUsage": null})), json!({"windows":[]}));
    }
}
