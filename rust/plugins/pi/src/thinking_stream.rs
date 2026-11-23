use serde_json::{json, Value};
use uuid::Uuid;

/// Pi addresses each reasoning block by its content index within a message.
/// Keep those identities separate even when text or tool-call frames interleave.
#[derive(Default)]
pub(super) struct ThinkingStreams {
    blocks: Vec<Block>,
    unindexed: Option<usize>,
    unindexed_closed_by_boundary: bool,
}

struct Block {
    id: String,
    index: Option<u64>,
    text: String,
    finished: bool,
}

impl Block {
    fn event(&self, text: &str, phase: &str, raw: &Value) -> Value {
        json!({"kind":"thinking","text":text,"phase":phase,"messageId":self.id,"raw":raw})
    }

    fn finish(&mut self, snapshot: &str, raw: &Value, events: &mut Vec<Value>) {
        if self.finished {
            return;
        }
        self.finished = true;
        // Final snapshots are cumulative. Send an unseen suffix as a delta,
        // never a full-text summary: older daemons filter that delta on replay
        // and older renderers can overwrite an unrelated block with the summary.
        if let Some(tail) = snapshot.strip_prefix(self.text.as_str()).filter(|tail| !tail.is_empty()) {
            events.push(self.event(tail, "delta", raw));
        }
        if !self.text.is_empty() || !snapshot.is_empty() {
            events.push(self.event("", "completed", raw));
        }
        self.text.clear();
    }
}

impl ThinkingStreams {
    pub(super) fn clear(&mut self) {
        self.blocks.clear();
        self.unindexed = None;
        self.unindexed_closed_by_boundary = false;
    }

    fn new_block(&mut self, index: Option<u64>) -> usize {
        let slot = self.blocks.len();
        self.blocks.push(Block {
            id: format!("pi-thinking-{}", Uuid::new_v4()),
            index,
            text: String::new(),
            finished: false,
        });
        if index.is_none() {
            self.unindexed = Some(slot);
            self.unindexed_closed_by_boundary = false;
        }
        slot
    }

    fn block(&mut self, index: Option<u64>) -> usize {
        let slot = match index {
            Some(index) => self.blocks.iter().position(|block| block.index == Some(index)),
            None => self.unindexed,
        };
        slot.unwrap_or_else(|| self.new_block(index))
    }

    pub(super) fn update(&mut self, update: &Value, raw: &Value) -> Vec<Value> {
        let mut events = vec![];
        let index = update["contentIndex"].as_u64();
        match update["type"].as_str() {
            Some("thinking_start") => {
                if index.is_none() {
                    events.extend(self.finish_unindexed(raw));
                }
                self.block(index);
            }
            Some("thinking_delta") => {
                let text = update["delta"].as_str().unwrap_or("");
                if !text.is_empty() {
                    let slot = self.block(index);
                    let block = &mut self.blocks[slot];
                    if !block.finished {
                        block.text.push_str(text);
                        events.push(block.event(text, "delta", raw));
                    }
                }
            }
            Some("thinking_end") => {
                // A legacy tool boundary may close the block before its own
                // end frame arrives. Do not replay that frame as a new block.
                if index.is_none() && self.unindexed.is_none() && std::mem::take(&mut self.unindexed_closed_by_boundary) {
                    return events;
                }
                let slot = self.block(index);
                self.blocks[slot].finish(update["content"].as_str().unwrap_or(""), raw, &mut events);
                if index.is_none() {
                    self.unindexed = None;
                }
            }
            _ => {}
        }
        events
    }

    /// Unindexed legacy frames cannot distinguish later blocks otherwise.
    pub(super) fn finish_unindexed(&mut self, raw: &Value) -> Vec<Value> {
        let mut events = vec![];
        if let Some(slot) = self.unindexed.take() {
            self.blocks[slot].finish("", raw, &mut events);
            self.unindexed_closed_by_boundary = true;
        }
        events
    }

    pub(super) fn finish_message(&mut self, content: &[Value], raw: &Value) -> Vec<Value> {
        let mut events = vec![];
        for (index, part) in content.iter().enumerate() {
            if part["type"] != "thinking" {
                continue;
            }
            let index = index as u64;
            // Legacy deltas lacked an index. Match their blocks in encounter
            // order against thinking entries in the final snapshot.
            let slot = self.blocks.iter().position(|block| block.index == Some(index))
                .or_else(|| self.blocks.iter().position(|block| block.index.is_none()))
                .unwrap_or_else(|| self.new_block(Some(index)));
            let block = &mut self.blocks[slot];
            block.index = Some(index);
            block.finish(part["thinking"].as_str().unwrap_or(""), raw, &mut events);
        }
        for block in &mut self.blocks {
            block.finish("", raw, &mut events);
        }
        self.clear();
        events
    }
}
