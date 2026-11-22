use std::{fs, io::Read, path::Path, sync::LazyLock};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};

use crate::{database::{connection::db_fail, Repositories}, errors::CoreResult};

pub(super) fn snapshot(connection: &Value, health: &Value) -> Value {
    let mut meta = health.clone();
    if !meta.is_object() { meta = json!({}); }
    let mut present = connection["hasCredential"] == true;
    let mut auth_rejected = meta["lastErrorSummary"] == "AUTH_REQUIRED";
    if connection["kind"] == "login" {
        let harness = connection["harness"].as_str().unwrap_or_default();
        let directory = connection["loginProfileDirectory"].as_str().filter(|path| !path.is_empty()).map(Path::new);
        let method = match harness {
            "antigravity" => "system_keyring",
            "opencode" => "console_oauth",
            _ => "cli_oauth",
        };
        let mut storage = json!({"authMethod":method});
        if let Some(directory) = directory {
            if harness != "antigravity" { storage["configDir"] = json!(directory); }
            let verified = read_json(&directory.join(".nautilo-verified-login.json"));
            if verified["providerId"] == harness && date(&verified["lastVerifiedAt"]).is_some() {
                let verified_at = date(&verified["lastVerifiedAt"]);
                if verified_at > date(&meta["lastVerifiedAt"]) {
                    meta["lastVerifiedAt"] = verified["lastVerifiedAt"].clone();
                }
                if verified_at > date(&meta["lastCheckedAt"]) {
                    auth_rejected = false;
                }
            }
            if harness == "opencode" {
                let path = directory.join("data/opencode/opencode.db");
                if let Some((id, email, expires, updated)) = open_code_identity(&path) {
                    present = true;
                    insert_text(&mut meta, "accountExternalId", &json!(id));
                    insert_text(&mut meta, "accountEmail", &json!(email));
                    let expires = expires.and_then(DateTime::<Utc>::from_timestamp_millis);
                    if let Some(expires) = expires { meta["tokenExpiresAt"] = json!(iso(expires)); }
                    if let Some(updated) = updated.and_then(DateTime::<Utc>::from_timestamp_millis) {
                        storage["credentialUpdatedAt"] = json!(iso(updated));
                    }
                }
            } else if let Some(file) = match harness {
                "codex" => Some("auth.json"),
                "claude-code" => Some(".credentials.json"),
                "kimi-code" => Some("credentials/kimi-code.json"),
                _ => None,
            } {
                let path = directory.join(file);
                let auth = read_json(&path);
                let expires = match harness {
                    "codex" => {
                        let tokens = &auth["tokens"];
                        let access = jwt(&tokens["access_token"]);
                        let id = jwt(&tokens["id_token"]);
                        let account = id.get("https://api.openai.com/auth").unwrap_or(&access["https://api.openai.com/auth"]);
                        present = token_present(&tokens["access_token"]);
                        let email = [&id["email"], &id["https://api.openai.com/profile"]["email"], &access["https://api.openai.com/profile"]["email"]]
                            .into_iter().find(|value| token_present(value)).unwrap_or(&Value::Null);
                        insert_text(&mut meta,"accountEmail",email);
                        insert_text(&mut meta,"accountLabel", &id["name"]);
                        insert_text(&mut meta,"accountExternalId", tokens.get("account_id").unwrap_or(&account["chatgpt_account_id"]));
                        insert_text(&mut meta,"subscriptionPlan", &account["chatgpt_plan_type"]);
                        access["exp"].as_i64().or_else(|| id["exp"].as_i64()).and_then(|seconds| DateTime::from_timestamp(seconds,0))
                    }
                    "claude-code" => {
                        let oauth = &auth["claudeAiOauth"];
                        present = token_present(&oauth["accessToken"]);
                        if present {
                            let profile = read_json(&directory.join(".claude.json"));
                            let account = &profile["oauthAccount"];
                            for (field,key) in [("accountEmail","emailAddress"),("accountLabel","displayName"),("accountExternalId","accountUuid"),("workspaceName","organizationName")] {
                                insert_text(&mut meta,field,&account[key]);
                            }
                            insert_text(&mut meta,"subscriptionPlan",&oauth["subscriptionType"]);
                        }
                        oauth["expiresAt"].as_i64().and_then(DateTime::from_timestamp_millis)
                    }
                    _ => {
                        present = token_present(&auth["access_token"]);
                        let access = jwt(&auth["access_token"]);
                        for (field,key) in [("accountEmail","email"),("accountLabel","name"),("accountExternalId","sub")] {
                            insert_text(&mut meta,field,&access[key]);
                        }
                        access["exp"].as_i64().and_then(|seconds| DateTime::from_timestamp(seconds,0))
                    }
                };
                if present {
                    if let Some(expires) = expires { meta["tokenExpiresAt"] = json!(iso(expires)); }
                    if let Ok(updated) = fs::metadata(&path).and_then(|info| info.modified()) {
                        storage["credentialUpdatedAt"] = json!(iso(updated.into()));
                    }
                }
            }
        }
        meta["storageMeta"] = storage;
        // An official Antigravity session probe or sign-in is the evidence available
        // for the current system-keyring account. Its credential file is not ours to read.
        if harness == "antigravity" { present = date(&meta["lastVerifiedAt"]).is_some(); }
    }
    let now = Utc::now();
    let expires = date(&meta["tokenExpiresAt"]);
    let status = if expires.is_some_and(|time| time <= now) { "expired" }
        else if auth_rejected { "error" }
        else if expires.is_some_and(|time| time <= now + Duration::hours(24)) { "expiring" }
        else if present && date(&meta["lastVerifiedAt"]).is_some() { "valid" }
        else { "unverified" };
    meta["authStatus"] = json!(status);
    meta
}

