use super::*;

#[test]
fn mobile_approval_keeps_the_user_selected_desktop_scope() {
    for scope in ["once", "run", "task", "project", "global"] {
        let input = mobile::approval_resolution(&json!({"approvalId":"a","decision":"approved","scope":scope})).unwrap();
        assert_eq!(input["scope"], scope);
        assert_eq!(input["approvalId"], "a");
    }
    assert_eq!(mobile::approval_resolution(&json!({"approvalId":"a","decision":"rejected"})).unwrap()["scope"], "once");
    for scope in [json!("everything"), json!(null), json!(true)] {
        assert_eq!(mobile::approval_resolution(&json!({"approvalId":"a","decision":"approved","scope":scope})).unwrap_err().to_string(), "INVALID_APPROVAL_SCOPE");
    }
}
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

pub(super) struct Fixture {
    pub(super) service: Arc<RemoteService>,
    _router: Arc<Router>,
    pub(super) directory: PathBuf,
    pub(super) calls: Arc<AtomicUsize>,
    pub(super) inputs: Arc<Mutex<Vec<Value>>>,
}

#[tokio::test]
async fn relay_catalog_is_read_only_and_does_not_probe_on_dropdown_open() {
    let fixture = Fixture::new().await;
    let before = fixture.service.settings().unwrap();
    let endpoint = fixture.addr().id;
    let result = fixture.service.relays(json!({"urls":["https://203.0.113.20"]})).await.unwrap();
    let nodes = result["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 5);
    assert!(nodes.iter().all(|node| node.get("measuredAt").is_none()));
    assert_eq!(nodes[4]["source"], "custom");
    assert_eq!(fixture.addr().id, endpoint, "Viewing nodes must not replace the paired endpoint");
    assert_eq!(serde_json::to_value(fixture.service.settings().unwrap()).unwrap(), serde_json::to_value(before).unwrap());
    assert!(fixture.service.relays(json!({"urls":["a","b","c","d","e"]})).await.is_err());
}

#[tokio::test]
async fn public_relay_needs_no_url_and_disables_direct_ip_transport() {
    let fixture = Fixture::new().await;
    let previous_id = fixture.addr().id;
    let status = fixture.service.configure(json!({"enabled":true,"deviceName":"Test host",
        "relayMode":"custom","relayUrls":[" ","\r\n"],"keepAwake":false})).await.unwrap();
    assert_eq!(status["settings"]["relayUrls"], json!([]));
    assert_eq!(status["settings"]["relayMode"], "custom");
    assert_eq!(status["state"], "listening", "{status}");
    assert_eq!(fixture.addr().id, previous_id, "Switching transport must preserve pairing identity");
    let diagnostics = fixture.service.diagnostics().await.unwrap();
    assert_eq!(diagnostics["boundSockets"], json!([]), "Relay mode must not create UDP paths");
    fixture.shutdown().await;
}

#[tokio::test]
async fn relay_urls_are_optional_normalized_and_only_validate_when_active() {
    let fixture = Fixture::new().await;
    let mut settings = json!({"enabled":false,"deviceName":"Test host","relayMode":"custom",
        "relayUrls":["  https://relay.example.com  ","", "https://relay.example.com", "\r"],"keepAwake":false});
    let status = fixture.service.configure(settings.clone()).await.unwrap();
    assert_eq!(status["settings"]["relayUrls"], json!(["https://relay.example.com"]));
    for invalid in [json!(["invalid"]), json!(["http://relay.example.com"]),
        json!(["https://user:pass@relay.example.com"]),
        json!(["https://a.example.com","https://b.example.com","https://c.example.com","https://d.example.com","https://e.example.com"])] {
        settings["relayUrls"] = invalid;
        assert!(fixture.service.configure(settings.clone()).await.is_err());
        assert_eq!(fixture.service.settings().unwrap().relay_urls, vec!["https://relay.example.com"]);
    }
    settings["relayUrls"] = json!(["unfinished custom node"]);
    for mode in ["automatic", "lan"] {
        settings["relayMode"] = json!(mode);
        assert_eq!(fixture.service.configure(settings.clone()).await.unwrap()["settings"]["relayMode"], mode);
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn legacy_direct_setting_migrates_to_cross_network_direct_and_control_has_no_workspace_data() {
    let fixture = Fixture::new().await;
    let invitation = fixture.invitation();
    let client = Endpoint::bind(presets::Minimal).await.unwrap();
    let connection = client.connect(fixture.addr(), ALPN_V2).await.unwrap();
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut request = control::POLICY_PREFIX.to_vec(); request.extend_from_slice(nonce.as_bytes());
    connection.send_datagram(request.into()).unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(2), connection.read_datagram()).await.unwrap().unwrap();
    let value: Value = serde_json::from_slice(&reply).unwrap();
    assert_eq!(value["nonce"], nonce);
    assert_eq!(value["relayMode"], "lan");
    assert_eq!(value["directOnly"], false);
    assert!(reply.len() <= 1100);
    assert!(!String::from_utf8_lossy(&reply).contains(invitation["token"].as_str().unwrap()));
    let diagnostics = fixture.service.diagnostics().await.unwrap();
    assert!(diagnostics["boundSockets"].is_array());
    assert!(!diagnostics.to_string().contains(invitation["token"].as_str().unwrap()));
    assert!(fixture.service.transport_policy_reply(b"session.send secrets").unwrap().is_none());
    client.close().await;
    // Invitation metadata must describe the protocol required by strict mode.
    let mut settings = fixture.service.settings().unwrap();
    settings.relay_mode = "direct".into();
    fixture.service.repo.save_settings(&serde_json::to_value(settings).unwrap()).unwrap();
    assert_eq!(fixture.invitation()["alpn"], "nautilo/remote/2");
    let status = fixture.service.configure(json!({"enabled":false,"deviceName":"Test","relayMode":"local","relayUrls":[],"keepAwake":false})).await.unwrap();
    assert_eq!(status["settings"]["relayMode"], "direct");
    assert_eq!(fixture.service.settings().unwrap().relay_mode, "direct");
    fixture.shutdown().await;
}
impl Fixture {
    pub(super) async fn new() -> Self {
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
            repos.agents().save(&json!({"id":"test-agent","providerId":"test-harness","displayName":"Test Harness","enabled":false,"permissionMode":"workspace-write"}), "2026-01-01").unwrap();
            db.raw.execute("INSERT INTO sessions(id,project_id,member_id,data,updated_at) VALUES('session','project','main',?1,'2026-01-01')",
                [json!({"id":"session","projectId":"project","agentInstanceId":"test-agent"}).to_string()]).unwrap();
        }
        let credentials = Arc::new(CredentialService::new(db.clone(), &directory));
        let events = Arc::new(EventService::new(
            db.clone(),
            RedactionService::new(Arc::new(Vec::new)),
        ));
        let service = RemoteService::new(db, credentials, events);
        let calls = Arc::new(AtomicUsize::new(0));
        let inputs = Arc::new(Mutex::new(Vec::new()));
        let mut router = Router::default();
        let count = calls.clone();
        let received = inputs.clone();
        router.register("session.send", move |input| {
            let count = count.clone();
            let received = received.clone();
            async move {
                received.lock().unwrap().push(input);
                count.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(30)).await;
                Ok(json!({"accepted":true,"runId":"run"}))
            }
        });
        router.register("project.list",|_|async { Ok(json!([{"id":"project","name":"Project","secret":"hidden"},{"id":"private","name":"Private"}])) });
        router.register("provider.catalog", |_| async { Ok(json!([{"providerId":"test-harness","modeDiscovery":true,"permissionModes":[{"value":"workspace-write"},{"value":"read-only"}]}])) });
        router.register("provider.modes", |_| async { Ok(json!({"defaultMode":"standard","modes":[{"id":"standard","name":"Standard"},{"id":"custom-plugin-mode","name":"Custom plugin mode"},{"id":"broken-mode","broken":"not installed"}]})) });
        router.register("run.list", |_| async { Ok(json!([])) });
        router.register("workflow.list", |input| async move {
            assert_eq!(input["sessionId"], "session");
            Ok(json!([{"id":"flow","name":"Review","status":"running","updatedAt":1}]))
        });
        router.register("workflow.get", |input| async move {
            Ok(json!({
                "sessionId":if input["runId"]=="flow" {"session"} else {"another-session"},
                "status":"running",
                "definition":{"name":"Review","nodes":[{"id":"scan","name":"Inspect"}]},
                "instances":[{"id":"n1","nodeId":"scan","status":"running","attempt":1,"prompt":"private"}]
            }))
        });
        router.register("slashCommand.list", |_| async { Ok(json!([
            {"id":"client-compact","name":"/compact","execution":"client"},
            {"id":"native-compact","name":"/compact","execution":"provider","providerCommand":"compact"}
        ])) });
        let compact_calls = calls.clone();
        let compact_inputs = inputs.clone();
        router.register("slashCommand.execute", move |input| {
            let count = compact_calls.clone();
            let received = compact_inputs.clone();
            async move {
                received.lock().unwrap().push(input);
                count.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"completed":true}))
            }
        });
        router.register("interaction.list", |_| async { Ok(json!([])) });
        for method in ["orchestration.start", "orchestration.cancel"] {
            let received = inputs.clone();
            let count = calls.clone();
            router.register(method, move |mut input| {
                let received = received.clone(); let count = count.clone();
                async move {
                    input["_method"] = json!(method);
                    received.lock().unwrap().push(input);
                    count.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"projectRun":{"id":"team-run"}}))
                }
            });
        }
        router.register("approval.list", |_| async { Ok(json!([{"id":"ours","sessionId":"session"},{"id":"other","sessionId":"another-session"}])) });
        let router = Arc::new(router);
        service.start(&router).await;
        service.configure(json!({"enabled":true,"deviceName":"Test host","relayMode":"lan","relayUrls":[],"keepAwake":false})).await.unwrap();
        assert_eq!(service.status().unwrap()["state"], "listening");
        Self {
            service,
            _router: router,
            directory,
            calls,
            inputs,
        }
    }
    pub(super) fn addr(&self) -> iroh::EndpointAddr {
        self.service
            .state
            .lock()
            .unwrap()
            .endpoint
            .as_ref()
            .unwrap()
            .addr()
    }
    pub(super) fn invitation(&self) -> Value {
        let invitation = self.service.invite().unwrap();
        let payload = invitation["uri"]
            .as_str()
            .unwrap()
            .split('#')
            .nth(1)
            .unwrap();
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap()
    }
    pub(super) async fn shutdown(self) {
        self.service.close().await;
        let path = self.directory.clone();
        drop(self);
        std::fs::remove_dir_all(path).unwrap();
    }
}

