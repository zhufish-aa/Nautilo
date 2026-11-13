use super::*;
use crate::{database::Repositories, runtime::security::RedactionService};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use iroh::endpoint::presets;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

#[test]
fn mobile_connection_switch_preserves_revision_until_identity_changes() {
    let original = json!({"projectId":"p","agentInstanceId":"a","connectionId":"old","connectionRevision":9});
    let mut same = original.clone();
    assert!(!mobile::select_configuration_connection(&mut same,&json!({"model":"new-model"})).unwrap());
    assert!(!mobile::select_configuration_connection(&mut same,&json!({"connectionId":"old"})).unwrap());
    assert_eq!(same,original);
    assert!(mobile::select_configuration_connection(&mut same,&json!({"connectionId":"new"})).is_err());
    assert_eq!(same,original);
    assert!(mobile::select_configuration_connection(&mut same,&json!({"connectionId":"new","confirmConnectionChange":true})).unwrap());
    assert_eq!(same["connectionId"],"new");
    assert!(same.get("connectionRevision").is_none());
    assert_eq!(same["agentInstanceId"],"a");
    assert!(mobile::select_configuration_connection(&mut same,&json!({"connectionId":null,"confirmConnectionChange":true})).unwrap());
    assert_eq!(same["connectionId"],Value::Null);
}

