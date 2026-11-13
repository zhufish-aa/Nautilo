use std::{collections::HashMap, path::PathBuf};

#[derive(Clone)]
pub struct NativeLocation {
    pub harness: String,
    pub root: PathBuf,
    pub config: Option<PathBuf>,
}
pub fn locations(
    home: &std::path::Path,
    env: &HashMap<String, String>,
    accounts: &[serde_json::Value],
) -> Vec<NativeLocation> {
    let root = |key: &str, fallback: PathBuf| {
        env.get(key)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or(fallback)
    };
    let mut entries = vec![
        ("codex", root("CODEX_HOME", home.join(".codex"))),
        (
            "claude-code",
            root("CLAUDE_CONFIG_DIR", home.join(".claude")),
        ),
        ("kimi-code", root("KIMI_CODE_HOME", home.join(".kimi-code"))),
        ("pi", root("PI_CODING_AGENT_DIR", home.join(".pi/agent"))),
        ("omp", home.join(".omp/agent")),
        ("command-code", home.join(".commandcode")),
        ("trae", home.join(".trae-agent")),
        (
            "opencode",
            root(
                "OPENCODE_CONFIG_DIR",
                root("XDG_CONFIG_HOME", home.join(".config")).join("opencode"),
            ),
        ),
    ]
    .into_iter()
    .map(|(harness, root)| NativeLocation {
        harness: harness.into(),
        root,
        config: None,
    })
    .collect::<Vec<_>>();
    if let Some(profile) = env.get("OMP_PROFILE").or_else(|| env.get("PI_PROFILE")) {
        if profile
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            entries.push(NativeLocation {
                harness: "omp".into(),
                root: home.join(".omp/profiles").join(profile).join("agent"),
                config: None,
            });
        }
    }
    for (harness, key) in [
        ("opencode", "OPENCODE_CONFIG"),
        ("trae", "TRAE_CONFIG_FILE"),
    ] {
        if let Some(file) = env.get(key) {
            let config = PathBuf::from(file);
            entries.push(NativeLocation {
                harness: harness.into(),
                root: config.parent().unwrap_or(home).into(),
                config: Some(config),
            });
        }
    }
    let dsh = root("DSH_HOME", home.join(".dsh"));
    entries.push(NativeLocation {
        harness: "deepseek".into(),
        root: dsh.clone(),
        config: None,
    });
    if let Ok(profiles) = std::fs::read_dir(dsh.join("profiles")) {
        for entry in profiles
            .flatten()
            .filter(|e| e.file_name() != "node_modules")
            .take(32)
        {
            if entry.path().is_dir() {
                entries.push(NativeLocation {
                    harness: "deepseek".into(),
                    root: entry.path(),
                    config: None,
                });
            }
        }
    }
    for account in accounts.iter().take(64) {
        if account["kind"] == "login" {
            if let (Some(harness), Some(path)) = (
                account["harness"].as_str(),
                account["loginProfileDirectory"].as_str(),
            ) {
                entries.push(NativeLocation {
                    harness: harness.into(),
                    root: path.into(),
                    config: None,
                });
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    entries.retain(|e| seen.insert((e.harness.clone(), e.root.clone(), e.config.clone())));
    entries
}
