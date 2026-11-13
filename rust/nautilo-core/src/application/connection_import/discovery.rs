use super::{
    document::{text, Documents},
    locations::NativeLocation,
    parsers::*,
    Candidate,
};
use serde_json::{json, Value};
use std::path::Path;

fn merge(base: &mut Value, patch: &Value) {
    if let (Some(a), Some(b)) = (base.as_object_mut(), patch.as_object()) {
        for (k, v) in b {
            if a.get(k).is_some_and(Value::is_object) && v.is_object() {
                merge(a.get_mut(k).unwrap(), v);
            } else {
                a.insert(k.clone(), v.clone());
            }
        }
    }
}
pub fn discover(docs: &mut Documents, locations: &[NativeLocation], home: &Path) -> Vec<Candidate> {
    let mut out = Vec::new();
    let dsh_root = docs
        .env
        .get("DSH_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".dsh"));
    let refs = docs.read("deepseek", &dsh_root.join(".credentials.yaml"))["refs"].clone();
    for location in locations {
        if out.len() >= 256 {
            break;
        }
        let root = &location.root;
        let harness = location.harness.as_str();
        match harness {
            "codex" => codex(docs, root, &mut out),
            "claude" | "claude-code" => claude(docs, root, &mut out),
            "kimi" | "kimi-code" => kimi(docs, root, &mut out),
            "pi" | "omp" => {
                let mut cfg = json!({"providers":{}});
                let mut auth = docs.read(harness, &root.join("auth.json"));
                if harness == "omp" {
                    let (a, c) = super::native_store::omp_catalog(docs, root);
                    merge(&mut cfg, &c);
                    if !auth.is_object() {
                        auth = json!({});
                    }
                    merge(&mut auth, &a);
                }
                if let Some(auth) = auth.as_object() {
                    for (id, a) in auth {
                        if (a["type"] == "api" || a["type"] == "api_key")
                            && builtin(id).is_some()
                            && cfg["providers"].get(id).is_none()
                        {
                            cfg["providers"][id] = json!({});
                        }
                    }
                }
                for name in ["models.json", "models.yml", "models.yaml"] {
                    let native = docs.read(harness, &root.join(name));
                    merge(&mut cfg, &native);
                }
                let settings = docs.read(
                    harness,
                    &root.join(if harness == "omp" {
                        "config.yml"
                    } else {
                        "settings.json"
                    }),
                );
                let selected = settings["modelRoles"]["default"]
                    .as_str()
                    .and_then(|id| id.split_once('/'))
                    .map(|(p, m)| (p.to_string(), m.to_string()))
                    .or_else(|| {
                        Some((
                            settings["defaultProvider"].as_str()?.into(),
                            settings["defaultModel"].as_str()?.into(),
                        ))
                    });
                if let Some((provider, id)) = selected {
                    if cfg["providers"].get(&provider).is_some()
                        && cfg["providers"][&provider]["models"]
                            .as_array()
                            .is_none_or(Vec::is_empty)
                    {
                        cfg["providers"][&provider]["models"] = json!([{"id":id}]);
                    }
                }
                let source = [
                    "models.json",
                    "models.yml",
                    "models.yaml",
                    "auth.json",
                    "agent.db",
                ]
                .iter()
                .map(|f| root.join(f))
                .find(|p| p.is_file())
                .unwrap_or_else(|| root.join("models.json"));
                provider_map(docs, harness, &source, &cfg, &auth, &Value::Null, &mut out);
            }
            "opencode" => {
                let auth_root = docs
                    .env
                    .get("XDG_DATA_HOME")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| home.join(".local/share"));
                let auth = docs.read(harness, &auth_root.join("opencode/auth.json"));
                let files = location.config.clone().map(|p| vec![p]).unwrap_or_else(|| {
                    vec![root.join("opencode.json"), root.join("opencode.jsonc")]
                });
                let mut cfg = json!({});
                let mut source = root.join("opencode.json");
                for file in files {
                    let item = docs.read(harness, &file);
                    if item.is_object() {
                        source = file;
                        merge(&mut cfg, &item);
                    }
                }
                let mut providers = cfg["provider"].as_object().cloned().unwrap_or_default();
                if let Some(auth) = auth.as_object() {
                    for (id, value) in auth {
                        if value["type"] == "api" && builtin(id).is_some() {
                            providers.entry(id.clone()).or_insert(json!({}));
                        }
                    }
                }
                for selected in ["model", "small_model"] {
                    if let Some((provider, id)) =
                        cfg[selected].as_str().and_then(|s| s.split_once('/'))
                    {
                        if let Some(p) = providers.get_mut(provider) {
                            if !p["models"].is_object() {
                                p["models"] = json!({});
                            }
                            if p["models"].get(id).is_none() {
                                p["models"][id] = json!({"name":id});
                            }
                        }
                    }
                }
                cfg["provider"] = json!(providers);
                if !source.is_file() {
                    source = auth_root.join("opencode/auth.json");
                }
                provider_map(docs, harness, &source, &cfg, &auth, &Value::Null, &mut out);
            }
            "trae" => {
                let files = location.config.clone().map(|p| vec![p]).unwrap_or_else(|| {
                    ["trae_config.yaml", "trae_config.yml", "trae_config.json"]
                        .iter()
                        .map(|name| root.join(name))
                        .collect()
                });
                for file in files {
                    trae(docs, &file, &mut out);
                }
            }
            "command" | "command-code" => {
                let file = root.join("config.json");
                let cfg = docs.read(harness, &file);
                let auth = docs.read(harness, &root.join("auth.json"));
                if auth["apiKey"].is_string() {
                    add(
                        &mut out,
                        docs,
                        harness,
                        &file,
                        "Command Code",
                        "responses",
                        text(&cfg, &["baseUrl", "baseURL"])
                            .unwrap_or("https://api.commandcode.ai/provider/v1"),
                        &auth["apiKey"],
                        &Value::Null,
                        model(&cfg["model"], "").into_iter().collect(),
                    );
                }
            }
            "deepseek" => {
                let mut cfg = json!({"providers":{}});
                let mut source = root.join("cordis.yml");
                for name in ["cordis.yml", "cordis.patch.yml"] {
                    let file = root.join(name);
                    let items = docs.read(harness, &file);
                    if let Some(items) = items.as_array() {
                        for entry in items {
                            if entry["name"]
                                .as_str()
                                .is_some_and(|s| s.contains("dsh-llm-pi-ai"))
                                || entry["id"] == "llm-pi-ai"
                            {
                                merge(&mut cfg, &entry["config"]);
                                source = file.clone();
                            }
                        }
                    }
                }
                provider_map(docs, harness, &source, &cfg, &Value::Null, &refs, &mut out);
            }
            _ => {}
        }
    }
    out.truncate(256);
    out
}
