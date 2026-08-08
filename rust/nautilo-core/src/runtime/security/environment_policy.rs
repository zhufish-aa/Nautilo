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
