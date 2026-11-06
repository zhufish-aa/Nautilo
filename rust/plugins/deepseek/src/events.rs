use agenthub_plugin_sdk::usage::TurnUsage;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct Events {
    attempts: HashMap<String, String>,
    streamed: HashSet<String>,
    committed: HashSet<String>,
    tool_names: HashMap<String, String>,
    children: HashMap<String, String>,
    usage: HashMap<String, TurnUsage>,
    windows: HashMap<String, Value>,
    code_inputs: HashMap<String, Value>,
}

impl Events {
    pub fn begin_turn(&mut self, root: &str) {
        self.attempts.remove(root);
        self.usage.remove(root);
    }

    pub fn parse(&mut self, frame: &Value, root: &str) -> Vec<Value> {
        let session = frame["sessionId"].as_str().unwrap_or(root);
        let mut events = vec![];
        if frame["kind"] != "child" && session != root && !self.children.contains_key(session) {
            return events;
        }
        match frame["kind"].as_str().unwrap_or("") {
            "child" => {
                let parent = frame["parentSessionId"].as_str().unwrap_or("");
                if parent != root && !self.children.contains_key(parent) {
                    return events;
                }
                let Some(child) = frame["childSessionId"].as_str() else {
                    return events;
                };
                let call = format!("dsh-child-{child}");
                self.children.insert(child.into(), call.clone());
                let phase = frame["phase"].as_str().unwrap_or("started");
                let status = if frame["failed"] == true {
                    "failed"
                } else if phase == "completed" {
                    "completed"
                } else {
                    "running"
                };
                let mut event = json!({"kind":"tool","name":"spawn_agent","callId":call,"phase":phase,"success":frame["failed"]!=true,
                    "input":{"agent_type":"DeepSeek Harness","receiverThreadIds":[child],"agentsStates":{child:{"status":status}}},"raw":frame});
                if parent != root {
                    event["subagentDispatchId"] = json!(self.children.get(parent));
                }
                events.push(event);
            }
            "stream" => {
                let stream = &frame["frame"];
                let attempt = stream["attemptId"].as_str().unwrap_or("current");
                self.attempts.insert(session.into(), attempt.into());
                if stream["type"] == "chunk" {
                    let chunk = &stream["chunk"];
                    let index = chunk["index"].as_u64().unwrap_or(0);
                    let id = format!("{session}:{attempt}:{index}");
                    match chunk["type"].as_str().unwrap_or("") {
                        "block-start" if chunk["blockType"] == "reasoning" => {
                            events.push(json!({"kind":"thinking","phase":"started","messageId":id}))
                        }
                        "text-delta" | "reasoning-delta" => {
                            self.streamed.insert(id.clone());
                            events.push(if chunk["type"]=="text-delta" {json!({"kind":"message","phase":"delta","messageId":id,"text":chunk["text"]})}
                                else {json!({"kind":"thinking","phase":"delta","messageId":id,"text":chunk["text"]})});
                        }
                        "block-end" => {
                            let block = &chunk["block"];
                            if !self.streamed.contains(&id) {
                                if block["type"] == "text" {
                                    events.push(json!({"kind":"message","phase":"delta","messageId":id,"text":block["text"]}));
                                }
                                if block["type"] == "reasoning" {
                                    events.push(json!({"kind":"thinking","phase":"delta","messageId":id,"text":block["text"]}));
                                }
                            }
                            self.streamed.insert(id.clone());
                            if block["type"] == "reasoning" {
                                events.push(
                                    json!({"kind":"thinking","phase":"completed","messageId":id}),
                                );
                            }
                        }
                        _ => {}
                    }
                }
            }
            "event" => {
                let event = &frame["event"];
                let data = &event["data"];
                match event["type"].as_str().unwrap_or("") {
                    "request/context" => {
                        if data["contextWindow"].is_number() {
                            self.windows.insert(session.into(),data["contextWindow"].clone());
                            events.push(json!({"kind":"usage","usageScope":"context","contextWindow":data["contextWindow"]}));
                        }
                    }
                    "assistant/message" => {
                        let attempt=self.attempts.get(session).cloned().unwrap_or_else(||format!("event-{}",event["seq"]));
                        for (index,block) in data["message"]["content"].as_array().into_iter().flatten().enumerate() {
                            let id=format!("{session}:{attempt}:{index}");
                            // A live delta is not a saved message. Always commit
                            // each native text block once, including streamed ones.
                            if block["type"]=="text" && self.committed.insert(id.clone()) {
                                events.push(json!({"kind":"message","phase":"completed","messageId":id,"text":block["text"]}));
                            }
                            if self.streamed.contains(&id) { continue; }
                            if block["type"]=="reasoning" { events.push(json!({"kind":"thinking","phase":"completed","messageId":id,"text":block["text"]})); }
                            self.streamed.insert(id);
                        }
                        if data["usage"].is_object() {
                            let u=&data["usage"];
                            let usage=json!({"kind":"usage","usageScope":"context","inputTokensIncludesCache":false,"contextWindow":self.windows.get(session),
                                "inputTokens":u["inputTokens"],"outputTokens":u["outputTokens"],"cachedInputTokens":u["cacheReadTokens"],
                                "cacheCreationInputTokens":u["cacheWriteTokens"],"reasoningOutputTokens":u["reasoningTokens"]});
                            events.push(usage.clone());
                            events.push(self.usage.entry(session.into()).or_default().update(&format!("{}:{}",data["turn"],data["step"]),&usage));
                        }
                    }
                    "tool/call" => {
                        let id=data["callId"].as_str().unwrap_or(""); let name=data["name"].as_str().unwrap_or("tool");
                        self.tool_names.insert(format!("{session}:{id}"),name.into());
                        if name == "run_code" {
                            self.code_inputs.insert(format!("{session}:{id}"), data["arguments"].as_str().and_then(|s|serde_json::from_str::<Value>(s).ok()).unwrap_or(data["arguments"].clone()));
                        }
                        let mut mapped=json!({"kind":"tool","phase":"started","callId":format!("{session}:{id}"),"name":name,
                            "input":data["arguments"].as_str().and_then(|s|serde_json::from_str::<Value>(s).ok()).unwrap_or(data["arguments"].clone()),"raw":data});
                        if name=="run_code" {mapped["raw"]["codeExecution"]=json!({"partial":true,"description":mapped["input"]["description"],"calls":[]});}
                        events.push(mapped);
                    }
                    "tool/ptc-dispatch-start" | "tool/ptc-dispatch" => {
                        let root_call = data["rootCallId"].as_str().or(data["parentCallId"].as_str()).unwrap_or("");
                        let key = format!("{session}:{root_call}");
                        let sub_call = data["subCallId"].as_str().unwrap_or("");
                        let output = data["content"].as_array().map(|blocks| blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"));
                        let call = json!({"callId":sub_call,"parentCallId":data["parentCallId"],"name":data["name"],
                            "input":data["arguments"].as_str().and_then(|s|serde_json::from_str::<Value>(s).ok()).unwrap_or(data["arguments"].clone()),
                            "output":output.map(|text|text.chars().take(8_000).collect::<String>()),"meta":data["meta"],
                            "status":if event["type"]=="tool/ptc-dispatch-start"{"running"}else if data["isError"]==true{"failed"}else{"done"}});
                        // Nested PTC dispatches update their existing code batch; they
                        // never finish the batch or create duplicate top-level rows.
                        events.push(json!({"kind":"tool","phase":"updated","callId":key,"name":"run_code",
                            "input":self.code_inputs.get(&key),"raw":{"codeExecution":{"partial":true,"calls":[call]}}}));
                    }
                    "tool/result" => {
                        let message=&data["message"];
                        let id=message["toolCallId"].as_str().or(message["callId"].as_str()).unwrap_or("");
                        let key=format!("{session}:{id}");
                        let output=message["content"].as_array().map(|blocks|blocks.iter().filter_map(|b|b["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_else(||message.to_string());
                        events.push(json!({"kind":"tool","phase":"completed","callId":key,"name":self.tool_names.get(&key).map(String::as_str).unwrap_or("tool"),
                            "output":output,"success":message["isError"]!=true,"raw":{
                                "codeExecution":if self.code_inputs.contains_key(&key) {json!({"partial":true,"calls":[]})} else {Value::Null}}}));
                    }
                    "turn/end" if data["reason"]["kind"]=="error" => events.push(json!({"kind":"error","message":data["reason"].to_string(),"retryable":true})),
                    _=>{}
                }
            }
            _ => {}
        }
        if session != root && frame["kind"] != "child" {
            events.retain(|event| event["kind"] != "usage");
            let parent = self
                .children
                .entry(session.into())
                .or_insert_with(|| format!("dsh-child-{session}"))
                .clone();
            for event in &mut events {
                event["subagentDispatchId"] = json!(parent);
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ptc_dispatches_patch_the_root_and_only_root_result_finishes_the_batch() {
        let mut state = Events::default();
        let frame = |kind: &str, data: Value| json!({"kind":"event","sessionId":"s","event":{"type":kind,"data":data}});
        let started = state.parse(&frame("tool/call", json!({"callId":"root","name":"run_code","arguments":{"description":"Clean stuck Chrome jobs","code":"await tools.job_kill({job_id:'pwsh-1'})"}})), "s");
        assert_eq!(started[0]["raw"]["codeExecution"]["description"], "Clean stuck Chrome jobs");
        for (kind, id, name, parent) in [
            ("tool/ptc-dispatch-start", "cancel", "job_kill", "root"),
            ("tool/ptc-dispatch-start", "shell", "pwsh", "root"),
            ("tool/ptc-dispatch", "cancel", "job_kill", "root"),
            ("tool/ptc-dispatch", "read", "read", "shell"),
        ] {
            let mapped = state.parse(&frame(kind, json!({"rootCallId":"root","parentCallId":parent,"subCallId":id,"name":name,"arguments":"{\"job_id\":\"pwsh-1\"}","isError":false,"content":[{"type":"text","text":"requested cancellation of job pwsh-1"}]})), "s");
            assert_eq!(mapped[0]["phase"], "updated");
            assert_eq!(mapped[0]["callId"], "s:root");
            let patch = &mapped[0]["raw"]["codeExecution"];
            assert_eq!(patch["partial"], true);
            assert_eq!(patch["calls"].as_array().unwrap().len(), 1);
            assert_eq!(patch["calls"][0]["callId"], id);
            assert_eq!(patch["calls"][0]["parentCallId"], parent);
            assert_eq!(patch["calls"][0]["input"]["job_id"], "pwsh-1");
            assert_eq!(patch["calls"][0]["status"], if kind.ends_with("-start") {"running"} else {"done"});
        }
        let complete = state.parse(&frame("tool/result", json!({"message":{"toolCallId":"root","content":[{"type":"text","text":"done"}],"isError":false}})), "s");
        assert_eq!(complete[0]["phase"], "completed");
        assert_eq!(complete[0]["raw"]["codeExecution"], json!({"partial":true,"calls":[]}));
    }
    #[test]
    fn live_chunks_and_committed_message_do_not_duplicate_text_or_thinking() {
        let mut state = Events::default();
        for (index, kind) in [(0, "text-delta"), (1, "reasoning-delta")] {
            let events=state.parse(&json!({"kind":"stream","sessionId":"s","frame":{"type":"chunk","attemptId":"a","chunk":{"type":kind,"index":index,"text":"hello"}}}),"s");
            assert_eq!(events.len(), 1);
            assert_eq!(events[0]["phase"], "delta");
        }
        let complete=state.parse(&json!({"kind":"event","sessionId":"s","event":{"type":"assistant/message","data":{"message":{"content":[{"type":"text","text":"hello"},{"type":"reasoning","text":"hello"}]}}}}),"s");
        assert_eq!(complete.len(), 1);
        assert_eq!(complete[0]["kind"], "message");
        assert_eq!(complete[0]["phase"], "completed");
        assert_eq!(complete[0]["text"], "hello");
        let repeated=state.parse(&json!({"kind":"event","sessionId":"s","event":{"type":"assistant/message","data":{"message":{"content":[{"type":"text","text":"hello"},{"type":"reasoning","text":"hello"}]}}}}),"s");
        assert!(repeated.is_empty());
    }
}
