use super::{credential_key, ConnectionService};
use crate::adapters::codex::read_app_server;
use crate::database::Repositories;
use crate::errors::{invalid, not_found, CoreError, CoreResult, ErrorCode};
use crate::runtime::antigravity_account;
use crate::runtime::opencode_account::OpenCodeAccount;
use crate::runtime::orchestration::member_router::MemberRouter;
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

impl ConnectionService {
    pub(crate) async fn quota(&self, input: &Value) -> CoreResult<Value> {
        if let Some(session_id) = input["sessionId"].as_str() {
            let session = Repositories::new(&self.db.lock().unwrap().raw).sessions().get(session_id)?
                .ok_or_else(|| not_found("session", session_id))?;
            if !session["connectionId"].is_null() {
                return Ok(json!({"windows":[]}));
            }
            let agent = MemberRouter::new(self.db.clone()).resolve_session(&session)?;
            if agent["providerId"] != "kimi-code" {
                return self.native_agent_quota(&agent).await;
            }
            if agent["providerOptions"]["baseUrl"].is_string()
                || agent["profile"].as_str().is_some_and(|profile| !profile.is_empty())
                || agent["baseArgs"].as_array().is_some_and(|args| !args.is_empty()) {
                return Ok(json!({"windows":[]}));
            }
            let home = std::env::var_os("KIMI_CODE_HOME").filter(|value| !value.is_empty())
                .map(std::path::PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".kimi-code")));
            let Some(home) = home else { return Ok(json!({"windows":[]})); };
            return Ok(json!({"windows":read_kimi_quota(&home, session["model"].as_str()).await?}));
        }
        if let Some(agent_id) = input["agentInstanceId"].as_str() {
            let agent = Repositories::new(&self.db.lock().unwrap().raw).agents().get(agent_id)?
                .ok_or_else(|| not_found("harness", agent_id))?;
            if agent["providerOptions"]["configurationKind"] != "harness" {
                return Ok(json!({"windows":[]}));
            }
            return self.native_agent_quota(&agent).await;
        }
        let id = input["connectionId"].as_str().unwrap_or("");
        let connection = self.get(id, input["revision"].as_u64())?;
        if connection["enabled"] != true {
            return Err(invalid("connectionId", "Select an enabled account to read subscription limits"));
        }
        if connection["kind"] == "api" {
            let Some(url) = subscription_endpoint(connection["baseUrl"].as_str().unwrap_or("")) else {
                return Ok(json!({"windows":[]}));
            };
            let credential = self.credentials.read(&credential_key(id, connection["revision"].as_u64().unwrap()))?;
            let Some(key) = credential.as_ref().and_then(|value| value["apiKey"].as_str()) else {
                return Ok(json!({"windows":[]}));
            };
            let report = usage_report(&url, key).await?;
            let windows = if url == OPENCODE_USAGE { opencode_windows(&report) } else { kimi_windows(&report) };
            return Ok(json!({"windows":windows}));
        }
        let provider = connection["harness"].as_str().unwrap_or("");
        let windows = match provider {
            "codex" => {
                let (agent, env) = self.login_probe(&connection, None)?;
                let response = read_app_server(&agent, &env, "account/rateLimits/read", Value::Null).await?;
                if !response["error"].is_null() {
                    return Err(unavailable("Codex did not return subscription limits"));
                }
                codex_windows(&response["result"])
            }
            "claude-code" => {
                // A pinned profile must never read the machine's other Claude account.
                let directory = connection["loginProfileDirectory"].as_str()
                    .ok_or_else(|| invalid("loginProfileDirectory", "Claude Code account profile is missing"))?;
                claude_windows(&read_claude(Path::new(directory)).await?)
            }
            "kimi-code" => {
                let directory = connection["loginProfileDirectory"].as_str()
                    .ok_or_else(|| invalid("loginProfileDirectory", "Kimi Code account profile is missing"))?;
                read_kimi_quota(Path::new(directory), None).await?
            }
            "antigravity" => {
                let (agent, env) = self.login_probe(&connection, None)?;
                let directory = self.credentials.connection_directory(id, connection["revision"].as_u64().unwrap()).join("quota");
                let report = antigravity_account::read_quota(&directory, agent["executable"].as_str().unwrap(), &env).await
                    .map_err(|_| unavailable("Antigravity did not return subscription limits"))?;
                antigravity_windows(&report)
            }
            "opencode" => {
                let (_, env) = self.login_probe(&connection, None)?;
                let key = OpenCodeAccount::quota_key(&connection, &env).await
                    .map_err(|_| unavailable("The selected OpenCode account did not provide a Go credential"))?;
                opencode_windows(&usage_report(OPENCODE_USAGE, &key).await?)
            }
            _ => Vec::new(),
        };
        Ok(json!({ "windows": windows }))
    }

    async fn native_agent_quota(&self, agent: &Value) -> CoreResult<Value> {
        let Some(adapter) = agent["providerId"].as_str().and_then(|provider| self.adapters.find(provider)) else {
            return Ok(json!({"windows":[]}));
        };
        let descriptor = adapter.descriptor();
        if descriptor["nativeAccountQuota"] != true || agent["enabled"] != true
            || agent["providerOptions"]["baseUrl"].as_str().is_some_and(|url| !url.trim().is_empty())
            || self.credentials.has(agent["id"].as_str().unwrap_or(""))? {
            return Ok(json!({"windows":[]}));
        }
        let additions = super::provider_environment_passthrough(agent, Some(&descriptor));
        let env = super::isolate_login_profile(agent, super::build_environment(None, additions))?;
        adapter.account_quota(agent, &json!({"env": env})).await
    }
}

