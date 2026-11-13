use super::{repositories::JsonRepository, Database, Repositories};
use crate::errors::now_iso;
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct RemoteRepository {
    db: Arc<Mutex<Database>>,
}

pub enum CommandReservation {
    New,
    Completed(Value),
    Pending,
}

impl RemoteRepository {
    pub fn new(db: Arc<Mutex<Database>>) -> Self {
        Self { db }
    }
    pub fn settings(&self) -> Result<Option<Value>> {
        Ok(JsonRepository::new(&self.db.lock().unwrap().raw, "remote_settings").get("host")?)
    }
    pub fn save_settings(&self, settings: &Value) -> Result<()> {
        let mut value = settings.clone();
        value["id"] = json!("host");
        Ok(
            JsonRepository::new(&self.db.lock().unwrap().raw, "remote_settings")
                .save(&value, &now_iso())?,
        )
    }
    pub fn devices(&self) -> Result<Vec<Value>> {
        Ok(JsonRepository::new(&self.db.lock().unwrap().raw, "remote_devices").list_default()?)
    }
    pub fn device(&self, id: &str) -> Result<Option<Value>> {
        Ok(JsonRepository::new(&self.db.lock().unwrap().raw, "remote_devices").get(id)?)
    }
    pub fn save_device(&self, device: &Value) -> Result<()> {
        Ok(
            JsonRepository::new(&self.db.lock().unwrap().raw, "remote_devices")
                .save(device, &now_iso())?,
        )
    }
    pub fn remove_device(&self, id: &str) -> Result<()> {
        JsonRepository::new(&self.db.lock().unwrap().raw, "remote_devices").remove(id)?;
        Ok(())
    }
    pub fn project_ids(&self) -> Result<Vec<String>> {
        Ok(Repositories::new(&self.db.lock().unwrap().raw)
            .projects()
            .list_default()?
            .iter()
            .filter_map(|v| v["id"].as_str().map(str::to_owned))
            .collect())
    }
    pub fn session_project(&self, id: &str) -> Result<String> {
        let db = self.db.lock().unwrap();
        let session = Repositories::new(&db.raw)
            .sessions()
            .get(id)?
            .ok_or_else(|| anyhow::anyhow!("SESSION_NOT_FOUND"))?;
        Ok(session["projectId"].as_str().unwrap_or("").to_owned())
    }
    pub fn session_template(&self, id: &str) -> Result<Value> {
        let db = self.db.lock().unwrap();
        let session = Repositories::new(&db.raw)
            .sessions()
            .get(id)?
            .ok_or_else(|| anyhow::anyhow!("SESSION_NOT_FOUND"))?;
        let mut input = json!({});
        for field in [
            "projectId",
            "memberId",
            "agentInstanceId",
            "connectionId",
            "connectionRevision",
            "model",
            "agentMode",
            "reasoningEffort",
            "serviceTier",
            "permissionMode",
        ] {
            if let Some(value) = session.get(field) {
                input[field] = value.clone();
            }
        }
        Ok(input)
    }
    pub fn mobile_options(&self) -> Result<Value> {
        let db = self.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let agents = repos.agents().list_default()?.into_iter().filter(|v| v["enabled"] != false)
            .map(|v| json!({"id":v["id"],"name":v["displayName"],"providerId":v["providerId"],"model":v["model"],"reasoningEffort":v["reasoningEffort"]})).collect::<Vec<_>>();
        let connections = repos
            .runtime_connections()
            .list_default()?
            .into_iter()
            .filter(|v| v["enabled"] == true)
            .map(|v| json!({"id":v["id"],"name":v["name"],"kind":v["kind"],"harness":v["harness"]}))
            .collect::<Vec<_>>();
        Ok(json!({"agents":agents,"connections":connections}))
    }
    pub fn mobile_session_input(&self, params: &Value) -> Result<Value> {
        let db = self.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let project = params["projectId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("INVALID_PROJECT"))?;
        if repos.projects().get(project)?.is_none() {
            bail!("PROJECT_NOT_FOUND");
        }
        let id = params["agentInstanceId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("INVALID_HARNESS"))?;
        let agent = repos
            .agents()
            .get(id)?
            .filter(|v| v["enabled"] != false)
            .ok_or_else(|| anyhow::anyhow!("HARNESS_NOT_AVAILABLE"))?;
        let mut input = json!({"projectId":project,"agentInstanceId":id,"memberId":id});
        for key in ["model", "reasoningEffort"] {
            if let Some(value) = params
                .get(key)
                .or_else(|| agent.get(key))
                .filter(|v| v.is_string())
            {
                input[key] = value.clone();
            }
        }
        if let Some(connection) = params["connectionId"].as_str().filter(|s| !s.is_empty()) {
            let value = repos
                .runtime_connections()
                .get(connection)?
                .filter(|v| v["enabled"] == true)
                .ok_or_else(|| anyhow::anyhow!("CONNECTION_NOT_AVAILABLE"))?;
            input["connectionId"] = json!(connection);
            input["connectionRevision"] = value["revision"].clone();
        }
        Ok(input)
    }
    pub fn run_session(&self, id: &str) -> Result<String> {
        let db = self.db.lock().unwrap();
        let run = Repositories::new(&db.raw)
            .runs()
            .get(id)?
            .ok_or_else(|| anyhow::anyhow!("RUN_NOT_FOUND"))?;
        Ok(run["sessionId"].as_str().unwrap_or("").to_owned())
    }
    pub fn session_details(&self, id: &str) -> Result<Value> {
        let db = self.db.lock().unwrap();
        let repos = Repositories::new(&db.raw);
        let session = repos
            .sessions()
            .get(id)?
            .ok_or_else(|| anyhow::anyhow!("SESSION_NOT_FOUND"))?;
        let agent_id = crate::application::session_service::effective_agent_id(&db.raw, &session)?;
        let agent = repos.agents().get(&agent_id)?.unwrap_or(json!({}));
        let mut config = json!({"id":id});
        for field in [
            "title",
            "status",
            "model",
            "reasoningEffort",
            "permissionMode",
            "agentMode",
            "projectId",
            "connectionId",
            "connectionRevision",
        ] {
            if let Some(value) = session.get(field) {
                config[field] = value.clone();
            }
        }
        let team = session["teamId"]
            .as_str()
            .map(|id| repos.teams().get(id))
            .transpose()?
            .flatten();
        let members = team
            .as_ref()
            .and_then(|t| t["members"].as_array())
            .into_iter()
            .flatten()
            .filter(|m| m["enabled"] != false)
            .map(|m| json!({"id":m["id"],"name":m["displayName"],"model":m["model"]}))
            .collect::<Vec<_>>();
        Ok(
            json!({"session":config,"agent":{"id":agent_id,"name":agent["displayName"],"providerId":agent["providerId"]},"members":members}),
        )
    }
    /// Bounded native event projection. It exposes only observed file changes.
    pub fn workspace_changes(&self, session: &str) -> Result<Value> {
        let db = self.db.lock().unwrap();
        let mut statement = db.raw.prepare("SELECT data FROM runtime_events WHERE session_id=?1 AND json_extract(data,'$.type') IN ('file.changed','tool.started','tool.finished','run.diff_updated','git.diff_collected') ORDER BY sequence DESC LIMIT 2000")?;
        let values = statement
            .query_map([session], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut files = std::collections::BTreeMap::<String, Value>::new();
        for raw in values.iter().rev() {
            let event: Value = serde_json::from_str(raw)?;
            let payload = &event["payload"];
            if let Some(diff) = payload
                .get("fileDiff")
                .filter(|d| ["edit", "write"].contains(&d["operation"].as_str().unwrap_or("")))
            {
                if let Some(path) = diff["path"].as_str() {
                    let entry = files
                        .entry(path.into())
                        .or_insert_with(|| json!({"path":path,"before":diff["before"]}));
                    entry["after"] = diff["after"].clone();
                    entry["truncated"] = diff["truncated"].clone();
                }
            }
            if event["type"] == "file.changed" {
                if let Some(path) = payload["path"].as_str() {
                    files.insert(path.into(), json!({"path":path,"patch":payload["diff"],"changeType":payload["changeType"]}));
                }
            }
            if let Some(patch) = payload["diff"]
                .as_str()
                .filter(|_| event["type"] == "run.diff_updated")
            {
                let mut path = String::new();
                let mut section = String::new();
                for line in patch.lines() {
                    if line.starts_with("diff --git ") {
                        if !path.is_empty() {
                            files.insert(path.clone(), json!({"path":path,"patch":section}));
                        }
                        path.clear();
                        section.clear();
                    }
                    if let Some(next) = line.strip_prefix("+++ b/") {
                        path = next.into();
                    }
                    if path.is_empty() {
                        if let Some(previous) = line.strip_prefix("--- a/") {
                            path = previous.into();
                        }
                    }
                    section.push_str(line);
                    section.push('\n');
                }
                if !path.is_empty() {
                    files.insert(path.clone(), json!({"path":path,"patch":section}));
                }
            }
        }
        let mut used = 0usize;
        let changes = files
            .into_values()
            .take(100)
            .take_while(|v| {
                used += v.to_string().len();
                used < 2_000_000
            })
            .collect::<Vec<_>>();
        Ok(json!({"files":changes}))
    }
    /// A durable reservation prevents repeating a mutation after a lost reply or restart.
    /// Pending reservations are deliberately retained when the outcome is uncertain.
    pub fn reserve(&self, id: &str, fingerprint: &str) -> Result<CommandReservation> {
        let db = self.db.lock().unwrap();
        let existing: Option<(String, Option<String>)> = db
            .raw
            .query_row(
                "SELECT fingerprint, response FROM remote_commands WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((saved, response)) = existing {
            if saved != fingerprint {
                bail!("REQUEST_ID_CONFLICT");
            }
            return Ok(match response {
                Some(value) => CommandReservation::Completed(serde_json::from_str(&value)?),
                None => CommandReservation::Pending,
            });
        }
        db.raw.execute(
            "INSERT INTO remote_commands(id,fingerprint,created_at) VALUES(?1,?2,?3)",
            params![id, fingerprint, now_iso()],
        )?;
        Ok(CommandReservation::New)
    }
    pub fn previous(&self, id: &str, fingerprint: &str) -> Result<Option<CommandReservation>> {
        let db = self.db.lock().unwrap();
        let existing: Option<(String, Option<String>)> = db
            .raw
            .query_row(
                "SELECT fingerprint,response FROM remote_commands WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((saved, response)) = existing else {
            return Ok(None);
        };
        if saved != fingerprint {
            bail!("REQUEST_ID_CONFLICT");
        }
        Ok(Some(match response {
            Some(value) => CommandReservation::Completed(serde_json::from_str(&value)?),
            None => CommandReservation::Pending,
        }))
    }
    pub fn epoch(&self) -> Result<String> {
        let db = self.db.lock().unwrap();
        Ok(db.raw.query_row(
            "SELECT epoch FROM read_projection_clock WHERE id=1",
            [],
            |r| r.get(0),
        )?)
    }
    pub fn complete(&self, id: &str, result: &Value) -> Result<()> {
        self.db.lock().unwrap().raw.execute(
            "UPDATE remote_commands SET response=?2 WHERE id=?1",
            params![id, result.to_string()],
        )?;
        Ok(())
    }
    pub fn audit(&self, peer: &str, action: &str, outcome: &str) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.raw.execute(
            "INSERT INTO remote_audit(device_id,action,outcome,timestamp) VALUES(?1,?2,?3,?4)",
            params![peer, action, outcome, now_iso()],
        )?;
        db.raw.execute("DELETE FROM remote_audit WHERE id < (SELECT COALESCE(MAX(id),0)-1000 FROM remote_audit)", [])?;
        Ok(())
    }
    pub fn history(&self, session: &str, before: Option<&Value>, limit: usize) -> Result<Value> {
        let db = self.db.lock().unwrap();
        let snapshot = db.raw.unchecked_transaction()?;
        let limit = limit.clamp(1, 100);
        let before_time = before
            .and_then(|v| v["createdAt"].as_str())
            .unwrap_or("9999");
        let before_ordinal = before
            .and_then(|v| v["ordinal"].as_i64())
            .unwrap_or(i64::MAX);
        let mut query = snapshot.prepare("SELECT rowid,created_at,data FROM messages WHERE session_id=?1 AND (created_at<?2 OR (created_at=?2 AND rowid<?3)) ORDER BY created_at DESC,rowid DESC LIMIT ?4")?;
        let rows = query.query_map(
            params![session, before_time, before_ordinal, limit + 1],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )?;
        let mut rows = rows.collect::<Result<Vec<_>, _>>()?;
        let more = rows.len() > limit;
        rows.truncate(limit);
        let next = if more {
            rows.last().map(|r| json!({"createdAt":r.1,"ordinal":r.0}))
        } else {
            None
        };
        rows.reverse();
        let mut items = rows
            .iter()
            .map(|r| {
                serde_json::from_str::<Value>(&r.2)
                    .map(|value| json!({"value":value,"order":{"createdAt":r.1,"ordinal":r.0}}))
            })
            .collect::<Result<Vec<_>, _>>()?;
        // Mobile associates each reply with its own native run, including older
        // history pages. Do not infer a duration from the latest session run.
        let message_ids = items.iter().map(|item| item["value"]["id"].clone()).collect::<Vec<_>>();
        let mut run_query = snapshot.prepare("SELECT json_extract(data,'$.payload.messageId'),run_id FROM runtime_events WHERE session_id=?1 AND json_extract(data,'$.type')='agent.message' AND json_extract(data,'$.payload.messageId') IN (SELECT value FROM json_each(?2)) ORDER BY sequence")?;
        let message_runs = run_query.query_map(params![session, serde_json::to_string(&message_ids)?], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?
            .collect::<Result<std::collections::HashMap<_, _>, _>>()?;
        for item in &mut items {
            if let Some(Some(run)) = item["value"]["id"].as_str().and_then(|id| message_runs.get(id)) {
                item["value"]["runId"] = json!(run);
            }
        }
        let sequence: i64 = snapshot.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM runtime_events WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )?;
        let epoch: String = snapshot.query_row(
            "SELECT epoch FROM read_projection_clock WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        let mut activity_query = snapshot.prepare("SELECT data FROM runtime_events WHERE session_id=?1 AND sequence<=?2 AND json_extract(data,'$.type') IN ('agent.message','agent.message_delta','agent.thinking_delta','agent.thinking_summary','tool.started','tool.updated','tool.finished','command.started','command.updated','command.finished','run.started','run.waiting','run.completed','run.cancelled','run.failed') ORDER BY sequence DESC LIMIT 200")?;
        let activity_rows = activity_query
            .query_map(params![session, sequence], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut activity = vec![];
        let mut size = 0;
        for raw in activity_rows {
            size += raw.len();
            if size > 2_000_000 {
                break;
            }
            activity.push(serde_json::from_str::<Value>(&raw)?);
        }
        activity.reverse();
        drop(activity_query);
        drop(run_query);
        drop(query);
        snapshot.commit()?;
        Ok(
            json!({"items":items,"before":next,"sequence":sequence,"epoch":epoch,"activity":activity}),
        )
    }
    pub fn events(&self, session: &str, after: i64, limit: usize) -> Result<Value> {
        let db = self.db.lock().unwrap();
        let latest: i64 = db.raw.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM runtime_events",
            [],
            |r| r.get(0),
        )?;
        if after > latest {
            bail!("CURSOR_RESET_REQUIRED");
        }
        let limit = limit.clamp(1, 200);
        let mut query = db.raw.prepare("SELECT data FROM runtime_events WHERE session_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3")?;
        let rows = query.query_map(params![session, after, limit + 1], |r| {
            r.get::<_, String>(0)
        })?;
        let mut events = rows
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .map(|s| serde_json::from_str::<Value>(s))
            .collect::<Result<Vec<_>, _>>()?;
        let more = events.len() > limit;
        events.truncate(limit);
        let sequence = events
            .last()
            .and_then(|v| v["sequence"].as_i64())
            .unwrap_or(after);
        Ok(json!({"events":events,"lastSequence":sequence,"hasMore":more}))
    }
}
