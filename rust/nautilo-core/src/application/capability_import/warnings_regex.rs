//! Shared secret/placeholder detection for capability imports
//! (the regexes from capability-import/mcp-json.ts).

/// `${env:FOO}`, `${FOO}` and `$FOO` all mean "read FOO from the environment".
pub fn placeholder_env_name(value: &str) -> Option<String> {
    let re = regex::Regex::new(r"^\$(?:\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$").ok()?;
    let captures = re.captures(value.trim())?;
    captures
        .get(1)
        .or_else(|| captures.get(2))
        .map(|m| m.as_str().to_string())
}

/// `Bearer $FOO` in an Authorization header.
pub fn bearer_placeholder_env_name(value: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?i)^Bearer\s+\$(?:\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$").ok()?;
    let captures = re.captures(value.trim())?;
    captures
        .get(1)
        .or_else(|| captures.get(2))
        .map(|m| m.as_str().to_string())
}

/// Key names whose literal values are worth flagging before they land in SQLite.
fn secret_key() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)").unwrap())
}

/// Well-known credential prefixes, so we can warn even when the key name is bland.
fn secret_value() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^(gh[pousr]_|github_pat_|sk-|sk_live_|xox[baprs]-|AIza|ya29\.|glpat-|npm_)").unwrap())
}

pub fn looks_like_secret(key: &str, value: &str) -> bool {
    if value.trim().is_empty() {
        return false;
    }
    if placeholder_env_name(value).is_some() {
        return false;
    }
    secret_value().is_match(value) || (secret_key().is_match(key) && value.len() >= 8)
}
