//! Explicit, conservative Responses -> Anthropic Messages bridge.
//! No SDK authentication or account credentials are inferred here.
use std::collections::{BTreeMap, HashMap};
use anyhow::{bail, ensure, Result};
use serde_json::{json, Value};
use uuid::Uuid;
use base64::Engine;
use super::chat_compat::{chat_tools, response_tool_types, write_sse};
const THINKING_PREFIX: &str = "nautilo-anthropic-v1:";

pub(super) fn endpoint(base: &str) -> Result<String> {
    let mut url = reqwest::Url::parse(base)?;
    ensure!(url.username().is_empty() && url.password().is_none() && url.query().is_none() && url.fragment().is_none(), "Endpoint must not contain credentials, query or fragment");
    ensure!(url.scheme() == "https" || (url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "[::1]"))), "Anthropic bridge requires HTTPS (except loopback)");
    let path = url.path().trim_end_matches('/');
    let path = if path.ends_with("/messages") { path.to_string() } else if path.is_empty() { "/v1/messages".into() } else { format!("{path}/messages") };
    url.set_path(&path);
    Ok(url.to_string())
}

fn text_blocks(value: &Value) -> Result<Vec<Value>> {
    if let Some(text) = value.as_str() { return Ok(vec![json!({"type":"text","text":text})]); }
    let parts = value.as_array().ok_or_else(|| anyhow::anyhow!("Expected text content"))?;
    parts.iter().map(|part| {
        ensure!(matches!(part["type"].as_str(), Some("text" | "input_text" | "output_text")), "Anthropic bridge currently supports text content only");
        let text = part["text"].as_str().ok_or_else(|| anyhow::anyhow!("Missing content text"))?;
        Ok(json!({"type":"text","text":text}))
    }).collect()
}
fn push_message(messages: &mut Vec<Value>, role: &str, content: Vec<Value>) {
    if let Some(last) = messages.last_mut().filter(|m| m["role"] == role) {
        last["content"].as_array_mut().unwrap().extend(content);
    } else { messages.push(json!({"role":role,"content":content})); }
}
fn validate_tools(tools: &Value) -> Result<()> {
    if tools.is_null() { return Ok(()); }
    for tool in tools.as_array().ok_or_else(|| anyhow::anyhow!("Invalid tools"))? {
        match tool["type"].as_str() {
            Some("function" | "custom") => {},
            Some("namespace") => validate_tools(&tool["tools"])?,
            _ => bail!("Anthropic bridge does not support hosted tools (web search, computer, image generation or file search)"),
        }
    }
    Ok(())
}