struct Fixture {
    service: Arc<RemoteService>,
    _router: Arc<Router>,
    directory: PathBuf,
    calls: Arc<AtomicUsize>,
}
impl Fixture {
    async fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("nautilo-remote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let db = Arc::new(Mutex::new(
            Database::open(&directory.join("test.sqlite")).unwrap(),
        ));
        {
            let db = db.lock().unwrap();
            let repos = Repositories::new(&db.raw);
            repos
                .projects()
                .save(&json!({"id":"project","name":"Project"}), "2026-01-01")
                .unwrap();
            repos
                .projects()
                .save(&json!({"id":"private","name":"Private"}), "2026-01-01")
                .unwrap();
            db.raw.execute("INSERT INTO sessions(id,project_id,member_id,data,updated_at) VALUES('session','project','main',?1,'2026-01-01')",
                [json!({"id":"session","projectId":"project"}).to_string()]).unwrap();
        }
        let credentials = Arc::new(CredentialService::new(db.clone(), &directory));
        let events = Arc::new(EventService::new(
            db.clone(),
            RedactionService::new(Arc::new(Vec::new)),
        ));
        let service = RemoteService::new(db, credentials, events);
        let calls = Arc::new(AtomicUsize::new(0));
        let mut router = Router::default();
        let count = calls.clone();
        router.register("session.send", move |_| {
            let count = count.clone();
            async move {
                count.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(30)).await;
                Ok(json!({"accepted":true,"runId":"run"}))
            }
        });
        router.register("project.list",|_|async { Ok(json!([{"id":"project","name":"Project","secret":"hidden"},{"id":"private","name":"Private"}])) });
        let router = Arc::new(router);
        service.start(&router).await;
        service.configure(json!({"enabled":true,"deviceName":"Test host","relayMode":"local","relayUrls":[],"keepAwake":false})).await.unwrap();
        assert_eq!(service.status().unwrap()["state"], "listening");
        Self {
            service,
            _router: router,
            directory,
            calls,
        }
    }
    fn addr(&self) -> iroh::EndpointAddr {
        self.service
            .state
            .lock()
            .unwrap()
            .endpoint
            .as_ref()
            .unwrap()
            .addr()
    }
    fn invitation(&self) -> Value {
        let invitation = self.service.invite().unwrap();
        let payload = invitation["uri"]
            .as_str()
            .unwrap()
            .split('#')
            .nth(1)
            .unwrap();
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap()
    }
    async fn shutdown(self) {
        self.service.close().await;
        let path = self.directory.clone();
        drop(self);
        std::fs::remove_dir_all(path).unwrap();
    }
}
async fn call(connection: &Connection, id: &str, method: &str, params: Value) -> Value {
    let (mut send, mut recv) = connection.open_bi().await.unwrap();
    send.write_all(
        &serde_json::to_vec(&json!({"v":1,"id":id,"method":method,"params":params})).unwrap(),
    )
    .await
    .unwrap();
    send.finish().unwrap();
    let bytes = tokio::time::timeout(Duration::from_secs(4), recv.read_to_end(1_000_000))
        .await
        .unwrap()
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
async fn rpc(connection: &Connection, method: &str, params: Value) -> Value {
    call(
        connection,
        &uuid::Uuid::new_v4().to_string(),
        method,
        params,
    )
    .await
}

#[tokio::test]
async fn encrypted_pairing_owner_access_dedupe_and_revoke() {
    let fixture = Fixture::new().await;
    let invite = fixture.invitation();
    let client = Endpoint::bind(presets::Minimal).await.unwrap();
    let connection = client.connect(fixture.addr(), ALPN).await.unwrap();
    assert_eq!(
        rpc(&connection, "hello", json!({})).await["error"]["code"],
        "DEVICE_NOT_AUTHORIZED"
    );
    assert_eq!(
        rpc(
            &connection,
            "pair",
            json!({"name":"Phone","token":"invalid"})
        )
        .await["error"]["code"],
        "INVALID_INVITATION"
    );
    let paired = rpc(
        &connection,
        "pair",
        json!({"name":"Phone","token":invite["token"]}),
    )
    .await;
    assert_eq!(paired["data"]["state"], "awaitingApproval");
    let id = client.id().to_string();
    assert_eq!(
        fixture.service.status().unwrap()["pending"][0]["code"],
        paired["data"]["code"]
    );
    fixture
        .service
        .approve(json!({"deviceId":id}))
        .unwrap();
    assert_eq!(
        rpc(&connection, "pair.status", json!({})).await["data"]["state"],
        "paired"
    );
    fixture.service.configure(json!({"enabled":true,"deviceName":"Renamed host","relayMode":"local","relayUrls":[],"keepAwake":true})).await.unwrap();
    assert_eq!(
        rpc(&connection, "hello", json!({})).await["data"]["name"],
        "Renamed host"
    );
    let projects = rpc(&connection, "projects.list", json!({})).await;
    assert_eq!(
        projects["data"]["projects"],
        json!([{"id":"project","name":"Project","rootPath":null},{"id":"private","name":"Private","rootPath":null}])
    );
    assert_eq!(
        rpc(&connection, "hello", json!({})).await["data"]["device"]["access"],
        "control"
    );
    let request_id = uuid::Uuid::new_v4().to_string();
    let params = json!({"sessionId":"session","text":"hello"});
    let (first, second) = tokio::join!(
        call(&connection, &request_id, "session.send", params.clone()),
        call(&connection, &request_id, "session.send", params.clone())
    );
    assert!(first["ok"] == true || second["ok"] == true);
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        call(&connection, &request_id, "session.send", params.clone()).await["ok"],
        true
    );
    assert_eq!(
        call(
            &connection,
            &request_id,
            "session.send",
            json!({"sessionId":"session","text":"changed"})
        )
        .await["error"]["code"],
        "REQUEST_ID_CONFLICT"
    );
    connection.close(0u32.into(), b"phone disconnected");
    let reconnected = client.connect(fixture.addr(), ALPN).await.unwrap();
    assert_eq!(rpc(&reconnected, "hello", json!({})).await["ok"], true);
    assert_eq!(
        call(&reconnected, &request_id, "session.send", params.clone()).await["ok"],
        true
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    fixture
        .service
        .update_device(
            json!({"deviceId":id,"name":"Phone"}),
        )
        .unwrap();
    assert_eq!(
        rpc(&reconnected, "session.send", params).await["ok"],
        true
    );
    fixture.service.revoke(json!({"deviceId":id})).unwrap();
    tokio::time::timeout(Duration::from_secs(3), reconnected.closed())
        .await
        .unwrap();
    assert!(fixture.service.repo.device(&id).unwrap().is_none());
    client.close().await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn invitation_expiry_identity_persistence_and_cursor_replay() {
    let fixture = Fixture::new().await;
    let identity = fixture.service.identity().unwrap().public();
    assert_eq!(fixture.service.identity().unwrap().public(), identity);
    let invite = fixture.invitation();
    fixture
        .service
        .state
        .lock()
        .unwrap()
        .invitation
        .as_mut()
        .unwrap()
        .expires_at = 0;
    assert!(fixture
        .service
        .pair("peer", &json!({"token":invite["token"],"name":"Phone"}))
        .unwrap_err()
        .to_string()
        .contains("EXPIRED"));
    let _ = fixture.invitation();
    fixture.service.cancel_invite().unwrap();
    assert!(fixture.service.state.lock().unwrap().invitation.is_none());
    let event = fixture
        .service
        .events
        .append_for_session(
            &json!({"id":"session","projectId":"project"}),
            &json!({}),
            "agent.message",
            json!({"text":"answer"}),
        )
        .unwrap();
    let page = fixture.service.repo.events("session", 0, 100).unwrap();
    assert_eq!(page["events"][0]["eventId"], event["eventId"]);
    assert_eq!(
        fixture
            .service
            .repo
            .events("session", page["lastSequence"].as_i64().unwrap(), 100)
            .unwrap()["events"],
        json!([])
    );
    assert!(fixture
        .service
        .repo
        .events("session", i64::MAX, 100)
        .is_err());
    fixture.service.configure(json!({"enabled":false,"deviceName":"Test host","relayMode":"local","relayUrls":[],"keepAwake":false})).await.unwrap();
    assert_eq!(fixture.service.status().unwrap()["state"], "disabled");
    assert_eq!(fixture.service.identity().unwrap().public(), identity);
    fixture.shutdown().await;
}

#[tokio::test]
async fn durable_command_reservation_survives_service_restart() {
    let fixture = Fixture::new().await;
    assert!(matches!(
        fixture.service.repo.reserve("peer:one", "same").unwrap(),
        crate::database::remote::CommandReservation::New
    ));
    let reopened = Arc::new(Mutex::new(
        Database::open(&fixture.directory.join("test.sqlite")).unwrap(),
    ));
    let replacement = RemoteService::new(
        reopened,
        fixture.service.credentials.clone(),
        fixture.service.events.clone(),
    );
    assert!(matches!(
        replacement.repo.reserve("peer:one", "same").unwrap(),
        crate::database::remote::CommandReservation::Pending
    ));
    fixture
        .service
        .repo
        .complete("peer:one", &json!({"ok":true}))
        .unwrap();
    assert!(matches!(
        replacement.repo.reserve("peer:one", "same").unwrap(),
        crate::database::remote::CommandReservation::Completed(_)
    ));
    assert!(replacement.repo.reserve("peer:one", "different").is_err());
    drop(replacement);
    fixture.shutdown().await;
}

#[tokio::test]
async fn history_pages_preserve_desktop_chronology_with_backfilled_messages() {
    let fixture = Fixture::new().await;
    {
        let database = Database::open(&fixture.directory.join("test.sqlite")).unwrap();
        for (id, time) in [
            ("new", "2026-01-03"),
            ("old", "2026-01-01"),
            ("middle", "2026-01-02"),
        ] {
            database.raw.execute("INSERT INTO messages(id,session_id,data,created_at) VALUES(?1,'session',?2,?3)",
                rusqlite::params![id,json!({"id":id,"text":id}).to_string(),time]).unwrap();
        }
        for (sequence, message, run) in [(1, "new", "latest-run"), (2, "old", "older-run")] {
            database.raw.execute("INSERT INTO runtime_events(event_id,sequence,session_id,run_id,data,timestamp) VALUES(?1,?2,'session',?3,?4,'2026-01-03')", rusqlite::params![format!("reply-{message}"), sequence, run,
                json!({"eventId":format!("reply-{message}"),"sequence":sequence,"runId":run,"type":"agent.message","payload":{"messageId":message}}).to_string()]).unwrap();
        }
    }
    let latest = fixture.service.repo.history("session", None, 2).unwrap();
    assert_eq!(latest["items"][0]["value"]["id"], "middle");
    assert_eq!(latest["items"][1]["value"]["id"], "new");
    assert_eq!(latest["items"][1]["value"]["runId"], "latest-run");
    let older = fixture
        .service
        .repo
        .history("session", latest.get("before"), 2)
        .unwrap();
    assert_eq!(older["items"][0]["value"]["id"], "old");
    assert_eq!(older["items"][0]["value"]["runId"], "older-run");
    assert_eq!(older["before"], Value::Null);
    assert_eq!(latest["epoch"], fixture.service.repo.epoch().unwrap());
    fixture.shutdown().await;
}

#[tokio::test]
async fn mobile_creation_uses_available_harnesses_and_pins_connection_revision() {
    let fixture = Fixture::new().await;
    {
        let database = Database::open(&fixture.directory.join("test.sqlite")).unwrap();
        let repos = Repositories::new(&database.raw);
        repos.agents().save(&json!({"id":"agent","providerId":"codex","displayName":"Codex","enabled":true,
            "executable":"private-cli-path","env":{"PRIVATE_KEY":"never-export"},"model":"default-model"}),"2026-01-01").unwrap();
        repos.agents().save(&json!({"id":"disabled","enabled":false}),"2026-01-01").unwrap();
        repos.runtime_connections().save(&json!({"id":"account","name":"Account","kind":"account","enabled":true,
            "revision":7,"apiKey":"never-export","options":{"token":"never-export"}}),"2026-01-01").unwrap();
    }
    let options = fixture.service.repo.mobile_options().unwrap();
    assert_eq!(options["agents"].as_array().unwrap().len(), 1);
    assert_eq!(options["connections"][0]["id"], "account");
    assert!(!options.to_string().contains("never-export"));
    assert!(!options.to_string().contains("private-cli-path"));
    let input = fixture.service.repo.mobile_session_input(&json!({"projectId":"private","agentInstanceId":"agent",
        "connectionId":"account","model":"chosen-model","reasoningEffort":"high","executable":"override"})).unwrap();
    assert_eq!(input["projectId"], "private");
    assert_eq!(input["connectionRevision"], 7);
    assert_eq!(input["model"], "chosen-model");
    assert!(input.get("executable").is_none());
    let account = json!({"id":"account","kind":"login","harness":"codex"});
    let routed = mobile::connection_catalog_input(&account, &json!({"id":"deepseek","providerId":"deepseek"}), Some(&json!(7)));
    assert_eq!(routed["connectionId"], "account");
    assert_eq!(routed["revision"], 7);
    assert!(routed.get("agentInstanceId").is_none());
    assert_eq!(mobile::connection_catalog_input(&account, &json!({"id":"codex-custom","providerId":"codex"}), None)["agentInstanceId"], "codex-custom");
    assert!(fixture.service.repo.mobile_session_input(&json!({"projectId":"private","agentInstanceId":"disabled"})).is_err());
    fixture.shutdown().await;
}

#[tokio::test]
async fn mobile_project_creation_browses_unicode_directories_and_rejects_existing_folders() {
    let fixture = Fixture::new().await;
    let input = mobile::project_input(&json!({"rootPath":fixture.directory,"folderName":"手机项目"})).unwrap();
    assert_eq!(input["name"], "手机项目");
    let created = mobile::create_project_directory(input.clone()).unwrap();
    assert!(std::path::Path::new(created["rootPath"].as_str().unwrap()).is_dir());
    assert_eq!(mobile::create_project_directory(input).unwrap_err().to_string(), "DIRECTORY_ALREADY_EXISTS");
    let directory = mobile::browse_directories(&json!({"path":fixture.directory})).unwrap();
    assert_eq!(directory["directories"][0]["name"], "手机项目");
    for name in ["..", "../other", "a\\b", "a:b"] {
        assert!(mobile::project_input(&json!({"rootPath":fixture.directory,"folderName":name})).is_err());
    }
    fixture.shutdown().await;
}
