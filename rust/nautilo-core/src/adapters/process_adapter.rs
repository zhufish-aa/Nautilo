//! Process-backed adapter plumbing — port of adapters/process-adapter.ts
//! (streamEvents; the per-adapter base behavior lives in each adapter module).

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc;

use crate::adapters::{AdapterEvent, TimeoutKind};
use crate::process_runtime::ProcessEvent;

// ---------------------------------------------------------------- process adapter plumbing

pub type StructuredEventParser = Arc<dyn Fn(&Value, &str) -> Vec<AdapterEvent> + Send + Sync>;

pub fn merge_cli_args(mut base: Vec<String>, managed: Vec<String>) -> Vec<String> {
    let mut index = 0;
    while index < managed.len() {
        let name = &managed[index];
        let takes_value = managed.get(index+1).is_some_and(|value| !value.starts_with('-'));
        if !["--settings", "--config", "-c"].contains(&name.as_str()) {
            let mut cursor = 0;
            while cursor < base.len() {
                let alias = match name.as_str() { "--model"=>Some("-m"),"--profile"=>Some("-p"),"--sandbox"=>Some("-s"),"--ask-for-approval"=>Some("-a"),"--resume"=>Some("-r"),"-p"=>Some("--print"),_=>None };
                let exact = base[cursor] == *name || alias == Some(base[cursor].as_str());
                if exact || base[cursor].starts_with(&format!("{name}=")) {
                    base.remove(cursor);
                    if exact && takes_value && cursor < base.len() { base.remove(cursor); }
                } else { cursor += 1; }
            }
        }
        base.push(name.clone());
        if takes_value { base.push(managed[index+1].clone()); }
        index += if takes_value {2} else {1};
    }
    base
}

fn flush_pending(pending: &mut [(&str, String)], parse: &StructuredEventParser, sender: &mpsc::UnboundedSender<AdapterEvent>) {
    for (stream, buffer) in pending {
        let text = std::mem::take(buffer);
        if text.trim().is_empty() { continue; }
        let events = serde_json::from_str::<Value>(&text).ok().map(|value|parse(&value,stream)).unwrap_or_default();
        if events.is_empty() { let _ = sender.send(AdapterEvent::Raw {stream:stream.to_string(),text}); }
        else { for event in events { let _ = sender.send(event); } }
    }
}

/// Port of streamEvents: lines a structured process's stdout/stderr into
/// AdapterEvents; raw mode forwards chunks untouched. Unparsed lines fall
/// back to raw events, and buffered tails flush when the stream closes.
pub fn stream_events(
    mut process_events: mpsc::UnboundedReceiver<ProcessEvent>,
    structured: bool,
    parse: StructuredEventParser,
) -> mpsc::UnboundedReceiver<AdapterEvent> {
    let (sender, receiver) = mpsc::unbounded_channel::<AdapterEvent>();
    tokio::spawn(async move {
        let mut pending: [(&'static str, String); 2] = [("stdout", String::new()), ("stderr", String::new())];
        while let Some(event) = process_events.recv().await {
            let (stream, text) = match event {
                ProcessEvent::Stdout(text) => ("stdout", text),
                ProcessEvent::Stderr(text) => ("stderr", text),
                ProcessEvent::Exit { exit_code, signal } => {
                    flush_pending(&mut pending, &parse, &sender);
                    let _ = sender.send(AdapterEvent::Exit { exit_code, signal });
                    continue;
                }
                ProcessEvent::Error(message) => {
                    let _ = sender.send(AdapterEvent::Error { message });
                    continue;
                }
                ProcessEvent::Timeout { reason } => {
                    let kind = match reason {
                        crate::process_runtime::TimeoutReason::Timeout => TimeoutKind::Timeout,
                        crate::process_runtime::TimeoutReason::Idle => TimeoutKind::Idle,
                        crate::process_runtime::TimeoutReason::MaxOutput => TimeoutKind::MaxOutput,
                    };
                    let _ = sender.send(AdapterEvent::Timeout { reason: kind });
                    continue;
                }
            };
            {
                if !structured {
                    let _ = sender.send(AdapterEvent::Raw { stream: stream.to_string(), text });
                    continue;
                }
                let buffer = if stream == "stdout" { &mut pending[0].1 } else { &mut pending[1].1 };
                buffer.push_str(&text);
                let mut lines: Vec<String> = buffer.split('\n').map(str::to_string).collect();
                *buffer = lines.pop().unwrap_or_default();
                for line in lines {
                    let line = line.trim_end_matches('\r');
                    if line.trim().is_empty() {
                        continue;
                    }
                    let events = match serde_json::from_str::<Value>(line) {
                        Ok(parsed) => {
                            let events = parse(&parsed, stream);
                            if events.is_empty() {
                                vec![AdapterEvent::Raw { stream: stream.to_string(), text: line.to_string() }]
                            } else {
                                events
                            }
                        }
                        Err(_) => vec![AdapterEvent::Raw { stream: stream.to_string(), text: line.to_string() }],
                    };
                    for event in events {
                        if sender.send(event).is_err() {
                            return;
                        }
                    }
                }
            }
        }
        flush_pending(&mut pending, &parse, &sender);
    });
    receiver
}
