use super::*;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};

async fn connect(pool: &McpPool, spec: &Value) -> (BufReader<OwnedReadHalf>, OwnedWriteHalf) {
    let socket = TcpStream::connect(&pool.address).await.unwrap();
    let (read, mut write) = socket.into_split();
    send(&mut write, json!({"token":pool.token,"spec":spec})).await;
    (BufReader::new(read), write)
}
async fn send(write: &mut OwnedWriteHalf, message: Value) {
    write
        .write_all(format!("{message}\n").as_bytes())
        .await
        .unwrap();
}
async fn read(read: &mut BufReader<OwnedReadHalf>) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(5), relay::read_message(read))
        .await
        .unwrap()
        .unwrap()
}
fn initialize(capabilities: Value) -> Value {
    json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":capabilities,"clientInfo":{"name":"fixture","version":"1"}}})
}

#[tokio::test]
async fn shared_process_isolates_ids_progress_cancellation_and_native_callbacks() {
    let pool = McpPool::start().unwrap();
    let file = std::env::temp_dir().join(format!("nautilo-mcp-{}.mjs", uuid::Uuid::new_v4()));
    std::fs::write(&file, include_str!("test-server.mjs")).unwrap();
    let spec =
        json!({"transport":"stdio","command":"node","args":[file],"cwd":std::env::temp_dir()});
    pool.prewarm(&spec, "");
    let (mut probe, mut probe_write) = connect(&pool, &spec).await;
    send(
        &mut probe_write,
        json!({"id":0,"method":"server/discover","params":{}}),
    )
    .await;
    let discovered = read(&mut probe).await;
    assert_eq!(discovered["error"]["code"], -32601);
    let (mut a, mut aw) = connect(&pool, &spec).await;
    let (mut b, mut bw) = connect(&pool, &spec).await;
    send(&mut aw, initialize(json!({}))).await;
    send(&mut bw, initialize(json!({}))).await;
    assert_eq!(
        read(&mut a).await["result"]["protocolVersion"],
        "2025-06-18"
    );
    assert_eq!(read(&mut b).await["id"], 1);
    for writer in [&mut aw, &mut bw] {
        send(
            writer,
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await;
    }
    send(&mut aw,json!({"id":2,"method":"tools/call","params":{"name":"echo","arguments":{"client":"a","delay":25},"_meta":{"progressToken":1}}})).await;
    send(&mut bw,json!({"id":2,"method":"tools/call","params":{"name":"echo","arguments":{"client":"b"},"_meta":{"progressToken":1}}})).await;
    assert_eq!(read(&mut a).await["params"]["progressToken"], 1);
    assert_eq!(read(&mut b).await["params"]["progressToken"], 1);
    let ar = read(&mut a).await;
    let br = read(&mut b).await;
    let av: Value =
        serde_json::from_str(ar["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let bv: Value =
        serde_json::from_str(br["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(av["pid"], bv["pid"]);
    assert_eq!(av["pid"], discovered["error"]["data"]["pid"]);
    assert_eq!(av["args"]["client"], "a");
    assert_eq!(bv["args"]["client"], "b");
    send(
        &mut aw,
        json!({"id":3,"method":"tools/call","params":{"name":"pending"}}),
    )
    .await;
    send(
        &mut bw,
        json!({"id":3,"method":"tools/call","params":{"name":"echo"}}),
    )
    .await;
    send(
        &mut aw,
        json!({"method":"notifications/cancelled","params":{"requestId":3}}),
    )
    .await;
    assert_eq!(read(&mut a).await["result"]["cancelled"], true);
    assert!(read(&mut b).await["result"]["content"].is_array());

    let (mut c, mut cw) = connect(&pool, &spec).await;
    send(&mut cw, initialize(json!({"roots":{"listChanged":true}}))).await;
    let question = read(&mut c).await;
    assert_eq!(question["method"], "roots/list");
    send(
        &mut cw,
        json!({"id":question["id"],"result":{"roots":[{"uri":"file:///workspace-a"}]}}),
    )
    .await;
    assert_eq!(
        read(&mut c).await["result"]["roots"][0]["uri"],
        "file:///workspace-a"
    );
    send(
        &mut cw,
        json!({"id":2,"method":"tools/call","params":{"name":"echo"}}),
    )
    .await;
    let cr = read(&mut c).await;
    let cv: Value =
        serde_json::from_str(cr["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_ne!(cv["pid"], av["pid"]);

    let modern_meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}});
    let (mut d, mut dw) = connect(&pool, &spec).await;
    let (mut e, mut ew) = connect(&pool, &spec).await;
    for writer in [&mut dw, &mut ew] {
        send(
            writer,
            json!({"id":"listen:0","method":"subscriptions/listen","params":{"_meta":modern_meta}}),
        )
        .await;
    }
    let da = read(&mut d).await;
    let ea = read(&mut e).await;
    assert_eq!(
        da["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"],
        "listen:0"
    );
    assert_eq!(
        ea["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"],
        "listen:0"
    );
    assert_eq!(da["params"]["pid"], ea["params"]["pid"]);
    assert_eq!(
        read(&mut d).await["method"],
        "notifications/tools/list_changed"
    );
    assert_eq!(
        read(&mut e).await["method"],
        "notifications/tools/list_changed"
    );
    // A modern discovery probe may be followed by callback-capable legacy initialization.
    send(&mut dw, initialize(json!({"roots":{"listChanged":true}}))).await;
    assert_eq!(read(&mut d).await["method"], "roots/list");
    send(&mut dw, json!({"id":"roots","result":{"roots":[]}})).await;
    assert!(read(&mut d).await["result"]["roots"]
        .as_array()
        .unwrap()
        .is_empty());
    pool.close().await;
    std::fs::remove_file(file).unwrap();
}
