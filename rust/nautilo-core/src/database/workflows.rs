use crate::database::connection::db_fail;
use crate::errors::{invalid, CoreResult};
use crate::runtime::workflow::WorkflowRun;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub fn template(db: &Connection, id: &str, revision: Option<u64>) -> CoreResult<Option<Value>> {
    let raw: Option<String> = match revision {
        Some(revision) => db
            .query_row(
                "SELECT data FROM workflow_templates WHERE id=?1 AND revision=?2",
                params![id, revision],
                |r| r.get(0),
            )
            .optional(),
        None => db
            .query_row(
                "SELECT data FROM workflow_templates WHERE id=?1 ORDER BY revision DESC LIMIT 1",
                [id],
                |r| r.get(0),
            )
            .optional(),
    }
    .map_err(db_fail)?;
    raw.map(|s| serde_json::from_str(&s).map_err(|e| invalid("workflowTemplate", &e.to_string())))
        .transpose()
}
pub fn templates(db: &Connection) -> CoreResult<Vec<Value>> {
    let mut stmt=db.prepare("SELECT data FROM workflow_templates t WHERE revision=(SELECT MAX(revision) FROM workflow_templates WHERE id=t.id) ORDER BY updated_at DESC").map_err(db_fail)?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(db_fail)?;
    rows.map(|r| {
        serde_json::from_str(&r.map_err(db_fail)?)
            .map_err(|e| invalid("workflowTemplate", &e.to_string()))
    })
    .collect()
}
pub fn save_template(db: &mut Connection, input: &Value, now: &str) -> CoreResult<Value> {
    let id = input["id"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| invalid("id", "A template id is required"))?;
    let expected = input["revision"].as_u64().unwrap_or(0);
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_fail)?;
    let current = template(&tx, id, None)?;
    let actual = current
        .as_ref()
        .and_then(|v| v["revision"].as_u64())
        .unwrap_or(0);
    if expected != actual {
        return Err(invalid(
            "revision",
            "The template changed in another window. Reload before saving.",
        ));
    }
    let value = json!({"id":id,"revision":actual+1,"name":input["name"],"definition":input["definition"],"layout":input.get("layout").cloned().unwrap_or_else(||json!({"nodes":{}})),"createdAt":current.as_ref().map(|v|v["createdAt"].clone()).unwrap_or_else(||json!(now)),"updatedAt":now});
    tx.execute(
        "INSERT INTO workflow_templates(id,revision,data,updated_at) VALUES(?1,?2,?3,?4)",
        params![id, actual + 1, value.to_string(), now],
    )
    .map_err(db_fail)?;
    tx.commit().map_err(db_fail)?;
    Ok(value)
}
pub fn get(db: &Connection, id: &str) -> CoreResult<Option<WorkflowRun>> {
    let raw: Option<String> = db
        .query_row("SELECT data FROM workflow_runs WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(db_fail)?;
    raw.map(|s| serde_json::from_str(&s).map_err(|e| invalid("workflowRun", &e.to_string())))
        .transpose()
}
pub fn by_request(
    db: &Connection,
    session: &str,
    request: &str,
) -> CoreResult<Option<WorkflowRun>> {
    let id: Option<String> = db
        .query_row(
            "SELECT id FROM workflow_runs WHERE session_id=?1 AND request_id=?2",
            params![session, request],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_fail)?;
    id.map(|id| get(db, &id)).transpose().map(Option::flatten)
}
pub fn list(db: &Connection, session: Option<&str>, active: bool) -> CoreResult<Vec<WorkflowRun>> {
    let mut stmt=db.prepare("SELECT data FROM workflow_runs WHERE (?1 IS NULL OR session_id=?1) AND (?2=0 OR status IN ('running','paused')) ORDER BY updated_at DESC LIMIT 200").map_err(db_fail)?;
    let rows = stmt
        .query_map(params![session, active], |r| r.get::<_, String>(0))
        .map_err(db_fail)?;
    rows.map(|r| {
        serde_json::from_str(&r.map_err(db_fail)?)
            .map_err(|e| invalid("workflowRun", &e.to_string()))
    })
    .collect()
}

pub fn project_graphs(db: &Connection, project_run_id: &str) -> CoreResult<Vec<String>> {
    let mut statement = db.prepare(
        "SELECT id FROM workflow_runs WHERE (status IN ('running','paused','finalizing','needs_decision') OR pending_actions>0)
         AND COALESCE(json_extract(data,'$.taskProjection.projectRunId'),json_extract(data,'$.workspace.context.adoptedProjectRunId'))=?1",
    ).map_err(db_fail)?;
    let rows = statement.query_map([project_run_id], |row| row.get(0)).map_err(db_fail)?;
    rows.map(|row| row.map_err(db_fail)).collect()
}

pub fn project_has_foreground_work(db: &Connection, project_run_id: &str) -> CoreResult<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM runs WHERE json_extract(data,'$.projectRunId')=?1
           AND json_extract(data,'$.status') NOT IN ('completed','failed','timed_out','crashed','cancelled'))",
        [project_run_id], |row| row.get(0)
    ).map_err(db_fail)
}
/// The projection, appended event history and durable pending actions commit
/// together. A second daemon cannot overwrite a transition or launch it twice.
pub fn save(db: &Connection, run: &mut WorkflowRun) -> CoreResult<()> {
    let previous = run.revision;
    run.revision += 1;
    let actions = run
        .messages
        .iter()
        .filter(|m| ["queued", "delivering", "waiting_approval"].contains(&m.status.as_str()))
        .count();
    let actions = actions
        + run
            .instances
            .iter()
            .filter(|instance| {
                ["cancelled", "failed"].contains(&instance.status.as_str())
                    && instance
                        .native_work
                        .as_ref()
                        .is_some_and(|work| work.pending())
            })
            .count();
    let workspace_cleanup=run.workspace.as_ref().is_some_and(|workspace|!run.active() && ["planning","preparing","verifying","waiting_approval","waiting_merge","merging"].contains(&workspace.stage.as_str()));
    let project_pending = run.task_projection.as_ref().and_then(|source| source.project_plan.as_ref()).is_some_and(|plan| plan.stage != "done");
    let actions=actions+usize::from(workspace_cleanup)+usize::from(project_pending)+run.instances.iter().filter(|instance|!instance.active() && instance.workspace.as_ref().is_some_and(|workspace|["preparing","verifying","waiting_approval"].contains(&workspace.stage.as_str()))).count();
    let changed=if previous==0 {
        db.execute("INSERT OR IGNORE INTO workflow_runs(id,session_id,request_id,revision,status,data,updated_at,pending_actions) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![run.id,run.session_id,run.request_id,run.revision,run.status,serde_json::to_string(run).unwrap(),run.updated_at,actions])
    }else{
        db.execute("UPDATE workflow_runs SET revision=?2,status=?3,data=?4,updated_at=?5,pending_actions=?7 WHERE id=?1 AND revision=?6",params![run.id,run.revision,run.status,serde_json::to_string(run).unwrap(),run.updated_at,previous,actions])
    }.map_err(db_fail)?;
    if changed != 1 {
        run.revision = previous;
        return Err(invalid("revision", "Workflow state changed concurrently"));
    }
    let last_sequence = db
        .query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM workflow_events WHERE run_id=?1",
            [&run.id],
            |row| row.get::<_, usize>(0),
        )
        .map_err(db_fail)?;
    for event in run.events.iter().filter(|e| e.sequence > last_sequence) {
        db.execute(
            "INSERT OR IGNORE INTO workflow_events(run_id,sequence,data) VALUES(?1,?2,?3)",
            params![
                run.id,
                event.sequence,
                serde_json::to_string(event).unwrap()
            ],
        )
        .map_err(db_fail)?;
    }
    Ok(())
}
pub fn lease(db: &Connection, id: &str, owner: &str, now: i64) -> CoreResult<bool> {
    Ok(db.execute("UPDATE workflow_runs SET lease_owner=?2,lease_until=?3 WHERE id=?1 AND (lease_owner=?2 OR lease_until IS NULL OR lease_until<?4)",params![id,owner,now+15_000,now]).map_err(db_fail)?==1)
}
pub fn pending(db: &Connection) -> CoreResult<Vec<String>> {
    // Terminal projections can still own an in-flight provider turn or child.
    // Keep reconciling until cancellation has reached those real executions.
    let mut stmt=db.prepare("SELECT id FROM workflow_runs w WHERE status IN ('running','paused','finalizing') OR pending_actions>0 OR EXISTS (SELECT 1 FROM runs r WHERE json_extract(r.data,'$.workflow.runId')=w.id AND json_extract(r.data,'$.status') NOT IN ('completed','failed','timed_out','crashed','cancelled')) OR EXISTS (SELECT 1 FROM workflow_runs child WHERE json_extract(child.data,'$.parentRunId')=w.id AND child.status IN ('running','paused','finalizing'))").map_err(db_fail)?;
    let rows = stmt.query_map([], |r| r.get(0)).map_err(db_fail)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_fail)
}
pub fn live_executions(db: &Connection, workflow: &str, instance: &str) -> CoreResult<Vec<Value>> {
    let mut statement = db.prepare("SELECT data FROM runs WHERE json_extract(data,'$.workflow.runId')=?1 AND json_extract(data,'$.workflow.instanceId')=?2 AND json_extract(data,'$.status') NOT IN ('completed','failed','timed_out','crashed','cancelled')").map_err(db_fail)?;
    let rows = statement
        .query_map(params![workflow, instance], |r| r.get::<_, String>(0))
        .map_err(db_fail)?;
    rows.map(|r| {
        serde_json::from_str(&r.map_err(db_fail)?).map_err(|e| invalid("run", &e.to_string()))
    })
    .collect()
}
pub fn native_work_events(db: &Connection, run_id: &str, after: i64) -> CoreResult<Vec<Value>> {
    let mut statement=db.prepare("SELECT data FROM runtime_events WHERE run_id=?1 AND sequence>?2 AND json_extract(data,'$.type') IN ('tool.started','tool.updated','tool.finished','provider.runtime_closed','provider.background_error') ORDER BY sequence,rowid").map_err(db_fail)?;
    let rows = statement
        .query_map(params![run_id, after], |row| row.get::<_, String>(0))
        .map_err(db_fail)?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(db_fail)?)
            .map_err(|error| invalid("nativeWork", &error.to_string()))
    })
    .collect()
}
pub struct FamilyBudget {
    pub max_parallel: usize,
    pub remaining_instances: usize,
    pub active: usize,
    members: BTreeMap<(String, String), usize>,
}
impl FamilyBudget {
    pub(crate) fn active_for_binding(&self, binding: &Value) -> usize {
        self.members.get(&member_limit_key(binding)).copied().unwrap_or(0)
    }
}
fn member_limit_key(binding: &Value) -> (String, String) {
    let harness = if binding["memberSnapshot"]["enabled"] == true {
        ""
    } else {
        binding["agentInstanceId"].as_str().unwrap_or("")
    };
    (harness.to_owned(), binding["memberId"].as_str().unwrap_or("").to_owned())
}
pub fn remaining_instance_budget(db: &Connection, id: &str) -> CoreResult<usize> {
    db.query_row(
        "WITH RECURSIVE ancestors(id,depth) AS (
            SELECT ?1,0
            UNION ALL SELECT json_extract(w.data,'$.parentRunId'),a.depth+1 FROM ancestors a
            JOIN workflow_runs w ON w.id=a.id WHERE json_extract(w.data,'$.parentRunId') IS NOT NULL AND a.depth<63
         ), family(owner,id,depth) AS (
            SELECT id,id,0 FROM ancestors
            UNION ALL SELECT f.owner,w.id,f.depth+1 FROM family f
            JOIN workflow_runs w ON json_extract(w.data,'$.parentRunId')=f.id WHERE f.depth<63
         ), used(owner,instances) AS (
            SELECT f.owner,SUM(json_array_length(w.data,'$.instances'))
            FROM family f JOIN workflow_runs w ON w.id=f.id GROUP BY f.owner
         )
         SELECT COALESCE(MIN(MAX(0,json_extract(w.data,'$.definition.limits.maxInstances')-used.instances)),0)
         FROM used JOIN workflow_runs w ON w.id=used.owner",
        [id], |row| row.get(0),
    ).map_err(db_fail)
}
/// The caller holds the same write transaction that reserves a node. Counting
/// the whole pinned call tree prevents parallel child workflows from each
/// spending the full parent concurrency/instance budget independently.
pub fn family_budget(db: &Connection, id: &str) -> CoreResult<FamilyBudget> {
    let mut root = get(db, id)?.ok_or_else(|| invalid("workflow", "Missing budget owner"))?;
    for _ in 0..64 {
        let Some(parent) = root.parent_run_id.clone() else {
            break;
        };
        root = get(db, &parent)?.ok_or_else(|| invalid("workflow", "Missing parent budget"))?;
    }
    let mut statement=db.prepare("WITH RECURSIVE family(id) AS (SELECT ?1 UNION ALL SELECT w.id FROM workflow_runs w JOIN family f ON json_extract(w.data,'$.parentRunId')=f.id) SELECT data FROM workflow_runs WHERE id IN (SELECT id FROM family)").map_err(db_fail)?;
    let rows = statement
        .query_map([&root.id], |r| r.get::<_, String>(0))
        .map_err(db_fail)?;
    let mut budget = FamilyBudget {
        max_parallel: root.definition.limits.max_parallel,
        remaining_instances: remaining_instance_budget(db, id)?,
        active: 0,
        members: BTreeMap::new(),
    };
    for row in rows {
        let run: WorkflowRun = serde_json::from_str(&row.map_err(db_fail)?)
            .map_err(|e| invalid("workflow", &e.to_string()))?;
        for instance in run.instances.iter().filter(|i| {
            i.occupies_slot()
        }) {
            let node = run.definition.node(&instance.node_id);
            if node.kind != "agent" {
                continue;
            }
            budget.active += 1;
            let binding = run.binding_for(node);
            *budget.members.entry(member_limit_key(binding)).or_default() += 1;
        }
    }
    Ok(budget)
}
pub fn execution(
    db: &Connection,
    workflow: &str,
    instance: &str,
    attempt: u32,
) -> CoreResult<Option<Value>> {
    let raw:Option<String>=db.query_row("SELECT data FROM runs WHERE json_extract(data,'$.workflow.runId')=?1 AND json_extract(data,'$.workflow.instanceId')=?2 AND json_extract(data,'$.workflow.attempt')=?3 ORDER BY updated_at DESC LIMIT 1",params![workflow,instance,attempt],|r|r.get(0)).optional().map_err(db_fail)?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|e| invalid("run", &e.to_string())))
        .transpose()
}
pub fn message_execution(db: &Connection, key: &str) -> CoreResult<Option<Value>> {
    let raw:Option<String>=db.query_row("SELECT data FROM runs WHERE json_extract(data,'$.queueKey')=?1 ORDER BY updated_at DESC LIMIT 1",[key],|r|r.get(0)).optional().map_err(db_fail)?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|e| invalid("run", &e.to_string())))
        .transpose()
}
/// Reserve a native session until its prior node has accepted its result and
/// released native background work. A completed foreground Run is insufficient.
pub fn session_in_use(db: &Connection, session: &str, workflow: &str, instance: &str) -> CoreResult<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM workflow_runs w, json_each(w.data,'$.instances') n WHERE json_extract(n.value,'$.sessionId')=?1 AND NOT(w.id=?2 AND json_extract(n.value,'$.id')=?3) AND (json_extract(n.value,'$.status') IN ('starting','running','waiting_submission','waiting_approval','verifying') OR (COALESCE(json_extract(n.value,'$.nativeWork.released'),0)=0 AND COALESCE(json_extract(n.value,'$.nativeWork.detached'),0)=0 AND EXISTS(SELECT 1 FROM json_each(n.value,'$.nativeWork.children') child WHERE child.value='running'))))",params![session,workflow,instance],|row|row.get(0)).map_err(db_fail)
}
/// Explicit team-member limits apply across independently launched task graphs
/// belonging to that project run, including leases held by another daemon.
pub fn task_member_active(db:&Connection,project_run:&str,member:&str)->CoreResult<usize> {
    db.query_row("SELECT COUNT(*) FROM workflow_runs w, json_each(w.data,'$.instances') n, json_each(w.data,'$.taskProjection.tasks') t WHERE json_extract(w.data,'$.taskProjection.projectRunId')=?1 AND t.key=json_extract(n.value,'$.nodeId') AND json_extract(t.value,'$.memberId')=?2 AND (json_extract(n.value,'$.status') IN ('starting','running','verifying') OR EXISTS(SELECT 1 FROM runs r WHERE json_extract(r.data,'$.workflow.runId')=w.id AND json_extract(r.data,'$.workflow.instanceId')=json_extract(n.value,'$.id') AND json_extract(r.data,'$.status') NOT IN ('completed','failed','cancelled','crashed','timed_out')) OR (COALESCE(json_extract(n.value,'$.nativeWork.released'),0)=0 AND COALESCE(json_extract(n.value,'$.nativeWork.detached'),0)=0 AND EXISTS(SELECT 1 FROM json_each(n.value,'$.nativeWork.children') child WHERE child.value='running')))",params![project_run,member],|row|row.get(0)).map_err(db_fail)
}
pub fn final_message(db: &Connection, run_id: &str) -> CoreResult<Option<String>> {
    db.query_row("SELECT json_extract(data,'$.text') FROM messages WHERE json_extract(data,'$.runId')=?1 AND json_extract(data,'$.sender')='agent' AND json_type(data,'$.text')='text' ORDER BY created_at DESC,rowid DESC LIMIT 1",[run_id],|row|row.get(0)).optional().map_err(db_fail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    fn run() -> WorkflowRun {
        WorkflowRun::start("workflow".into(),"session".into(),"project".into(),"request".into(),serde_json::from_value(json!({"schemaVersion":1,"id":"minimal","entry":"main","nodes":[{"id":"main","kind":"main","exits":[{"id":"done","name":"完成"}]}],"edges":[{"from":["main","done"],"to":"$return"}]})).unwrap(),json!({}),json!({}),1000).unwrap()
    }
    #[test]
    fn workflow_repository_pins_template_revisions_and_rejects_lost_updates() {
        let mut db = Database::open(std::path::Path::new(":memory:")).unwrap();
        let input = json!({"id":"template","revision":0,"name":"First","definition":run().definition,"layout":{"nodes":{}}});
        let first = save_template(&mut db.raw, &input, "1").unwrap();
        let mut update = input.clone();
        update["revision"] = json!(1);
        update["name"] = json!("Second");
        assert_eq!(
            save_template(&mut db.raw, &update, "2").unwrap()["revision"],
            2
        );
        assert!(save_template(&mut db.raw, &update, "3").is_err());
        assert_eq!(template(&db.raw, "template", Some(1)).unwrap(), Some(first));
        assert_eq!(
            template(&db.raw, "template", None).unwrap().unwrap()["name"],
            "Second"
        );
    }
    #[test]
    fn workflow_repository_rolls_back_events_messages_and_state_together() {
        let mut db = Database::open(std::path::Path::new(":memory:")).unwrap();
        let mut original = run();
        save(&db.raw, &mut original).unwrap();
        {
            let tx = db.raw.transaction().unwrap();
            let mut staged = original.clone();
            staged.event("test.event", None, "should roll back", Value::Null, 2000);
            staged.messages[0].status = "delivered".into();
            save(&tx, &mut staged).unwrap();
            // Simulate losing the process before the transaction commits.
        }
        let loaded = get(&db.raw, &original.id).unwrap().unwrap();
        assert_eq!(loaded.revision, original.revision);
        assert_eq!(loaded.events.len(), original.events.len());
        assert_eq!(loaded.messages[0].status, "queued");
        let count: usize = db
            .raw
            .query_row("SELECT COUNT(*) FROM workflow_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, original.events.len());
        let mut latest = original.clone();
        latest.event("test.committed", None, "commit", Value::Null, 3000);
        save(&db.raw, &mut latest).unwrap();
        assert!(save(&db.raw, &mut original).is_err());
        assert_eq!(
            get(&db.raw, &latest.id).unwrap().unwrap().events.len(),
            latest.events.len()
        );
    }
    #[test]
    fn workflow_repository_prevents_duplicate_launch_requests_and_competing_leases() {
        let db = Database::open(std::path::Path::new(":memory:")).unwrap();
        let mut original = run();
        save(&db.raw, &mut original).unwrap();
        let mut duplicate = run();
        duplicate.id = "other".into();
        assert!(save(&db.raw, &mut duplicate).is_err());
        assert_eq!(
            by_request(&db.raw, "session", "request")
                .unwrap()
                .unwrap()
                .id,
            original.id
        );
        assert!(lease(&db.raw, &original.id, "owner-one", 1000).unwrap());
        assert!(!lease(&db.raw, &original.id, "owner-two", 1001).unwrap());
        assert!(lease(&db.raw, &original.id, "owner-two", 16001).unwrap());
    }
}
