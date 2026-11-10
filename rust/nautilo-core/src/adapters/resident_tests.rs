use super::*;
use serde_json::json;

fn request(provider: &str) -> AdapterStartRequest {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/native-session.mjs");
    AdapterStartRequest {
        instance: json!({"executable":"node","baseArgs":[fixture,provider]}),
        local_session_id: Some(format!("resident-test-{provider}")),
        cwd: std::env::temp_dir().to_string_lossy().into(),
        prompt: "first".into(),
        timeout_ms: Some(4000),
        env: Some(
            std::env::vars()
                .filter(|(key, _)| {
                    ["path", "systemroot", "windir", "temp", "tmp", "comspec"]
                        .contains(&key.to_lowercase().as_str())
                })
                .collect(),
        ),
        ..Default::default()
    }
}
async fn collect(mut run: AdapterRun) -> (String, i32) {
    tokio::time::timeout(std::time::Duration::from_secs(8), async move {
        let mut text = String::new();
        let mut code = -1;
        while let Some(event) = run.events.recv().await {
            match event {
                AdapterEvent::Message { text: part, .. } => text = part,
                AdapterEvent::Error { message } => eprintln!("{message}"),
                AdapterEvent::Raw { stream, text } if stream == "stderr" => eprintln!("{text}"),
                AdapterEvent::Exit { exit_code, .. } => {
                    code = exit_code.unwrap_or(-1);
                    break;
                }
                _ => {}
            }
        }
        (text, code)
    })
    .await
    .expect("native run must settle")
}
#[tokio::test]
async fn native_residents_reuse_and_recover() {
    for provider in ["claude", "kimi"] {
        let start = |request: AdapterStartRequest, resume: Option<String>| match provider {
            "claude" => super::claude::resident_test_launch(request, resume),
            _ => super::kimi::acp_run::start_kimi_acp(request, resume),
        };
        let mut request = request(provider);
        let (first, code) = collect(start(request.clone(), None).unwrap()).await;
        assert_eq!(code, 0, "{provider}: {first}");
        request.prompt = "second".into();
        let (second, code) =
            collect(start(request.clone(), Some("fixture-session".into())).unwrap()).await;
        assert_eq!(code, 0, "{provider}: {second}");
        assert_eq!(
            first.split(':').next(),
            second.split(':').next(),
            "{provider} restarted between turns"
        );
        assert!(second.contains(":2:second"), "{provider}: {second}");
        request.prompt = "hang".into();
        request.timeout_ms = Some(80);
        let (_, code) =
            collect(start(request.clone(), Some("fixture-session".into())).unwrap()).await;
        assert_ne!(code, 0);
        request.prompt = "recovered".into();
        request.timeout_ms = Some(4000);
        let (recovered, code) =
            collect(start(request, Some("fixture-session".into())).unwrap()).await;
        assert_eq!(code, 0);
        assert!(recovered.contains(":1:recovered"));
        if provider == "claude" {
            super::claude::resident_test_release("resident-test-claude").await;
        } else {
            super::kimi::acp_run::release_session("resident-test-kimi").await;
        }
    }
}

#[tokio::test]
async fn claude_delivers_same_read_and_delayed_child_events_after_foreground_exit() {
    let mut request=request("claude");request.local_session_id=Some("claude-background-test".into());request.prompt="background".into();
    let (sender,mut events)=tokio::sync::mpsc::unbounded_channel();
    request.session_events=Some(Arc::new(move |event|{let _=sender.send(event);}));
    let (_,code)=collect(super::claude::resident_test_launch(request.clone(),None).unwrap()).await;assert_eq!(code,0);
    let text=tokio::time::timeout(std::time::Duration::from_secs(2),async {
        let mut text=String::new();while let Some(event)=events.recv().await {
            if let AdapterEvent::Message{text:part,subagent_dispatch_id,..}=event {
                assert_eq!(subagent_dispatch_id.as_deref(),Some("background-call"));text.push_str(&part);
                if text.contains("child-after-turn"){break;}
            }
        }text
    }).await.expect("background output must not wait for the next prompt");
    assert!(text.contains("child-in-terminal-chunk"));assert!(text.contains("child-after-turn"));
    request.prompt="next".into();
    let (reply,code)=collect(super::claude::resident_test_launch(request,Some("fixture-session".into())).unwrap()).await;
    assert_eq!(code,0);assert!(reply.contains(":2:next"));
    super::claude::resident_test_release("claude-background-test").await;
}

