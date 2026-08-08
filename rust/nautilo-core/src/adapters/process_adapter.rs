//! Process-backed adapter plumbing — port of adapters/process-adapter.ts
//! (streamEvents; the per-adapter base behavior lives in each adapter module).

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc;

use crate::adapters::{AdapterEvent, TimeoutKind};
use crate::process_runtime::ProcessEvent;

// ---------------------------------------------------------------- process adapter plumbing

pub type StructuredEventParser = Arc<dyn Fn(&Value, &str) -> Vec<AdapterEvent> + Send + Sync>;

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
        for (stream, buffer) in pending.iter_mut() {
            if !buffer.trim().is_empty() {
                let _ = sender.send(AdapterEvent::Raw { stream: stream.to_string(), text: std::mem::take(buffer) });
            }
        }
    });
    receiver
}
