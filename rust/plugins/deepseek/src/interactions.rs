//! Native requests can remain pending after their parent turn has settled.
use super::Native;
use serde_json::{json, Value};
use tokio::sync::oneshot;

pub fn dispatch(native: &Native, frame: Value) {
    let root = native.session.lock().unwrap().clone();
    let owner = native.routes.lock().unwrap().owner(&frame, &root);
    let Some(owner) = owner else { return };
    let child = frame["sessionId"]
        .as_str()
        .is_some_and(|session| session != root);
    let channel = owner.channel(child);
    let Some(id) = frame["id"].as_str().map(str::to_string) else {
        return;
    };
    let native = native.clone();
    let pending = native.interactions.clone();
    let request_id = id.clone();
    // Install cancellation before the worker can finish or a following native
    // abort frame arrives in the same stdout chunk.
    let (start, ready) = oneshot::channel();
    let task = tokio::spawn(async move {
        if ready.await.is_err() {
            return;
        }
        let response = async {
            let Some(channel) = channel else {
                return json!({"outcome":"cancelled"});
            };
            if frame["kind"] == "host_tool" {
                channel
                    .call_tool(
                        &owner.run_id,
                        frame["name"].as_str().unwrap_or(""),
                        frame["arguments"].clone(),
                    )
                    .await
            } else {
                let input = if frame["kind"] == "question" {
                    json!({"kind":"question","nativeRequestId":request_id,"title":"DeepSeek Harness","questions":frame["questions"]})
                } else {
                    json!({"kind":"approval","nativeRequestId":request_id,"title":frame["title"],"detail":frame["detail"],
                        "options":[{"id":"once","label":"允许一次"},{"id":"reject","label":"拒绝"}]})
                };
                channel.ask(&owner.run_id, input).await
            }
        };
        tokio::select! {
            answer = response => {
                let _ = native.call("/answer", json!({"id":request_id,"answer":answer})).await;
            }
            _ = native.process.wait() => {}
        }
        native.interactions.lock().unwrap().remove(&request_id);
    });
    if let Some(previous) = pending.lock().unwrap().insert(id, task.abort_handle()) {
        previous.abort();
    }
    let _ = start.send(());
}
