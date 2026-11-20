//! Ports of Magpie OpenCodeClient, OpenCodeProject, OpenCodeEnvironment,
//! openCodeNewID and zenFreeTools. See parent module for upstream attribution.
use ring::digest::{digest, SHA1_FOR_LEGACY_USE_ONLY};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

pub const MIN_VERSION: &str = "2.2.5";
pub const CORE: [&str; 5] = ["edit", "glob", "grep", "read", "shell"];
pub const STUB_NOTE: &str = "(The model asked for a tool this session doesn't have.)";
const STUB: &str = "Not available in this session. Never call this tool.";

#[derive(Clone)]
pub struct Session {
    pub id: String,
    trace: String,
}
impl Session {
    pub fn new() -> Self {
        static CLOCK: OnceLock<Mutex<(i64, u64)>> = OnceLock::new();
        let mut clock = CLOCK.get_or_init(|| Mutex::new((0, 0))).lock().unwrap();
        let ms = chrono::Utc::now().timestamp_millis();
        if clock.0 != ms {
            *clock = (ms, 0);
        }
        clock.1 += 1;
        let time = !((ms as u64) * 0x1000 + clock.1) & 0xffffffffffff;
        let random = uuid::Uuid::new_v4();
        let alphabet = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
        let suffix = random.as_bytes()[..14]
            .iter()
            .map(|byte| alphabet[*byte as usize % 62] as char)
            .collect::<String>();
        Self {
            id: format!("ses_{time:012x}{suffix}"),
            trace: uuid::Uuid::new_v4().simple().to_string(),
        }
    }
}

struct Version {
    value: String,
    checked: Option<Instant>,
    asking: bool,
}
pub(super) fn version() -> String {
    static VERSION: OnceLock<Mutex<Version>> = OnceLock::new();
    let shared = VERSION.get_or_init(|| {
        Mutex::new(Version {
            value: MIN_VERSION.into(),
            checked: None,
            asking: false,
        })
    });
    let mut state = shared.lock().unwrap();
    let current = state.value.clone();
    if (!cfg!(test) || std::env::var_os("NAUTILO_RELAY_SMOKE_HOME").is_some())
        && !state.asking
        && state
            .checked
            .is_none_or(|at| at.elapsed() > Duration::from_secs(6 * 3600))
    {
        state.asking = true;
        let asked = current.clone();
        tokio::spawn(async move {
            let found = async {
                let client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(3))
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .ok()?;
                let response = client
                    .get("https://opencode.ai/update/api/latest/cli/npm")
                    .query(&[("current", asked)])
                    .send()
                    .await
                    .ok()?;
                if !response.status().is_success() {
                    return None;
                }
                let response: Value = response.json().await.ok()?;
                let version = response["version"].as_str()?;
                let numbers = version
                    .split('.')
                    .map(str::parse::<u64>)
                    .collect::<Result<Vec<_>, _>>()
                    .ok()?;
                (numbers.len() == 3 && numbers.as_slice() >= &[2, 2, 5])
                    .then(|| version.to_string())
            }
            .await;
            let mut state = shared.lock().unwrap();
            if let Some(found) = found {
                state.value = found;
            }
            state.checked = Some(Instant::now());
            state.asking = false;
        });
    }
    current
}

pub async fn headers(session: &Session, cwd: &str) -> HashMap<String, String> {
    let span = uuid::Uuid::new_v4().simple().to_string()[..16].to_string();
    let parent = uuid::Uuid::new_v4().simple().to_string()[..16].to_string();
    let mut headers = HashMap::from([
        (
            "User-Agent".into(),
            format!("opencode/latest/{}/cli", version()),
        ),
        ("b3".into(), format!("{}-{span}-1-{parent}", session.trace)),
        (
            "traceparent".into(),
            format!("00-{}-{span}-01", session.trace),
        ),
        ("x-opencode-client".into(), "cli".into()),
        ("x-opencode-project".into(), project(cwd)),
        ("Accept".into(), "*/*".into()),
    ]);
    for name in [
        "x-opencode-session",
        "x-opencode-session-id",
        "x-session-affinity",
        "x-session-id",
    ] {
        headers.insert(name.into(), session.id.clone());
    }
    headers
}

