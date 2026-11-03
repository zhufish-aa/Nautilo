//! Environment policy — port of runtime/security/environment-policy.ts.

use std::collections::HashMap;

use serde_json::Value;

const PLATFORM_KEYS_WINDOWS: [&str; 12] = [
    "PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA",
    "LOCALAPPDATA",
];
const PLATFORM_KEYS_UNIX: [&str; 6] = ["PATH", "HOME", "TMPDIR", "SHELL", "LANG", "LC_ALL"];

pub fn default_environment_allowlist() -> Vec<String> {
    let platform: Vec<&str> = if cfg!(windows) { PLATFORM_KEYS_WINDOWS.to_vec() } else { PLATFORM_KEYS_UNIX.to_vec() };
    platform.into_iter().chain(["CI", "NO_COLOR", "TERM"]).map(str::to_string).collect()
}

/// Extra env for provider processes, sourced from the shell environment and
/// the instance's providerOptions. Which variables pass through comes from
/// the provider's descriptor. Stored credentials are merged on top by callers.
pub fn provider_environment_passthrough(instance: &Value, descriptor: Option<&Value>) -> HashMap<String, String> {
    let mut additions = HashMap::new();
    let keys: Vec<&str> = descriptor
        .and_then(|d| d.get("envPassthrough"))
        .and_then(Value::as_array)
        .map(|keys| keys.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let process_env: HashMap<String, String> = std::env::vars().collect();
    for key in keys {
        if let Some(value) = lookup(&process_env, key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            additions.insert(key.to_string(), value);
        }
    }
    if let Some(base_url_env) = descriptor.and_then(|d| d.get("baseUrlEnv")).and_then(Value::as_str) {
        if let Some(base_url) = instance
            .get("providerOptions")
            .and_then(|o| o.get("baseUrl"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            additions.insert(base_url_env.to_string(), base_url.to_string());
        }
    }
    additions
}

/// Case-insensitive lookup: Windows typically spells it "Path".
fn lookup(env: &HashMap<String, String>, key: &str) -> Option<String> {
    env.iter().find(|(name, _)| name.eq_ignore_ascii_case(key)).map(|(_, value)| value.clone())
}

/// Builds the exact child environment from the policy allowlist plus additions.
pub fn build_environment(policy: Option<&Value>, additions: HashMap<String, String>) -> HashMap<String, String> {
    let allowed: Vec<String> = policy
        .and_then(|p| p.get("environmentAllowlist"))
        .and_then(Value::as_array)
        .map(|keys| keys.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>())
        .filter(|keys| !keys.is_empty())
        .unwrap_or_else(default_environment_allowlist);
    let process_env: HashMap<String, String> = std::env::vars().collect();
    let mut environment = HashMap::new();
    for key in allowed {
        if let Some(value) = lookup(&process_env, &key) {
            environment.insert(key, value);
        }
    }
    for (key, value) in additions {
        environment.insert(key, value);
    }
    environment
}

/// Validates metadata only; the CLI owns credentials and authentication.
pub fn login_profile_directory(instance: &Value) -> crate::errors::CoreResult<Option<String>> {
    use crate::errors::invalid;
    let raw = instance.get("providerOptions").and_then(|o| o.get("loginProfileDirectory"));
    if raw.is_none() || raw == Some(&Value::String(String::new())) { return Ok(None); }
    let directory = raw.and_then(Value::as_str).unwrap_or("").trim();
    if directory.is_empty() || !std::path::Path::new(directory).is_absolute() || directory.chars().any(|c| c == '\r' || c == '\n' || c == '\0') {
        return Err(invalid("loginProfileDirectory", "Use an absolute account configuration directory"));
    }
    let provider = instance.get("providerId").and_then(Value::as_str).unwrap_or("");
    if provider != "codex" && provider != "claude-code" {
        return Err(invalid("loginProfileDirectory", "This harness does not support isolated login profiles"));
    }
    if instance.get("providerOptions").and_then(|o| o.get("baseUrl")).and_then(Value::as_str).is_some_and(|s| !s.is_empty())
        || instance.get("baseArgs").and_then(Value::as_array).is_some_and(|v| !v.is_empty())
        || instance.get("profile").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
        return Err(invalid("loginProfileDirectory", "Account profiles cannot be combined with API endpoints, CLI profiles, or custom arguments"));
    }
    Ok(Some(directory.to_string()))
}

/// Apply after all policy and vault merges so a chosen login cannot be overridden.
pub fn isolate_login_profile(instance: &Value, mut environment: HashMap<String, String>) -> crate::errors::CoreResult<HashMap<String, String>> {
    if let Some(directory) = login_profile_directory(instance)? {
        environment.retain(|key, _| {
            let key = key.to_ascii_uppercase();
            !["OPENAI_", "CODEX_", "ANTHROPIC_", "CLAUDE_CODE_OAUTH", "CLAUDE_CODE_API", "CLAUDE_CODE_USE_", "CLAUDE_CODE_SESSION_ACCESS"].iter().any(|prefix| key.starts_with(prefix))
                && key != "CLAUDE_CONFIG_DIR" && key != "AGENTHUB_API_KEY"
        });
        let key = if instance.get("providerId").and_then(Value::as_str) == Some("codex") { "CODEX_HOME" } else { "CLAUDE_CONFIG_DIR" };
        if key == "CLAUDE_CONFIG_DIR" {
            environment.insert("ANTHROPIC_CONFIG_DIR".to_string(), std::path::Path::new(&directory).join("anthropic").to_string_lossy().into_owned());
        }
        environment.insert(key.to_string(), directory);
    }
    Ok(environment)
}

#[cfg(test)]
mod login_profile_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn account_environment_overrides_api_credentials() {
        let directory = std::env::temp_dir().join("nautilo-account-test").to_string_lossy().to_string();
        let instance = json!({ "providerId": "codex", "baseArgs": [], "providerOptions": { "loginProfileDirectory": directory } });
        let env = HashMap::from([("OPENAI_API_KEY".to_string(), "secret".to_string()), ("PATH".to_string(), "bin".to_string()), ("CODEX_HOME".to_string(), "wrong".to_string())]);
        let isolated = isolate_login_profile(&instance, env).unwrap();
        assert_eq!(isolated.get("CODEX_HOME"), Some(&directory));
        assert!(!isolated.contains_key("OPENAI_API_KEY"));
        assert_eq!(isolated.get("PATH").map(String::as_str), Some("bin"));
    }

    #[test]
    fn claude_accounts_override_the_global_federation_config_root() {
        let directory = std::env::temp_dir().join("nautilo-claude-account");
        let instance = json!({ "providerId": "claude-code", "baseArgs": [], "providerOptions": { "loginProfileDirectory": directory.to_string_lossy() } });
        let env = HashMap::from([
            ("HOME".to_string(), "unchanged-user-home".to_string()),
            ("ANTHROPIC_CONFIG_DIR".to_string(), "global-root".to_string()),
            ("ANTHROPIC_PROFILE".to_string(), "global-federation-profile".to_string()),
        ]);
        let isolated = isolate_login_profile(&instance, env).unwrap();
        assert_eq!(isolated.get("ANTHROPIC_CONFIG_DIR"), Some(&directory.join("anthropic").to_string_lossy().into_owned()));
        assert_eq!(isolated.get("CLAUDE_CONFIG_DIR"), Some(&directory.to_string_lossy().into_owned()));
        assert!(!isolated.contains_key("ANTHROPIC_PROFILE"));
        assert_eq!(isolated.get("HOME").map(String::as_str), Some("unchanged-user-home"));
    }

    #[test]
    fn rejects_relative_and_unsupported_profiles() {
        assert!(login_profile_directory(&json!({ "providerId": "codex", "providerOptions": { "loginProfileDirectory": "relative" } })).is_err());
        let directory = std::env::temp_dir().to_string_lossy().to_string();
        assert!(login_profile_directory(&json!({ "providerId": "kimi", "providerOptions": { "loginProfileDirectory": directory } })).is_err());
    }
}
