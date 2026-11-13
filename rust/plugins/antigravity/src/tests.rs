use super::*;
use std::time::Duration;

fn request(prompt: &str) -> Value {
    json!({"instance":{"executable":"node","baseArgs":[format!("{}/tests/fake-agy.mjs",env!("CARGO_MANIFEST_DIR"))],"providerOptions":{"nativeLogin":true}},
        "cwd":std::env::temp_dir(),"env":std::env::vars().collect::<HashMap<_,_>>(),"localSessionId":"local","prompt":prompt,"model":"gemini-fixture","reasoningEffort":"xhigh","timeoutMs":5000})
}
fn drain(rx: &mut mpsc::UnboundedReceiver<Value>) -> Vec<Value> {
    let mut events = vec![];
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }
    events
}

#[tokio::test]
async fn resident_turns_deliver_final_chunks_before_completion_and_resume_native_id() {
    let req = request("hello");
    let native = Session::open(&req, None, None).await.unwrap();
    let pid = native.rpc.process_handle().pid;
    for turn in 1..=2 {
        let (tx, mut rx) = mpsc::unbounded_channel();
        native.turn(&req, tx, turn > 1).await.unwrap();
        let events = drain(&mut rx);
        assert_eq!(native.rpc.process_handle().pid, pid);
        let body = events
            .iter()
            .position(|e| e["kind"] == "message" && e["phase"] == "completed")
            .unwrap();
        let end = events
            .iter()
            .position(|e| e["phase"] == "turn_completed")
            .unwrap();
        assert!(body < end);
        assert_eq!(events[body]["text"], format!("Turn {turn}; effort=extra"));
        assert!(events
            .iter()
            .any(|e| e["contextUsed"] == 127 && e["contextWindow"] == 200000));
    }
    native.close().await;
    let resumed = Session::open(&req, Some("saved-native-id"), None)
        .await
        .unwrap();
    assert_eq!(resumed.native_id, "saved-native-id");
    resumed.close().await;
}

struct Replies;
impl DaemonChannel for Replies {
    fn ask(
        &self,
        _: &str,
        input: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        Box::pin(async move {
            if input["kind"] == "approval" {
                json!({"outcome":"selected","optionId":"once"})
            } else {
                json!({"outcome":"selected","answers":{"choice":["Beta"]}})
            }
        })
    }
    fn call_tool(
        &self,
        _: &str,
        _: &str,
        _: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        Box::pin(async { json!({"success":true,"content":"fixture"}) })
    }
}
#[tokio::test]
async fn permissions_and_questions_round_trip_to_native_values() {
    let req = request("interact");
    let native = Session::open(&req, None, Some(Arc::new(Replies)))
        .await
        .unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    native.turn(&req, tx, false).await.unwrap();
    let events = drain(&mut rx);
    let tool = events
        .iter()
        .find(|e| e["kind"] == "tool" && e["phase"] == "completed")
        .unwrap();
    assert_eq!(tool["input"]["permit"], "once");
    assert_eq!(tool["output"]["choice"], "b");
    native.close().await;
}
#[tokio::test]
async fn native_cancellation_settles_and_the_same_process_can_run_again() {
    let req = request("wait");
    let native = Arc::new(Session::open(&req, None, None).await.unwrap());
    let (tx, mut rx) = mpsc::unbounded_channel();
    let run = native.clone();
    let turn = tokio::spawn(async move { run.turn(&req, tx, false).await });
    while rx.recv().await.unwrap()["kind"] != "thinking" {}
    native.cancel().await;
    tokio::time::timeout(Duration::from_secs(3), turn)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(drain(&mut rx).iter().any(|e| e["phase"] == "cancelled"));
    let (tx2, mut rx2) = mpsc::unbounded_channel();
    native.turn(&request("again"), tx2, true).await.unwrap();
    assert!(drain(&mut rx2)
        .iter()
        .any(|e| e["phase"] == "turn_completed"));
    native.close().await;
}
#[tokio::test]
async fn unsigned_account_fails_explicitly_instead_of_creating_fake_session() {
    let mut req = request("hello");
    req["env"]["FIXTURE_AUTH"] = json!("required");
    match Session::open(&req, None, None).await {
        Ok(_) => panic!("auth error was ignored"),
        Err(error) => assert!(error.to_string().contains("Authentication required")),
    }
}
#[test]
fn multi_select_answers_preserve_values_and_required_fields() {
    let form = json!({"requestedSchema":{"type":"object","required":["selected"],"properties":{"selected":{"type":"array","items":{"anyOf":[{"const":"one","title":"第一项"},{"const":"two","title":"第二项"}]},"minItems":1}}}});
    assert_eq!(
        interactions::form(&form).unwrap()["questions"][0]["multiSelect"],
        true
    );
    let answer = interactions::form_answer(
        &form,
        &json!({"outcome":"selected","answers":{"selected":["第二项","第一项"]}}),
    )
    .unwrap();
    assert_eq!(answer["content"]["selected"], json!(["two", "one"]));
    assert!(interactions::form_answer(&form, &json!({"outcome":"selected","answers":{}})).is_err());
    let mut optional_selection = form;
    optional_selection["requestedSchema"]["properties"]["selected"]["minItems"] = json!(0);
    assert_eq!(
        interactions::form_answer(
            &optional_selection,
            &json!({"outcome":"selected","answers":{"selected":[]}})
        )
        .unwrap()["content"]["selected"],
        json!([])
    );
}