fn local(path: &Path) -> PathBuf {
    let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.into());
    #[cfg(windows)]
    {
        let text = real.to_string_lossy();
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(normal) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(normal);
        }
    }
    real
}
fn directory(cwd: &str) -> PathBuf {
    if cwd.is_empty() {
        return dirs::home_dir().unwrap_or_default();
    }
    if cwd == "~" || cwd.starts_with("~/") {
        return dirs::home_dir()
            .unwrap_or_default()
            .join(cwd.trim_start_matches('~').trim_start_matches('/'));
    }
    local(Path::new(cwd))
}

fn remote_path(remote: &str) -> Option<String> {
    let remote = remote.trim();
    let (host, path) = if remote.contains("://") {
        let url = reqwest::Url::parse(remote).ok()?;
        if url.scheme() == "file" {
            return None;
        }
        (url.host_str()?.to_lowercase(), url.path().to_string())
    } else {
        let (host, path) = remote.split_once(':')?;
        if host.contains('/') || host.len() == 1 {
            return None;
        }
        (host.rsplit('@').next()?.to_lowercase(), path.into())
    };
    let path = path
        .trim_start_matches('/')
        .trim_end_matches('/')
        .trim_end_matches(".git");
    (!host.is_empty() && !path.is_empty()).then(|| format!("{host}/{path}"))
}

fn repository(dir: &Path) -> Option<(PathBuf, Option<String>)> {
    for root in dir.ancestors() {
        let dot = root.join(".git");
        if !dot.exists() {
            continue;
        }
        let mut common = dot.clone();
        if dot.is_file() {
            let text = std::fs::read_to_string(&dot).ok()?;
            let name = text.trim().strip_prefix("gitdir:")?.trim();
            common = root.join(name);
            if let Ok(shared) = std::fs::read_to_string(common.join("commondir")) {
                common = common.join(shared.trim());
            }
        }
        let config = std::fs::read_to_string(common.join("config")).unwrap_or_default();
        let mut section = String::new();
        let mut first = None;
        let mut origin = None;
        let mut origin_present = false;
        for line in config.lines().map(str::trim) {
            if line.starts_with('[') {
                section = line
                    .strip_prefix("[remote \"")
                    .and_then(|v| v.strip_suffix("\"]"))
                    .unwrap_or("")
                    .into();
                if section == "origin" {
                    origin_present = true;
                }
            } else if !section.is_empty() {
                if let Some((name, value)) = line.split_once('=') {
                    if name.trim() == "url" {
                        if first.is_none() {
                            first = Some(value.trim().to_string());
                        }
                        if section == "origin" {
                            origin = Some(value.trim().to_string());
                        }
                    }
                }
            }
        }
        let chosen = if origin_present { origin } else { first };
        return Some((root.into(), chosen.and_then(|v| remote_path(&v))));
    }
    None
}

