//! MCP config discovery — port of capability-import/discovery.ts.

use serde_json::{json, Map, Value};

use crate::application::capability_import::mcp_json::parse_mcp_config_json;
use crate::application::capability_import::mcp_toml::parse_mcp_config_toml;

/// Refuse to slurp a config file that is implausibly large.
const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;

struct ConfigLocation {
    id: &'static str,
    label: &'static str,
    path: String,
    format: &'static str,
}

/// Per-OS install location of the Claude Desktop config.
fn claude_desktop_config(home: &std::path::Path) -> String {
    if cfg!(windows) {
        let app_data = std::env::var("APPDATA")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        return app_data.join("Claude").join("claude_desktop_config.json").to_string_lossy().into_owned();
    }
    if cfg!(target_os = "macos") {
        return home
            .join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude_desktop_config.json")
            .to_string_lossy()
            .into_owned();
    }
    let config_home = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    config_home.join("Claude").join("claude_desktop_config.json").to_string_lossy().into_owned()
}

/// Known MCP config files, user-level first then project-level.
pub fn mcp_config_locations(project_root: Option<&str>) -> Vec<ConfigLocation> {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let mut locations = vec![
        ConfigLocation {
            id: "claude-code",
            label: "Claude Code",
            path: home.join(".claude.json").to_string_lossy().into_owned(),
            format: "json",
        },
        ConfigLocation { id: "claude-desktop", label: "Claude Desktop", path: claude_desktop_config(&home), format: "json" },
        ConfigLocation {
            id: "cursor",
            label: "Cursor",
            path: home.join(".cursor").join("mcp.json").to_string_lossy().into_owned(),
            format: "json",
        },
        ConfigLocation {
            id: "codex",
            label: "Codex",
            path: home.join(".codex").join("config.toml").to_string_lossy().into_owned(),
            format: "toml",
        },
    ];
    if let Some(root) = project_root.map(str::trim).filter(|r| !r.is_empty()) {
        let root = std::path::Path::new(root);
        locations.push(ConfigLocation {
            id: "project-mcp",
            label: "项目 .mcp.json",
            path: root.join(".mcp.json").to_string_lossy().into_owned(),
            format: "json",
        });
        locations.push(ConfigLocation {
            id: "project-cursor",
            label: "项目 .cursor",
            path: root.join(".cursor").join("mcp.json").to_string_lossy().into_owned(),
            format: "json",
        });
        locations.push(ConfigLocation {
            id: "project-vscode",
            label: "项目 .vscode",
            path: root.join(".vscode").join("mcp.json").to_string_lossy().into_owned(),
            format: "json",
        });
    }
    locations
}

/// Reads every known config file; a missing file is reported, never thrown.
pub fn discover_mcp_sources(project_root: Option<&str>) -> Vec<Value> {
    mcp_config_locations(project_root)
        .iter()
        .map(|location| {
            let mut base = Map::new();
            base.insert("id".to_string(), json!(location.id));
            base.insert("label".to_string(), json!(location.label));
            base.insert("path".to_string(), json!(location.path));
            base.insert("available".to_string(), json!(false));
            base.insert("servers".to_string(), json!([]));
            let path = std::path::Path::new(&location.path);
            if !path.exists() {
                return Value::Object(base);
            }
            base.insert("available".to_string(), json!(true));
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            if size > MAX_CONFIG_BYTES {
                base.insert("error".to_string(), json!("配置文件过大，已跳过"));
                return Value::Object(base);
            }
            let Ok(text) = std::fs::read_to_string(path) else {
                base.insert("error".to_string(), json!("配置文件读取失败"));
                return Value::Object(base);
            };
            let (servers, errors) = if location.format == "toml" {
                parse_mcp_config_toml(&text, Some(location.label))
            } else {
                parse_mcp_config_json(&text, Some(location.label))
            };
            // "no mcpServers block" is normal for these files, not worth surfacing.
            if servers.is_empty() && !errors.is_empty() {
                base.insert("error".to_string(), json!(errors.join("；")));
            }
            base.insert("servers".to_string(), Value::Array(servers));
            Value::Object(base)
        })
        .collect()
}
