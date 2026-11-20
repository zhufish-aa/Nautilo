use serde_json::{json, Value};
use crate::application::core_daemon::Daemon;
use crate::database::composer_drafts as repository;
use crate::errors::{invalid, CoreResult};

pub fn list(daemon: &Daemon) -> CoreResult<Value> {
    let rows = repository::list(&daemon.db.lock().unwrap().raw)?;
    let mut items = Vec::new();
    let mut unreadable = Vec::new();
    for row in rows {
        let id = row["id"].as_str().unwrap_or("");
        if row["encrypted"].is_null() {
            items.push(json!({"id":id,"revision":row["revision"],"value":null,"acceptedMessageIds":[]}));
            continue;
        }
        match daemon.credentials.decrypt_payload(&row["encrypted"]) {
            Ok(value) => {
                let ids: Vec<String> = value["submissions"].as_array().into_iter().flatten()
                    .filter_map(|s|s["messageId"].as_str().map(str::to_owned)).take(100).collect();
                let accepted = repository::accepted_messages(&daemon.db.lock().unwrap().raw,id,&ids)?;
                items.push(json!({"id":id,"revision":row["revision"],"value":value,"acceptedMessageIds":accepted}));
            }
            Err(_) => unreadable.push(id.to_string()),
        }
    }
    Ok(json!({"items":items,"unreadable":unreadable}))
}

pub fn write(daemon: &Daemon, input: &Value) -> CoreResult<Value> {
    let id = input["id"].as_str().filter(|id|!id.is_empty() && id.len()<=512).ok_or_else(||invalid("id","Invalid draft key"))?;
    let revision = input["revision"].as_u64().filter(|r| *r < 9_007_199_254_740_991).ok_or_else(||invalid("revision","Invalid draft revision"))?;
    let value = &input["value"];
    if (!value.is_object() && !value.is_null()) || value.to_string().len()>1_048_576 {
        return Err(invalid("value","Invalid draft payload"));
    }
    let encrypted = if value.is_null() {Value::Null} else {daemon.credentials.encrypt_payload(value)?};
    repository::write(&daemon.db.lock().unwrap().raw,id,revision,&encrypted)
}
