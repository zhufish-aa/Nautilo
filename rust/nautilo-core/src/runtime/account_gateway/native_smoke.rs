//! Opt-in live inference through installed native CLIs, with isolated test homes.
use super::*;
use super::http::read_http;
use crate::adapters::{AdapterEvent, AgentCliAdapter};
use crate::runtime::plugins::plugin_adapter::launch_plugin;

#[test]
#[ignore = "requires installed OpenCode/outer harness and live free-model service"]
fn opencode_free_model_through_native_outer_harness() {
    run_live_smoke("opencode");
}

#[test]
#[ignore = "requires an explicitly selected signed-in Codex account and installed outer harness"]
fn codex_account_through_native_outer_harness() {
    run_live_smoke("codex");
}

#[test]
#[ignore = "requires an explicitly selected signed-in Antigravity account and installed outer harness"]
fn antigravity_account_through_native_outer_harness() {
    run_live_smoke("antigravity");
}

#[test]
#[ignore = "requires an explicitly selected OpenCode Console account and live inference"]
fn opencode_account_direct_http_roundtrip() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let account:Value=serde_json::from_slice(&std::fs::read(std::env::var("NAUTILO_RELAY_SMOKE_ACCOUNT_JSON").unwrap()).unwrap()).unwrap();
        assert_eq!(account["harness"],"opencode");
        let provider=crate::runtime::opencode_account::OpenCodeAccount::new(&account,&HashMap::new());
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
        let server=tokio::spawn(async move {
            let (mut socket,_)=listener.accept().await.unwrap();
            let (_,_,body)=read_http(&mut socket).await.unwrap();
            let (_cancel,cancelled)=watch::channel(false);let mut headers=false;
            let cwd=std::env::var("NAUTILO_RELAY_SMOKE_HOME").unwrap();
            if let Err(error)=provider.relay(&mut socket,&body,"direct-account-smoke",&cwd,cancelled,&mut headers).await {
                let _=response(&mut socket,502,&json!({"error":{"message":error.to_string()}})).await;
            }
        });
        let reply=reqwest::Client::new().post(format!("http://{address}/chat/completions")).json(&json!({"model":"opencode/deepseek-v4.1-flash-free","reasoning_effort":"low","messages":[{"role":"user","content":"Reply exactly NAUTILO_ACCOUNT_OK. Do not run tools."}],"stream":false})).send().await.unwrap();
        let status=reply.status();let reply:Value=reply.json().await.unwrap();
        eprintln!("selected OpenCode HTTP result: {status} {reply}");
        server.await.unwrap();
        assert_eq!(status,200,"{reply}");assert!(reply["choices"][0]["message"]["content"].as_str().unwrap_or("").contains("NAUTILO_ACCOUNT_OK"));
    });
    runtime.shutdown_timeout(std::time::Duration::from_secs(3));
}

fn run_live_smoke(source: &str) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        runtime.block_on(live_smoke(source))
    }));
    // Native pipe readers use blocking tasks; keep the opt-in harness bounded
    // after all adapters have received their explicit dispose request.
    runtime.shutdown_timeout(std::time::Duration::from_secs(3));
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

