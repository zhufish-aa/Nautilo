//! Command policy evaluation — port of runtime/security/command-policy-service.ts.

use std::path::Path;

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::database::{lock, Database, Repositories};
use crate::errors::{invalid, not_found, now_iso, CoreError, CoreResult, ErrorCode};


const DEFAULT_ENV_KEYS_WINDOWS: [&str; 12] = [
    "PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
];
const DEFAULT_ENV_KEYS_UNIX: [&str; 6] = ["PATH", "HOME", "TMPDIR", "SHELL", "LANG", "LC_ALL"];

pub struct CommandPolicyService {
    db: Arc<Mutex<Database>>,
}

impl CommandPolicyService {
    pub fn new(db: Arc<Mutex<Database>>) -> CoreResult<Self> {
        let service = Self { db };
        service.ensure_default()?;
        Ok(service)
    }

    pub fn list(&self) -> CoreResult<Vec<Value>> {
        Repositories::new(&lock(&self.db).raw).policies().list_default()
    }

    pub fn get(&self, id: &str) -> CoreResult<Value> {
        let guard = lock(&self.db);
        let repos = Repositories::new(&guard.raw);
        let policies = repos.policies();
        Ok(policies.get(id)?.or(policies.get("default")?).unwrap_or(Value::Null))
    }

    pub fn save(&self, policy: &Value) -> CoreResult<Value> {
        let updated_at = policy.get("updatedAt").and_then(Value::as_str).unwrap_or("").to_string();
        Repositories::new(&lock(&self.db).raw).policies().save(policy, &updated_at)?;
        Ok(policy.clone())
    }

    pub fn evaluate(&self, input: &Value) -> CoreResult<Value> {
        let policy = self.get(input.get("policyId").and_then(Value::as_str).unwrap_or("default"))?;
        let command = input.get("command").and_then(Value::as_str).unwrap_or("");
        let source = input.get("source").and_then(Value::as_str).unwrap_or("");
        let args: Vec<String> = input
            .get("args")
            .and_then(Value::as_array)
            .map(|args| args.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let executable = Path::new(command)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| command.to_string());
        let executable = strip_executable_extension(&executable).to_lowercase();
        let rules = policy.get("commandRules").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut matched: Option<&Value> = None;
        for rule in &rules {
            let sources_match = rule
                .get("sources")
                .and_then(Value::as_array)
                .is_none_or(|sources| sources.is_empty() || sources.iter().any(|s| s.as_str() == Some(source)));
            if !sources_match {
                continue;
            }
            let rule_executable = rule.get("executable").and_then(Value::as_str);
            if let Some(rule_executable) = rule_executable {
                if rule_executable != "*" && rule_executable.to_lowercase() != executable {
                    continue;
                }
            }
            let prefix: Vec<&str> = rule
                .get("argsPrefix")
                .and_then(Value::as_array)
                .map(|prefix| prefix.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if !prefix.is_empty()
                && !prefix.iter().enumerate().all(|(index, value)| args.get(index).is_some_and(|arg| arg.eq_ignore_ascii_case(value)))
            {
                continue;
            }
            matched = Some(rule);
            break;
        }
        let default_action = policy.get("defaultCommandAction").and_then(Value::as_str).unwrap_or("approval");
        match matched {
            Some(rule) => {
                let mut result = Map::new();
                result.insert("action".to_string(), rule.get("action").cloned().unwrap_or(Value::Null));
                if let Some(id) = rule.get("id").cloned() {
                    result.insert("ruleId".to_string(), id);
                }
                result.insert(
                    "reason".to_string(),
                    rule.get("description").cloned().unwrap_or_else(|| json!(format!("Default {default_action} policy"))),
                );
                Ok(Value::Object(result))
            }
            None => Ok(json!({
                "action": default_action,
                "reason": format!("Default {default_action} policy"),
            })),
        }
    }

    fn ensure_default(&self) -> CoreResult<()> {
        if Repositories::new(&lock(&self.db).raw).policies().get("default")?.is_some() {
            return Ok(());
        }
        let keys: Vec<&str> = if cfg!(windows) { DEFAULT_ENV_KEYS_WINDOWS.to_vec() } else { DEFAULT_ENV_KEYS_UNIX.to_vec() };
        let policy = json!({
            "id": "default",
            "name": "Default local safety policy",
            "defaultCommandAction": "approval",
            "environmentAllowlist": keys,
            "allowedPaths": [],
            "commandRules": [
                { "id": "block-rm", "action": "blocked", "executable": "rm", "description": "Recursive deletion is blocked by default" },
                { "id": "block-format", "action": "blocked", "executable": "format", "description": "Disk formatting is blocked" },
                { "id": "block-force-push", "action": "blocked", "executable": "git", "argsPrefix": ["push", "--force"], "description": "Force push is blocked" },
                { "id": "safe-agent-launch", "action": "safe", "executable": "*", "sources": ["agent"], "description": "Configured Agent CLI launch" },
                { "id": "safe-registered-verification", "action": "safe", "executable": "*", "sources": ["verification"], "description": "Project-registered verification command" },
                { "id": "safe-system", "action": "safe", "executable": "*", "sources": ["system"], "description": "Nautilo internal command" }
            ],
            "updatedAt": now_iso(),
        });
        let updated_at = policy.get("updatedAt").and_then(Value::as_str).unwrap_or("").to_string();
        Repositories::new(&lock(&self.db).raw).policies().save(&policy, &updated_at)
    }
}

fn strip_executable_extension(name: &str) -> String {
    let lower = name.to_lowercase();
    for extension in [".exe", ".cmd", ".bat", ".ps1"] {
        if let Some(stripped) = lower.strip_suffix(extension) {
            return stripped.to_string();
        }
    }
    name.to_string()
}
