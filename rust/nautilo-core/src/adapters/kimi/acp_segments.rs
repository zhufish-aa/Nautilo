//! Turn segmenter — port of adapters/kimi/acp-segments.ts.
//! Splits one Kimi ACP turn into message/reasoning segments at tool boundaries.

use crate::adapters::kimi::acp_events::KimiAcpParseState;
use crate::adapters::AdapterEvent;

pub struct KimiAcpTurnSegments {
    message_text: String,
    thinking_text: String,
    message_index: u32,
    thinking_index: u32,
    identity: String,
}

impl KimiAcpTurnSegments {
    pub fn new() -> Self {
        Self { message_text: String::new(), thinking_text: String::new(), message_index: 1, thinking_index: 1,
            identity: format!("kimi-{}", uuid::Uuid::new_v4().simple()) }
    }

    pub fn bind(&self, state: &mut KimiAcpParseState) {
        state.message_id = format!("{}-message-{}", self.identity, self.message_index);
        state.thinking_id = format!("{}-thinking-{}", self.identity, self.thinking_index);
    }

    pub fn flush_before(&mut self, events: &[AdapterEvent], state: &mut KimiAcpParseState) -> Vec<AdapterEvent> {
        let tool_started = events.iter().any(|event| {
            matches!(event, AdapterEvent::Tool { phase, .. } if phase.as_deref() == Some("started"))
        });
        let answer_started = events.iter().any(|event| {
            matches!(event, AdapterEvent::Message { phase, .. } if phase.as_deref() == Some("delta"))
        });
        if tool_started {
            let mut flushed = self.flush_message(state);
            flushed.extend(self.flush_thinking(state));
            return flushed;
        }
        if answer_started {
            return self.flush_thinking(state);
        }
        vec![]
    }

    pub fn append(&mut self, event: &AdapterEvent) {
        match event {
            AdapterEvent::Message { text, phase, .. } if phase.as_deref() == Some("delta") => self.message_text.push_str(text),
            AdapterEvent::Thinking { text, phase, .. } if phase.as_deref() == Some("delta") => self.thinking_text.push_str(text),
            _ => {}
        }
    }

    pub fn flush_message(&mut self, state: &mut KimiAcpParseState) -> Vec<AdapterEvent> {
        if self.message_text.is_empty() {
            return vec![];
        }
        let completed = AdapterEvent::Message {
            text: std::mem::take(&mut self.message_text),
            phase: Some("completed".to_string()),
            message_id: Some(state.message_id.clone()),
            subagent_dispatch_id: None,
            raw: None,
        };
        self.message_index += 1;
        self.bind(state);
        vec![completed]
    }

    pub fn flush_thinking(&mut self, state: &mut KimiAcpParseState) -> Vec<AdapterEvent> {
        if self.thinking_text.is_empty() {
            return vec![];
        }
        let completed = AdapterEvent::Thinking {
            text: std::mem::take(&mut self.thinking_text),
            phase: Some("completed".to_string()),
            message_id: Some(state.thinking_id.clone()),
            subagent_dispatch_id: None,
            raw: None,
        };
        self.thinking_index += 1;
        self.bind(state);
        vec![completed]
    }
}

impl Default for KimiAcpTurnSegments {
    fn default() -> Self {
        Self::new()
    }
}
