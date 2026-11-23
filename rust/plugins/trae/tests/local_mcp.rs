use agenthub_plugin_sdk::{
    runtime_tools::{RuntimeTools, ToolRoute},
    DaemonChannel,
};
use serde_json::{json, Value};
use std::{process::Stdio, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::{timeout, Duration},
};

struct Daemon;
impl DaemonChannel for Daemon {
    fn ask(
        &self, _: &str, _: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        panic!("unexpected interaction")
    }
    fn call_tool(
        &self,
        run_id: &str,
        name: &str,
        args: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        let receipt = format!("{run_id}:{name}:{}", args["task"].as_str().unwrap_or(""));
        Box::pin(async move { json!({"success":true,"content":receipt}) })
    }
}

#[tokio::test]
async fn stdio_relay_lists_and_invokes_native_tools_through_the_active_turn() {
    let request = json!({"runtimeTools":[
        {"name":"agenthub_delegate","description":"Dispatch","inputSchema":{"type":"object"}},
        {"name":"agenthub_workflow_submit","description":"Submit","inputSchema":{"type":"object"}},
    ]});
    let bridge = RuntimeTools::start(
        &request,
        Some(Arc::new(Daemon)),
        ToolRoute::Run("first".into()),
        "nautilo_runtime",
        |name| name,
    )
    .await
    .unwrap()
    .unwrap();
    let spec = json!({"url":bridge.url});
    let mut child = Command::new(env!("CARGO_BIN_EXE_agenthub-plugin-trae"))
        .arg("--local-mcp-stdio")
        .env("NAUTILO_LOCAL_MCP_SPEC", spec.to_string())
        .env("HTTP_PROXY", "http://127.0.0.1:1")
        .env("NO_PROXY", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    for (id, method, params) in [
        (1, "initialize", json!({"protocolVersion":"2025-03-26"})),
        (2, "tools/list", json!({})),
        (
            3,
            "tools/call",
            json!({"name":"agenthub_delegate","arguments":{"task":"inspect"}}),
        ),
        (
            4,
            "tools/call",
            json!({"name":"agenthub_workflow_submit","arguments":{"task":"report"}}),
        ),
        (
            5,
            "tools/call",
            json!({"name":"agenthub_delegate","arguments":{"task":"late"}}),
        ),
    ] {
        if id == 4 {
            bridge.bind(ToolRoute::Run("second".into()));
        }
        if id == 5 {
            bridge.suspend();
        }
        input
            .write_all(
                format!(
                    "{}\n",
                    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let line = timeout(Duration::from_secs(5), output.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let reply: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(reply["id"], id);
        let result = &reply["result"];
        match id {
            1 => assert_eq!(result["protocolVersion"], "2025-03-26"),
            2 => assert_eq!(result["tools"][0]["name"], "agenthub_delegate"),
            3 => assert_eq!(
                result["content"][0]["text"],
                "first:agenthub_delegate:inspect"
            ),
            4 => assert_eq!(
                result["content"][0]["text"],
                "second:agenthub_workflow_submit:report"
            ),
            5 => assert_eq!(result["isError"], true),
            _ => unreachable!(),
        }
    }
    drop(input);
    assert!(timeout(Duration::from_secs(5), child.wait())
        .await
        .unwrap()
        .unwrap()
        .success());
}
