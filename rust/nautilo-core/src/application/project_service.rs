//! Project service — port of application/project-service.ts.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::database::{lock, Database, Repositories};
use crate::errors::{invalid, not_found, now_iso, CoreError, CoreResult, ErrorCode};
use crate::application::project_inspector::inspect_project;
use uuid::Uuid;
use std::path::Path;


pub struct ProjectService {
    db: Arc<Mutex<Database>>,
}

impl ProjectService {
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self { db }
    }

    pub fn list(&self) -> CoreResult<Vec<Value>> {
        Repositories::new(&lock(&self.db).raw).projects().list_default()
    }

    pub fn add(&self, input: &Value) -> CoreResult<Value> {
        let root_path = input.get("rootPath").and_then(Value::as_str).unwrap_or("");
        let name = input
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| root_path.split(['/', '\\']).filter(|part| !part.is_empty()).last().map(str::to_string))
            .unwrap_or_else(|| "Project".to_string());
        let now = now_iso();
        let project = json!({
            "id": Uuid::new_v4().to_string(),
            "name": name,
            "rootPath": root_path,
            "repositoryType": "none",
            "workspaceMode": "direct",
            "frontendPaths": [],
            "backendPaths": [],
            "ignoredPaths": [],
            "policyId": "default",
            "createdAt": now,
            "updatedAt": now,
        });
        Repositories::new(&lock(&self.db).raw).projects().save(&project, &now)?;
        Ok(project)
    }

    pub fn remove(&self, project_id: &str) -> CoreResult<Value> {
        Repositories::new(&lock(&self.db).raw).projects().remove(project_id)?;
        Ok(json!({ "removed": true }))
    }

    pub fn scan(&self, project_id: &str) -> CoreResult<Value> {
        let project = Repositories::new(&lock(&self.db).raw)
            .projects()
            .get(project_id)?
            .ok_or_else(|| not_found("project", project_id))?;
        let inspection = inspect_project(&project);
        let mut updated = project.clone();
        let root = Path::new(project.get("rootPath").and_then(Value::as_str).unwrap_or(""));
        let is_repo = inspection.get("git").and_then(|g| g.get("isRepo")).and_then(Value::as_bool).unwrap_or(false);
        updated["repositoryType"] = json!(if is_repo { "git" } else { "none" });
        match inspection.get("git").and_then(|g| g.get("defaultBranch")).cloned() {
            Some(Value::String(branch)) => updated["defaultBranch"] = json!(branch),
            _ => {
                updated.as_object_mut().unwrap().remove("defaultBranch");
            }
        }
        updated["frontendPaths"] = inspection.get("frontendPaths").cloned().unwrap_or(json!([]));
        updated["backendPaths"] = inspection.get("backendPaths").cloned().unwrap_or(json!([]));
        updated["updatedAt"] = inspection.get("scannedAt").cloned().unwrap_or(json!(now_iso()));
        let scanned_at = updated["updatedAt"].as_str().unwrap_or("").to_string();
        let _ = root;
        Repositories::new(&lock(&self.db).raw).projects().save(&updated, &scanned_at)?;
        Ok(json!({ "project": updated, "inspection": inspection }))
    }
}

