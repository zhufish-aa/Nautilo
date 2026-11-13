//! Chat completion serialization shared by streaming and buffered callers.
use super::http::{chunk, error, response, write_sse};
use super::{Conversation, Route};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::{io::AsyncWriteExt, net::TcpStream};

pub(super) async fn write_completion(
    route: &Route,
    mut socket: TcpStream,
    body: &Value,
    conversation: &mut Conversation,
    identity: &str,
) -> anyhow::Result<()> {
    let stream = body["stream"] == true;
    let id = format!("chatcmpl-{}", uuid::Uuid::new_v4());
    let model = body["model"].clone();
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_calls = vec![];
    let mut usage = Value::Null;
    let mut finish = "stop";
    let mut failure = None;
    if stream {
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n").await?;
    }
    let receiver = conversation.worker.as_mut().unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(300), receiver.recv()).await;
        let Some(frame) = frame.ok().flatten() else {
            failure = Some("Native account stream ended without a completion".to_string());
            route.stop();
            break;
        };
        if let Some(error) = frame["error"].as_str() {
            failure = Some(error.to_string());
            route.stop();
            break;
        }
        if frame["done"] == true {
            if frame["failed"] == true {
                failure = Some("Native account request failed".into());
            } else if let Some((hashes, tools)) = conversation.pending_history.take() {
                conversation.hashes = hashes;
                conversation.tools = Some(tools);
                route.checkpoint(
                    identity,
                    &conversation.hashes,
                    conversation.tools.as_deref().unwrap_or(""),
                );
            }
            conversation.worker = None;
            break;
        }
        if let Some(u) = frame.get("usage") {
            usage = u.clone();
            continue;
        }
        if let Some(calls) = frame["tool_calls"].as_array() {
            tool_calls.extend(calls.clone());
            finish = "tool_calls";
            if stream {
                write_sse(&mut socket, &chunk(&id, &model, frame, None)).await?;
            }
            break;
        }
        if let Some(part) = frame["content"].as_str() {
            content.push_str(part);
        }
        if let Some(part) = frame["reasoning_content"].as_str() {
            reasoning.push_str(part);
        }
        if stream {
            if let Err(e) = write_sse(&mut socket, &chunk(&id, &model, frame, None)).await {
                route.stop();
                conversation.worker = None;
                conversation.pending_history = None;
                return Err(e);
            }
        }
    }
    if let Some(message) = failure {
        conversation.worker = None;
        conversation.pending_history = None;
        let (code, message) = route.account_error(&message);
        if stream {
            write_sse(
                &mut socket,
                &json!({"error":{"code":code,"message":message}}),
            )
            .await?;
            socket.write_all(b"data: [DONE]\n\n").await?;
            return Ok(());
        }
        return error(
            &mut socket,
            if code == "AGENT_NOT_AUTHENTICATED" {
                401
            } else {
                502
            },
            code,
            &message,
        )
        .await;
    }
    if stream {
        write_sse(&mut socket, &chunk(&id, &model, json!({}), Some(finish))).await?;
        if !usage.is_null() {
            write_sse(&mut socket,&json!({"id":id,"object":"chat.completion.chunk","model":model,"choices":[],"usage":usage})).await?;
        }
        socket.write_all(b"data: [DONE]\n\n").await?;
    } else {
        response(&mut socket,200,&json!({"id":id,"object":"chat.completion","model":model,"choices":[{"index":0,"message":{"role":"assistant","content":content,"reasoning_content":reasoning,"tool_calls":tool_calls},"finish_reason":finish}],"usage":usage})).await?;
    }
    Ok(())
}