fn read_json(path: &Path) -> Value {
    let Ok(file) = fs::File::open(path) else { return Value::Null; };
    let mut bytes = Vec::new();
    if file.take(512 * 1024).read_to_end(&mut bytes).is_err() { return Value::Null; }
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

fn open_code_identity(path: &Path) -> Option<(String, Option<String>, Option<i64>, Option<i64>)> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    db.busy_timeout(std::time::Duration::ZERO).ok()?;
    db.query_row("SELECT a.id, a.email, NULLIF(a.token_expiry,0), NULLIF(a.time_updated,0) FROM account a
        JOIN account_state s ON s.active_account_id=a.id WHERE length(a.access_token)>0 LIMIT 1",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).ok()
}

fn token_present(value: &Value) -> bool { value.as_str().is_some_and(|text| !text.is_empty()) }
fn jwt(value: &Value) -> Value {
    value.as_str().and_then(|token| token.split('.').nth(1))
        .and_then(|body| URL_SAFE_NO_PAD.decode(body).ok())
        .and_then(|body| serde_json::from_slice(&body).ok()).unwrap_or(Value::Null)
}
fn insert_text(output: &mut Value, key: &str, value: &Value) {
    if let Some(text) = value.as_str().map(str::trim).filter(|v| !v.is_empty() && v.len() <= 256 && !v.chars().any(char::is_control)) {
        output[key] = json!(text);
    }
}
fn date(value: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.as_str()?).ok().map(|value| value.with_timezone(&Utc))
}
pub(super) fn iso(time: DateTime<Utc>) -> String { time.to_rfc3339_opts(SecondsFormat::Millis,true) }

pub(super) fn update_health(db: &Connection, id: &str, revision: u64, update: impl FnOnce(&mut Value)) -> CoreResult<()> {
    let repo = Repositories::new(db).runtime_connections();
    let Some(mut connection) = repo.get(id)? else { return Ok(()); };
    if connection["revision"].as_u64() != Some(revision) { return Ok(()); }
    if !connection["connectionHealth"].is_object() { connection["connectionHealth"] = json!({}); }
    update(&mut connection["connectionHealth"]);
    let updated = connection["updatedAt"].as_str().unwrap_or_default();
    repo.save(&connection, updated)
}