fn project(cwd: &str) -> String {
    let dir = directory(cwd);
    let key = match repository(&dir) {
        Some((_, Some(remote))) => format!("git-remote:{remote}"),
        Some((root, None)) => format!("directory:{}", root.display()),
        None => format!("directory:{}", dir.display()),
    };
    digest(&SHA1_FOR_LEGACY_USE_ONLY, key.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn environment(cwd: &str) -> String {
    let dir = directory(cwd);
    let repo = repository(&dir);
    let root = repo.as_ref().map(|r| r.0.as_path()).unwrap_or(&dir);
    let platform = if cfg!(windows) {
        "win32"
    } else {
        std::env::consts::OS
    };
    format!("Here is some useful information about the environment you are running in:\n<env>\n  Working directory: {}\n  Workspace root folder: {}\n  Is directory a git repo: {}\n  Platform: {platform}\n  Prefer {} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.\n</env>",dir.display(),root.display(),if repo.is_some(){"yes"}else{"no"},local(&std::env::temp_dir()).join("opencode").display())
}

#[derive(Default)]
pub struct Tools {
    pub back: HashMap<String, String>,
    pub stubs: HashSet<String>,
}
pub fn prepare_free(body: &mut Value, cwd: &str) -> anyhow::Result<Tools> {
    let mut mapping = Tools::default();
    let schemas: Value = serde_json::from_str(include_str!("core-tools.json"))?;
    let mut tools = body["tools"].as_array().cloned().unwrap_or_default();
    for name in CORE {
        let index = tools
            .iter()
            .position(|tool| tool["function"]["name"] == name)
            .or_else(|| {
                tools.iter().position(|tool| {
                    tool["function"]["name"]
                        .as_str()
                        .is_some_and(|value| value.eq_ignore_ascii_case(name))
                })
            });
        if let Some(index) = index {
            let own = tools[index]["function"]["name"]
                .as_str()
                .unwrap()
                .to_string();
            if own != name {
                mapping.back.insert(name.into(), own);
                tools[index]["function"]["name"] = json!(name);
            }
        } else {
            tools.push(json!({"type":"function","function":{"name":name,"description":STUB,"parameters":schemas[name]}}));
            mapping.stubs.insert(name.into());
        }
    }
    for tool in &mut tools {
        if tool["type"] == "function" {
            tool["function"]["strict"] = json!(false);
        }
    }
    body["tools"] = json!(tools);
    body["stream"] = json!(true);
    if !body["stream_options"].is_object() {
        body["stream_options"] = json!({});
    }
    body["stream_options"]["include_usage"] = json!(true);
    let messages = body["messages"]
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("Expected messages"))?;
    // Magpie readChat + zenEnvironment + buildChat: combine caller system
    // instructions and append the environment to that same system message.
    // Sending it as an extra earlier system message lets a later caller system
    // message replace it at Zen, which then rejects the free-tier request.
    let mut system = messages
        .iter()
        .filter(|message| matches!(message["role"].as_str(), Some("system" | "developer")))
        .map(|message| {
            message["content"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| {
                    message["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|part| part["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let has_environment = system.contains("<env>")
        && system.contains("Working directory:")
        && system.contains("Platform:");
    if !has_environment {
        if !system.is_empty() {
            system.push_str("\n\n");
        }
        system.push_str(&environment(cwd));
    }
    messages.retain(|message| !matches!(message["role"].as_str(), Some("system" | "developer")));
    messages.insert(0, json!({"role":"system","content":system}));
    for message in messages.iter_mut() {
        for call in message["tool_calls"].as_array_mut().into_iter().flatten() {
            if let Some(up) = mapping.back.iter().find_map(|(up, own)| {
                (call["function"]["name"] == own.as_str()).then(|| up.clone())
            }) {
                call["function"]["name"] = json!(up);
            }
        }
    }
    if let Some(up) = mapping.back.iter().find_map(|(up, own)| {
        (body["tool_choice"]["function"]["name"] == own.as_str()).then(|| up.clone())
    }) {
        body["tool_choice"]["function"]["name"] = json!(up);
    }
    Ok(mapping)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_session_layout_and_trace_are_preserved() {
        let s = Session::new();
        assert_eq!(s.id.len(), 30);
        assert!(s.id.starts_with("ses_"));
        let low = u16::from_str_radix(&s.id[13..16], 16).unwrap();
        assert!(0xfff - low < 16);
    }
    #[test]
    fn caller_tools_history_and_forced_choice_use_the_same_native_names() {
        let mut request = json!({"messages":[{"role":"assistant","tool_calls":[{"id":"old","function":{"name":"Read","arguments":"{}"}}]},{"role":"tool","tool_call_id":"old","content":"actual result"},{"role":"user","content":"Continue"}],"tools":[{"type":"function","function":{"name":"Read","parameters":{"type":"object","properties":{"custom":{"type":"string"}}}}}],"tool_choice":{"type":"function","function":{"name":"Read"}},"temperature":0});
        let tools = prepare_free(&mut request, "C:/workspace").unwrap();
        assert_eq!(tools.back["read"], "Read");
        assert!(!tools.stubs.contains("read"));
        assert!(tools.stubs.contains("shell"));
        assert_eq!(
            request["messages"][1]["tool_calls"][0]["function"]["name"],
            "read"
        );
        assert_eq!(request["messages"][2]["content"], "actual result");
        assert_eq!(request["tool_choice"]["function"]["name"], "read");
        assert_eq!(
            request["tools"][0]["function"]["parameters"]["properties"]["custom"]["type"],
            "string"
        );
        assert_eq!(request["temperature"], 0);
        assert_eq!(request["tools"].as_array().unwrap().len(), 5);
    }
    #[test]
    fn environment_is_appended_to_the_combined_caller_system_message() {
        let mut request = json!({"messages":[{"role":"system","content":"First policy"},{"role":"developer","content":[{"type":"text","text":"Second policy"}]},{"role":"user","content":"hello"}]});
        prepare_free(&mut request, "C:/workspace").unwrap();
        assert_eq!(request["messages"].as_array().unwrap().len(), 2);
        let system = request["messages"][0]["content"].as_str().unwrap();
        assert!(
            system.starts_with("First policy\n\nSecond policy\n\nHere is some useful information")
        );
        assert!(system.contains("<env>"));
        assert_eq!(request["messages"][1]["content"], "hello");
    }
}
