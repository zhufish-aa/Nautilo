//! Native API imports are previewed without secrets, then copied into the vault.
mod discovery;
mod document;
mod locations;
mod native_store;
mod parsers;
#[cfg(test)]
mod tests;

use super::ConnectionService;
use crate::{
    errors::{invalid, CoreResult},
    runtime::security::CredentialService,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct Candidate {
    public: Value,
    secret: Option<String>,
}
struct Scan {
    created: Instant,
    candidates: Vec<Candidate>,
}
pub struct ConnectionImportService {
    connections: ConnectionService,
    credentials: Arc<CredentialService>,
    scans: Mutex<HashMap<String, Scan>>,
}
impl ConnectionImportService {
    pub fn new(connections: ConnectionService, credentials: Arc<CredentialService>) -> Self {
        Self {
            connections,
            credentials,
            scans: Mutex::new(HashMap::new()),
        }
    }
    pub fn scan(&self) -> CoreResult<Value> {
        let home = dirs::home_dir().ok_or_else(|| invalid("home", "Home directory unavailable"))?;
        let mut docs = document::Documents {
            env: std::env::vars().collect(),
            reports: Vec::new(),
        };
        let existing = self.connections.list()?;
        let locations = locations::locations(&home, &docs.env, &existing);
        let candidates = deduplicate(discovery::discover(&mut docs, &locations, &home));
        self.cache(candidates, docs.reports, &existing)
    }
    fn cache(
        &self,
        mut candidates: Vec<Candidate>,
        sources: Vec<Value>,
        existing: &[Value],
    ) -> CoreResult<Value> {
        for candidate in &mut candidates {
            if let Some(value) = self.existing(candidate, existing)? {
                candidate.public["existingConnectionId"] = value["id"].clone();
            }
        }
        let scan_id = uuid::Uuid::new_v4().to_string();
        let public = candidates
            .iter()
            .map(|c| c.public.clone())
            .collect::<Vec<_>>();
        let mut scans = self.scans.lock().unwrap();
        scans.retain(|_, s| s.created.elapsed() < Duration::from_secs(600));
        if scans.len() >= 4 {
            if let Some(oldest) = scans
                .iter()
                .min_by_key(|(_, s)| s.created)
                .map(|(id, _)| id.clone())
            {
                scans.remove(&oldest);
            }
        }
        scans.insert(
            scan_id.clone(),
            Scan {
                created: Instant::now(),
                candidates,
            },
        );
        Ok(
            json!({"scanId":scan_id,"expiresAt":(chrono::Utc::now()+chrono::Duration::minutes(10)).to_rfc3339(),"candidates":public,"sources":sources}),
        )
    }
    fn existing(&self, candidate: &Candidate, connections: &[Value]) -> CoreResult<Option<Value>> {
        for connection in connections {
            if connection["kind"] != "api"
                || connection["protocol"] != candidate.public["protocol"]
                || normalized_url(connection["baseUrl"].as_str().unwrap_or(""))
                    != normalized_url(candidate.public["baseUrl"].as_str().unwrap_or(""))
            {
                continue;
            }
            let key = self
                .credentials
                .read(&super::connection_service::credential_key(
                    connection["id"].as_str().unwrap_or(""),
                    connection["revision"].as_u64().unwrap_or(0),
                ))?;
            if key.as_ref().and_then(|k| k["apiKey"].as_str()) == candidate.secret.as_deref() {
                return Ok(Some(connection.clone()));
            }
        }
        Ok(None)
    }
    pub fn import(&self, input: &Value) -> CoreResult<Value> {
        let id = input["scanId"]
            .as_str()
            .ok_or_else(|| invalid("scanId", "Scan again before importing"))?;
        let ids = input["candidateIds"]
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 256)
            .ok_or_else(|| invalid("candidateIds", "Select 1–256 connections"))?;
        let mut scans = self.scans.lock().unwrap();
        let scan = scans
            .get_mut(id)
            .filter(|s| s.created.elapsed() < Duration::from_secs(600))
            .ok_or_else(|| invalid("scanId", "SCAN_EXPIRED"))?;
        if ids
            .iter()
            .any(|id| !id.is_string() || !scan.candidates.iter().any(|c| c.public["id"] == *id))
        {
            return Err(invalid("candidateIds", "Unknown scan candidate"));
        }
        let mut results = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in ids {
            if !seen.insert(id.as_str().unwrap()) {
                continue;
            }
            let candidate = scan
                .candidates
                .iter()
                .find(|c| c.public["id"] == *id)
                .unwrap();
            let existing = self.connections.list()?;
            if let Some(connection) = self.existing(candidate, &existing)? {
                results.push(json!({"candidateId":id,"status":"existing","connection":connection}));
                continue;
            }
            let connection = json!({"id":format!("connection-{}",uuid::Uuid::new_v4()),"name":candidate.public["name"],"kind":"api","enabled":true,
                "protocol":candidate.public["protocol"],"baseUrl":candidate.public["baseUrl"],"models":candidate.public["models"]});
            let mut request = json!({"connection":connection});
            if let Some(key) = &candidate.secret {
                request["apiKey"] = json!(key);
            }
            match self.connections.upsert(&request) {
                Ok(connection) => results
                    .push(json!({"candidateId":id,"status":"imported","connection":connection})),
                Err(_) => results
                    .push(json!({"candidateId":id,"status":"failed","error":"IMPORT_FAILED"})),
            }
        }
        Ok(json!({"items":results}))
    }
}
fn normalized_url(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}
fn deduplicate(candidates: Vec<Candidate>) -> Vec<Candidate> {
    let mut result: Vec<Candidate> = Vec::new();
    for mut candidate in candidates {
        // Models and credentials stay in the daemon; the public preview never contains keys.
        let mut models = Vec::<Value>::new();
        for model in candidate.public["models"].as_array().unwrap() {
            if !models.iter().any(|m| m["id"] == model["id"]) {
                models.push(model.clone());
            }
        }
        candidate.public["models"] = json!(models);
        if let Some(same) = result.iter_mut().find(|c| {
            c.public["protocol"] == candidate.public["protocol"]
                && normalized_url(c.public["baseUrl"].as_str().unwrap())
                    == normalized_url(candidate.public["baseUrl"].as_str().unwrap())
                && c.secret == candidate.secret
        }) {
            for source in candidate.public["sources"].as_array().unwrap() {
                if !same.public["sources"].as_array().unwrap().contains(source) {
                    same.public["sources"]
                        .as_array_mut()
                        .unwrap()
                        .push(source.clone());
                }
            }
            for model in models {
                if !same.public["models"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["id"] == model["id"])
                {
                    same.public["models"].as_array_mut().unwrap().push(model);
                }
            }
            if !same.public["models"].as_array().unwrap().is_empty() {
                same.public["warnings"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|w| w != "MODELS_MISSING");
            }
        } else {
            result.push(candidate);
        }
    }
    for candidate in &mut result {
        candidate.public["models"]
            .as_array_mut()
            .unwrap()
            .truncate(500);
    }
    result
}
