//! Chat wire projection for Magpie's zenReply semantics: return the caller's
//! tool names, suppress compatibility stubs, and gather SSE for buffered clients.
use super::wire::{Tools, STUB_NOTE};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::watch,
};

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    arguments: String,
    visible: Option<usize>,
    hidden: bool,
    started: bool,
}
#[derive(Default)]
struct Choice {
    text: String,
    reasoning: String,
    calls: BTreeMap<usize, Call>,
    visible: usize,
    stubbed: bool,
    finish: Option<Value>,
}
#[derive(Default)]
struct Reply {
    choices: BTreeMap<usize, Choice>,
    usage: Value,
    base: Value,
}
impl Reply {
    fn frame(&mut self, mut frame: Value, tools: &Tools) -> anyhow::Result<Value> {
        if let Some(error) = frame.get("error") {
            anyhow::bail!(
                "{}",
                error["message"]
                    .as_str()
                    .unwrap_or("OpenCode upstream stream failed")
            );
        }
        if self.base.is_null() {
            self.base = frame.clone();
        }
        if let Some(usage) = frame.get("usage").filter(|u| !u.is_null()) {
            self.usage = usage.clone();
        }
        for choice in frame["choices"].as_array_mut().into_iter().flatten() {
            let index = choice["index"].as_u64().unwrap_or(0) as usize;
            let state = self.choices.entry(index).or_default();
            if let Some(text) = choice["delta"]["content"].as_str() {
                state.text.push_str(text);
            }
            if let Some(text) = choice["delta"]["reasoning_content"].as_str() {
                state.reasoning.push_str(text);
            }
            let mut emitted = vec![];
            for part in choice["delta"]["tool_calls"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let input_index = part["index"].as_u64().unwrap_or(0) as usize;
                let call = state.calls.entry(input_index).or_default();
                if let Some(id) = part["id"].as_str() {
                    if call.id.is_empty() {
                        call.id = id.into();
                    }
                }
                if let Some(name) = part["function"]["name"].as_str() {
                    call.name.push_str(name);
                }
                let args = part["function"]["arguments"].as_str();
                if let Some(args) = args {
                    call.arguments.push_str(args);
                }
                if !call.started && args.is_some() && !call.name.is_empty() {
                    call.started = true;
                    if tools.stubs.contains(&call.name) {
                        call.hidden = true;
                        state.stubbed = true;
                    } else {
                        let out = state.visible;
                        state.visible += 1;
                        call.visible = Some(out);
                        let name = tools.back.get(&call.name).unwrap_or(&call.name);
                        emitted.push(json!({"index":out,"id":call.id,"type":"function","function":{"name":name,"arguments":call.arguments}}));
                    }
                } else if let (Some(index), Some(args)) = (call.visible, args) {
                    emitted.push(json!({"index":index,"function":{"arguments":args}}));
                }
            }
            if choice["delta"].is_object() {
                choice["delta"]
                    .as_object_mut()
                    .unwrap()
                    .remove("tool_calls");
                if !emitted.is_empty() {
                    choice["delta"]["tool_calls"] = json!(emitted);
                }
            }
            if let Some(finish) = choice
                .get("finish_reason")
                .filter(|v| !v.is_null())
                .cloned()
            {
                if state.stubbed && state.visible == 0 {
                    if state.text.is_empty() {
                        state.text = STUB_NOTE.into();
                        choice["delta"]["content"] = json!(STUB_NOTE);
                    }
                    if finish == "tool_calls" {
                        choice["finish_reason"] = json!("stop");
                    }
                }
                state.finish = Some(choice["finish_reason"].clone());
            }
        }
        Ok(frame)
    }
    fn complete(&self) -> bool {
        !self.choices.is_empty() && self.choices.values().all(|c| c.finish.is_some())
    }
    fn buffered(&self, model: &Value, tools: &Tools) -> Value {
        let choices=self.choices.iter().map(|(index,choice)| {
            let mut calls=choice.calls.values().filter_map(|call|call.visible.map(|index| {
                (index,json!({"id":call.id,"type":"function","function":{"name":tools.back.get(&call.name).unwrap_or(&call.name),"arguments":call.arguments}}))
            })).collect::<Vec<_>>();
            calls.sort_by_key(|(index,_)|*index);
            json!({"index":index,"message":{"role":"assistant","content":choice.text,"reasoning_content":choice.reasoning,"tool_calls":calls.into_iter().map(|(_,call)|call).collect::<Vec<_>>()},"finish_reason":choice.finish})
        }).collect::<Vec<_>>();
        json!({"id":self.base["id"],"object":"chat.completion","created":self.base["created"],"model":model,"choices":choices,"usage":self.usage})
    }
}
async fn sse(socket: &mut TcpStream, value: &Value) -> anyhow::Result<()> {
    socket
        .write_all(format!("data: {value}\n\n").as_bytes())
        .await?;
    Ok(())
}
async fn buffered(socket: &mut TcpStream, body: &Value) -> anyhow::Result<()> {
    let bytes = body.to_string();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{bytes}",bytes.len()).as_bytes()).await?;
    Ok(())
}
pub async fn relay(
    socket: &mut TcpStream,
    mut response: reqwest::Response,
    body: &Value,
    tools: Tools,
    cancelled: &mut watch::Receiver<bool>,
    headers_started: &mut bool,
) -> anyhow::Result<()> {
    let streaming = body["stream"] == true;
    let is_sse = response
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.contains("text/event-stream"));
    if !is_sse {
        let mut response: Value = response.json().await?;
        anyhow::ensure!(
            response["choices"].is_array(),
            "OpenCode returned no completion"
        );
        for choice in response["choices"].as_array_mut().into_iter().flatten() {
            choice["delta"] = choice["message"].clone();
            choice.as_object_mut().unwrap().remove("message");
            for (index, call) in choice["delta"]["tool_calls"]
                .as_array_mut()
                .into_iter()
                .flatten()
                .enumerate()
            {
                call["index"] = json!(index);
            }
        }
        response["object"] = json!("chat.completion.chunk");
        let mut reply = Reply::default();
        let response = reply.frame(response, &tools)?;
        if !streaming {
            return buffered(socket, &reply.buffered(&body["model"], &tools)).await;
        }
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .await?;
        *headers_started = true;
        sse(socket, &response).await?;
        socket.write_all(b"data: [DONE]\n\n").await?;
        return Ok(());
    }
    if streaming {
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n").await?;
        *headers_started = true;
    }
    let mut pending = vec![];
    let mut reply = Reply::default();
    let mut disconnected = [0u8; 1];
    'stream: loop {
        let bytes = tokio::select! {
            result=response.chunk()=>result?,
            _=cancelled.changed()=>anyhow::bail!("OpenCode request cancelled"),
            _=socket.read(&mut disconnected)=>return Ok(()),
        };
        let Some(bytes) = bytes else { break };
        pending.extend_from_slice(&bytes);
        anyhow::ensure!(
            pending.len() < 20 * 1024 * 1024,
            "OpenCode SSE frame exceeds the local transport limit"
        );
        loop {
            let boundary = pending
                .windows(2)
                .position(|w| w == b"\n\n")
                .map(|i| (i, 2))
                .or_else(|| {
                    pending
                        .windows(4)
                        .position(|w| w == b"\r\n\r\n")
                        .map(|i| (i, 4))
                });
            let Some((end, separator)) = boundary else {
                break;
            };
            let frame = String::from_utf8(pending[..end].to_vec())?;
            pending.drain(..end + separator);
            let data = frame
                .lines()
                .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
                .collect::<Vec<_>>()
                .join("\n");
            if data == "[DONE]" {
                break 'stream;
            }
            if data.is_empty() {
                continue;
            }
            let mut frame = reply.frame(serde_json::from_str(&data)?, &tools)?;
            frame["model"] = body["model"].clone();
            if streaming {
                sse(socket, &frame).await?;
            }
        }
    }
    anyhow::ensure!(
        reply.complete(),
        "OpenCode stream ended without a completed response"
    );
    if streaming {
        socket.write_all(b"data: [DONE]\n\n").await?;
    } else {
        buffered(socket, &reply.buffered(&body["model"], &tools)).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_deltas_restore_names_and_never_expose_stubs() {
        let tools = Tools {
            back: std::collections::HashMap::from([("read".into(), "Read".into())]),
            stubs: std::collections::HashSet::from(["shell".into()]),
        };
        let mut reply = Reply::default();
        let frame=reply.frame(json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"real","function":{"name":"read","arguments":"{"}}]}}]}),&tools).unwrap();
        assert_eq!(
            frame["choices"][0]["delta"]["tool_calls"][0]["function"]["name"],
            "Read"
        );
        let frame=reply.frame(json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"stub","function":{"name":"shell","arguments":"{}"}},{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}),&tools).unwrap();
        assert_eq!(
            frame["choices"][0]["delta"]["tool_calls"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            reply.buffered(&json!("model"), &tools)["choices"][0]["message"]["tool_calls"][0]
                ["function"]["arguments"],
            "{}"
        );
        assert_eq!(
            reply.buffered(&json!("model"), &tools)["choices"][0]["message"]["tool_calls"][0]
                ["function"]["name"],
            "Read"
        );
    }
    #[test]
    fn stub_only_answer_stops_with_the_upstream_note() {
        let tools = Tools {
            stubs: std::collections::HashSet::from(["shell".into()]),
            ..Default::default()
        };
        let mut reply = Reply::default();
        let frame=reply.frame(json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"shell","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}),&tools).unwrap();
        assert_eq!(frame["choices"][0]["finish_reason"], "stop");
        assert_eq!(frame["choices"][0]["delta"]["content"], STUB_NOTE);
    }
}
