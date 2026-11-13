//! Explicit native-resource sync: preview, encrypted backups, compare-and-swap and undo.
use crate::{
    database::{Database, Repositories},
    errors::{invalid, not_found, now_iso, CoreResult},
    runtime::{
        config_document,
        security::{CredentialService, RedactionService},
    },
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

mod files;
mod mcp;
mod targets;

use files::{atomic_write, bundle, read_encoded, read_optional};
use mcp::{native_mcp, safe_preview};
use targets::targets;

pub struct ResourceService {
    db: Arc<Mutex<Database>>,
    credentials: Arc<CredentialService>,
    redaction: RedactionService,
    write_lock: Mutex<()>,
}
impl ResourceService {
    pub fn new(
        db: Arc<Mutex<Database>>,
        credentials: Arc<CredentialService>,
        redaction: RedactionService,
    ) -> Self {
        Self {
            db,
            credentials,
            redaction,
            write_lock: Mutex::new(()),
        }
    }
    pub fn inventory(&self) -> CoreResult<Value> {
        let db = self.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let resources=repos.capabilities().list_default()?.iter().map(|c|json!({"id":c["id"],"name":c["name"],"kind":c["kind"],"enabled":c["enabled"],"providerIds":c["providerIds"],"source":c.pointer("/origin/label").or_else(||c.pointer("/origin/kind")).or_else(||c.pointer("/skill/source")).cloned().unwrap_or_else(||json!(if c["tags"].as_array().is_some_and(|tags|tags.contains(&json!("builtin"))){"builtin"}else{"unknown"})),"sourcePath":c.pointer("/origin/path").or_else(||c.pointer("/skill/resourceDir")),"owner":"nautilo","updatedAt":c["updatedAt"]})).collect::<Vec<_>>();
        let accounts = repos.runtime_connections().list_default()?;
        Ok(json!({"resources":resources,"targets":targets(&accounts)}))
    }
    pub fn history(&self) -> CoreResult<Value> {
        let db = self.db.lock().unwrap();
        Ok(json!(Repositories::new(&db.raw)
            .resource_transactions()
            .list_default()?
            .into_iter()
            .take(50)
            .collect::<Vec<_>>()))
    }
    pub fn preview(&self, input: &Value) -> CoreResult<Value> {
        let (caps, accounts) = {
            let db = self.db.lock().unwrap();
            let r = Repositories::new(&db.raw);
            (
                r.capabilities().list_default()?,
                r.runtime_connections().list_default()?,
            )
        };
        let target = targets(&accounts)
            .into_iter()
            .find(|t| t["id"] == input["targetId"])
            .ok_or_else(|| not_found("target", input["targetId"].as_str().unwrap_or("")))?;
        let resolution = input["resolution"].as_str().unwrap_or("keep");
        if !["keep", "replace", "rename"].contains(&resolution) {
            return Err(invalid("resolution", "Unknown conflict resolution"));
        }
        let requested = input["capabilityIds"]
            .as_array()
            .ok_or_else(|| invalid("capabilityIds", "Select resources to sync"))?;
        if requested.len() > 200 {
            return Err(invalid("capabilityIds", "Too many resources"));
        }
        let mut files = BTreeMap::<String, (Option<String>, String)>::new();
        let mut changes = vec![];
        let mut binary = std::collections::HashSet::new();
        for id in requested {
            let c = caps
                .iter()
                .find(|c| c["id"] == *id)
                .ok_or_else(|| not_found("capability", id.as_str().unwrap_or("")))?;
            let name = c["name"].as_str().unwrap_or("resource");
            let resource_id = c["id"].as_str().unwrap_or("");
            let (path, before, after, operation, conflict) = if c["kind"] == "mcp" {
                let path=target["mcpPath"].as_str().ok_or_else(||invalid("targetId","This harness merges MCP through its invocation configuration; no verified global MCP file is available"))?.to_string();
                let original = read_optional(Path::new(&path))?;
                let previous = files
                    .get(&path)
                    .map(|(_, v)| v.clone())
                    .or_else(|| original.clone())
                    .unwrap_or_else(|| {
                        if target["providerId"] == "codex" {
                            String::new()
                        } else {
                            "{}\n".into()
                        }
                    });
                let server = crate::runtime::run_service::capability_to_mcp_server(c)
                    .ok_or_else(|| invalid("capabilityId", "Invalid MCP configuration"))?;
                let key = server["name"].as_str().unwrap_or("mcp");
                let section = if target["providerId"] == "codex" {
                    "mcp_servers"
                } else if target["providerId"] == "opencode" {
                    "mcp"
                } else {
                    "mcpServers"
                };
                let get = |text: &str, key: &str| {
                    if target["providerId"] == "codex" {
                        config_document::toml_get(text, &[section, key])
                    } else {
                        config_document::json_get(text, &[section, key])
                    }
                };
                let desired = native_mcp(&server, target["providerId"].as_str().unwrap_or(""));
                let existing = get(&previous, key)?;
                let conflict = existing.as_ref().is_some_and(|old| old != &desired);
                let mut key = key.to_string();
                if conflict && resolution == "rename" {
                    key = format!("{key}-nautilo");
                    let mut n = 2;
                    while get(&previous, &key)?.is_some_and(|v| v != desired) {
                        key = format!("{}-nautilo-{n}", server["name"].as_str().unwrap_or("mcp"));
                        n += 1;
                    }
                }
                let operation = if existing.as_ref() == Some(&desired) {
                    "unchanged"
                } else if conflict && resolution == "keep" {
                    "keep"
                } else if conflict && resolution == "rename" {
                    "rename"
                } else if existing.is_some() {
                    "update"
                } else {
                    "create"
                };
                let after = if matches!(operation, "keep" | "unchanged") {
                    previous.clone()
                } else if target["providerId"] == "codex" {
                    config_document::toml_set(&previous, &[section, &key], &desired)?
                } else {
                    config_document::json_set(&previous, &[section, &key], &desired)?
                };
                files
                    .entry(path.clone())
                    .or_insert_with(|| (original.clone(), previous))
                    .1 = after.clone();
                changes.push(json!({"resourceId":resource_id,"name":name,"path":path,"operation":operation,"conflict":conflict,"before":existing.map(|v|safe_preview(&v).to_string()),"after":safe_preview(&desired).to_string()}));
                continue;
            } else {
                let directory = target["skillDirectory"].as_str().ok_or_else(|| {
                    invalid(
                        "targetId",
                        "This harness has no verified native skill directory",
                    )
                })?;
                let slug = crate::application::capability_service::slugify(name);
                let mut path = PathBuf::from(directory).join(&slug).join("SKILL.md");
                let original = read_optional(&path)?;
                let instructions = c
                    .pointer("/skill/instructions")
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid("capabilityId", "Skill instructions are missing"))?;
                let marker = format!("<!-- agenthub:capability:{resource_id} -->");
                let desired = format!(
                    "---\nname: {slug}\ndescription: {}\n---\n\n{instructions}\n\n{marker}\n",
                    serde_json::to_string(
                        c["description"]
                            .as_str()
                            .filter(|v| !v.is_empty())
                            .unwrap_or(name)
                    )
                    .unwrap()
                );
                let conflict = original.as_ref().is_some_and(|old| old != &desired);
                if conflict && resolution == "rename" {
                    let base = PathBuf::from(directory).join(format!(
                        "{slug}-nautilo-{}",
                        resource_id
                            .chars()
                            .filter(|c| c.is_ascii_alphanumeric())
                            .take(12)
                            .collect::<String>()
                    ));
                    path = base.join("SKILL.md");
                    let mut n = 2;
                    while read_optional(&path)?.is_some_and(|v| v != desired) {
                        path = PathBuf::from(format!("{}-{n}", base.to_string_lossy()))
                            .join("SKILL.md");
                        n += 1;
                    }
                }
                let before = read_optional(&path)?;
                let operation = if before.as_ref() == Some(&desired) {
                    "unchanged"
                } else if conflict && resolution == "keep" {
                    "keep"
                } else if conflict && resolution == "rename" {
                    "rename"
                } else if before.is_some() {
                    "update"
                } else {
                    "create"
                };
                if operation != "keep" {
                    if let Some(root) = c.pointer("/skill/resourceDir").and_then(Value::as_str) {
                        for (relative, content) in bundle(Path::new(root))? {
                            let destination = path.parent().unwrap().join(&relative);
                            let before = read_encoded(&destination, true)?;
                            let conflict = before.as_ref().is_some_and(|v| v != &content);
                            let operation = if before.as_ref() == Some(&content) {
                                "unchanged"
                            } else if conflict && resolution != "replace" {
                                "keep"
                            } else if before.is_some() {
                                "update"
                            } else {
                                "create"
                            };
                            let after = if operation == "keep" {
                                before.clone().unwrap()
                            } else {
                                content
                            };
                            let key = destination.to_string_lossy().into_owned();
                            binary.insert(key.clone());
                            files.insert(key.clone(), (before, after));
                            changes.push(json!({"resourceId":resource_id,"name":relative,"path":key,"operation":operation,"conflict":conflict,"resourceFile":true}));
                        }
                    }
                }
                let after = if matches!(operation, "keep" | "unchanged") {
                    before.clone().unwrap_or_default()
                } else {
                    desired
                };
                (
                    path.to_string_lossy().into_owned(),
                    before,
                    after,
                    operation,
                    conflict,
                )
            };
            files.insert(path.clone(), (before, after));
            changes.push(json!({"resourceId":resource_id,"name":name,"path":path,"operation":operation,"conflict":conflict}));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        let plan = json!({"id":id,"targetId":target["id"],"state":"preview","createdAt":now,"changes":changes});
        if files.len() > 256
            || files
                .values()
                .map(|(before, after)| {
                    before.as_ref().map(String::len).unwrap_or_default() + after.len()
                })
                .sum::<usize>()
                > 16 * 1024 * 1024
        {
            return Err(invalid(
                "resources",
                "Sync plan exceeds 256 files or 16 MiB; select fewer resources",
            ));
        }
        let files=files.into_iter().filter(|(_, (before,after))|before.as_deref()!=Some(after.as_str())).map(|(path,(before,after))|json!({"encoding":if binary.contains(&path){"base64"}else{"utf8"},"path":path,"before":before,"after":after})).collect::<Vec<_>>();
        self.credentials.set(
            &format!("resource-plan:{id}"),
            &json!({"apiKey":uuid::Uuid::new_v4().to_string(),"files":files}),
        )?;
        Repositories::new(&self.db.lock().unwrap().raw)
            .resource_transactions()
            .save(&self.redaction.value(&plan), &now)?;
        Ok(self.redaction.value(&plan))
    }
    pub fn apply(&self, id: &str, undo: bool) -> CoreResult<Value> {
        let _lock = self.write_lock.lock().unwrap();
        let mut plan = Repositories::new(&self.db.lock().unwrap().raw)
            .resource_transactions()
            .get(id)?
            .ok_or_else(|| not_found("resourcePlan", id))?;
        if plan["state"] != if undo { "applied" } else { "preview" } {
            return Err(invalid("planId", "This sync plan is no longer applicable"));
        }
        let payload = self
            .credentials
            .read(&format!("resource-plan:{id}"))?
            .ok_or_else(|| not_found("resourceBackup", id))?;
        let files = payload["files"]
            .as_array()
            .ok_or_else(|| invalid("planId", "Invalid sync backup"))?;
        // Preflight every path before touching any file. Undo also refuses to erase later user edits.
        for file in files {
            let expected = if undo {
                &file["after"]
            } else {
                &file["before"]
            };
            if read_encoded(
                Path::new(file["path"].as_str().unwrap_or("")),
                file["encoding"] == "base64",
            )?
            .as_deref()
                != expected.as_str()
            {
                return Err(invalid("conflict","Native files changed after preview; refresh the preview before applying or undoing"));
            }
        }
        let mut written = vec![];
        for file in files {
            let path = Path::new(file["path"].as_str().unwrap());
            let desired = if undo {
                file["before"].as_str()
            } else {
                file["after"].as_str()
            };
            if let Err(error) = atomic_write(path, desired, file["encoding"] == "base64") {
                for prior in written.iter().rev() {
                    let prior: &Value = prior;
                    let path = Path::new(prior["path"].as_str().unwrap());
                    let ours = if undo {
                        prior["before"].as_str()
                    } else {
                        prior["after"].as_str()
                    };
                    if read_encoded(path, prior["encoding"] == "base64")
                        .ok()
                        .as_ref()
                        .and_then(|v| v.as_deref())
                        == ours
                    {
                        let _ = atomic_write(
                            path,
                            if undo {
                                prior["after"].as_str()
                            } else {
                                prior["before"].as_str()
                            },
                            prior["encoding"] == "base64",
                        );
                    }
                }
                return Err(error);
            }
            written.push(file.clone());
        }
        plan["state"] = json!(if undo { "undone" } else { "applied" });
        plan["updatedAt"] = json!(now_iso());
        Repositories::new(&self.db.lock().unwrap().raw)
            .resource_transactions()
            .save(&plan, &now_iso())?;
        Ok(plan)
    }
}