async fn live_smoke(source: &str) {
    let root = std::path::PathBuf::from(
        std::env::var("NAUTILO_RELAY_SMOKE_HOME").expect("isolated smoke home"),
    );
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(root.join("codex")).unwrap();
    std::fs::create_dir_all(root.join("deepseek")).unwrap();
    let registry = AdapterRegistry::with_builtins();
    if source == "opencode" || source == "antigravity" {
        let plugin_exe = std::path::PathBuf::from(
            std::env::var(if source == "opencode" {
                "NAUTILO_TEST_OPENCODE_PLUGIN"
            } else {
                "NAUTILO_TEST_ANTIGRAVITY_PLUGIN"
            })
            .unwrap(),
        );
        let client = launch_plugin(source, &plugin_exe, plugin_exe.parent().unwrap())
            .await
            .unwrap();
        registry.register(Arc::new(client));
    }
    let harness = std::env::var("NAUTILO_TEST_OUTER_PROVIDER").unwrap_or("codex".into());
    if harness != "codex" {
        let path = std::path::PathBuf::from(std::env::var("NAUTILO_TEST_OUTER_PLUGIN").unwrap());
        registry.register(Arc::new(
            launch_plugin(&harness, &path, path.parent().unwrap())
                .await
                .unwrap(),
        ));
    }
    let db = Arc::new(Mutex::new(
        Database::open(&root.join("smoke.sqlite")).unwrap(),
    ));
    let account = if let Ok(account_path) = std::env::var("NAUTILO_RELAY_SMOKE_ACCOUNT_JSON") {
        let account: Value = serde_json::from_slice(&std::fs::read(account_path).unwrap()).unwrap();
        assert_eq!(account["harness"], source);
        assert_eq!(account["enabled"], true);
        account
    } else {
        json!({"id":"native-free","name":"Live native free smoke","kind":"login","harness":"opencode","nativeLogin":true,"loginProfileDirectory":root.join("account"),"enabled":true,"revision":1,"models":[]})
    };
    let native_exe = std::env::var(match source {
        "codex" => "NAUTILO_TEST_CODEX",
        "antigravity" => "NAUTILO_TEST_ANTIGRAVITY",
        _ => "NAUTILO_TEST_OPENCODE",
    })
    .unwrap();
    {
        let guard = db.lock().unwrap();
        let repo = Repositories::new(&guard.raw);
        repo.agents().save(&json!({"id":"native-source","providerId":source,"executable":native_exe,"baseArgs":[],"providerOptions":{},"enabled":true}), "now").unwrap();
        repo.runtime_connections().save(&account, "now").unwrap();
        repo.integration_settings().save(&json!({"id":"integration-settings","gateway":{"enabled":true,"connectionIds":[account["id"]]}}), "now").unwrap();
    }
    let gateways = AccountGateways::new(
        db.clone(),
        Arc::new(CredentialService::new(db.clone(), &root)),
        registry.clone(),
    );
    let outer = json!({"id":"outer","providerId":harness,"executable":std::env::var("NAUTILO_TEST_OUTER_CLI").unwrap(),"baseArgs":[],"providerOptions":{}});
    let mut route_account = account.clone();
    route_account["viaAccountGateway"] = json!(true);
    let instance =
        crate::application::connection_service::apply_connection(&outer, &route_account).unwrap();
    let env = crate::runtime::security::environment_policy::build_environment(
        None,
        HashMap::from([
            (
                "CODEX_HOME".into(),
                root.join("codex").to_string_lossy().into(),
            ),
            (
                "DSH_HOME".into(),
                root.join("deepseek").to_string_lossy().into(),
            ),
        ]),
    );
    let mut request = AdapterStartRequest {
        instance,
        cwd: root.to_string_lossy().into(),
        local_session_id: Some("live-native-relay-smoke".into()),
        prompt: "Reply exactly NAUTILO_ACCOUNT_OK. Do not inspect files or run commands.".into(),
        model: Some(std::env::var("NAUTILO_TEST_MODEL").unwrap_or_else(|_| {
            if source == "codex" {
                "gpt-6.1-sol".into()
            } else {
                "opencode/deepseek-v4.1-flash-free".into()
            }
        })),
        reasoning_effort: Some(std::env::var("NAUTILO_TEST_EFFORT").unwrap_or("max".into()))
            .filter(|effort| !effort.is_empty()),
        permission_mode: Some("danger-full-access".into()),
        env: Some(env),
        timeout_ms: Some(120000),
        idle_timeout_ms: Some(110000),
        ..Default::default()
    };
    gateways
        .bind("live-native-relay-smoke", &route_account, &mut request)
        .await
        .unwrap();
    if source == "opencode" {
        assert_eq!(
            request.instance["models"][0]["reasoningEfforts"],
            json!(["high", "low", "max"])
        );
    }
    let mut run = registry.start(request).unwrap();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(125), async {
        let mut reply = String::new();
        let mut errors = Vec::new();
        while let Some(event) = run.events.recv().await {
            match event {
                AdapterEvent::Message { text, .. } => reply.push_str(&text),
                AdapterEvent::Status { phase, raw } if phase == "runtime_ready" => {
                    eprintln!("native outer runtime ready: {raw:?}")
                }
                AdapterEvent::Error { message } => errors.push(message),
                AdapterEvent::Exit { .. } => break,
                _ => {}
            }
        }
        (reply, errors)
    })
    .await;
    eprintln!("native smoke outcome: {outcome:?}");
    if outcome.is_err() {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), run.cancel()).await;
    }
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        gateways.cancel_session("live-native-relay-smoke"),
    )
    .await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), registry.dispose()).await;
    let (reply, errors) = outcome.expect("native inference timed out");
    assert!(errors.is_empty(), "native outer errors: {errors:?}");
    assert!(reply.contains("NAUTILO_ACCOUNT_OK"), "reply: {reply:?}");
}
