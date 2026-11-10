async fn background_event(
    events: &mut mpsc::UnboundedReceiver<(String, AdapterEvent)>,
    matches: impl Fn(&AdapterEvent) -> bool,
) -> (String, AdapterEvent) {
    tokio::time::timeout(Duration::from_secs(3),async {
        while let Some((owner,event))=events.recv().await {
            assert!(!matches!(&event,AdapterEvent::Session{provider_session_id,..} if provider_session_id=="background-child-thread"));
            if matches(&event){return (owner,event);}
        }panic!("native background stream closed");
    }).await.expect("native background activity must arrive without another prompt")
}

#[tokio::test]
async fn native_background_keeps_child_origin_and_async_approval_across_turns() {
    let (mut request, root) = fake_request("background-native");
    request.local_session_id = Some("background-local".into());
    let pooled = acquire_codex_app_server(&request).unwrap();
    let base = request.clone();
    let log_path = root.join("rpc.ndjson");
    let result=tokio::spawn(async move {
        let (output,mut events)=mpsc::unbounded_channel();let first=output.clone();
        request.session_events=Some(Arc::new(move |event|{let _=first.send(("first".into(),event));}));
        let (questions,mut prompts)=mpsc::unbounded_channel();let release=Arc::new(tokio::sync::Notify::new());let gate=release.clone();
        request.session_interaction=Some(Arc::new(move |input|{
            let _=questions.send(input);let gate=gate.clone();Box::pin(async move {gate.notified().await;Ok(json!({"outcome":"selected","optionId":"accept"}))})
        }));
        request.request_interaction=Some(Arc::new(|_|Box::pin(async{panic!("child approval used a completed foreground turn")})));
        let tools=Arc::new(Mutex::new(vec![]));let calls=tools.clone();
        request.session_tool=Some(Arc::new(move |input|{calls.lock().unwrap().push(input);Box::pin(async{Ok(json!({"success":true,"content":"native-background-tool-ok"}))})}));
        request.execute_runtime_tool=Some(Arc::new(|_|Box::pin(async{panic!("child tool used a completed foreground turn")})));
        let mut run=start_codex_app_server(request.clone(),None).unwrap();let first=collect(&mut run).await;
        let thread=first.iter().find_map(|event|if let AdapterEvent::Session{provider_session_id,..}=event{Some(provider_session_id.clone())}else{None}).unwrap();
        let question=tokio::time::timeout(Duration::from_secs(3),prompts.recv()).await.unwrap().unwrap();
        assert_eq!(question["nativeRequestId"],"background-approval");
        let (owner,_)=background_event(&mut events,|event|matches!(event,AdapterEvent::Message{text,..} if text=="Child while approval pending")).await;
        assert_eq!(owner,"first");
        request.prompt="slow".into();
        request.session_events=Some(Arc::new(move |event|{let _=output.send(("second".into(),event));}));
        let mut next=start_codex_app_server(request.clone(),Some(thread.clone())).unwrap();until_phase(&mut next,"turn_started").await;
        release.notify_one();
        let (owner,_)=background_event(&mut events,|event|matches!(event,AdapterEvent::Message{text,subagent_dispatch_id:Some(dispatch),..} if text=="Background native child result" && dispatch=="spawn-background")).await;
        assert_eq!(owner,"first","an old native child was reassigned to the next turn");
        let next=collect(&mut next).await;
        assert!(next.iter().any(|event|matches!(event,AdapterEvent::Message{text,..} if text=="done:slow")));
        assert!(!next.iter().any(|event|matches!(event,AdapterEvent::Message{subagent_dispatch_id:Some(_),..})));
        assert!(next.iter().all(|event|!matches!(event,AdapterEvent::Session{provider_session_id,..} if provider_session_id!=&thread)));
        assert_eq!(tools.lock().unwrap().len(),1);assert_eq!(tools.lock().unwrap()[0]["arguments"]["background"],true);
        let ready_pid=|events:&[AdapterEvent]|events.iter().find_map(|event|match event{AdapterEvent::Status{phase,raw:Some(raw)} if phase=="runtime_ready"=>Some(raw["pid"].clone()),_=>None});
        // The first ready frame and same-session next turn share one runtime.
        assert!(ready_pid(&first).is_some());
        request.prompt="hang".into();request.timeout_ms=Some(90);
        let mut limited=start_codex_app_server(request.clone(),Some(thread.clone())).unwrap();
        assert!(collect(&mut limited).await.iter().any(|event|matches!(event,AdapterEvent::Timeout{..})));
        request.prompt="after-timeout".into();request.timeout_ms=Some(4000);
        let mut recovered=start_codex_app_server(request,Some(thread)).unwrap();
        assert!(collect(&mut recovered).await.iter().any(|event|matches!(event,AdapterEvent::Message{text,..} if text=="done:after-timeout")));
        let log=std::fs::read_to_string(log_path).unwrap();
        assert_eq!(log.lines().filter(|line|line.contains("\"event\":\"spawn\"")).count(),1);
    }).await;
    pooled.rpc.process_handle().cancel().await;
    discard_codex_app_server(&pooled);
    let _ = session_pool::release_session(&base).await;
    let _ = std::fs::remove_dir_all(root);
    result.unwrap();
}

#[tokio::test]
async fn native_request_resolution_and_process_exit_dismiss_background_waits() {
    for resolved in [true, false] {
        let (mut request, root) = fake_request("background-native");
        request.local_session_id = Some("dismiss-local".into());
        if resolved {
            request
                .env
                .as_mut()
                .unwrap()
                .insert("CODEX_FAKE_CANCEL_BACKGROUND_REQUEST".into(), "1".into());
        }
        let pooled = acquire_codex_app_server(&request).unwrap();
        let base = request.clone();
        let pending = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = pending.clone();
        let result = tokio::spawn(async move {
            let (asked, mut question) = mpsc::unbounded_channel();
            request.session_interaction = Some(Arc::new(move |_| {
                let _ = asked.send(());
                let count = count.clone();
                Box::pin(async move {
                    struct Waiting(Arc<std::sync::atomic::AtomicUsize>);
                    impl Drop for Waiting {
                        fn drop(&mut self) {
                            self.0.fetch_sub(1, Ordering::AcqRel);
                        }
                    }
                    count.fetch_add(1, Ordering::AcqRel);
                    let _waiting = Waiting(count);
                    std::future::pending::<()>().await;
                    Ok(json!({"outcome":"cancelled"}))
                })
            }));
            let mut run = start_codex_app_server(request, None).unwrap();
            collect(&mut run).await;
            tokio::time::timeout(Duration::from_secs(3), question.recv())
                .await
                .unwrap()
                .unwrap();
            if resolved {
                tokio::time::timeout(Duration::from_secs(2), async {
                    while pending.load(Ordering::Acquire) != 0 {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .unwrap();
            } else {
                assert_eq!(pending.load(Ordering::Acquire), 1);
            }
            pending
        })
        .await;
        pooled.rpc.process_handle().cancel().await;
        discard_codex_app_server(&pooled);
        let _ = session_pool::release_session(&base).await;
        let _ = std::fs::remove_dir_all(root);
        let pending = result.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while pending.load(Ordering::Acquire) != 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
}
