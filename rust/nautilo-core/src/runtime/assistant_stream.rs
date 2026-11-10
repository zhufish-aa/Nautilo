use crate::adapters::codex::SseDecoder;
use crate::errors::{invalid, CoreResult};
use serde_json::{json, Value};
use std::io::{self, Write};

/// Assemble the provider's final message while forwarding only answer text to the owning desktop.
pub async fn read(
    mut response: reqwest::Response,
    protocol: &str,
    step_id: &str,
) -> CoreResult<Value> {
    let mut decoder = SseDecoder::default();
    let mut state = Stream::default();
    let pipe = std::env::var("NAUTILO_ASSISTANT_STREAM").as_deref() == Ok("1");
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| invalid("model", "助手模型流连接已中断。"))?
    {
        for frame in decoder
            .feed(&chunk)
            .map_err(|_| invalid("model", "助手模型返回了无效的数据流。"))?
        {
            if frame.trim() == "[DONE]" {
                state.complete = true;
                continue;
            }
            let event: Value = serde_json::from_str(&frame)
                .map_err(|_| invalid("model", "助手模型返回了无效的流事件。"))?;
            let text = state.apply(&event, protocol)?;
            if !text.is_empty() {
                state.text.push_str(text);
                if pipe {
                    let packet = json!({"event":"assistant.text","stepId":step_id,"text":text});
                    let mut out = io::stdout().lock();
                    let _ = writeln!(out, "{packet}");
                    let _ = out.flush();
                }
            }
            if state.text.len() + state.arguments.len() > 1024 * 1024 {
                return Err(invalid("model", "助手回复过长。"));
            }
        }
    }
    state.finish(protocol)
}
#[derive(Default)]
struct Stream {
    text: String,
    name: String,
    arguments: String,
    tool_index: Option<u64>,
    usage: Value,
    final_response: Option<Value>,
    complete: bool,
}
impl Stream {
    fn apply<'a>(&mut self, e: &'a Value, protocol: &str) -> CoreResult<&'a str> {
        let kind = e["type"].as_str().unwrap_or("");
        if e["error"].is_object()
            || matches!(kind, "error" | "response.failed" | "response.incomplete")
        {
            return Err(invalid("model", "助手模型未能完成本次流式回复。"));
        }
        match protocol {
            "responses" => match kind {
                "response.output_text.delta" => return Ok(e["delta"].as_str().unwrap_or("")),
                "response.output_item.added"
                    if e["item"]["type"] == "function_call" && self.tool_index.is_none() =>
                {
                    self.tool_index = e["output_index"].as_u64();
                    self.name = e["item"]["name"].as_str().unwrap_or("").to_owned();
                }
                "response.function_call_arguments.delta"
                    if e["output_index"].as_u64() == self.tool_index =>
                {
                    self.arguments.push_str(e["delta"].as_str().unwrap_or(""))
                }
                "response.function_call_arguments.done"
                    if e["output_index"].as_u64() == self.tool_index =>
                {
                    if let Some(args) = e["arguments"].as_str() {
                        self.arguments = args.to_owned();
                    }
                }
                "response.completed" => {
                    self.complete = true;
                    self.final_response = Some(e["response"].clone());
                    self.usage = e["response"]["usage"].clone();
                }
                _ => {}
            },
            "anthropic" => match kind {
                "message_start" => self.usage = e["message"]["usage"].clone(),
                "content_block_start"
                    if e["content_block"]["type"] == "tool_use" && self.tool_index.is_none() =>
                {
                    self.tool_index = e["index"].as_u64();
                    self.name = e["content_block"]["name"].as_str().unwrap_or("").to_owned();
                    if e["content_block"]["input"]
                        .as_object()
                        .is_some_and(|v| !v.is_empty())
                    {
                        self.arguments = e["content_block"]["input"].to_string();
                    }
                }
                "content_block_delta" if e["delta"]["type"] == "text_delta" => {
                    return Ok(e["delta"]["text"].as_str().unwrap_or(""))
                }
                "content_block_delta"
                    if e["index"].as_u64() == self.tool_index
                        && e["delta"]["type"] == "input_json_delta" =>
                {
                    self.arguments
                        .push_str(e["delta"]["partial_json"].as_str().unwrap_or(""))
                }
                "message_delta" => {
                    if e["delta"]["stop_reason"] == "max_tokens" {
                        return Err(invalid("model", "助手回复达到了模型输出上限。"));
                    }
                    if let Some(extra) = e["usage"].as_object() {
                        for (k, v) in extra {
                            self.usage[k] = v.clone();
                        }
                    }
                }
                "message_stop" => self.complete = true,
                _ => {}
            },
            _ => {
                if e["usage"].is_object() {
                    self.usage = e["usage"].clone();
                }
                let choice = &e["choices"][0];
                if matches!(
                    choice["finish_reason"].as_str(),
                    Some("length" | "content_filter")
                ) {
                    return Err(invalid("model", "助手回复被供应商提前结束。"));
                }
                if choice["finish_reason"].is_string() {
                    self.complete = true;
                }
                for call in choice["delta"]["tool_calls"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if call["index"].as_u64().unwrap_or(0) == 0 {
                        self.name
                            .push_str(call["function"]["name"].as_str().unwrap_or(""));
                        self.arguments
                            .push_str(call["function"]["arguments"].as_str().unwrap_or(""));
                    }
                }
                return Ok(choice["delta"]["content"].as_str().unwrap_or(""));
            }
        }
        Ok("")
    }
    fn finish(self, protocol: &str) -> CoreResult<Value> {
        if !self.complete {
            return Err(invalid("model", "助手模型连接已中断，未收到完整回复。"));
        }
        if let Some(full) = self.final_response {
            if full["output"].as_array().is_some_and(|v| !v.is_empty()) {
                return Ok(full);
            }
        }
        let args = if self.name.is_empty() || self.arguments.is_empty() {
            "{}"
        } else {
            self.arguments.as_str()
        };
        let body = match protocol {
            "responses" => {
                json!({"output":if self.name.is_empty(){json!([{"type":"message","content":[{"type":"output_text","text":self.text}]}])}else{json!([{"type":"function_call","name":self.name,"arguments":args}])},"usage":self.usage})
            }
            "anthropic" => {
                let block = if self.name.is_empty() {
                    json!({"type":"text","text":self.text})
                } else {
                    let input: Value = serde_json::from_str(args)
                        .map_err(|_| invalid("model", "助手模型返回的工具参数不完整。"))?;
                    json!({"type":"tool_use","name":self.name,"input":input})
                };
                json!({"content":[block],"usage":self.usage})
            }
            _ => {
                json!({"choices":[{"message":{"content":self.text,"tool_calls":if self.name.is_empty(){json!([])}else{json!([{"function":{"name":self.name,"arguments":args}}])}}}],"usage":self.usage})
            }
        };
        Ok(body)
    }
}