const OPENCODE_USAGE: &str = "https://opencode.ai/inference/go/v1/usage";

async fn read_kimi_quota(home: &Path, model: Option<&str>) -> CoreResult<Vec<Value>> {
    let config = tokio::fs::read_to_string(home.join("config.toml")).await.unwrap_or_default();
    let Some(url) = kimi_oauth_config(&config, model) else { return Ok(Vec::new()); };
    let file = tokio::fs::read(home.join("credentials").join("kimi-code.json")).await
        .map_err(|_| unavailable("No readable Kimi Code login for the configured model"))?;
    let auth: Value = serde_json::from_slice(&file).map_err(|_| unavailable("Invalid Kimi Code login"))?;
    let token = auth["access_token"].as_str().filter(|value| !value.is_empty())
        .ok_or_else(|| unavailable("Sign in to Kimi Code first"))?;
    Ok(kimi_windows(&usage_report(&url, token).await?))
}

fn kimi_oauth_config(text: &str, model: Option<&str>) -> Option<String> {
    let config: Value = toml_edit::de::from_str(text).ok()?;
    let model = model.or(config["default_model"].as_str())?;
    let provider = config["models"][model]["provider"].as_str()?;
    let provider = &config["providers"][provider];
    let oauth = &provider["oauth"];
    let base = provider["base_url"].as_str()?;
    if oauth["storage"] != "file" || oauth["key"] != "oauth/kimi-code"
        || !["api.kimi.com", "api.kimi.ai"].iter().any(|host| base.starts_with(&format!("https://{host}/"))) {
        return None;
    }
    subscription_endpoint(base)
}

fn subscription_endpoint(base: &str) -> Option<String> {
    let base = base.trim_end_matches('/');
    match base {
        "https://opencode.ai/zen/go/v1" | "https://opencode.ai/inference/go/v1"
        | "https://opencode.ai/inference/go/openai/v1" | "https://opencode.ai/inference/go/anthropic/v1"
        | "https://opencode.ai/inference/go/openai-responses/v1" => Some(OPENCODE_USAGE.into()),
        "https://api.kimi.com/coding" | "https://api.kimi.com/coding/v1" => Some("https://api.kimi.com/coding/v1/usages".into()),
        "https://api.kimi.ai/coding" | "https://api.kimi.ai/coding/v1" => Some("https://api.kimi.ai/coding/v1/usages".into()),
        _ => None,
    }
}

async fn usage_report(url: &str, key: &str) -> CoreResult<Value> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none()).build()
        .map_err(|_| unavailable("Could not start quota lookup"))?;
    let response = client.get(url).bearer_auth(key).send().await
        .map_err(|_| unavailable("Could not reach account quota service"))?;
    if !response.status().is_success() {
        return Err(unavailable(&format!("Account quota service returned {}", response.status().as_u16())));
    }
    response.json().await.map_err(|_| unavailable("The account returned an invalid usage report"))
}

