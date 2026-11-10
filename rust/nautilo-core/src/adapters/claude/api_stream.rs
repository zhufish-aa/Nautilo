//! Incremental Chat/Responses SSE to native Messages events.
use std::collections::HashMap;
use base64::Engine;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

pub(super) const REASONING_SIGNATURE: &str = "nautilo-responses-v1:";
pub(super) fn reasoning_signature(item: &Value) -> String {
    format!("{REASONING_SIGNATURE}{}", base64::engine::general_purpose::STANDARD.encode(item.to_string()))
}
struct Block { index: usize, value: String, signature: bool }
#[derive(Default)]
struct Call { id: String, name: String, arguments: String, sent: String }
pub(super) struct NativeMessageStream {
    responses: bool, model: String, started: bool, terminal: bool, stop: String, usage: Value,
    blocks: HashMap<String, Block>, calls: HashMap<String, Call>, output_ids: HashMap<u64, String>, frames: Vec<Value>,
}
impl NativeMessageStream {
    pub(super) fn new(responses: bool, model: &str) -> Self {
        Self { responses, model:model.into(), started:false, terminal:false, stop:"end_turn".into(), usage:json!({"input_tokens":0,"output_tokens":0}), blocks:HashMap::new(), calls:HashMap::new(), output_ids:HashMap::new(), frames:vec![] }
    }
    fn begin(&mut self) {
        if self.started { return }
        self.started=true;
        self.frames.push(json!({"type":"message_start","message":{"id":format!("msg_{}",uuid::Uuid::new_v4()),"type":"message","role":"assistant","model":self.model,"content":[],"stop_reason":null,"stop_sequence":null,"usage":self.usage}}));
    }
    fn block(&mut self, key: &str, kind: &str, extra: Value) -> usize {
        self.begin();
        if let Some(block)=self.blocks.get(key) { return block.index }
        let index=self.blocks.len();
        let content=match kind {
            "tool_use"=>json!({"type":"tool_use","id":extra["id"],"name":extra["name"],"input":{}}),
            "thinking"=>json!({"type":"thinking","thinking":"","signature":""}),
            _=>json!({"type":"text","text":""}),
        };
        self.blocks.insert(key.into(),Block{index,value:String::new(),signature:false});
        self.frames.push(json!({"type":"content_block_start","index":index,"content_block":content}));
        index
    }
    fn delta(&mut self, key: &str, kind: &str, value: &str) {
        if value.is_empty() { return }
        let index=self.block(key,kind,Value::Null);
        self.blocks.get_mut(key).unwrap().value.push_str(value);
        let delta=if kind=="thinking" {json!({"type":"thinking_delta","thinking":value})} else {json!({"type":"text_delta","text":value})};
        self.frames.push(json!({"type":"content_block_delta","index":index,"delta":delta}));
    }
    fn full(&mut self, key: &str, kind: &str, value: &str) {
        let sent=self.blocks.get(key).map(|b|b.value.len()).unwrap_or(0);
        if value.is_char_boundary(sent) && self.blocks.get(key).is_none_or(|b|value.starts_with(&b.value)) { self.delta(key,kind,&value[sent..]); }
    }
    fn tool(&mut self, key: &str, id: Option<&str>, name: Option<&str>, arguments: &str, full: bool) -> anyhow::Result<()> {
        let (id,name,delta)={
            let call=self.calls.entry(key.into()).or_default();
            if let Some(id)=id.filter(|s|!s.is_empty()) {call.id=id.into()}
            if let Some(name)=name.filter(|s|!s.is_empty()) { if full {call.name=name.into()} else {call.name.push_str(name)} }
            if full {call.arguments=arguments.into()} else {call.arguments.push_str(arguments)}
            if call.id.is_empty() || call.name.is_empty() {return Ok(())}
            anyhow::ensure!(call.arguments.starts_with(&call.sent),"The API changed streamed tool arguments");
            let delta=call.arguments[call.sent.len()..].to_string(); call.sent=call.arguments.clone();
            (call.id.clone(),call.name.clone(),delta)
        };
        let index=self.block(key,"tool_use",json!({"id":id,"name":name}));
        if !delta.is_empty() {self.frames.push(json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":delta}}));}
        self.stop="tool_use".into();
        Ok(())
    }
    fn item(&mut self, item: &Value, fallback: &str) -> anyhow::Result<()> {
        let id=item["id"].as_str().unwrap_or(fallback);
        match item["type"].as_str() {
            Some("message")=>for (index,part) in item["content"].as_array().into_iter().flatten().enumerate() {
                self.full(&format!("text:{id}:{index}"),"text",part["text"].as_str().or_else(||part["refusal"].as_str()).unwrap_or(""));
            },
            Some("function_call")=>self.tool(&format!("tool:{id}"),item["call_id"].as_str(),item["name"].as_str(),item["arguments"].as_str().unwrap_or(""),true)?,
            Some("reasoning")=>{
                let parts=item["summary"].as_array().cloned().unwrap_or_default();
                for (index,part) in parts.iter().enumerate() {self.full(&format!("thinking:{id}:{index}"),"thinking",part["text"].as_str().unwrap_or(""));}
                let key=format!("thinking:{id}:{}",parts.len().saturating_sub(1));
                let index=self.block(&key,"thinking",Value::Null);
                if !self.blocks[&key].signature {
                    self.blocks.get_mut(&key).unwrap().signature=true;
                    self.frames.push(json!({"type":"content_block_delta","index":index,"delta":{"type":"signature_delta","signature":reasoning_signature(item)}}));
                }
            }
            _=>{}
        }
        Ok(())
    }
    pub(super) fn event(&mut self, value: &Value) -> anyhow::Result<Vec<Value>> {
        self.frames.clear(); self.begin();
        anyhow::ensure!(value["error"].is_null() && !matches!(value["type"].as_str(),Some("error"|"response.failed")),"{}",value["error"]["message"].as_str().or_else(||value["response"]["error"]["message"].as_str()).unwrap_or("The selected API stream failed"));
        if !self.responses {
            let choice=&value["choices"][0]; let delta=&choice["delta"];
            self.delta("thinking","thinking",delta["reasoning_content"].as_str().or_else(||delta["reasoning"].as_str()).unwrap_or(""));
            self.delta("text","text",delta["content"].as_str().unwrap_or(""));
            for call in delta["tool_calls"].as_array().into_iter().flatten() {self.tool(&format!("tool:{}",call["index"].as_u64().unwrap_or(0)),call["id"].as_str(),call["function"]["name"].as_str(),call["function"]["arguments"].as_str().unwrap_or(""),false)?;}
            if let Some(reason)=choice["finish_reason"].as_str().filter(|s|!s.is_empty()) {self.terminal=true; match reason {"length"=>self.stop="max_tokens".into(),"tool_calls"=>self.stop="tool_use".into(),_=>{}}}
            if value["usage"].is_object() {self.usage=usage(&value["usage"],false);}
        } else {
            let output=value["output_index"].as_u64().unwrap_or(0);
            let fallback=format!("out_{output}");
            let id=value["item_id"].as_str().map(str::to_string).or_else(||self.output_ids.get(&output).cloned()).unwrap_or(fallback);
            let index=value["content_index"].as_u64().unwrap_or(0);
            match value["type"].as_str() {
                Some("response.output_item.added")=>{
                    let item=&value["item"]; let id=item["id"].as_str().unwrap_or(&id);
                    self.output_ids.insert(output,id.into());
                    if item["type"]=="function_call" {self.tool(&format!("tool:{id}"),item["call_id"].as_str(),item["name"].as_str(),item["arguments"].as_str().unwrap_or(""),true)?;}
                }
                Some("response.output_text.delta"|"response.refusal.delta")=>self.delta(&format!("text:{id}:{index}"),"text",value["delta"].as_str().unwrap_or("")),
                Some("response.output_text.done")=>self.full(&format!("text:{id}:{index}"),"text",value["text"].as_str().unwrap_or("")),
                Some("response.reasoning_summary_text.delta"|"response.reasoning_text.delta")=>self.delta(&format!("thinking:{id}:{}",value["summary_index"].as_u64().unwrap_or(0)),"thinking",value["delta"].as_str().unwrap_or("")),
                Some("response.function_call_arguments.delta")=>self.tool(&format!("tool:{id}"),None,None,value["delta"].as_str().unwrap_or(""),false)?,
                Some("response.function_call_arguments.done")=>self.tool(&format!("tool:{id}"),None,None,value["arguments"].as_str().unwrap_or(""),true)?,
                Some("response.output_item.done")=>self.item(&value["item"],&id)?,
                Some("response.completed"|"response.incomplete")=>{
                    let incomplete=value["type"]=="response.incomplete";
                    anyhow::ensure!(!incomplete || value["response"]["incomplete_details"]["reason"]=="max_output_tokens","The API response did not complete");
                    for (index,item) in value["response"]["output"].as_array().into_iter().flatten().enumerate() {
                        let id=self.output_ids.get(&(index as u64)).cloned().unwrap_or_else(||format!("out_{index}")); self.item(item,&id)?;
                    }
                    self.usage=usage(&value["response"]["usage"],true); self.terminal=true;
                    if incomplete {self.stop="max_tokens".into();}
                }
                _=>{}
            }
        }
        Ok(std::mem::take(&mut self.frames))
    }
    pub(super) fn finish(&self) -> anyhow::Result<Vec<Value>> {
        anyhow::ensure!(self.terminal,"The selected API stream ended before completion");
        anyhow::ensure!(self.calls.values().all(|call|!call.name.is_empty() && !call.id.is_empty()),"The API returned an incomplete tool call");
        let mut indices=self.blocks.values().map(|b|b.index).collect::<Vec<_>>(); indices.sort_unstable();
        let mut frames=indices.into_iter().map(|index|json!({"type":"content_block_stop","index":index})).collect::<Vec<_>>();
        frames.push(json!({"type":"message_delta","delta":{"stop_reason":self.stop,"stop_sequence":null},"usage":self.usage}));
        frames.push(json!({"type":"message_stop"})); Ok(frames)
    }
}
fn usage(value: &Value, responses: bool) -> Value {
    let (input,output,details)=if responses {("input_tokens","output_tokens","input_tokens_details")} else {("prompt_tokens","completion_tokens","prompt_tokens_details")};
    let cached=value[details]["cached_tokens"].as_u64().unwrap_or(0);
    json!({"input_tokens":value[input].as_u64().unwrap_or(0).saturating_sub(cached),"output_tokens":value[output].as_u64().unwrap_or(0),"cache_read_input_tokens":cached,"cache_creation_input_tokens":0})
}
async fn frame(writer: &mut tokio::net::tcp::OwnedWriteHalf, value: &Value) -> anyhow::Result<()> {
    let payload=format!("event: {}\ndata: {value}\n\n",value["type"].as_str().unwrap_or("error"));
    writer.write_all(format!("{:X}\r\n{payload}\r\n",payload.len()).as_bytes()).await?; Ok(())
}
pub(super) async fn stream_response(writer: &mut tokio::net::tcp::OwnedWriteHalf, mut response: reqwest::Response, responses: bool, model: &str, key: &str) -> anyhow::Result<()> {
    writer.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await?;
    let result: anyhow::Result<()>=async {
        let mut state=NativeMessageStream::new(responses,model); let mut buffer=Vec::new();
        'upstream: while let Some(chunk)=response.chunk().await? {
            buffer.extend_from_slice(&chunk);
            loop {
                let boundary=buffer.windows(2).position(|b|b==b"\n\n").map(|i|(i,2))
                    .into_iter().chain(buffer.windows(4).position(|b|b==b"\r\n\r\n").map(|i|(i,4))).min_by_key(|(i,_)|*i);
                let Some((end,separator))=boundary else {break};
                let value=String::from_utf8(buffer.drain(..end+separator).collect())?;
                let data=value.lines().filter_map(|line|line.strip_prefix("data:").map(str::trim_start)).collect::<Vec<_>>().join("\n");
                if data=="[DONE]" {break 'upstream}
                if data.is_empty() {continue}
                for value in state.event(&serde_json::from_str(&data)?)? {frame(writer,&value).await?;}
                if responses && state.terminal {break 'upstream}
            }
            anyhow::ensure!(buffer.len()<=16*1024*1024,"The API stream event exceeds the size limit");
        }
        for value in state.finish()? {frame(writer,&value).await?;} Ok(())
    }.await;
    if let Err(error)=result {frame(writer,&json!({"type":"error","error":{"type":"api_error","message":error.to_string().replace(key,"[redacted]")}})).await?;}
    writer.write_all(b"0\r\n\r\n").await?; Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reasoning_tools_and_terminal_state_are_preserved_without_buffering_text() {
        let mut state=NativeMessageStream::new(true,"selected");
        let first=state.event(&json!({"type":"response.reasoning_summary_text.delta","item_id":"reason","delta":"Plan"})).unwrap();
        assert!(first.iter().any(|frame|frame["delta"]["thinking"]=="Plan"));
        assert!(state.finish().is_err());
        let reason=json!({"id":"reason","type":"reasoning","summary":[{"type":"summary_text","text":"Plan"}],"encrypted_content":"opaque"});
        let signature=state.event(&json!({"type":"response.output_item.done","item":reason})).unwrap();
        assert!(signature.iter().any(|frame|frame["delta"]["type"]=="signature_delta"));
        state.event(&json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"tool","call_id":"call","name":"read","arguments":""}})).unwrap();
        let args=state.event(&json!({"type":"response.function_call_arguments.delta","item_id":"tool","delta":"{\"path\":\"a\"}"})).unwrap();
        assert!(args.iter().any(|frame|frame["delta"]["partial_json"]=="{\"path\":\"a\"}"));
        state.event(&json!({"type":"response.completed","response":{"output":[],"usage":{"input_tokens":20,"output_tokens":5,"input_tokens_details":{"cached_tokens":4}}}})).unwrap();
        let end=state.finish().unwrap();
        assert!(end.iter().any(|frame|frame["delta"]["stop_reason"]=="tool_use" && frame["usage"]["input_tokens"]==16));
        assert_eq!(end.last().unwrap()["type"],"message_stop");
    }
}
