//! Portable configuration plans and explicit independent-service/account bindings.
use crate::{
    adapters::registry::AdapterRegistry,
    database::{Database, Repositories},
    errors::{invalid, not_found, now_iso, CoreResult},
    runtime::security::CredentialService,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

mod portable;
use portable::portable;

pub struct IntegrationService {
    db: Arc<Mutex<Database>>,
    credentials: Arc<CredentialService>,
    adapters: AdapterRegistry,
    write_lock: Mutex<()>,
}
impl IntegrationService {
    pub fn new(
        db: Arc<Mutex<Database>>,
        credentials: Arc<CredentialService>,
        adapters: AdapterRegistry,
    ) -> Self {
        Self {
            db,
            credentials,
            adapters,
            write_lock: Mutex::new(()),
        }
    }
    pub fn get(&self) -> CoreResult<Value> {
        Ok(Repositories::new(&self.db.lock().unwrap().raw).integration_settings().get("integration-settings")?.unwrap_or_else(||json!({"id":"integration-settings","schemaVersion":1,"updatedAt":now_iso(),"toolServices":[],"gateway":{"enabled":false,"connectionIds":[]}})))
    }
    pub fn save(&self, input: &Value) -> CoreResult<Value> {
        if input["schemaVersion"] != 1 {
            return Err(invalid("schemaVersion", "Invalid integration settings"));
        }
        let mut bindings = input["toolServices"]
            .as_array()
            .filter(|a| a.len() <= 3)
            .cloned()
            .ok_or_else(|| invalid("toolServices", "Invalid tool services"))?;
        let ids = input["gateway"]["connectionIds"]
            .as_array()
            .ok_or_else(|| invalid("gateway", "Invalid account routes"))?;
        let db = self.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let mut seen = HashSet::new();
        for b in &mut bindings {
            let purpose = b["purpose"].as_str().unwrap_or("");
            if !["image", "vision", "search"].contains(&purpose)
                || !seen.insert(purpose.to_string())
            {
                return Err(invalid("purpose", "Invalid or duplicate tool service"));
            }
            if b["enabled"] != true {
                continue;
            }
            let id = b["connectionId"].as_str().unwrap_or("");
            let c = repos
                .runtime_connections()
                .get(id)?
                .filter(|c| c["enabled"] == true)
                .ok_or_else(|| invalid("connectionId", "Select an enabled service connection"))?;
            let revision = b["connectionRevision"]
                .as_u64()
                .or_else(|| c["revision"].as_u64())
                .unwrap_or(0);
            let v = repos
                .runtime_connection_versions()
                .get(&super::connection_service::version_key(id, revision))?
                .ok_or_else(|| {
                    invalid(
                        "connectionRevision",
                        "Pinned service revision was not found",
                    )
                })?;
            if let Some(model) = b["model"].as_str() {
                if !v["models"].as_array().is_some_and(|models| {
                    models
                        .iter()
                        .any(|m| m["id"] == model && m["enabled"] != false)
                }) {
                    return Err(invalid("model", "Select an enabled service model"));
                }
            }
            b["connectionRevision"] = json!(revision);
        }
        let mut accounts = vec![];
        for id in ids {
            let id = id
                .as_str()
                .ok_or_else(|| invalid("connectionId", "Invalid account ID"))?;
            let c = repos
                .runtime_connections()
                .get(id)?
                .ok_or_else(|| not_found("connection", id))?;
            if c["enabled"] != true
                || c["kind"] != "login"
                || !matches!(c["harness"].as_str(), Some("codex" | "claude-code"))
            {
                return Err(invalid(
                    "connectionId",
                    "Account gateway requires an enabled Codex or Claude Code account",
                ));
            }
            if !accounts.contains(&json!(id)) {
                accounts.push(json!(id));
            }
        }
        let value = json!({"id":"integration-settings","schemaVersion":1,"updatedAt":now_iso(),"toolServices":bindings,"gateway":{"enabled":input["gateway"]["enabled"]==true,"connectionIds":accounts}});
        repos.integration_settings().save(&value, &now_iso())?;
        Ok(value)
    }
    pub fn set_account_route(&self, id: &str, enabled: bool) -> CoreResult<()> {
        let _guard = self.write_lock.lock().unwrap();
        let mut settings = self.get()?;
        let mut ids = if settings["gateway"]["enabled"] == true {
            settings["gateway"]["connectionIds"].as_array().cloned().unwrap_or_default()
        } else { vec![] };
        ids.retain(|value| value.as_str() != Some(id));
        if enabled { ids.push(json!(id)); }
        settings["gateway"] = json!({"enabled": !ids.is_empty(), "connectionIds": ids});
        self.save(&settings)?;
        Ok(())
    }
    pub fn list(&self) -> CoreResult<Value> {
        Ok(json!(Repositories::new(&self.db.lock().unwrap().raw)
            .configuration_presets()
            .list_default()?))
    }
    pub fn capture(&self, name: &str) -> CoreResult<Value> {
        let value = {
            let db = self.db.lock().unwrap();
            let r = Repositories::new(&db.raw);
            json!({"name":name,"schemaVersion":1,"resources":r.capabilities().list_default()?,"harnesses":r.agents().list_default()?,"connections":r.runtime_connections().list_default()?})
        };
        self.import(&value)
    }
    pub fn import(&self, input: &Value) -> CoreResult<Value> {
        if input["schemaVersion"] != 1
            || input["name"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty() || s.len() > 120)
        {
            return Err(invalid("preset", "Invalid configuration format or name"));
        }
        let mut seen = HashSet::new();
        for (kind, key) in [
            ("resource", "resources"),
            ("harness", "harnesses"),
            ("connection", "connections"),
        ] {
            let rows = input[key]
                .as_array()
                .filter(|a| a.len() <= 200)
                .ok_or_else(|| invalid("preset", "Configuration exceeds its resource limit"))?;
            for row in rows {
                let id = row["id"].as_str().unwrap_or("");
                if id.is_empty()
                    || id.len() > 200
                    || !id
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "_.:-".contains(c))
                    || !seen.insert(format!("{kind}:{id}"))
                {
                    return Err(invalid("id", "Invalid or duplicate configuration ID"));
                }
                if (kind == "resource" && !matches!(row["kind"].as_str(), Some("skill" | "mcp")))
                    || (kind == "connection"
                        && !matches!(row["kind"].as_str(), Some("api" | "login")))
                    || (kind == "harness"
                        && (row["providerId"].as_str().is_none()
                            || row["executable"]
                                .as_str()
                                .is_none_or(|s| s.trim().is_empty())))
                {
                    return Err(invalid("preset", "Invalid configuration entry"));
                }
            }
        }
        let mut value = portable(input);
        value["id"] = json!(uuid::Uuid::new_v4().to_string());
        value["name"] = json!(input["name"].as_str().unwrap().trim());
        value["createdAt"] = json!(now_iso());
        value["updatedAt"] = json!(now_iso());
        if value.to_string().len() > 2 * 1024 * 1024 {
            return Err(invalid("preset", "Configuration exceeds 2 MiB"));
        }
        Repositories::new(&self.db.lock().unwrap().raw)
            .configuration_presets()
            .save(&value, &now_iso())?;
        Ok(value)
    }
    pub fn export(&self, id: &str) -> CoreResult<Value> {
        Ok(portable(
            &Repositories::new(&self.db.lock().unwrap().raw)
                .configuration_presets()
                .get(id)?
                .ok_or_else(|| not_found("preset", id))?,
        ))
    }
    pub fn remove(&self, id: &str) -> CoreResult<Value> {
        Ok(
            json!({"removed":Repositories::new(&self.db.lock().unwrap().raw).configuration_presets().remove(id)?}),
        )
    }
    fn read(&self, kind: &str, id: &str) -> CoreResult<Value> {
        let db = self.db.lock().unwrap();
        let r = Repositories::new(&db.raw);
        Ok(match kind {
            "resource" => r.capabilities().get(id)?,
            "harness" => r.agents().get(id)?,
            _ => r.runtime_connections().get(id)?,
        }
        .unwrap_or(Value::Null))
    }
    pub fn preview(&self, id: &str, replace: bool) -> CoreResult<Value> {
        let preset = self.export(id)?;
        let mut entries = vec![];
        let mut snapshots = vec![];
        for (kind, key) in [
            ("resource", "resources"),
            ("harness", "harnesses"),
            ("connection", "connections"),
        ] {
            for row in preset[key].as_array().unwrap() {
                let id = row["id"].as_str().unwrap();
                let current = self.read(kind, id)?;
                let mut value = row.clone();
                let name = row
                    .get("name")
                    .or_else(|| row.get("displayName"))
                    .cloned()
                    .unwrap_or_else(|| json!(id));
                if kind == "connection" && row["kind"] == "login" {
                    if current.is_null() {
                        entries.push(
                            json!({"kind":kind,"id":id,"name":name,"operation":"unavailable"}),
                        );
                        continue;
                    }
                    value["loginProfileDirectory"] = current["loginProfileDirectory"].clone();
                }
                if kind == "connection" && current.is_null() {
                    value["enabled"] = json!(false);
                }
                entries.push(json!({"kind":kind,"id":id,"name":name,"operation":if current.is_null(){"create"}else if replace{"replace"}else{"keep"},"credentialRequired":kind=="connection"&&row["kind"]=="api"&&current["hasCredential"]!=true}));
                snapshots.push(
                    json!({"kind":kind,"id":id,"fingerprint":fingerprint(&current),"value":value}),
                );
            }
        }
        let plan = json!({"id":uuid::Uuid::new_v4().to_string(),"presetId":id,"state":"preview","entries":entries});
        self.credentials.set(
            &format!("configuration-plan:{}", plan["id"].as_str().unwrap()),
            &json!({"apiKey":uuid::Uuid::new_v4().to_string(),"plan":plan,"snapshots":snapshots}),
        )?;
        Ok(plan)
    }
    pub fn apply(&self, id: &str) -> CoreResult<Value> {
        let _guard = self.write_lock.lock().unwrap();
        let key = format!("configuration-plan:{id}");
        let mut payload = self
            .credentials
            .read(&key)?
            .ok_or_else(|| not_found("configurationPlan", id))?;
        if payload["plan"]["state"] != "preview" {
            return Err(invalid(
                "planId",
                "Configuration preview is no longer applicable",
            ));
        }
        let snapshots = payload["snapshots"].as_array().unwrap();
        for s in snapshots {
            if fingerprint(&self.read(s["kind"].as_str().unwrap(), s["id"].as_str().unwrap())?)
                != s["fingerprint"].as_str().unwrap()
            {
                return Err(invalid(
                    "conflict",
                    "Configuration changed after preview; create a new preview",
                ));
            }
        }
        let connections = super::connection_service::ConnectionService::new(
            self.db.clone(),
            self.credentials.clone(),
            self.adapters.clone(),
        );
        let agents = super::agent_service::AgentService::new(
            self.db.clone(),
            self.adapters.clone(),
            self.credentials.clone(),
        );
        let capabilities = super::capability_service::CapabilityService::new(self.db.clone());
        for e in payload["plan"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| matches!(e["operation"].as_str(), Some("create" | "replace")))
        {
            let row = &snapshots
                .iter()
                .find(|s| s["kind"] == e["kind"] && s["id"] == e["id"])
                .unwrap()["value"];
            match e["kind"].as_str().unwrap() {
                "connection" => {
                    let current = self.read("connection", e["id"].as_str().unwrap())?;
                    let mut request = json!({"connection":row});
                    if !current["revision"].is_null() {
                        request["expectedRevision"] = current["revision"].clone();
                    }
                    connections.upsert(&request)?;
                }
                "harness" => {
                    agents.upsert(row)?;
                }
                _ => {
                    capabilities.upsert(row)?;
                }
            }
        }
        payload["plan"]["state"] = json!("applied");
        self.credentials.set(&key, &payload)?;
        Ok(payload["plan"].clone())
    }
}
fn fingerprint(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