pub(super) fn request(input: &Value) -> Result<Value> {
    ensure!(input.is_object(), "Expected a Responses request object");
    ensure!(input.get("previous_response_id").is_none_or(Value::is_null), "Send complete history; previous_response_id is unsupported");
    ensure!(input.get("stream").is_none_or(|v| v == true), "Anthropic bridge requires stream=true");
    ensure!(input.get("background").is_none_or(|v| v != true), "Background responses are unsupported");
    ensure!(input.pointer("/text/format/type").and_then(Value::as_str).is_none_or(|v| v == "text"), "Structured response formats are unsupported by the Anthropic bridge");
    validate_tools(&input["tools"])?;
    let tools = chat_tools(input.get("tools"));
    let mut names = std::collections::HashSet::new();
    for t in &tools {
        let name = t["function"]["name"].as_str().unwrap_or("");
        ensure!(!name.is_empty() && name.len() <= 64 && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') && names.insert(name.to_string()), "Invalid or colliding converted tool names");
    }
    let mut messages = vec![];
    let mut system = vec![];
    if let Some(text) = input["instructions"].as_str().filter(|s| !s.is_empty()) { system.push(json!({"type":"text","text":text})); }
    if let Some(text) = input["input"].as_str() { push_message(&mut messages, "user", text_blocks(&json!(text))?); }
    else {
        for item in input["input"].as_array().ok_or_else(|| anyhow::anyhow!("Expected input history"))? {
            match item["type"].as_str().unwrap_or("message") {
                "message" => {
                    let role = item["role"].as_str().unwrap_or("user");
                    let content = text_blocks(&item["content"])?;
                    match role {
                        "system" | "developer" => system.extend(content),
                        "user" | "assistant" => push_message(&mut messages, role, content),
                        _ => bail!("Unsupported message role"),
                    }
                }
                "function_call" | "custom_tool_call" => {
                    let name = item["name"].as_str().ok_or_else(|| anyhow::anyhow!("Missing tool name"))?;
                    let name = if let Some(ns) = item["namespace"].as_str().filter(|s| !s.is_empty()) { format!("{ns}-{name}") } else { name.into() };
                    let args: Value = if item["type"] == "custom_tool_call" { json!({"input":item["input"].as_str().ok_or_else(|| anyhow::anyhow!("Invalid custom tool input"))?}) } else { serde_json::from_str(item["arguments"].as_str().unwrap_or("{}"))? };
                    ensure!(args.is_object(), "Tool arguments must be an object");
                    let id = item["call_id"].as_str().ok_or_else(|| anyhow::anyhow!("Missing tool call ID"))?;
                    push_message(&mut messages, "assistant", vec![json!({"type":"tool_use","id":id,"name":name,"input":args})]);
                }
                "function_call_output" | "custom_tool_call_output" => {
                    let id = item["call_id"].as_str().ok_or_else(|| anyhow::anyhow!("Missing tool result ID"))?;
                    let content = text_blocks(&item["output"])?;
                    push_message(&mut messages, "user", vec![json!({"type":"tool_result","tool_use_id":id,"content":content})]);
                }
                "reasoning" => {
                    let encoded = item["encrypted_content"].as_str().and_then(|v|v.strip_prefix(THINKING_PREFIX)).ok_or_else(||anyhow::anyhow!("Foreign reasoning history cannot be replayed to Anthropic"))?;
                    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)?;
                    let block: Value = serde_json::from_slice(&bytes)?;
                    ensure!(matches!(block["type"].as_str(),Some("thinking"|"redacted_thinking")), "Invalid Anthropic reasoning history");
                    push_message(&mut messages, "assistant", vec![block]);
                }
                _ => bail!("Unsupported Responses history item; start a new text-only session"),
            }
        }
    }
    ensure!(!messages.is_empty(), "Message history is empty");
    let model = input["model"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| anyhow::anyhow!("Missing model"))?;
    let max = input.get("max_output_tokens").map(|v| v.as_u64().filter(|v| *v > 0).ok_or_else(|| anyhow::anyhow!("Invalid max_output_tokens"))).transpose()?.unwrap_or(4096);
    let mut output = json!({"model":model,"messages":messages,"max_tokens":max,"stream":true});
    if let Some(effort) = input.pointer("/reasoning/effort").and_then(Value::as_str).filter(|v|!v.is_empty() && *v!="none") {
        output["output_config"] = json!({"effort":effort});
    }
    if !system.is_empty() { output["system"] = json!(system); }
    if !tools.is_empty() {
        output["tools"] = Value::Array(tools.iter().map(|t| { let f = &t["function"]; json!({"name":f["name"],"description":f["description"].as_str().unwrap_or(""),"input_schema":f["parameters"]}) }).collect());
        let choice = match input.get("tool_choice") {
            None | Some(Value::Null) => json!({"type":"auto"}),
            Some(Value::String(s)) if s == "auto" => json!({"type":"auto"}),
            Some(Value::String(s)) if s == "required" => json!({"type":"any"}),
            Some(Value::String(s)) if s == "none" => json!({"type":"none"}),
            Some(v) if v["type"] == "function" || v["type"] == "custom" => {
                let name = v["name"].as_str().unwrap_or("");
                ensure!(names.contains(name), "Unknown forced tool name");
                json!({"type":"tool","name":name})
            },
            _ => bail!("Unsupported tool_choice"),
        };
        output["tool_choice"] = choice;
        if input["parallel_tool_calls"] == false && output["tool_choice"]["type"] != "none" { output["tool_choice"]["disable_parallel_tool_use"] = json!(true); }
    }
    for key in ["temperature", "top_p"] { if let Some(v) = input.get(key).filter(|v| v.is_number()) { output[key] = v.clone(); } }
    ensure!(output.get("temperature").is_none() || output.get("top_p").is_none(), "Use temperature or top_p, not both");
    Ok(output)
}

