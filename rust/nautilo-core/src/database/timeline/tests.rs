use super::*;
use crate::database::{Database, Repositories};
use crate::runtime::{event_service::EventService, security::RedactionService};
use std::sync::{Arc, Mutex};

#[tokio::test]
async fn live_order_matches_reopened_database_after_steering_and_late_result() {
    let path = std::env::temp_dir().join(format!("nautilo-timeline-{}.sqlite", Uuid::new_v4()));
    let db = Arc::new(Mutex::new(Database::open(&path).unwrap()));
    let session = json!({"id":"s"});
    {
        let guard = db.lock().unwrap();
        let repos = Repositories::new(&guard.raw);
        repos.sessions().save(&session).unwrap();
        for (id, text) in [
            ("u1", "first prompt"),
            ("u2", "steering"),
            ("u3", "next prompt"),
        ] {
            repos
                .sessions()
                .save_message(&json!({
                    "id":id,"sessionId":"s","sender":"user","kind":"chat","text":text,
                    "createdAt":"2025-01-01T00:00:00Z"
                }))
                .unwrap();
        }
    }
    let redaction = RedactionService::new(Arc::new(Vec::new));
    let events = EventService::new(db.clone(), redaction.clone());
    let initial = events.timeline_open("s").unwrap();
    let mut revision = initial["revision"].as_i64().unwrap();
    let mut live: Vec<Value> = vec![];
    let mut turns = serde_json::Map::new();
    for (run, kind, payload) in [
        ("r1", "run.started", json!({"userMessageId":"u1"})),
        (
            "r1",
            "agent.thinking_delta",
            json!({"messageId":"1","text":"first"}),
        ),
        (
            "r1",
            "agent.thinking_delta",
            json!({"messageId":"1","text":" thought"}),
        ),
        (
            "r1",
            "tool.started",
            json!({"callId":"call","toolName":"edit_file","fileDiff":{"path":"src/main.rs","before":"old","after":"new"}}),
        ),
        (
            "r1",
            "agent.thinking_summary",
            json!({"messageId":"1","text":"first thought"}),
        ),
        (
            "r1",
            "tool.started",
            json!({"callId":"call","toolName":"edit_file","inputSummary":"updated arguments"}),
        ),
        (
            "r1",
            "tool.finished",
            json!({"callId":"call","success":true}),
        ),
        ("r1", "session.follow_up_steered", json!({"messageId":"u2"})),
        (
            "r1",
            "agent.thinking_delta",
            json!({"messageId":"1","text":"second thought"}),
        ),
        (
            "r1",
            "agent.thinking_summary",
            json!({"messageId":"1","text":"second thought"}),
        ),
        (
            "r1",
            "agent.message_delta",
            json!({"messageId":"1","text":"Looking at this"}),
        ),
        (
            "r1",
            "agent.message",
            json!({"text":"Looking at this","timelineHadDelta":true}),
        ),
        (
            "r1",
            "agent.message",
            json!({"text":"Snapshot-only final","timelineHadDelta":false}),
        ),
        ("r1", "run.completed", json!({})),
        ("r2", "run.started", json!({"userMessageId":"u3"})),
        (
            "r1",
            "tool.finished",
            json!({"callId":"call","success":false}),
        ),
        (
            "r2",
            "agent.thinking_delta",
            json!({"messageId":"1","text":"new turn"}),
        ),
        (
            "r2",
            "interaction.requested",
            json!({"interaction":{"id":"approve","status":"pending"}}),
        ),
        (
            "r2",
            "interaction.resolved",
            json!({"interaction":{"id":"approve","status":"answered"}}),
        ),
    ] {
        let (page, _) = tokio::join!(events.timeline_wait("s", revision, 100), async {
            tokio::task::yield_now().await;
            events
                .append(&json!({"id":run}), &session, kind, payload)
                .unwrap();
        });
        let page = page.unwrap();
        assert_eq!(page["reset"], false);
        revision = page["revision"].as_i64().unwrap();
        for batch in page["changes"].as_array().unwrap() {
            if let Some(id) = batch["turn"]["runId"].as_str() {
                turns.insert(id.into(), batch["turn"].clone());
            }
            for op in batch["operations"].as_array().unwrap() {
                if op["type"] == "block_created" {
                    assert_eq!(op["block"]["seq"].as_u64().unwrap(), live.len() as u64 + 1);
                    live.push(op["block"].clone());
                    continue;
                }
                let index = live
                    .iter()
                    .position(|block| block["blockId"] == op["blockId"])
                    .unwrap();
                let tail = index + 1 == live.len();
                let target = &mut live[index];
                if op["type"] == "block_delta" {
                    assert!(tail && target["sealed"] == false);
                    target["content"]["text"] = json!(format!(
                        "{}{}",
                        target["content"]["text"].as_str().unwrap(),
                        op["text"].as_str().unwrap()
                    ));
                } else {
                    for key in ["sealed", "result", "status"] {
                        if let Some(value) = op.get(key) {
                            target[key] = value.clone();
                        }
                    }
                }
            }
        }
    }
    assert_eq!(
        live.iter()
            .map(|block| block["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "user_prompt",
            "thinking",
            "tool_call",
            "user_append",
            "thinking",
            "assistant_text",
            "assistant_text",
            "user_prompt",
            "late_result",
            "thinking",
            "interaction"
        ]
    );
    assert_eq!(live[1]["content"]["text"], "first thought");
    assert_eq!(live[2]["status"], "done");
    assert_eq!(live[2]["result"]["payload"]["fileDiff"]["path"], "src/main.rs");
    assert_eq!(live[2]["result"]["payload"]["inputSummary"], "updated arguments");
    assert_eq!(live[3]["content"]["text"], "steering");
    assert_eq!(live[4]["content"]["text"], "second thought");
    assert_eq!(live[5]["content"]["text"], "Looking at this");
    assert_eq!(live[6]["content"]["text"], "Snapshot-only final");
    assert_eq!(live[8]["runId"], "r1");
    assert_eq!(live[10]["status"], "answered");
    assert_eq!(turns["r1"]["finalBlockId"], live[6]["blockId"]);

    {
        let guard = db.lock().unwrap();
        let id = live[1]["blockId"].as_str().unwrap();
        let mut writer = Writer {
            db: &guard.raw,
            session: "s",
            changes: vec![],
            turn: None,
        };
        assert!(writer.append_text(id, " must not appear").is_err());
        assert!(guard
            .raw
            .execute(
                "UPDATE timeline_blocks SET content='{}' WHERE block_id=?",
                [id]
            )
            .is_err());
        assert!(guard
            .raw
            .execute("UPDATE timeline_blocks SET seq=80 WHERE block_id=?", [id])
            .is_err());
    }
    drop(events);
    drop(db);
    let reopened_db = Arc::new(Mutex::new(Database::open(&path).unwrap()));
    let reopened = EventService::new(reopened_db, redaction)
        .timeline_open("s")
        .unwrap();
    assert_eq!(reopened["blocks"], json!(live));
    assert_eq!(reopened["revision"], revision);
    let reopened_turns = reopened["turns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|turn| (turn["runId"].as_str().unwrap().to_string(), turn.clone()))
        .collect::<serde_json::Map<_, _>>();
    assert_eq!(reopened_turns, turns);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn migration_repairs_old_duplicate_tool_rows_at_the_first_position() {
    let path = std::env::temp_dir().join(format!("nautilo-timeline-repair-{}.sqlite", Uuid::new_v4()));
    let db = Database::open(&path).unwrap();
    Repositories::new(&db.raw).sessions().save(&json!({"id":"s"})).unwrap();
    db.raw.execute_batch("DELETE FROM schema_meta WHERE key='timeline_tool_rows_v1'").unwrap();
    let mut writer = Writer { db: &db.raw, session: "s", changes: vec![], turn: None };
    let start = json!({"type":"tool.started","payload":{"callId":"call","toolName":"bash"}});
    writer.create("tool_call", Some("r1"), start.clone(), true, Some("call"), Some("running")).unwrap();
    writer.create("thinking", Some("r1"), json!({"text":"between updates"}), true, None, None).unwrap();
    writer.create("tool_call", Some("r1"), start.clone(), true, Some("call"), Some("running")).unwrap();
    writer.update_result(Some("r1"), "tool_call", "call", &json!({"type":"tool.finished","payload":{"outputSummary":"result"}}), "done").unwrap();
    writer.create("tool_call", Some("r2"), start, true, Some("call"), Some("running")).unwrap();
    writer.record().unwrap();
    let before = open(&db.raw, "s").unwrap();
    drop(db);

    let db = Database::open(&path).unwrap();
    let after = open(&db.raw, "s").unwrap();
    let blocks = after["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0]["blockId"], before["blocks"][0]["blockId"]);
    assert_eq!(blocks[0]["seq"], 1);
    assert_eq!(blocks[0]["status"], "done");
    assert_eq!(blocks[0]["result"]["payload"]["outputSummary"], "result");
    assert_eq!(blocks[1], before["blocks"][1]);
    assert_eq!(blocks[2], before["blocks"][3]);
    assert_eq!(changes(&db.raw, "s", before["revision"].as_i64().unwrap()).unwrap()["reset"], true);
    drop(db);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn workflow_plan_migration_restores_one_card_at_the_original_position() {
    let path = std::env::temp_dir().join(format!("nautilo-timeline-plan-{}.sqlite", Uuid::new_v4()));
    let db = Database::open(&path).unwrap();
    Repositories::new(&db.raw).sessions().save(&json!({"id":"s"})).unwrap();
    db.raw.execute_batch("DELETE FROM schema_meta WHERE key='timeline_workflow_plan_rows_v1'").unwrap();
    let mut writer = Writer { db: &db.raw, session: "s", changes: vec![], turn: None };
    let snapshot = |id, status| json!({"type":"workflow.plan","payload":{"plan":{"id":id,"status":status}}});
    writer.create("notice", None, snapshot("p1", "pending"), true, None, None).unwrap();
    writer.create("assistant_text", None, json!({"text":"Plan ready"}), true, None, None).unwrap();
    writer.create("notice", None, snapshot("p1", "approved"), true, None, None).unwrap();
    writer.create("notice", None, snapshot("p2", "pending"), true, None, None).unwrap();
    writer.record().unwrap();
    let before = open(&db.raw, "s").unwrap();
    drop(db);

    let db = Database::open(&path).unwrap();
    let after = open(&db.raw, "s").unwrap();
    let blocks = after["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0]["blockId"], before["blocks"][0]["blockId"]);
    assert_eq!(blocks[0]["seq"], 1);
    assert_eq!(blocks[0]["result"], snapshot("p1", "approved"));
    assert_eq!(blocks[1], before["blocks"][1]);
    assert_eq!(blocks[2], before["blocks"][3]);
    assert_eq!(changes(&db.raw, "s", before["revision"].as_i64().unwrap()).unwrap()["reset"], true);
    drop(db);
    std::fs::remove_file(path).unwrap();
}
