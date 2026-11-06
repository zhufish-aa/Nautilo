//! Retains parsing and native child-wire positions for the whole ACP session.
use super::{is_kimi_agent_tool, tool_call_id, tool_phase};
use crate::adapters::{
    kimi::{
        acp_events::{parse_kimi_acp_update, KimiAcpParseState},
        acp_segments::KimiAcpTurnSegments,
        subagent_wire::KimiSubagentWireWatcher,
    },
    AdapterEvent,
};
use serde_json::Value;

pub(super) struct Pipeline {
    pub state: KimiAcpParseState,
    pub segments: KimiAcpTurnSegments,
    pub wires: Option<KimiSubagentWireWatcher>,
    pub usage_received: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn kimi_progress_keeps_call_identity_and_changes_only_when_content_changes() {
        let mut pipeline = Pipeline::default();
        pipeline.update(&json!({"sessionUpdate":"tool_call","toolCallId":"read","title":"Read","status":"in_progress","rawInput":{"path":"file"}})).await;
        let update = json!({"sessionUpdate":"tool_call_update","toolCallId":"read","status":"in_progress","rawOutput":"partial output"});
        let events = pipeline.update(&update).await;
        assert!(
            matches!(events.as_slice(),[AdapterEvent::Tool{name,phase:Some(phase),output:Some(output),..}] if name=="Read" && phase=="updated" && *output==json!("partial output"))
        );
        assert!(pipeline.update(&update).await.is_empty());
    }
}
impl Default for Pipeline {
    fn default() -> Self {
        let mut state = KimiAcpParseState::default();
        let segments = KimiAcpTurnSegments::new();
        segments.bind(&mut state);
        Self {
            state,
            segments,
            wires: None,
            usage_received: false,
        }
    }
}
impl Pipeline {
    pub async fn update(&mut self, update: &Value) -> Vec<AdapterEvent> {
        let parsed = parse_kimi_acp_update(update, &mut self.state);
        let mut events = self.segments.flush_before(&parsed, &mut self.state);
        for item in parsed {
            if is_kimi_agent_tool(&item)
                && matches!(tool_phase(&item).as_deref(), Some("started" | "updated"))
            {
                if let (Some(wires), Some(call_id)) = (&mut self.wires, tool_call_id(&item)) {
                    let input = match &item {
                        AdapterEvent::Tool { input, .. } => input.as_ref(),
                        _ => None,
                    };
                    wires.track(&call_id, input);
                }
            }
            let completed =
                is_kimi_agent_tool(&item) && tool_phase(&item).as_deref() == Some("completed");
            if completed {
                events.extend(self.poll().await);
            }
            self.segments.append(&item);
            self.usage_received |= matches!(item, AdapterEvent::Usage { .. });
            let call_id = tool_call_id(&item);
            events.push(item);
            if completed {
                if let (Some(wires), Some(call_id)) = (&mut self.wires, call_id) {
                    wires.release(&call_id);
                }
            }
        }
        events
    }
    pub async fn poll(&mut self) -> Vec<AdapterEvent> {
        match &mut self.wires {
            Some(wires) => wires.poll().await,
            None => vec![],
        }
    }
    pub fn has_active(&self) -> bool {
        self.wires.as_ref().is_some_and(|wires| wires.has_active())
    }
    pub fn flush(&mut self) -> Vec<AdapterEvent> {
        let mut events = self.segments.flush_message(&mut self.state);
        events.extend(self.segments.flush_thinking(&mut self.state));
        events
    }
}