struct Block { item: Value, arguments: String, stopped: bool, output_index: usize, native: Option<Value> }
struct Translator {
    response_id: String, created_at: u64, model: Value, blocks: BTreeMap<u64, Block>,
    tool_types: HashMap<String, (String, String, String)>, input_tokens: u64, output_tokens: u64,
    cached_tokens: u64, stop: Option<String>, started: bool, finished: bool, sequence: u64,
}
impl Translator {
    fn new(request: &Value) -> Self { Self { response_id: format!("resp_{}", Uuid::new_v4()), created_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(), model: request["model"].clone(), blocks: BTreeMap::new(), tool_types: response_tool_types(request.get("tools")), input_tokens: 0, output_tokens: 0, cached_tokens: 0, stop: None, started: false, finished: false, sequence: 0 } }
    fn response(&self, status: &str) -> Value {
        json!({"id":self.response_id,"object":"response","created_at":self.created_at,"status":status,"model":self.model,"output":self.blocks.values().map(|b| b.item.clone()).collect::<Vec<_>>(),"error":null,"incomplete_details": if status == "incomplete" {json!({"reason":"max_output_tokens"})} else {Value::Null},"usage":{"input_tokens":self.input_tokens,"output_tokens":self.output_tokens,"total_tokens":self.input_tokens+self.output_tokens,"input_tokens_details":{"cached_tokens":self.cached_tokens}}})
    }
    fn event(&mut self, value: Value) -> Value { let mut value = value; value["sequence_number"] = json!(self.sequence); self.sequence += 1; value }
    fn consume(&mut self, value: Value) -> Result<Vec<Value>> {
        ensure!(!self.finished, "Events after message_stop");
        let mut events = vec![];
        match value["type"].as_str().unwrap_or("") {
            "ping" => {},
            "error" => bail!("Anthropic upstream stream reported an error"),
            "message_start" => {
                ensure!(!self.started, "Duplicate message_start"); self.started = true;
                let usage = &value["message"]["usage"];
                self.cached_tokens = usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
                self.input_tokens = usage["input_tokens"].as_u64().unwrap_or(0) + self.cached_tokens + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                self.output_tokens = usage["output_tokens"].as_u64().unwrap_or(0);
                events.push(json!({"type":"response.created","response":self.response("in_progress")}));
            }
            "content_block_start" => {
                ensure!(self.started, "Content before message_start");
                let index = value["index"].as_u64().ok_or_else(|| anyhow::anyhow!("Missing block index"))?;
                ensure!(index == self.blocks.len() as u64 && index < 1024, "Invalid content block index or too many blocks");
                let block = &value["content_block"];
                ensure!(block["input"].is_null() || block["input"].as_object().is_some_and(|v| v.is_empty()), "Non-empty initial streaming tool input is unsupported");
                let id = format!("item_{}", Uuid::new_v4());
                let output_index = self.blocks.len();
                let mut item = match block["type"].as_str() {
                    Some("text") => json!({"id":id,"type":"message","role":"assistant","status":"in_progress","content":[]}),
                    Some("thinking" | "redacted_thinking") => json!({"id":id,"type":"reasoning","status":"in_progress","summary":if block["type"]=="thinking" {json!([{"type":"summary_text","text":block["thinking"].as_str().unwrap_or("")}])} else {json!([])}}),
                    Some("tool_use") => {
                        let name = block["name"].as_str().unwrap_or("");
                        let (ns, name, kind) = self.tool_types.get(name).ok_or_else(|| anyhow::anyhow!("Upstream called an unknown tool"))?;
                        let call_id = block["id"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| anyhow::anyhow!("Missing upstream tool ID"))?;
                        let mut item = json!({"id":id,"type":if kind == "custom" {"custom_tool_call"} else {"function_call"},"status":"in_progress","name":name,"call_id":call_id});
                        if !ns.is_empty() { item["namespace"] = json!(ns); }
                        item[if kind == "custom" {"input"} else {"arguments"}] = json!(""); item
                    },
                    _ => bail!("Unsupported Anthropic server content block"),
                };
                events.push(json!({"type":"response.output_item.added","output_index":output_index,"item":item}));
                if item["type"] == "message" {
                    ensure!(block["text"].as_str().unwrap_or("").is_empty(), "Non-empty initial streaming text is unsupported");
                    item["content"] = json!([{"type":"output_text","text":"","annotations":[]}]);
                    events.push(json!({"type":"response.content_part.added","output_index":output_index,"item_id":id,"content_index":0,"part":item["content"][0]}));
                }
                if item["type"] == "reasoning" && item["summary"].as_array().is_some_and(|a|!a.is_empty()) {
                    events.push(json!({"type":"response.reasoning_summary_part.added","output_index":output_index,"item_id":id,"summary_index":0,"part":item["summary"][0]}));
                }
                let native = (item["type"]=="reasoning").then(||block.clone());
                self.blocks.insert(index, Block { item, arguments: String::new(), stopped: false, output_index, native });
            }
            "content_block_delta" | "content_block_stop" => {
                let index = value["index"].as_u64().ok_or_else(|| anyhow::anyhow!("Missing block index"))?;
                let b = self.blocks.get_mut(&index).ok_or_else(|| anyhow::anyhow!("Unknown content block"))?;
                ensure!(!b.stopped, "Content after block stop");
                let id = b.item["id"].clone(); let oi = b.output_index;
                if value["type"] == "content_block_stop" {
                    b.stopped = true; b.item["status"] = json!("completed");
                    if b.item["type"] == "message" {
                        events.push(json!({"type":"response.output_text.done","output_index":oi,"item_id":id,"content_index":0,"text":b.item["content"][0]["text"]}));
                        events.push(json!({"type":"response.content_part.done","output_index":oi,"item_id":id,"content_index":0,"part":b.item["content"][0]}));
                    } else if let Some(native) = &b.native {
                        b.item["encrypted_content"] = json!(format!("{THINKING_PREFIX}{}",base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(native)?)));
                        if b.item["summary"].as_array().is_some_and(|a|!a.is_empty()) {
                            events.push(json!({"type":"response.reasoning_summary_text.done","output_index":oi,"item_id":id,"summary_index":0,"text":b.item["summary"][0]["text"]}));
                            events.push(json!({"type":"response.reasoning_summary_part.done","output_index":oi,"item_id":id,"summary_index":0,"part":b.item["summary"][0]}));
                        }
                    } else {
                        let args: Value = serde_json::from_str(if b.arguments.is_empty() {"{}"} else {&b.arguments})?;
                        ensure!(args.is_object(), "Tool arguments are not an object");
                        if b.item["type"] == "custom_tool_call" {
                            let input = args["input"].as_str().ok_or_else(|| anyhow::anyhow!("Custom tool input missing"))?;
                            b.item["input"] = json!(input);
                            events.push(json!({"type":"response.custom_tool_call_input.delta","output_index":oi,"item_id":id,"delta":input}));
                            events.push(json!({"type":"response.custom_tool_call_input.done","output_index":oi,"item_id":id,"input":input}));
                        } else {
                            b.item["arguments"] = json!(args.to_string());
                            events.push(json!({"type":"response.function_call_arguments.done","output_index":oi,"item_id":id,"arguments":b.item["arguments"]}));
                        }
                    }
                    events.push(json!({"type":"response.output_item.done","output_index":oi,"item":b.item}));
                } else {
                    let delta = &value["delta"];
                    match delta["type"].as_str() {
                        Some("text_delta") if b.item["type"] == "message" => {
                            let text = delta["text"].as_str().ok_or_else(|| anyhow::anyhow!("Missing text delta"))?;
                            let all = format!("{}{text}", b.item["content"][0]["text"].as_str().unwrap_or(""));
                            ensure!(all.len() <= 20 * 1024 * 1024, "Output too large");
                            b.item["content"][0]["text"] = json!(all);
                            events.push(json!({"type":"response.output_text.delta","output_index":oi,"item_id":id,"content_index":0,"delta":text}));
                        },
                        Some("thinking_delta") if b.native.as_ref().is_some_and(|n|n["type"]=="thinking") => {
                            let text = delta["thinking"].as_str().ok_or_else(||anyhow::anyhow!("Invalid thinking delta"))?;
                            let native = b.native.as_mut().unwrap();
                            native["thinking"] = json!(format!("{}{text}",native["thinking"].as_str().unwrap_or("")));
                            b.item["summary"][0]["text"] = native["thinking"].clone();
                            events.push(json!({"type":"response.reasoning_summary_text.delta","output_index":oi,"item_id":id,"summary_index":0,"delta":text}));
                        },
                        Some("signature_delta") if b.native.as_ref().is_some_and(|n|n["type"]=="thinking") => {
                            let signature = delta["signature"].as_str().ok_or_else(||anyhow::anyhow!("Invalid thinking signature"))?;
                            let native = b.native.as_mut().unwrap();
                            native["signature"] = json!(format!("{}{signature}",native["signature"].as_str().unwrap_or("")));
                        },
                        Some("input_json_delta") if matches!(b.item["type"].as_str(),Some("function_call"|"custom_tool_call")) => {
                            let text = delta["partial_json"].as_str().ok_or_else(|| anyhow::anyhow!("Missing JSON delta"))?;
                            b.arguments.push_str(text); ensure!(b.arguments.len() <= 20 * 1024 * 1024, "Tool input too large");
                            if b.item["type"] == "function_call" { events.push(json!({"type":"response.function_call_arguments.delta","output_index":oi,"item_id":id,"delta":text})); }
                        },
                        _ => bail!("Unsupported content delta"),
                    }
                }
            }
            "message_delta" => {
                self.stop = value["delta"]["stop_reason"].as_str().map(str::to_string);
                if let Some(n) = value["usage"]["output_tokens"].as_u64() { self.output_tokens = n; }
            }
            "message_stop" => {
                ensure!(self.started && !self.blocks.is_empty() && self.blocks.values().all(|b| b.stopped), "Incomplete upstream stream");
                ensure!(self.blocks.values().any(|b| b.item["type"] != "message" || b.item["content"][0]["text"].as_str().is_some_and(|s| !s.is_empty())), "Empty upstream response");
                let status = match self.stop.as_deref() { Some("end_turn" | "tool_use" | "stop_sequence") => "completed", Some("max_tokens") => "incomplete", _ => bail!("Unsupported upstream stop reason") };
                self.finished = true;
                events.push(json!({"type":format!("response.{status}"),"response":self.response(status)}));
            }
            _ => bail!("Unknown upstream stream event"),
        }
        Ok(events.into_iter().map(|v| self.event(v)).collect())
    }
}