#[tokio::test]
async fn snapshot_and_modes_are_authenticated_and_keep_provider_options() {
    let fixture = Fixture::new().await;
    {
        let db = Database::open(&fixture.directory.join("test.sqlite")).unwrap();
        Repositories::new(&db.raw).agents().save(&json!({"id":"test-agent","providerId":"test-harness","displayName":"Test Harness","enabled":true,"permissionMode":"workspace-write"}), "2026-01-01").unwrap();
    }
    let invitation = fixture.invitation();
    let client = Endpoint::bind(presets::Minimal).await.unwrap();
    let connection = client.connect(fixture.addr(), ALPN).await.unwrap();
    assert_eq!(rpc(&connection, "session.snapshot", json!({"sessionId":"session"})).await["error"]["code"], "DEVICE_NOT_AUTHORIZED");
    rpc(&connection, "pair", json!({"name":"Phone","token":invitation["token"]})).await;
    fixture.service.approve(json!({"deviceId":client.id().to_string()})).unwrap();
    let hello = rpc(&connection, "hello", json!({})).await;
    assert_eq!(hello["data"]["endpoint"]["id"], fixture.addr().id.to_string());
    assert!(hello["data"]["capabilities"].as_array().unwrap().contains(&json!("session.snapshot")));
    assert!(hello["data"]["capabilities"].as_array().unwrap().contains(&json!("session.workflows")));
    let workflows = rpc(&connection, "session.workflows", json!({"sessionId":"session"})).await;
    assert_eq!(workflows["data"]["items"][0]["id"], "flow");
    let workflow = rpc(&connection, "session.workflows", json!({"sessionId":"session","runId":"flow"})).await;
    assert_eq!(workflow["data"]["instances"][0]["name"], "Inspect");
    assert!(workflow["data"]["instances"][0].get("prompt").is_none());
    let unrelated = rpc(&connection, "session.workflows", json!({"sessionId":"session","runId":"other"})).await;
    assert_eq!(unrelated["error"]["code"], "WORKFLOW_NOT_IN_SESSION");
    let snapshot = rpc(&connection, "session.snapshot", json!({"sessionId":"session"})).await;
    assert_eq!(snapshot["ok"], true, "{snapshot}");
    assert_eq!(snapshot["data"]["approvals"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["data"]["approvals"][0]["id"], "ours");
    let modes = rpc(&connection, "session.modes", json!({"agentInstanceId":"test-agent","projectId":"project"})).await;
    assert_eq!(modes["data"]["modes"][1]["id"], "custom-plugin-mode");
    let changed = fixture.service.mobile_configuration("session", &json!({"permissionMode":"read-only","agentMode":"custom-plugin-mode"})).await.unwrap();
    assert_eq!(changed["agentMode"], "custom-plugin-mode");
    assert_eq!(changed["permissionMode"], "read-only");
    assert!(fixture.service.mobile_configuration("session", &json!({"agentMode":"broken-mode"})).await.is_err());
    assert!(fixture.service.mobile_configuration("session", &json!({"permissionMode":"made-up-mode"})).await.is_err());
    {
        let db = Database::open(&fixture.directory.join("test.sqlite")).unwrap();
        db.raw.execute("INSERT INTO messages(id,session_id,data,created_at) VALUES('user-message','session',?1,'2026-01-01')", [json!({"id":"user-message","sender":"user","text":"hello"}).to_string()]).unwrap();
    }
    assert_eq!(fixture.service.mobile_configuration("session", &json!({"agentMode":"custom-plugin-mode"})).await.unwrap_err().to_string(), "HARNESS_MODE_LOCKED");
    assert!(fixture.service.mobile_configuration("session", &json!({"permissionMode":"read-only"})).await.is_ok());
    client.close().await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn mobile_context_compaction_uses_the_native_command_and_replays_its_receipt() {
    let fixture = Fixture::new().await;
    let invitation = fixture.invitation();
    let client = Endpoint::bind(presets::Minimal).await.unwrap();
    let connection = client.connect(fixture.addr(), ALPN).await.unwrap();
    let params = json!({"sessionId":"session"});
    assert_eq!(rpc(&connection,"session.compact",params.clone()).await["error"]["code"],"DEVICE_NOT_AUTHORIZED");
    rpc(&connection,"pair",json!({"name":"Phone","token":invitation["token"]})).await;
    fixture.service.approve(json!({"deviceId":client.id().to_string()})).unwrap();
    let snapshot = rpc(&connection,"session.snapshot",params.clone()).await;
    assert_eq!(snapshot["data"]["compactCommand"]["id"],"native-compact");
    let id = uuid::Uuid::new_v4().to_string();
    let first = call(&connection,&id,"session.compact",params.clone()).await;
    let replay = call(&connection,&id,"session.compact",params).await;
    assert_eq!(first["ok"],true,"{first}");
    assert_eq!(replay,first);
    assert_eq!(fixture.calls.load(Ordering::SeqCst),1);
    assert_eq!(fixture.inputs.lock().unwrap()[0],json!({"sessionId":"session","commandId":"native-compact"}));
    client.close().await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn phone_uploads_travel_over_authenticated_rpc_into_native_message_attachments() {
    use base64::engine::general_purpose::STANDARD;
    let fixture = Fixture::new().await;
    let invitation = fixture.invitation();
    let upload_id = uuid::Uuid::new_v4().to_string();
    let mut chunk = json!({"uploadId":upload_id,"name":"设计说明.txt","mimeType":"text/plain","sizeBytes":6,"offset":0,"data":STANDARD.encode(b"abc")});
    let unpaired = Endpoint::bind(presets::Minimal).await.unwrap();
    let rejected = unpaired.connect(fixture.addr(), ALPN).await.unwrap();
    assert_eq!(rpc(&rejected, "attachment.upload", chunk.clone()).await["error"]["code"], "DEVICE_NOT_AUTHORIZED");
    unpaired.close().await;
    let client = Endpoint::bind(presets::Minimal).await.unwrap();
    let connection = client.connect(fixture.addr(), ALPN).await.unwrap();
    rpc(&connection, "pair", json!({"name":"Phone","token":invitation["token"]})).await;
    fixture.service.approve(json!({"deviceId":client.id().to_string()})).unwrap();
    assert_eq!(rpc(&connection, "attachment.upload", chunk.clone()).await["data"]["receivedBytes"], 3);
    let message = json!({"sessionId":"session","text":"","attachmentIds":[upload_id]});
    assert_eq!(rpc(&connection, "session.send", message.clone()).await["error"]["code"], "ATTACHMENT_INCOMPLETE");
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    chunk["offset"] = json!(3); chunk["data"] = json!(STANDARD.encode(b"def"));
    assert_eq!(rpc(&connection, "attachment.upload", chunk).await["data"]["complete"], true);
    assert_eq!(rpc(&connection, "session.send", message).await["ok"], true);
    let input = fixture.inputs.lock().unwrap()[0].clone();
    assert_eq!(input["text"], "请查看附件。");
    assert_eq!(input["attachments"][0]["name"], "设计说明.txt");
    assert_eq!(std::fs::read(input["attachments"][0]["path"].as_str().unwrap()).unwrap(), b"abcdef");
    assert!(input.get("_attachments").is_none());
    client.close().await;
    fixture.shutdown().await;
}
pub(super) async fn call(connection: &Connection, id: &str, method: &str, params: Value) -> Value {
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
pub(super) async fn rpc(connection: &Connection, method: &str, params: Value) -> Value {
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
    fixture.service.configure(json!({"enabled":true,"deviceName":"Renamed host","relayMode":"lan","relayUrls":[],"keepAwake":true})).await.unwrap();
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
    fixture.service.configure(json!({"enabled":false,"deviceName":"Test host","relayMode":"lan","relayUrls":[],"keepAwake":false})).await.unwrap();
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
async fn mobile_history_preserves_stream_position_beyond_the_activity_window() {
    let fixture = Fixture::new().await;
    {
        let database = Database::open(&fixture.directory.join("test.sqlite")).unwrap();
        database.raw.execute("INSERT INTO messages(id,session_id,data,created_at) VALUES('comment','session',?1,'2026-11-14T01:00:10Z')",
            [json!({"id":"comment","sender":"agent","text":"检查文件","createdAt":"2026-11-14T01:00:10Z"}).to_string()]).unwrap();
        for sequence in 1..=205 {
            let (kind, payload) = match sequence {
                1 => ("agent.message_delta", json!({"messageId":"native","text":"检查"})),
                3 => ("agent.message", json!({"messageId":"comment","providerMessageId":"native","text":"检查文件"})),
                _ => ("usage.updated", json!({"inputTokens":sequence})),
            };
            database.raw.execute("INSERT INTO runtime_events(event_id,sequence,session_id,run_id,data,timestamp) VALUES(?1,?2,'session','run',?3,'2026-11-14T01:00:01Z')",
                rusqlite::params![format!("position-{sequence}"), sequence, json!({"eventId":format!("position-{sequence}"),"sequence":sequence,"runId":"run","type":kind,"payload":payload}).to_string()]).unwrap();
        }
    }
    let history = fixture.service.repo.history("session", None, 10).unwrap();
    assert_eq!(history["items"][0]["value"]["runId"], "run");
    assert_eq!(history["items"][0]["value"]["sequence"], 1);
    assert_eq!(history["items"][0]["value"]["timelineStartedAt"], "2026-11-14T01:00:01Z");
    assert_eq!(history["items"][0]["value"]["createdAt"], "2026-11-14T01:00:10Z");
    assert!(history["activity"].as_array().unwrap().iter().all(|v|v["sequence"].as_i64().unwrap() > 1));
    fixture.shutdown().await;
}

#[tokio::test]
async fn legacy_omp_history_returns_resumed_reply_under_the_new_user_turn() {
    let fixture = Fixture::new().await;
    let database = Database::open(&fixture.directory.join("test.sqlite")).unwrap();
    let repos = Repositories::new(&database.raw);
    let reply = |id, native, child| json!({"messageId":id,"providerMessageId":native,"subagentDispatchId":child,"text":"项目结构"});
    for (sequence, run, kind, payload, background) in [
        (1, "old", "run.started", json!({"userMessageId":"first"}), false),
        (2, "old", "provider.runtime_ready", json!({"providerId":"omp","pid":101,"reused":true}), false),
        (3, "old", "run.cancelled", json!({}), false),
        (4, "resume", "run.started", json!({"userMessageId":"continue"}), false),
        (5, "resume", "provider.runtime_ready", json!({"providerId":"omp","pid":202,"reused":false}), false),
        (6, "old", "agent.message", reply("answer", "omp-message-3", Value::Null), true),
        (7, "old", "agent.message", reply("new-format", "omp-message-11111111-1111-4111-8111-111111111111", Value::Null), true),
        (8, "old", "agent.message", reply("child", "omp-message-4", json!("dispatch")), true),
        (9, "resume", "run.completed", json!({}), false),
        (10, "old", "agent.message", reply("late", "omp-message-5", Value::Null), true),
    ] {
        repos.events().append(&json!({"eventId":format!("omp-{sequence}"),"sequence":sequence,"runId":run,"sessionId":"session",
            "timestamp":format!("2026-11-22T07:31:{sequence:02}Z"),"type":kind,"background":background,"payload":payload})).unwrap();
    }
    for (id, sequence) in [("answer", 6), ("new-format", 7), ("child", 8), ("late", 10)] {
        repos.sessions().save_message(&json!({"id":id,"sessionId":"session","sender":"agent","runId":"old","background":true,
            "createdAt":format!("2026-11-22T07:31:{sequence:02}Z"),"text":"项目结构"})).unwrap();
    }
    let desktop = repos.sessions().history("session", None).unwrap();
    let mobile = fixture.service.repo.history("session", None, 10).unwrap();
    for projection in [&desktop, &mobile] {
        let items = projection["items"].as_array().unwrap();
        assert_eq!(items[0]["value"]["id"], "answer");
        assert_eq!(items[0]["value"]["runId"], "resume");
        assert!(items[0]["value"].get("background").is_none());
        assert!(items[1..].iter().all(|item| item["value"]["runId"] == "old"));
    }
    let receipt = mobile["activity"].as_array().unwrap().iter().find(|event| event["sequence"] == 6).unwrap();
    assert_eq!(receipt["runId"], "resume");
    assert_eq!(repos.sessions().message("session", "answer").unwrap().unwrap()["runId"], "old");
    assert_eq!(repos.events().replay(Some("session"), None, None, None).unwrap()[5]["runId"], "old");
    drop(database);
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

#[tokio::test]
async fn mobile_create_and_switch_use_the_desktop_account_gateways() {
    let fixture = Fixture::new().await;
    {
        let db = Database::open(&fixture.directory.join("test.sqlite")).unwrap();
        let repos = Repositories::new(&db.raw);
        for provider in ["deepseek", "opencode", "codex", "antigravity"] {
            repos.agents().save(&json!({"id":provider,"providerId":provider,"displayName":provider,"enabled":true}), "2026-01-01").unwrap();
        }
        for provider in ["codex", "claude-code", "opencode", "antigravity", "unsupported"] {
            let id = format!("account-{provider}");
            repos.runtime_connections().save(&json!({"id":id,"name":id,"kind":"login","harness":provider,
                "enabled":true,"revision":7}), "2026-01-01").unwrap();
        }
        repos.sessions().save(&json!({"id":"session","projectId":"project","memberId":"deepseek",
            "agentInstanceId":"deepseek","connectionId":"account-codex","connectionRevision":7})).unwrap();
    }
    let order = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut router = (*fixture._router).clone();
    let created = order.clone();
    router.register("session.create", move |input| {
        let created = created.clone();
        async move {
            assert!(input.get("_mobileAccountRoute").is_none());
            assert_eq!(input["connectionRevision"], 7);
            created.lock().unwrap().push(format!("create:{}:{}", input["agentInstanceId"].as_str().unwrap(), input["connectionId"].as_str().unwrap()));
            Ok(input)
        }
    });
    let routed = order.clone();
    router.register("connection.gateway", move |input| {
        let routed = routed.clone();
        async move {
            assert_eq!(input["enabled"], true);
            routed.lock().unwrap().push(format!("gateway:{}", input["connectionId"].as_str().unwrap()));
            Ok(json!({}))
        }
    });
    router.register("connection.models", |input| async move {
        assert_eq!(input, json!({"connectionId":"account-antigravity"}));
        Ok(json!({"models":[{"id":"gemini-3.8-flash","reasoningEfforts":["high"]}]}))
    });
    let switched = order.clone();
    router.register("session.upsert", move |input| {
        let switched = switched.clone();
        async move {
            assert_eq!(input["id"], "session");
            assert_eq!(input["agentInstanceId"], "deepseek");
            assert_eq!(input["connectionId"], "account-antigravity");
            assert_eq!(input["model"], "gemini-3.8-flash");
            assert_eq!(input["confirmConnectionChange"], true);
            assert!(input.get("connectionRevision").is_none());
            assert!(input.get("_mobileAccountRoute").is_none());
            switched.lock().unwrap().push("switch:deepseek:account-antigravity".into());
            Ok(input)
        }
    });
    let router = Arc::new(router);
    *fixture.service.router.lock().unwrap() = Arc::downgrade(&router);
    let invitation = fixture.invitation();
    let client = Endpoint::bind(presets::Minimal).await.unwrap();
    let connection = client.connect(fixture.addr(), ALPN).await.unwrap();
    rpc(&connection, "pair", json!({"name":"Phone","token":invitation["token"]})).await;
    fixture.service.approve(json!({"deviceId":client.id().to_string()})).unwrap();
    for (provider, source) in [
        ("deepseek", "codex"), ("deepseek", "claude-code"), ("deepseek", "opencode"),
        ("deepseek", "antigravity"), ("opencode", "codex"), ("codex", "codex"), ("antigravity", "antigravity"),
    ] {
        let response = rpc(&connection, "session.create", json!({"projectId":"project","agentInstanceId":provider,"connectionId":format!("account-{source}")})).await;
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["data"]["agentInstanceId"], provider);
    }
    for (provider, source) in [("deepseek", "unsupported"), ("antigravity", "codex")] {
        let response = rpc(&connection, "session.create", json!({"projectId":"project","agentInstanceId":provider,"connectionId":format!("account-{source}")})).await;
        assert_eq!(response["error"]["code"], "CONNECTION_NOT_AVAILABLE", "{response}");
    }
    let response = rpc(&connection, "session.configure", json!({"sessionId":"session","connectionId":"account-antigravity",
        "model":"gemini-3.8-flash","reasoningEffort":"high","confirmConnectionChange":true})).await;
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(*order.lock().unwrap(), vec![
        "create:deepseek:account-codex", "gateway:account-codex",
        "create:deepseek:account-claude-code", "gateway:account-claude-code",
        "create:deepseek:account-opencode", "gateway:account-opencode",
        "create:deepseek:account-antigravity", "gateway:account-antigravity",
        "create:opencode:account-codex", "gateway:account-codex",
        "create:codex:account-codex", "create:antigravity:account-antigravity",
        "switch:deepseek:account-antigravity", "gateway:account-antigravity",
    ]);
    connection.close(0u32.into(), b"done");
    client.close().await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn mobile_harness_errors_preserve_the_reason_and_leave_the_connection_usable() {
    let fixture = Fixture::new().await;
    let mut router = (*fixture._router).clone();
    router.register("session.send", |_| async {
        Err(crate::errors::invalid("connectionId", "Enable the selected account gateway").into())
    });
    let router = Arc::new(router);
    *fixture.service.router.lock().unwrap() = Arc::downgrade(&router);
    let invitation = fixture.invitation();
    let client = Endpoint::bind(presets::Minimal).await.unwrap();
    let connection = client.connect(fixture.addr(), ALPN).await.unwrap();
    rpc(&connection, "pair", json!({"name":"Phone","token":invitation["token"]})).await;
    fixture.service.approve(json!({"deviceId":client.id().to_string()})).unwrap();
    let response = rpc(&connection, "session.send", json!({"sessionId":"session","text":"probe"})).await;
    assert_eq!(response["error"]["code"], "IPC_INVALID_REQUEST");
    assert!(response["error"]["message"].as_str().unwrap().contains("Enable the selected account gateway"));
    assert_eq!(rpc(&connection, "hello", json!({})).await["ok"], true);
    connection.close(0u32.into(), b"done");
    client.close().await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn mobile_files_are_authenticated_confined_and_preserve_chunk_continuity() {
    let fixture = Fixture::new().await;
    let root = fixture.directory.join("workspace");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(root.join("tests")).unwrap();
    std::fs::write(root.join("src/示例.rs"), "fn main() { println!(\"中文\"); }".as_bytes()).unwrap();
    std::fs::write(root.join("src/same.rs"), b"one").unwrap();
    std::fs::write(root.join("tests/same.rs"), b"two").unwrap();
    std::fs::write(fixture.directory.join("outside.txt"), b"outside").unwrap();
    {
        let db = Database::open(&fixture.directory.join("test.sqlite")).unwrap();
        Repositories::new(&db.raw).projects().save(&json!({"id":"project","name":"Project","rootPath":root}), "2026-01-01").unwrap();
    }
    let invitation = fixture.invitation();
    let client = Endpoint::bind(presets::Minimal).await.unwrap();
    let connection = client.connect(fixture.addr(), ALPN).await.unwrap();
    let input = json!({"projectId":"project","path":"src/示例.rs","length":8});
    assert_eq!(rpc(&connection, "file.preview", input.clone()).await["error"]["code"], "DEVICE_NOT_AUTHORIZED");
    rpc(&connection, "pair", json!({"name":"Phone","token":invitation["token"]})).await;
    fixture.service.approve(json!({"deviceId":client.id().to_string()})).unwrap();
    let files = rpc(&connection, "project.files", json!({"projectId":"project","path":"src"})).await;
    assert_eq!(files["ok"], true, "{files}");
    assert!(files["data"]["entries"].as_array().unwrap().iter().any(|e|e["name"]=="示例.rs"));
    let first = rpc(&connection, "file.preview", input).await;
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["data"]["nextOffset"], 8);
    let second = rpc(&connection, "file.preview", json!({"projectId":"project","path":"src/示例.rs","offset":8})).await;
    let mut bytes = base64::engine::general_purpose::STANDARD.decode(first["data"]["base64"].as_str().unwrap()).unwrap();
    bytes.extend(base64::engine::general_purpose::STANDARD.decode(second["data"]["base64"].as_str().unwrap()).unwrap());
    assert_eq!(bytes, std::fs::read(root.join("src/示例.rs")).unwrap());
    assert!(second["data"]["nextOffset"].is_null());
    let candidates = rpc(&connection, "file.preview", json!({"projectId":"project","path":"same.rs"})).await;
    assert_eq!(candidates["data"]["candidates"], json!(["src/same.rs","tests/same.rs"]));
    for method in ["file.preview", "project.files"] {
        assert_eq!(rpc(&connection, method, json!({"projectId":"project","path":"../outside.txt"})).await["ok"], false);
        assert_eq!(rpc(&connection, method, json!({"projectId":"unknown","path":"src/示例.rs"})).await["ok"], false);
    }
    connection.close(0u32.into(), b"done"); client.close().await; fixture.shutdown().await;
}

#[tokio::test]
async fn message_images_sync_metadata_and_bytes_without_exposing_desktop_paths() {
    let fixture = Fixture::new().await;
    let database = Arc::new(Mutex::new(Database::open(&fixture.directory.join("test.sqlite")).unwrap()));
    let path = fixture.directory.join("phone-photo.png");
    let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==").unwrap();
    std::fs::write(&path, &png).unwrap();
    let saved = crate::runtime::message_attachment_service::MessageAttachmentService::new(database.clone())
        .save(&json!({"id":"session"}), &[json!({"path":path,"kind":"image","name":"照片.png","mimeType":"image/png","remoteUploadId":"a55ad99e-3883-4efb-887c-dc14c6fe096a"})]).unwrap();
    let id = saved[0]["id"].clone();
    {
        let db = database.lock().unwrap();
        db.raw.execute("INSERT INTO messages(id,session_id,data,created_at) VALUES('image-message','session',?1,'2026-11-15')", [json!({"id":"image-message","sender":"user","text":"查看图片","attachmentIds":[id]}).to_string()]).unwrap();
    }
    let input = json!({"sessionId":"session","attachmentId":id,"length":16});
    let invitation = fixture.invitation();
    let unpaired = Endpoint::bind(presets::Minimal).await.unwrap();
    let rejected = unpaired.connect(fixture.addr(), ALPN).await.unwrap();
    assert_eq!(rpc(&rejected, "attachment.read", input.clone()).await["error"]["code"], "DEVICE_NOT_AUTHORIZED");
    unpaired.close().await;
    let client = Endpoint::bind(presets::Minimal).await.unwrap();
    let connection = client.connect(fixture.addr(), ALPN).await.unwrap();
    rpc(&connection, "pair", json!({"name":"Phone","token":invitation["token"]})).await;
    fixture.service.approve(json!({"deviceId":client.id().to_string()})).unwrap();
    let history = rpc(&connection, "session.history", json!({"sessionId":"session"})).await;
    let attachment = &history["data"]["items"][0]["value"]["attachments"][0];
    assert_eq!(attachment["kind"], "image"); assert_eq!(attachment["mimeType"], "image/png");
    assert_eq!(attachment["sizeBytes"], png.len());
    assert_eq!(attachment["uploadId"], "a55ad99e-3883-4efb-887c-dc14c6fe096a");
    assert!(attachment.get("path").is_none());
    let first = rpc(&connection, "attachment.read", input).await;
    assert_eq!(first["data"]["nextOffset"], 16);
    assert!(first["data"].get("path").is_none());
    let second = rpc(&connection, "attachment.read", json!({"sessionId":"session","attachmentId":id,"offset":16})).await;
    let mut joined = base64::engine::general_purpose::STANDARD.decode(first["data"]["base64"].as_str().unwrap()).unwrap();
    joined.extend(base64::engine::general_purpose::STANDARD.decode(second["data"]["base64"].as_str().unwrap()).unwrap());
    assert_eq!(joined, png);
    assert_eq!(rpc(&connection, "attachment.read", json!({"sessionId":"private-session","attachmentId":id})).await["ok"], false);
    assert_eq!(rpc(&connection, "attachment.read", json!({"sessionId":"session","attachmentId":"unknown","path":path})).await["error"]["code"], "ATTACHMENT_NOT_AVAILABLE");
    // A stored artifact without a message reference is not a message attachment.
    database.lock().unwrap().raw.execute("DELETE FROM messages WHERE id='image-message'", []).unwrap();
    assert_eq!(rpc(&connection, "attachment.read", json!({"sessionId":"session","attachmentId":id})).await["error"]["code"], "ATTACHMENT_NOT_AVAILABLE");
    connection.close(0u32.into(), b"done"); client.close().await; drop(database); fixture.shutdown().await;
}
