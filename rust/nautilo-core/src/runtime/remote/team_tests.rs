use super::*;
use super::tests::{Fixture, rpc, call};
use crate::database::Repositories;

#[test]
fn mobile_team_request_reports_disk_full_without_exposing_database_details() {
    let error = anyhow::Error::new(rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL), Some("private database path".into()))).context("Failed to save remote command");
    let response = super::access::request_failure("request", &error);
    assert_eq!(response["error"]["code"], "DESKTOP_DISK_FULL");
    assert!(!response.to_string().contains("private database path"));
}

fn seed(fixture: &Fixture, active: bool) {
    let db = Database::open(&fixture.directory.join("test.sqlite")).unwrap();
    let repos = Repositories::new(&db.raw);
    repos.teams().save(&json!({"id":"team","name":"研发团队","delegationPolicy":"autonomous",
        "members":[{"id":"explorer","displayName":"项目探索者","enabled":true,"agentInstanceId":"test-agent","model":"model","systemPrompt":"private prompt"}],
        "privateSetting":"not for mobile"}), "2026-11-16").unwrap();
    let mut session = json!({"id":"session","projectId":"project","agentInstanceId":"test-agent","memberId":"main",
        "teamId":"team","providerSessionId":"native-thread","providerContextSyncedAt":"kept","createdAt":"2026-11-16","updatedAt":"2026-11-16"});
    if active {
        session["projectRunId"] = json!("team-run");
        repos.project_runs().save(&json!({"id":"team-run","projectId":"project","teamId":"team","status":"executing","goal":"真实团队任务",
            "createdAt":"2026-11-16T00:00:00Z","updatedAt":"2026-11-16T00:00:10Z"})).unwrap();
    }
    repos.sessions().save(&session).unwrap();
}

#[tokio::test]
async fn mobile_team_selection_preserves_identity_and_rejects_missing_teams() {
    let fixture = Fixture::new().await;
    seed(&fixture, false);
    let repo = &fixture.service.repo;
    let options = repo.mobile_options().unwrap();
    assert_eq!(options["teams"][0]["name"], "研发团队");
    assert!(options["teams"][0].get("privateSetting").is_none());
    assert!(options["teams"][0]["members"][0].get("systemPrompt").is_none());
    let details = repo.session_details("session").unwrap();
    assert_eq!(details["session"]["teamId"], "team");
    let mut template = repo.session_template("session").unwrap();
    assert_eq!(template["teamId"], "team");
    assert!(repo.mobile_select_team(&mut template, &json!({"teamId":"missing"})).is_err());
    repo.mobile_select_team(&mut template, &json!({"teamId":null})).unwrap();
    assert!(template["teamId"].is_null());
    assert_eq!(repo.session_details("session").unwrap()["session"]["teamId"], "team", "A preview must not mutate the desktop session");
    fixture.shutdown().await;
}

#[tokio::test]
async fn mobile_team_changes_keep_native_history_and_block_active_reassignment() {
    let fixture = Fixture::new().await;
    seed(&fixture, false);
    {
        let db = Arc::new(Mutex::new(Database::open(&fixture.directory.join("test.sqlite")).unwrap()));
        let service = crate::application::session_service::SessionService::new(db);
        let updated = service.upsert(&json!({"id":"session","projectId":"project","agentInstanceId":"test-agent","memberId":"main","teamId":null})).unwrap();
        assert!(updated.get("teamId").is_none());
        assert_eq!(updated["providerSessionId"],"native-thread");
        assert_eq!(updated["providerContextSyncedAt"],"kept");
    }
    seed(&fixture,true);
    {
        let db = Arc::new(Mutex::new(Database::open(&fixture.directory.join("test.sqlite")).unwrap()));
        let service = crate::application::session_service::SessionService::new(db);
        assert!(service.upsert(&json!({"id":"session","projectId":"project","agentInstanceId":"test-agent","memberId":"main","teamId":null})).is_err());
        assert_eq!(fixture.service.repo.session_details("session").unwrap()["session"]["teamId"],"team");
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn mobile_team_snapshot_keeps_parallel_dependencies_and_task_session_links() {
    let fixture = Fixture::new().await;
    seed(&fixture, true);
    {
        let db = Database::open(&fixture.directory.join("test.sqlite")).unwrap();
        let repos = Repositories::new(&db.raw);
        for (id, dependencies, status) in [("analysis",json!([]),"completed"),("ui",json!(["analysis"]),"running"),
            ("events",json!(["analysis"]),"running"),("verify",json!(["ui","events"]),"blocked_dependency")] {
            repos.tasks().save(&json!({"id":id,"projectRunId":"team-run","title":id,"status":status,"dependencies":dependencies,
                "assignedMemberId":"explorer","createdAt":"2026-11-16","updatedAt":"2026-11-16"})).unwrap();
        }
        repos.sessions().save(&json!({"id":"child-ui","projectId":"project","projectRunId":"team-run","teamId":"team","parentSessionId":"session",
            "taskId":"ui","agentInstanceId":"test-agent","createdAt":"2026-11-16","updatedAt":"2026-11-16"})).unwrap();
    }
    let result = fixture.service.repo.mobile_team_tasks("session").unwrap();
    let tasks = result["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(),4);
    let find = |id:&str| tasks.iter().find(|task| task["id"] == id).unwrap();
    assert_eq!(find("ui")["dependencies"],json!(["analysis"]));
    assert_eq!(find("events")["dependencies"],json!(["analysis"]));
    assert_eq!(find("verify")["dependencies"],json!(["ui","events"]));
    assert_eq!(find("ui")["sessionId"],"child-ui");
    assert_eq!(result["team"]["delegationPolicy"],"autonomous");
    assert!(result["run"]["endedAt"].is_null());
    fixture.shutdown().await;
}

#[tokio::test]
async fn mobile_team_first_message_uses_real_orchestration_and_command_deduplication() {
    let fixture = Fixture::new().await;
    seed(&fixture, false);
    let invite = fixture.invitation();
    let client = Endpoint::bind(iroh::endpoint::presets::Minimal).await.unwrap();
    let connection = client.connect(fixture.addr(), ALPN).await.unwrap();
    rpc(&connection,"pair",json!({"name":"Phone","token":invite["token"]})).await;
    fixture.service.approve(json!({"deviceId":client.id().to_string()})).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    for _ in 0..2 {
        let response = call(&connection,&id,"session.send",json!({"sessionId":"session","text":"并行分析和开发"})).await;
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["data"]["projectRunId"], "team-run");
    }
    assert_eq!(fixture.calls.load(std::sync::atomic::Ordering::SeqCst),1);
    assert_eq!(fixture.inputs.lock().unwrap()[0]["_method"],"orchestration.start");
    assert_eq!(fixture.inputs.lock().unwrap()[0]["sessionId"],"session");
    seed(&fixture,true);
    assert_eq!(rpc(&connection,"session.send",json!({"sessionId":"session","text":"继续"})).await["ok"],true);
    assert!(fixture.inputs.lock().unwrap()[1].get("_method").is_none(),"Reuse an existing project run rather than starting the team again");
    let cancel = rpc(&connection,"session.team.cancel",json!({"sessionId":"session"})).await;
    assert_eq!(cancel["ok"],true,"{cancel}");
    assert_eq!(fixture.inputs.lock().unwrap()[2]["_method"],"orchestration.cancel");
    assert_eq!(fixture.inputs.lock().unwrap()[2]["projectRunId"],"team-run");
    connection.close(0u32.into(), b"done"); client.close().await;
    fixture.shutdown().await;
}