pub(crate) fn record_run_rate_limit(db: &Connection, run: &Value, message: &str) -> CoreResult<()> {
    static RATE_LIMIT: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)(?:\bHTTP(?: status)?[ :]+429\b|\b429 Too Many Requests\b|\(429\)|\brate[_ -]limit(?:ed|[_ -](?:exceeded|reached|error))\b|\bquota[_ -](?:exceeded|exhausted|reached)\b|\bfree usage limit reached\b)").unwrap());
    static RETRY: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?im)\bretry-after[ \t]*:[ \t]*([^\r\n]+)").unwrap());
    let (Some(id),Some(revision)) = (run["connectionId"].as_str(),run["connectionRevision"].as_u64()) else { return Ok(()); };
    if !RATE_LIMIT.is_match(message) { return Ok(()); }
    let retry_after = RETRY.captures(message).and_then(|captures| captures.get(1)).map(|value| value.as_str().trim());
    record_rate_limit(db, id, revision, retry_after)
}

pub(crate) fn record_rate_limit(db: &Connection, id: &str, revision: u64, retry_after: Option<&str>) -> CoreResult<()> {
    let now = Utc::now();
    let until = retry_after.and_then(|value| {
        value.parse::<i64>().ok().and_then(Duration::try_seconds).and_then(|delay| now.checked_add_signed(delay))
            .or_else(|| DateTime::parse_from_rfc2822(value).ok().map(|value| value.with_timezone(&Utc)))
    });
    update_health(db, id, revision, |health| {
        if until.is_none() && date(&health["rateLimitedUntil"]).is_some_and(|time| time > now) { return; }
        health["rateLimitedUntil"] = json!(iso(until.unwrap_or(now + Duration::minutes(15))));
        health["lastRateLimitReason"] = json!("PROVIDER_RATE_LIMIT");
    })
}

pub(super) fn add_detail(db: &Connection, connection: &mut Value) -> CoreResult<()> {
    let id = connection["id"].as_str().unwrap_or_default();
    let now = Utc::now();
    let local = now.with_timezone(&chrono::Local);
    let midnight = local.date_naive().and_hms_opt(0,0,0).unwrap()
        .and_local_timezone(chrono::Local).earliest().map(|value| value.with_timezone(&Utc)).unwrap_or(now);
    let today = iso(midnight);
    let week = iso(now - Duration::days(7));
    let requests: u64 = db.query_row("SELECT count(*) FROM runs WHERE json_extract(data,'$.connectionId')=?1 AND json_extract(data,'$.startedAt')>=?2",
        [id,&today], |row| row.get(0)).map_err(db_fail)?;
    let latest: Option<(String, Option<String>)> = db.query_row("SELECT json_extract(r.data,'$.startedAt'),json_extract(p.data,'$.name')
        FROM runs r LEFT JOIN sessions s ON s.id=r.session_id LEFT JOIN projects p ON p.id=s.project_id
        WHERE json_extract(r.data,'$.connectionId')=?1 AND json_extract(r.data,'$.startedAt') IS NOT NULL
        ORDER BY json_extract(r.data,'$.startedAt') DESC LIMIT 1", [id], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(db_fail)?;
    let usage = super::usage::totals(db,id,&week)?;
    let mut detail = json!({"requestsToday":requests,"tokens7d":usage.0});
    if let Some(rate) = usage.1 { detail["cacheHitRate7d"] = json!(rate); }
    if let Some((time, project)) = latest {
        detail["lastUsedAt"] = json!(time);
        if let Some(project) = project { detail["lastUsedContext"] = json!(project); }
    }
    let references = db.prepare("WITH bindings(agent_id) AS (
            SELECT coalesce(json_extract(s.data,'$.agentInstanceId'),s.member_id) FROM sessions s WHERE json_extract(s.data,'$.connectionId')=?1
            UNION SELECT json_extract(m.value,'$.agentInstanceId') FROM teams t, json_each(t.data,'$.members') m WHERE json_extract(m.value,'$.connectionId')=?1
        ) SELECT DISTINCT json_extract(a.data,'$.providerId') FROM bindings b JOIN agents a ON a.id=b.agent_id
        WHERE json_extract(a.data,'$.providerId')<>?2 ORDER BY 1").map_err(db_fail)?
        .query_map([id,connection["harness"].as_str().unwrap_or_default()], |row| row.get::<_,String>(0)).map_err(db_fail)?
        .collect::<Result<Vec<_>,_>>().map_err(db_fail)?;
    connection["accountMeta"]["localUsage"] = detail;
    connection["accountMeta"]["referencedByHarnesses"] = json!(references);
    Ok(())
}