#[tokio::test]
async fn kimi_keeps_late_tools_permissions_and_unique_message_identity_across_turns() {
    let mut request=request("kimi");
    let local=format!("kimi-background-{}",uuid::Uuid::new_v4().simple());
    request.local_session_id=Some(local.clone());request.prompt="background".into();
    let (output,mut background)=tokio::sync::mpsc::unbounded_channel();
    request.session_events=Some(Arc::new(move |event|{let _=output.send(event);}));
    let (questions,mut input)=tokio::sync::mpsc::unbounded_channel();
    let release=Arc::new(tokio::sync::Notify::new());let gate=release.clone();
    request.session_interaction=Some(Arc::new(move |question| {
        let _=questions.send(question);let gate=gate.clone();
        Box::pin(async move {gate.notified().await;Ok(json!({"outcome":"selected","optionId":"once"}))})
    }));
    request.request_interaction=Some(Arc::new(|_|Box::pin(async {panic!("late permission was routed to a finished foreground turn")})));
    async fn turn(mut run:AdapterRun)->(String,String) {
        tokio::time::timeout(std::time::Duration::from_secs(4),async {
            let mut text=String::new();let mut identity=String::new();
            while let Some(event)=run.events.recv().await {
                match event {
                    AdapterEvent::Message{text:part,message_id,..}=>{text=part;identity=message_id.unwrap_or_default();}
                    AdapterEvent::Exit{exit_code,..}=>{assert_eq!(exit_code,Some(0));break;}
                    AdapterEvent::Error{message}=>panic!("{message}"),_=>{}
                }
            }(text,identity)
        }).await.unwrap()
    }
    let first=turn(super::kimi::acp_run::start_kimi_acp(request.clone(),None).unwrap()).await;
    let question=tokio::time::timeout(std::time::Duration::from_secs(2),input.recv()).await.unwrap().unwrap();
    assert_eq!(question["nativeRequestId"],"idle-permission");
    let mut started=false;
    tokio::time::timeout(std::time::Duration::from_secs(2),async {
        while let Some(event)=background.recv().await {
            if let AdapterEvent::Tool{call_id,output,..}=event {
                if call_id.as_deref()==Some("late-read"){started=true;}
                if output==Some(json!("while-approval-is-pending")){break;}
            } else if let AdapterEvent::Message{text,..}=event {assert!(!text.contains("cross-session-leak"));}
        }
    }).await.expect("a pending approval must not block other native events");
    assert!(started,"the prompt response's same-read tail was lost");
    request.prompt="second".into();
    let second=turn(super::kimi::acp_run::start_kimi_acp(request,Some("fixture-session".into())).unwrap()).await;
    assert_eq!(first.0.split(':').next(),second.0.split(':').next());
    assert_ne!(first.1,second.1,"message IDs must not collide across turns");
    release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(2),async {
        while let Some(event)=background.recv().await {
            if let AdapterEvent::Tool{call_id,name,phase,output,..}=event {
                if call_id.as_deref()==Some("late-read") && phase.as_deref()==Some("completed") {
                    assert_eq!(name,"Read late file");assert_eq!(output,Some(json!("approved-late-result")));return;
                }
            }
        }panic!("background channel closed unexpectedly");
    }).await.unwrap();
    super::kimi::acp_run::release_session(&local).await;
}

#[tokio::test]
async fn kimi_polls_native_child_wires_after_the_parent_turn_has_settled() {
    let mut request=request("kimi");
    let local=format!("kimi-wires-{}",uuid::Uuid::new_v4().simple());
    request.local_session_id=Some(local.clone());request.prompt="background-wire".into();
    let directory=std::env::temp_dir().join(&local);
    // Deliberately leave the session directory absent at initialize time.
    std::fs::create_dir_all(&directory).unwrap();
    request.env.as_mut().unwrap().insert("KIMI_CODE_HOME".into(),directory.to_string_lossy().into());
    let (sender,mut background)=tokio::sync::mpsc::unbounded_channel();
    request.session_events=Some(Arc::new(move |event|{let _=sender.send(event);}));
    assert_eq!(collect(super::kimi::acp_run::start_kimi_acp(request,None).unwrap()).await.1,0);
    let result=tokio::time::timeout(std::time::Duration::from_secs(3),async {
        while let Some(event)=background.recv().await {
            if let AdapterEvent::Message{text,subagent_dispatch_id,..}=event {
                if text=="native-child-from-wire-after-turn" {
                    assert_eq!(subagent_dispatch_id.as_deref(),Some("agent-background"));return;
                }
            }
        }panic!("child watcher stopped with its parent turn");
    }).await;
    super::kimi::acp_run::release_session(&local).await;
    result.unwrap();
}
