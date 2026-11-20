use rusqlite::{params, Connection};
use serde_json::{json, Value};
use crate::database::connection::db_fail;
use crate::errors::CoreResult;

pub fn list(db: &Connection) -> CoreResult<Vec<Value>> {
    let mut statement = db.prepare("SELECT id,revision,data FROM composer_drafts").map_err(db_fail)?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?, row.get::<_, String>(2)?))).map_err(db_fail)?;
    rows.map(|row| {
        let (id, revision, data) = row.map_err(db_fail)?;
        Ok(json!({"id":id,"revision":revision,"encrypted":serde_json::from_str::<Value>(&data).unwrap_or_else(|_|json!({"invalid":true}))}))
    }).collect()
}

/// Compare-and-swap is atomic across renderers and daemon processes. Tombstones
/// retain their revision so a late clear cannot resurrect a previously sent draft.
pub fn write(db: &Connection, id: &str, revision: u64, encrypted: &Value) -> CoreResult<Value> {
    let changed = if revision == 0 {
        db.execute("INSERT OR IGNORE INTO composer_drafts(id,revision,data) VALUES(?1,1,?2)", params![id, encrypted.to_string()]).map_err(db_fail)?
    } else {
        db.execute("UPDATE composer_drafts SET revision=revision+1,data=?3 WHERE id=?1 AND revision=?2", params![id, revision, encrypted.to_string()]).map_err(db_fail)?
    };
    Ok(json!({"saved":changed==1,"revision":if changed==1 {revision+1} else {revision}}))
}

pub fn accepted_messages(db: &Connection, session_id: &str, ids: &[String]) -> CoreResult<Vec<String>> {
    let mut statement = db.prepare("SELECT EXISTS(SELECT 1 FROM messages WHERE id=?1 AND session_id=?2)").map_err(db_fail)?;
    let mut accepted = Vec::new();
    for id in ids {
        if statement.query_row(params![id,session_id], |row| row.get::<_, bool>(0)).map_err(db_fail)? { accepted.push(id.clone()); }
    }
    Ok(accepted)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::database::migrations::migrate(&db).unwrap();
        db
    }
    #[test]
    fn composer_drafts_compare_and_swap_preserves_clear_revisions() {
        let db = database();
        assert_eq!(write(&db,"s",0,&json!({"ciphertext":"first"})).unwrap()["saved"], true);
        assert_eq!(write(&db,"s",0,&json!({"ciphertext":"stale"})).unwrap()["saved"], false);
        assert_eq!(write(&db,"s",1,&Value::Null).unwrap()["revision"], 2);
        assert_eq!(write(&db,"s",1,&json!({"ciphertext":"late"})).unwrap()["saved"], false);
        assert!(list(&db).unwrap()[0]["encrypted"].is_null());
    }
    #[test]
    fn composer_drafts_acknowledgements_are_session_scoped_and_deletion_cleans_up() {
        let db = database();
        db.execute("INSERT INTO sessions(id,project_id,member_id,data,updated_at) VALUES('s','p','m','{}','now')",[]).unwrap();
        db.execute("INSERT INTO messages(id,session_id,data,created_at) VALUES('accepted','s','{}','now'),('other','t','{}','now')",[]).unwrap();
        assert_eq!(accepted_messages(&db,"s",&["accepted".into(),"other".into(),"missing".into()]).unwrap(),vec!["accepted"]);
        write(&db,"s",0,&Value::Null).unwrap();
        db.execute("DELETE FROM sessions WHERE id='s'",[]).unwrap();
        assert!(list(&db).unwrap().is_empty());
    }
    #[test]
    fn composer_drafts_corruption_is_not_a_tombstone() {
        let db = database();
        db.execute("INSERT INTO composer_drafts(id,revision,data) VALUES('s',1,'corrupt')",[]).unwrap();
        assert_eq!(list(&db).unwrap()[0]["encrypted"]["invalid"],true);
    }
}