/// Byte-oriented SSE framing avoids corrupting split UTF-8 and supports multiline data.
#[derive(Default)]
pub(crate) struct SseDecoder { pending: Vec<u8>, data: String }
impl SseDecoder {
    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        self.pending.extend_from_slice(bytes);
        ensure!(self.pending.len() + self.data.len() <= 20 * 1024 * 1024, "SSE event exceeds limit");
        let mut events = vec![];
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            let line = std::str::from_utf8(&line)?.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !self.data.is_empty() { events.push(std::mem::take(&mut self.data)); }
            } else if let Some(data) = line.strip_prefix("data:") {
                if !self.data.is_empty() { self.data.push('\n'); }
                self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
            }
        }
        Ok(events)
    }
}

pub(super) async fn stream(mut remote: reqwest::Response, writer: &mut tokio::net::tcp::OwnedWriteHalf, input: &Value) -> Result<()> {
    let mut state = Translator::new(input);
    let result: Result<()> = async {
        ensure!(remote.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("text/event-stream")), "Expected Anthropic event stream");
        let mut decoder = SseDecoder::default();
        let mut total = 0usize;
        while let Some(chunk) = remote.chunk().await? {
            total += chunk.len();
            ensure!(total <= 20 * 1024 * 1024, "Upstream response exceeds size limit");
            for data in decoder.feed(&chunk)? {
                for event in state.consume(serde_json::from_str(&data)?)? {
                    write_sse(writer, event["type"].as_str().unwrap(), &event).await?;
                }
                if state.finished { return Ok(()); }
            }
        }
        bail!("Anthropic stream ended before message_stop")
    }.await;
    if result.is_err() {
        let mut response = state.response("failed");
        response["error"] = json!({"code":"upstream_protocol_error","message":"Anthropic stream failed or used an unsupported feature"});
        let event = state.event(json!({"type":"response.failed","response":response}));
        write_sse(writer, "response.failed", &event).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn sse_keeps_split_unicode_and_multiline_data() {
        let bytes = "event: content_block_delta\r\ndata: {\r\ndata: \"text\":\"你好\"}\r\n\r\n".as_bytes();
        let mut decoder = SseDecoder::default();
        let mut events = vec![];
        for byte in bytes { events.extend(decoder.feed(&[*byte]).unwrap()); }
        assert_eq!(events.len(), 1);
        assert_eq!(serde_json::from_str::<Value>(&events[0]).unwrap()["text"], "你好");
    }
    #[test] fn maps_text_and_tool_roundtrip() {
        let r = request(&json!({"model":"claude-test","instructions":"system","tools":[{"type":"function","name":"read","parameters":{"type":"object"}}],"input":[{"role":"user","content":[{"type":"input_text","text":"你好"}]},{"type":"function_call","call_id":"call_1","name":"read","arguments":"{\"path\":\"x\"}"},{"type":"function_call_output","call_id":"call_1","output":"done"}]})).unwrap();
        assert_eq!(r["messages"][1]["content"][0]["input"]["path"], "x");
        assert_eq!(r["messages"][2]["content"][0]["tool_use_id"], "call_1");
        assert_eq!(r["max_tokens"], 4096);
    }
    #[test] fn rejects_lossy_features() {
        for extra in [json!({"previous_response_id":"r"}), json!({"tools":[{"type":"web_search"}]}), json!({"input":[{"type":"reasoning","summary":[]}]}), json!({"input":[{"role":"user","content":[{"type":"input_image","image_url":"secret"}]}]})] {
            let mut i = json!({"model":"m","input":"hi"}); i.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone()); assert!(request(&i).is_err());
        }
    }
    #[test] fn configured_effort_is_forwarded_without_enabling_unsigned_thinking() {
        let r = request(&json!({"model":"custom","input":"hello","reasoning":{"effort":"max"}})).unwrap();
        assert_eq!(r["output_config"]["effort"], "max");
        assert!(r.get("thinking").is_none());
    }
    #[test] fn signed_thinking_stream_roundtrips_without_changing_the_signature() {
        let mut state = Translator::new(&json!({"model":"custom"}));
        for event in [
            json!({"type":"message_start","message":{"usage":{}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Read the file first."}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque-provider-signature"}}),
            json!({"type":"content_block_stop","index":0}),
        ] { state.consume(event).unwrap(); }
        let item = state.blocks.get(&0).unwrap().item.clone();
        assert_eq!(item["summary"][0]["text"], "Read the file first.");
        let replay = request(&json!({"model":"custom","input":[{"role":"user","content":"hello"},item,{"role":"assistant","content":"done"},{"role":"user","content":"continue"}]})).unwrap();
        assert_eq!(replay["messages"][1]["content"][0], json!({"type":"thinking","thinking":"Read the file first.","signature":"opaque-provider-signature"}));
    }
    #[test] fn endpoint_security_and_paths() {
        assert_eq!(endpoint("https://example.com").unwrap(), "https://example.com/v1/messages");
        assert_eq!(endpoint("https://example.com/v1/messages/").unwrap(), "https://example.com/v1/messages");
        assert!(endpoint("http://example.com").is_err()); assert!(endpoint("https://key@example.com").is_err()); assert!(endpoint("https://example.com?key=s").is_err());
    }
    #[test] fn mixed_blocks_keep_stable_output_indices_and_usage() {
        let mut t = Translator::new(&json!({"model":"m","tools":[{"type":"function","name":"read"}]}));
        let fixtures = vec![json!({"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":3}}}),json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}),json!({"type":"content_block_stop","index":0}),json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"read","input":{}}}),json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"x\":1}"}}),json!({"type":"content_block_stop","index":1}),json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}),json!({"type":"message_stop"})];
        let events: Vec<Value> = fixtures.into_iter().flat_map(|f| t.consume(f).unwrap()).collect();
        let done = events.last().unwrap(); assert_eq!(done["type"], "response.completed"); assert_eq!(done["response"]["output"][1]["arguments"], "{\"x\":1}"); assert_eq!(done["response"]["usage"]["input_tokens"],5);
        for e in &events { if e["type"] == "response.output_text.done" { assert_eq!(e["output_index"],0); } }
        assert!(t.consume(json!({"type":"message_stop"})).is_err());
    }
    #[test] fn does_not_complete_truncated_or_error_streams() {
        let mut t = Translator::new(&json!({"model":"m"})); assert!(t.consume(json!({"type":"message_stop"})).is_err()); assert!(t.consume(json!({"type":"error","error":{"message":"secret"}})).is_err());
    }
}