fn opencode_windows(report: &Value) -> Vec<Value> {
    [("rolling", None, Some(300)), ("weekly", None, Some(10080)), ("monthly", Some("Monthly"), None)]
        .into_iter().filter_map(|(id, label, period)| {
            let entry = &report["usage"][id];
            window(id.into(), label, &entry["percent"], period, rfc3339(&entry["resetsAt"]))
        }).collect()
}

fn kimi_windows(report: &Value) -> Vec<Value> {
    let entries = &report["usages"];
    [
        ("limit_5h", None, Some(300)),
        ("limit_7d", None, Some(10080)),
        ("limit_month_total", Some("Monthly"), None),
        ("limit_month_code", Some("Monthly · Code"), None),
    ].into_iter().filter_map(|(id, label, period)| {
        let entry = &entries[id];
        let ratio = entry["used_ratio"].as_f64().or_else(|| entry["used_ratio"].as_str()?.parse::<f64>().ok())?;
        window(id.into(), label, &json!(100.0 * ratio), period, rfc3339(&entry["reset_time"]))
    }).collect()
}

fn unavailable(message: &str) -> CoreError {
    CoreError::reason(ErrorCode::IpcInternalError, message)
}

async fn read_claude(directory: &Path) -> CoreResult<Value> {
    let file = tokio::fs::read(directory.join(".credentials.json")).await
        .map_err(|_| unavailable("The selected Claude Code profile has no readable OAuth login"))?;
    let auth: Value = serde_json::from_slice(&file)
        .map_err(|_| unavailable("The selected Claude Code profile has no valid OAuth login"))?;
    let token = auth.pointer("/claudeAiOauth/accessToken").and_then(Value::as_str).filter(|token| !token.is_empty())
        .ok_or_else(|| unavailable("Sign in to the selected Claude Code profile first"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| unavailable("Could not start Claude Code quota lookup"))?;
    let response = client.get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send().await.map_err(|_| unavailable("Could not reach Claude Code quota service"))?;
    if !response.status().is_success() {
        return Err(unavailable(&format!("Claude Code quota service returned {}", response.status().as_u16())));
    }
    response.json().await.map_err(|_| unavailable("Claude Code returned an invalid usage report"))
}

fn window(id: String, label: Option<&str>, used: &Value, minutes: Option<u64>, reset: Option<String>) -> Option<Value> {
    let used = used.as_f64().filter(|used| (0.0..=100.0).contains(used))?;
    let mut result = json!({ "id": id, "usedPercent": used });
    if let Some(label) = label { result["label"] = json!(label); }
    if let Some(minutes) = minutes.filter(|period| *period > 0) { result["windowMinutes"] = json!(minutes); }
    if let Some(reset) = reset { result["resetsAt"] = json!(reset); }
    Some(result)
}

fn rfc3339(value: &Value) -> Option<String> {
    let time = chrono::DateTime::parse_from_rfc3339(value.as_str()?).ok()?;
    Some(time.to_rfc3339())
}

fn codex_windows(report: &Value) -> Vec<Value> {
    let pools: Vec<_> = match report["rateLimitsByLimitId"].as_object().filter(|pools| !pools.is_empty()) {
        Some(pools) => pools.iter().map(|(id, pool)| (id.as_str(), pool)).collect(),
        None => vec![("codex", &report["rateLimits"])],
    };
    pools.into_iter().flat_map(|(id, pool)| {
        ["primary", "secondary"].into_iter().filter_map(move |slot| {
            let entry = &pool[slot];
            let reset = entry["resetsAt"].as_i64().and_then(|time| chrono::DateTime::from_timestamp(time, 0)).map(|time| time.to_rfc3339());
            let label = pool["limitName"].as_str().or((id != "codex").then_some(id));
            window(format!("{id}:{slot}"), label, &entry["usedPercent"], entry["windowDurationMins"].as_u64(), reset)
        })
    }).collect()
}

fn claude_windows(report: &Value) -> Vec<Value> {
    let windows = [
        ("five_hour", None, 300),
        ("seven_day", None, 10080),
        ("seven_day_sonnet", Some("Sonnet"), 10080),
        ("seven_day_opus", Some("Opus"), 10080),
    ];
    windows.into_iter().filter_map(|(id, label, period)| {
        let entry = &report[id];
        window(id.into(), label, &entry["utilization"], Some(period), rfc3339(&entry["resets_at"]))
    }).collect()
}

fn antigravity_windows(report: &Value) -> Vec<Value> {
    report.as_array().into_iter().flatten().enumerate().filter_map(|(index, entry)| {
        let name = entry["name"].as_str()?;
        let period = entry["span"].as_u64().map(|seconds| seconds / 60);
        let label = if period.is_some() { name.rsplit_once(" · ").map_or(name, |(pool, _)| pool) } else { name };
        window(format!("{name}:{index}"), Some(label), &entry["used"], period, rfc3339(&entry["resetsAt"]))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_named_pools_and_missing_windows() {
        let primary = json!({"usedPercent": 14, "windowDurationMins": 300, "resetsAt": 1_700_000_000});
        let report = json!({"rateLimits":{"primary":primary}, "rateLimitsByLimitId":{
            "codex":{"primary":primary}, "spark":{"limitName":"Spark", "primary":{"usedPercent":100, "windowDurationMins":10080}, "secondary":null}
        }});
        let windows = codex_windows(&report);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0]["resetsAt"], "2023-11-14T22:13:20+00:00");
        assert_eq!(windows[1]["label"], "Spark");
        assert_eq!(windows[1]["usedPercent"], 100.0);
    }

    #[test]
    fn claude_and_antigravity_only_report_measured_windows() {
        let claude = claude_windows(&json!({"five_hour":{"utilization":0,"resets_at":"2026-11-20T10:00:00Z"}, "seven_day":null, "seven_day_sonnet":{"utilization":25.5}}));
        assert_eq!(claude.len(), 2);
        assert_eq!(claude[0]["usedPercent"], 0.0);
        assert_eq!(claude[1]["label"], "Sonnet");
        let agy = antigravity_windows(&json!([
            {"name":"Gemini · 5 hours","span":18000,"used":35},
            {"name":"Gemini · 7 days","span":604800,"used":41},
            {"name":"Claude & GPT · 7 days","span":604800,"used":0},
            {"name":"Other","display":"Limits not available"}
        ]));
        assert_eq!(agy.len(), 3);
        assert_eq!(agy[0]["windowMinutes"], 300);
        assert_eq!(agy[0]["label"], "Gemini");
        assert_eq!(agy[1]["windowMinutes"], 10080);
        assert_eq!(agy[2]["label"], "Claude & GPT");
        assert_eq!(agy[2]["usedPercent"], 0.0);
    }

    #[test]
    fn go_and_kimi_keep_each_reported_window_and_reject_other_origins() {
        assert_eq!(subscription_endpoint("https://opencode.ai/zen/go/v1/").as_deref(), Some(OPENCODE_USAGE));
        assert!(subscription_endpoint("https://opencode.ai.evil.test/zen/go/v1").is_none());
        let go = opencode_windows(&json!({"usage":{"rolling":{"percent":0},"weekly":{"percent":14},"monthly":{}}}));
        assert_eq!(go.len(), 2);
        assert_eq!(go[0]["usedPercent"], 0.0);
        let kimi = kimi_windows(&json!({"usages":{"limit_5h":{"used_ratio":"0.25"},"limit_7d":{"used_ratio":0.2},
            "limit_month_total":{"used_ratio":0.5},"limit_month_code":{"used_ratio":0.75}}}));
        assert_eq!(kimi.len(), 4);
        assert_eq!(kimi[0]["usedPercent"], 25.0);
        assert_eq!(kimi[3]["usedPercent"], 75.0);
    }

    #[test]
    fn kimi_login_uses_only_the_selected_models_actual_oauth_profile() {
        let config = r#"
default_model = "k3"
[models.k3]
provider = "managed:kimi-code"
[models.custom]
provider = "custom"
[providers."managed:kimi-code"]
base_url = "https://api.kimi.com/coding/v1"
[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
"#;
        assert_eq!(kimi_oauth_config(config, None).as_deref(), Some("https://api.kimi.com/coding/v1/usages"));
        assert!(kimi_oauth_config(config, Some("custom")).is_none());
        assert!(kimi_oauth_config(&config.replace("oauth/kimi-code", "oauth/../other"), None).is_none());
    }
}
