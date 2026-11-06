//! Claude's native Messages API over a selected Chat/Responses connection.
//! Only this loopback capability receives the CLI's throwaway credential;
//! the configured key is held by the upstream client and never sent to the CLI.
use crate::adapters::AdapterStartRequest;
use crate::errors::{CoreError, CoreResult, ErrorCode};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use base64::Engine;
use super::api_stream::{reasoning_signature, REASONING_SIGNATURE};

pub struct ApiProxy {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}
impl Drop for ApiProxy {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

impl ApiProxy {
    pub fn prepare(request: &mut AdapterStartRequest) -> CoreResult<Option<Self>> {
        let options = &request.instance["providerOptions"];
        if options["runtimeConnectionId"].as_str().is_none() {
            return Ok(None);
        }
        if let Some(model) = request.model.as_ref() {
            let env = request.env.get_or_insert_with(HashMap::new);
            for name in [
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_SMALL_FAST_MODEL",
                "CLAUDE_CODE_SUBAGENT_MODEL",
            ] {
                env.insert(name.into(), model.clone());
            }
        }
        if options["apiType"] == "anthropic-messages" {
            let env=request.env.get_or_insert_with(HashMap::new);
            let base=options["baseUrl"].as_str().unwrap_or("").trim_end_matches('/');
            env.insert("ANTHROPIC_BASE_URL".into(),base.strip_suffix("/v1").unwrap_or(base).to_string());
            env.insert("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),"1".into());
            return Ok(None);
        }
        let base = options["baseUrl"]
            .as_str()
            .unwrap_or("")
            .trim_end_matches('/')
            .to_string();
        let responses = options["apiType"] == "openai-responses";
        let env = request.env.get_or_insert_with(HashMap::new);
        let key = env
            .get("NAUTILO_CONNECTION_API_KEY")
            .cloned()
            .ok_or_else(|| {
                CoreError::reason(
                    ErrorCode::RunStartFailed,
                    "The API connection has no credential",
                )
            })?;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(failed)?;
        listener.set_nonblocking(true).map_err(failed)?;
        let port = listener.local_addr().map_err(failed)?.port();
        let listener = tokio::net::TcpListener::from_std(listener).map_err(failed)?;
        let capability = uuid::Uuid::new_v4().to_string();
        for value in env.values_mut() {
            if value == &key {
                *value = capability.clone();
            }
        }
        env.retain(|name, _| {
            !name.starts_with("ANTHROPIC_") && !name.starts_with("CLAUDE_CODE_OAUTH")
        });
        env.insert(
            "ANTHROPIC_BASE_URL".into(),
            format!("http://127.0.0.1:{port}/{capability}"),
        );
        env.insert("ANTHROPIC_API_KEY".into(), capability.clone());
        env.insert(
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
            "1".into(),
        );
        if let Some(model) = &request.model { env.insert("NAUTILO_BRIDGE_MODEL".into(), model.clone()); }
        if let Some(effort) = &request.reasoning_effort { env.insert("NAUTILO_BRIDGE_EFFORT".into(), effort.clone()); }
        let model = request.model.clone();
        let effort = request.reasoning_effort.clone();
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let tasks = Arc::new(Mutex::new(Vec::<tokio::task::AbortHandle>::new()));
            loop {
                tokio::select! {
                    _=&mut rx=>break,
                    accepted=listener.accept()=>{
                        let Ok((socket,_))=accepted else {break};
                        let base=base.clone(); let key=key.clone(); let capability=capability.clone();
                        let model=model.clone(); let effort=effort.clone();
                        let task=tokio::spawn(async move { let _=serve(socket,&base,&key,&capability,responses,model.as_deref(),effort.as_deref()).await; });
                        let mut tasks=tasks.lock().unwrap(); tasks.retain(|task|!task.is_finished()); tasks.push(task.abort_handle());
                    }
                }
            }
            for task in tasks.lock().unwrap().drain(..) {
                task.abort();
            }
        });
        Ok(Some(Self { shutdown: Some(tx) }))
    }
}
fn failed(error: impl std::fmt::Display) -> CoreError {
    CoreError::reason(ErrorCode::RunStartFailed, error.to_string())
}
fn content_text(value: &Value) -> String {
    value.as_str().map(str::to_string).unwrap_or_else(|| {
        value
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    })
}
pub(super) fn chat_request(input: &Value, model: Option<&str>, effort: Option<&str>) -> Value {
    let mut messages = Vec::new();
    let system = content_text(&input["system"]);
    if !system.is_empty() {
        messages.push(json!({"role":"system","content":system}));
    }
    for message in input["messages"].as_array().into_iter().flatten() {
        let role = message["role"].as_str().unwrap_or("user");
        if message["content"].is_string() {
            messages.push(json!({"role":role,"content":message["content"]}));
            continue;
        }
        let mut parts = Vec::new();
        let mut calls = Vec::new();
        let mut reasoning = String::new();
        let mut preserved = Vec::new();
        let mut results = Vec::new();
        for part in message["content"].as_array().into_iter().flatten() {
            match part["type"].as_str() {
                Some("text")=>parts.push(json!({"type":"text","text":part["text"]})),
                Some("image")=>{
                    let source=&part["source"];
                    let url=if source["type"]=="base64" {format!("data:{};base64,{}",source["media_type"].as_str().unwrap_or("image/png"),source["data"].as_str().unwrap_or(""))} else {source["url"].as_str().unwrap_or("").into()};
                    parts.push(json!({"type":"image_url","image_url":{"url":url}}));
                }
                Some("thinking")=>{
                    reasoning.push_str(part["thinking"].as_str().unwrap_or(""));
                    if let Some(signature)=part["signature"].as_str().and_then(|s|s.strip_prefix(REASONING_SIGNATURE)) {
                        if let Ok(bytes)=base64::engine::general_purpose::STANDARD.decode(signature) {
                            if let Ok(item)=serde_json::from_slice::<Value>(&bytes) {if item["type"]=="reasoning" {preserved.push(item);}}
                        }
                    }
                }
                Some("tool_use")=>calls.push(json!({"id":part["id"],"type":"function","function":{"name":part["name"],"arguments":part["input"].to_string()}})),
                Some("tool_result")=>results.push(json!({"role":"tool","tool_call_id":part["tool_use_id"],"content":content_text(&part["content"])})),
                _=>{}
            }
        }
        if !parts.is_empty() || !calls.is_empty() || !reasoning.is_empty() || !preserved.is_empty() {
            let mut value =
                json!({"role":role,"content":if parts.is_empty(){Value::Null}else{json!(parts)}});
            if !calls.is_empty() {
                value["tool_calls"] = json!(calls);
            }
            if !reasoning.is_empty() {
                value["reasoning_content"] = json!(reasoning);
            }
            if !preserved.is_empty() { value["_nautiloReasoning"]=json!(preserved); }
            messages.push(value);
        }
        messages.extend(results);
    }
    let mut body = json!({"model":model.map(Value::from).unwrap_or_else(||input["model"].clone()),"messages":messages,"stream":input["stream"]==true});
    if let Some(max) = input["max_tokens"].as_u64() {
        body["max_tokens"] = json!(max);
    }
    if let Some(effort) = effort.filter(|e| !e.is_empty()) {
        body["reasoning_effort"] = json!(effort);
    }
    let tools=input["tools"].as_array().into_iter().flatten().map(|tool|json!({"type":"function","function":{"name":tool["name"],"description":tool["description"],"parameters":tool["input_schema"]}})).collect::<Vec<_>>();
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    match input["tool_choice"]["type"].as_str() {
        Some("any") => body["tool_choice"] = json!("required"),
        Some("tool") => {
            body["tool_choice"] =
                json!({"type":"function","function":{"name":input["tool_choice"]["name"]}})
        }
        Some("auto") => body["tool_choice"] = json!("auto"),
        _ => {}
    }
    body
}
fn responses_request(chat: &Value) -> Value {
    let mut input = Vec::new();
    let mut instructions = Vec::new();
    for message in chat["messages"].as_array().into_iter().flatten() {
        if message["role"] == "system" {
            instructions.push(content_text(&message["content"]));
            continue;
        }
        if message["role"] == "tool" {
            input.push(json!({"type":"function_call_output","call_id":message["tool_call_id"],"output":content_text(&message["content"])}));
            continue;
        }
        input.extend(message["_nautiloReasoning"].as_array().into_iter().flatten().cloned());
        if !message["content"].is_null() {
            let content=if let Some(parts)=message["content"].as_array() {
                json!(parts.iter().map(|part|if part["type"]=="image_url" {json!({"type":"input_image","image_url":part["image_url"]["url"]})} else {json!({"type":if message["role"]=="assistant" {"output_text"} else {"input_text"},"text":part["text"]})}).collect::<Vec<_>>())
            } else {message["content"].clone()};
            input.push(json!({"role":message["role"],"content":content}));
        }
        for call in message["tool_calls"].as_array().into_iter().flatten() {
            input.push(json!({"type":"function_call","call_id":call["id"],"name":call["function"]["name"],"arguments":call["function"]["arguments"]}));
        }
    }
    let mut body = json!({"model":chat["model"],"input":input,"instructions":instructions.join("\n"),"stream":chat["stream"],"include":["reasoning.encrypted_content"]});
    if let Some(max) = chat["max_tokens"].as_u64() {
        body["max_output_tokens"] = json!(max);
    }
    if let Some(effort) = chat["reasoning_effort"].as_str() {
        body["reasoning"] = json!({"effort":effort});
        if effort!="none" {body["reasoning"]["summary"]=json!("auto");}
    }
    if let Some(tools) = chat["tools"].as_array() {
        body["tools"]=json!(tools.iter().map(|tool|json!({"type":"function","name":tool["function"]["name"],"description":tool["function"]["description"],"parameters":tool["function"]["parameters"]})).collect::<Vec<_>>());
    }
    body
}
fn native_message(reply: &Value, responses: bool, model: &Value) -> Value {
    let mut content = Vec::new();
    let mut stop = "end_turn";
    let usage = if responses {
        for item in reply["output"].as_array().into_iter().flatten() {
            if item["type"]=="reasoning" {content.push(json!({"type":"thinking","thinking":content_text(&item["summary"]),"signature":reasoning_signature(item)}));}
            if item["type"] == "message" {
                for part in item["content"].as_array().into_iter().flatten() {
                    if let Some(text) = part["text"].as_str() {
                        content.push(json!({"type":"text","text":text}));
                    }
                }
            }
            if item["type"] == "function_call" {
                stop = "tool_use";
                content.push(json!({"type":"tool_use","id":item["call_id"],"name":item["name"],"input":serde_json::from_str::<Value>(item["arguments"].as_str().unwrap_or("{}")).unwrap_or_else(|_|json!({}))}));
            }
        }
        json!({"input_tokens":reply["usage"]["input_tokens"],"output_tokens":reply["usage"]["output_tokens"]})
    } else {
        let message = &reply["choices"][0]["message"];
        if let Some(thinking)=message["reasoning_content"].as_str().or_else(||message["reasoning"].as_str()).filter(|s|!s.is_empty()) {content.push(json!({"type":"thinking","thinking":thinking,"signature":""}));}
        if let Some(text) = message["content"].as_str().filter(|s| !s.is_empty()) {
            content.push(json!({"type":"text","text":text}));
        }
        for call in message["tool_calls"].as_array().into_iter().flatten() {
            stop = "tool_use";
            content.push(json!({"type":"tool_use","id":call["id"],"name":call["function"]["name"],"input":serde_json::from_str::<Value>(call["function"]["arguments"].as_str().unwrap_or("{}")).unwrap_or_else(|_|json!({}))}));
        }
        if reply["choices"][0]["finish_reason"] == "length" {
            stop = "max_tokens";
        }
        let cached = reply["usage"]["prompt_tokens_details"]["cached_tokens"]
            .as_u64()
            .unwrap_or(0);
        json!({"input_tokens":reply["usage"]["prompt_tokens"].as_u64().map(|v|v.saturating_sub(cached)),"output_tokens":reply["usage"]["completion_tokens"],"cache_read_input_tokens":cached,"cache_creation_input_tokens":0})
    };
    json!({"id":reply["id"].as_str().unwrap_or("nautilo-response"),"type":"message","role":"assistant","model":model,"content":content,"stop_reason":stop,"stop_sequence":null,"usage":usage})
}
fn sse(message: &Value) -> String {
    let mut events = Vec::new();
    let mut start = message.clone();
    start["content"] = json!([]);
    start["stop_reason"] = Value::Null;
    events.push(json!({"type":"message_start","message":start}));
    for (index, block) in message["content"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let mut empty = block.clone();
        let delta = if block["type"] == "tool_use" {
            empty["input"] = json!({});
            json!({"type":"input_json_delta","partial_json":block["input"].to_string()})
        } else if block["type"]=="thinking" {
            empty=json!({"type":"thinking","thinking":"","signature":""});
            json!({"type":"thinking_delta","thinking":block["thinking"]})
        } else {
            empty["text"] = json!("");
            json!({"type":"text_delta","text":block["text"]})
        };
        events.push(json!({"type":"content_block_start","index":index,"content_block":empty}));
        events.push(json!({"type":"content_block_delta","index":index,"delta":delta}));
        if block["type"]=="thinking" && block["signature"].as_str().is_some_and(|s|!s.is_empty()) {events.push(json!({"type":"content_block_delta","index":index,"delta":{"type":"signature_delta","signature":block["signature"]}}));}
        events.push(json!({"type":"content_block_stop","index":index}));
    }
    events.push(json!({"type":"message_delta","delta":{"stop_reason":message["stop_reason"],"stop_sequence":null},"usage":message["usage"]}));
    events.push(json!({"type":"message_stop"}));
    events
        .iter()
        .map(|event| {
            format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
        })
        .collect()
}
async fn send(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    kind: &str,
    body: &str,
) -> anyhow::Result<()> {
    socket.write_all(format!("HTTP/1.1 {status} Response\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await?;
    Ok(())
}
async fn serve(
    mut socket: tokio::net::TcpStream,
    base: &str,
    key: &str,
    cap: &str,
    responses: bool,
    model: Option<&str>,
    effort: Option<&str>,
) -> anyhow::Result<()> {
    let mut bytes = Vec::new();
    let mut byte = [0u8; 1];
    while !bytes.ends_with(b"\r\n\r\n") {
        if bytes.len() > 32768 {
            return Ok(());
        }
        if socket.read(&mut byte).await? == 0 {
            return Ok(());
        }
        bytes.push(byte[0]);
    }
    let headers = String::from_utf8(bytes)?;
    let path = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");
    if !path.starts_with(&format!("/{cap}/")) {
        return send(&mut socket, 404, "application/json", "{}").await;
    }
    let length = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|v| v.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    if length > 16 * 1024 * 1024 {
        return send(&mut socket, 413, "application/json", "{}").await;
    }
    let mut body = vec![0; length];
    socket.read_exact(&mut body).await?;
    let input: Value = serde_json::from_slice(&body)?;
    if path.ends_with("/count_tokens") {
        return send(
            &mut socket,
            200,
            "application/json",
            &json!({"input_tokens":(body.len()/4).max(1)}).to_string(),
        )
        .await;
    }
    if !path.ends_with("/messages") {
        return send(&mut socket, 404, "application/json", "{}").await;
    }
    let chat = chat_request(&input, model, effort);
    let mut upstream = if responses {
        responses_request(&chat)
    } else {
        chat.clone()
    };
    if !responses {for message in upstream["messages"].as_array_mut().into_iter().flatten() {if let Some(object)=message.as_object_mut() {object.remove("_nautiloReasoning");}}}
    let suffix = if responses {
        "/responses"
    } else {
        "/chat/completions"
    };
    let endpoint = if base.ends_with(suffix) {
        base.to_string()
    } else {
        format!("{base}{suffix}")
    };
    let response = reqwest::Client::new()
        .post(endpoint)
        .bearer_auth(key)
        .json(&upstream)
        .timeout(std::time::Duration::from_secs(900))
        .send()
        .await;
    let response=match response {Ok(response)=>response,Err(_)=>return send(&mut socket,502,"application/json",&json!({"type":"error","error":{"type":"api_error","message":"Unable to reach the selected API endpoint"}}).to_string()).await};
    if response.status().is_success() && input["stream"]==true && response.headers().get("content-type").and_then(|v|v.to_str().ok()).is_some_and(|v|v.contains("text/event-stream")) {
        let (mut reader,mut writer)=socket.into_split(); let mut disconnect=[0u8;1];
        tokio::select! {
            result=super::api_stream::stream_response(&mut writer,response,responses,chat["model"].as_str().unwrap_or("model"),key)=>return result,
            _=reader.read(&mut disconnect)=>return Ok(()),
        }
    }
    let reply=match Ok::<_,reqwest::Error>(response){
        Ok(response)=>{let status=response.status();let text=response.text().await?;if !status.is_success(){return send(&mut socket,status.as_u16(),"application/json",&json!({"type":"error","error":{"type":"api_error","message":text.replace(key,"[redacted]")}}).to_string()).await} serde_json::from_str::<Value>(&text)?},
        Err(_)=>return send(&mut socket,502,"application/json",&json!({"type":"error","error":{"type":"api_error","message":"Unable to reach the selected API endpoint"}}).to_string()).await,
    };
    let message = native_message(&reply, responses, &chat["model"]);
    if input["stream"] == true {
        send(&mut socket, 200, "text/event-stream", &sse(&message)).await
    } else {
        send(&mut socket, 200, "application/json", &message.to_string()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn messages_tools_and_selected_effort_round_trip() {
        let chat = chat_request(
            &json!({"model":"unconfigured","system":"system","max_tokens":512,"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call","name":"read","input":{"path":"a"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call","content":"text"}]}],"tools":[{"name":"read","input_schema":{"type":"object"}}]}),
            Some("configured"),
            Some("max"),
        );
        assert_eq!(chat["model"], "configured");
        assert_eq!(chat["reasoning_effort"], "max");
        assert_eq!(chat["messages"][2]["tool_call_id"], "call");
        let message = native_message(
            &json!({"choices":[{"message":{"content":"Hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":5}}}),
            false,
            &chat["model"],
        );
        assert_eq!(message["content"][0]["text"], "Hello");
        assert_eq!(message["usage"]["input_tokens"], 15);
        assert!(sse(&message).contains("message_stop"));
    }

    #[tokio::test]
    async fn both_wires_forward_selected_max_and_stream_before_upstream_finishes() {
        use std::sync::atomic::{AtomicBool,Ordering};
        for responses in [false,true] {
            let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base=format!("http://{}/v1",listener.local_addr().unwrap());
            let (release,gate)=tokio::sync::oneshot::channel();
            let finished=Arc::new(AtomicBool::new(false)); let upstream_finished=finished.clone();
            let upstream=tokio::spawn(async move {
                let (mut socket,_)=listener.accept().await.unwrap(); let mut headers=Vec::new(); let mut byte=[0u8;1];
                while !headers.ends_with(b"\r\n\r\n") {socket.read_exact(&mut byte).await.unwrap();headers.push(byte[0]);}
                let headers=String::from_utf8(headers).unwrap();
                let size=headers.lines().find_map(|line|line.to_lowercase().strip_prefix("content-length:").and_then(|s|s.trim().parse::<usize>().ok())).unwrap();
                let mut bytes=vec![0;size];socket.read_exact(&mut bytes).await.unwrap();let body:Value=serde_json::from_slice(&bytes).unwrap();
                assert_eq!(body["stream"],true);assert_eq!(if responses {&body["reasoning"]["effort"]} else {&body["reasoning_effort"]},"max");
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                let prefix=if responses {vec![
                    json!({"type":"response.reasoning_summary_text.delta","item_id":"reason","delta":"思考中"}),
                    json!({"type":"response.output_text.delta","item_id":"answer","delta":"Hello"}),
                ]} else {vec![json!({"choices":[{"delta":{"reasoning_content":"思考中","content":"Hello"}}]})]};
                for value in prefix {socket.write_all(format!("data: {value}\r\n\r\n").as_bytes()).await.unwrap();}
                socket.flush().await.unwrap();let _=gate.await;upstream_finished.store(true,Ordering::SeqCst);
                let tail=if responses {json!({"type":"response.completed","response":{"status":"completed","output":[
                    {"id":"reason","type":"reasoning","summary":[{"type":"summary_text","text":"思考中"}],"encrypted_content":"opaque"},
                    {"id":"answer","type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello world"}]}],
                    "usage":{"input_tokens":20,"output_tokens":9,"input_tokens_details":{"cached_tokens":4}}}})}
                    else {json!({"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":9,"prompt_tokens_details":{"cached_tokens":4}}})};
                socket.write_all(format!("data: {tail}\n\n").as_bytes()).await.unwrap();
            });
            let mut request=AdapterStartRequest {instance:json!({"providerOptions":{"runtimeConnectionId":"api","baseUrl":base,"apiType":if responses {"openai-responses"} else {"openai-completions"}}}),
                model:Some("selected".into()),reasoning_effort:Some("max".into()),env:Some(HashMap::from([("NAUTILO_CONNECTION_API_KEY".into(),"key".into())])),..Default::default()};
            let proxy=ApiProxy::prepare(&mut request).unwrap().unwrap();
            let endpoint=format!("{}/v1/messages",request.env.as_ref().unwrap()["ANTHROPIC_BASE_URL"]);
            let mut response=reqwest::Client::new().post(endpoint).json(&json!({"stream":true,"output_config":{"effort":"low"},"messages":[{"role":"user","content":"Hi"}]})).send().await.unwrap();
            let mut first=Vec::new();
            tokio::time::timeout(std::time::Duration::from_secs(2),async {
                while !String::from_utf8_lossy(&first).contains("Hello") {first.extend_from_slice(&response.chunk().await.unwrap().unwrap());}
            }).await.unwrap();
            assert!(!finished.load(Ordering::SeqCst));
            assert!(String::from_utf8_lossy(&first).contains("thinking_delta"));
            release.send(()).unwrap();let tail=response.text().await.unwrap();
            assert!(tail.contains("message_stop"));assert!(tail.contains("world"));assert!(tail.contains("\"input_tokens\":16"));
            drop(proxy);upstream.await.unwrap();
        }
    }
}
