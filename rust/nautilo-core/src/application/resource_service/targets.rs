//! Verified native resource locations, including selected account profiles.
use serde_json::{json, Value};
use std::path::PathBuf;

fn env_path(name: &str, default: PathBuf) -> PathBuf {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or(default)
}
pub(super) fn targets(accounts: &[Value]) -> Vec<Value> {
    let home = dirs::home_dir().unwrap_or_default();
    let config = env_path("XDG_CONFIG_HOME", home.join(".config"));
    let mut targets = vec![];
    for (id, label, root, mcp) in [
        (
            "codex",
            "Codex",
            env_path("CODEX_HOME", home.join(".codex")),
            Some("config.toml"),
        ),
        (
            "claude-code",
            "Claude Code",
            env_path("CLAUDE_CONFIG_DIR", home.join(".claude")),
            None,
        ),
        (
            "kimi-code",
            "Kimi Code",
            env_path("KIMI_CODE_HOME", home.join(".kimi-code")),
            Some("mcp.json"),
        ),
        (
            "opencode",
            "OpenCode",
            env_path("OPENCODE_CONFIG_DIR", config.join("opencode")),
            Some("opencode.json"),
        ),
        (
            "pi",
            "Pi",
            env_path("PI_CODING_AGENT_DIR", home.join(".pi/agent")),
            None,
        ),
        ("omp", "Oh My Pi", home.join(".omp/agent"), None),
        (
            "commandcode",
            "Command Code",
            home.join(".commandcode"),
            None,
        ),
        ("trae", "Trae", home.join(".trae-agent"), None),
        ("deepseek", "DeepSeek Harness", home.join(".dsh"), None),
    ] {
        let mcp_path = if id == "claude-code" {
            Some(if std::env::var_os("CLAUDE_CONFIG_DIR").is_some() {
                root.join(".claude.json")
            } else {
                home.join(".claude.json")
            })
        } else {
            mcp.map(|file| root.join(file))
        };
        let mcp_path = if id == "opencode" {
            if std::env::var_os("OPENCODE_CONFIG").is_some() {
                Some(env_path("OPENCODE_CONFIG", root.join("opencode.json")))
            } else if root.join("opencode.jsonc").exists() {
                Some(root.join("opencode.jsonc"))
            } else {
                mcp_path
            }
        } else {
            mcp_path
        };
        let skill_root = if id == "omp" {
            std::env::var("OMP_PROFILE")
                .ok()
                .or_else(|| std::env::var("PI_PROFILE").ok())
                .filter(|v| !v.is_empty() && v != "default")
                .map(|p| {
                    home.join(std::env::var("PI_CONFIG_DIR").unwrap_or_else(|_| ".omp".into()))
                        .join("profiles")
                        .join(p)
                        .join("agent")
                })
                .unwrap_or_else(|| env_path("PI_CODING_AGENT_DIR", root.clone()))
        } else {
            root.clone()
        };
        targets.push(json!({"id":id,"providerId":id,"label":label,"mcpPath":mcp_path.map(|p|p.to_string_lossy().into_owned()),"skillDirectory":if matches!(id,"trae"|"deepseek"){None}else{Some(skill_root.join("skills").to_string_lossy().into_owned())},"mode":if mcp_path_is_verified(id){"native-file"}else{"invocation"}}));
    }
    for a in accounts
        .iter()
        .filter(|a| a["kind"] == "login" && a["enabled"] == true)
    {
        if let (Some(id), Some(provider), Some(root)) = (
            a["id"].as_str(),
            a["harness"].as_str(),
            a["loginProfileDirectory"].as_str(),
        ) {
            if matches!(provider, "codex" | "claude-code") {
                let root = PathBuf::from(root);
                targets.push(json!({"id":format!("account:{id}"),"providerId":provider,"accountId":id,"label":a["name"],"mcpPath":root.join(if provider=="codex"{"config.toml"}else{".claude.json"}).to_string_lossy(),"skillDirectory":root.join("skills").to_string_lossy(),"mode":"native-file"}));
            }
        }
    }
    targets
}
fn mcp_path_is_verified(id: &str) -> bool {
    matches!(id, "codex" | "claude-code" | "kimi-code" | "opencode")
}
