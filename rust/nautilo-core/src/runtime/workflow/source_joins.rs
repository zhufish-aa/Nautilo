//! Correlate overlapping dependency joins by dispatch activation and source node.
//! A source may feed more than one join; one join never consumes another's batch.
use super::*;

fn live(instance: &Instance) -> bool {
    instance.active()
}

impl WorkflowRun {
    pub(super) fn source_cancelled(&self, node_id: &str, frames: &[Frame]) -> bool {
        let mut seen = BTreeSet::new();
        frames.iter().rev().any(|frame| {
            self.batches
                .iter()
                .find(|batch| batch.id == frame.batch)
                .filter(|batch| seen.insert(&batch.node_id))
                .is_some_and(|batch| {
                    batch.joins.iter().any(|(id, progress)| {
                        let join = self.definition.node(id);
                        progress.joined
                            && join.remaining == "cancel"
                            && join.sources.iter().any(|source| source == node_id)
                            && !progress.arrivals.contains_key(node_id)
                    })
                })
        })
    }

    pub(super) fn arrive_source_join(
        &mut self,
        node: &Node,
        incoming: Value,
        frames: Vec<Frame>,
        traversals: BTreeMap<usize, u32>,
        now: i64,
    ) -> Result<(), String> {
        let source = incoming["from"]
            .as_str()
            .ok_or("A source join needs a named predecessor")?
            .to_owned();
        if !node.sources.contains(&source) {
            return Err(format!(
                "Join {} received undeclared source {source}",
                node.id
            ));
        }
        let batch_index = frames
            .iter()
            .rev()
            .find_map(|frame| {
                self.batches.iter().position(|batch| {
                    batch.id == frame.batch && Some(&batch.node_id) == node.scope.as_ref()
                })
            })
            .ok_or_else(|| format!("Join {} was reached outside its scope", node.id))?;
        let expected = node.sources.len();
        let required = match node.wait.as_str() {
            "firstValid" => 1,
            "quorum" => node.quorum.unwrap_or(1),
            _ => expected,
        };
        let progress = self.batches[batch_index]
            .joins
            .entry(node.id.clone())
            .or_default();
        if progress.joined {
            return Ok(());
        }
        if let Some(previous) = progress.arrivals.get(&source) {
            if previous["instanceId"] == incoming["instanceId"]
                && previous["result"] == incoming["result"]
            {
                return Ok(());
            }
            return Err(format!("Join {} received multiple activations of {source}; collect a foreach batch before this join",node.id));
        }
        progress.arrivals.insert(source, incoming);
        for (edge, count) in traversals {
            progress
                .traversals
                .entry(edge)
                .and_modify(|current| *current = (*current).max(count))
                .or_insert(count);
        }
        let received = progress.arrivals.len();
        let batch_id = self.batches[batch_index].id.clone();
        self.event(
            "join.progress",
            None,
            "Join received a predecessor",
            json!({"nodeId":node.id,"batchId":batch_id,"received":received,"required":required}),
            now,
        );
        if received < required {
            return Ok(());
        }
        self.batches[batch_index]
            .joins
            .get_mut(&node.id)
            .unwrap()
            .joined = true;
        let batch = self.batches[batch_index].clone();
        let progress = &batch.joins[&node.id];
        if node.remaining == "cancel" {
            let pending: Vec<_> = self
                .instances
                .iter()
                .filter(|i| {
                    live(i)
                        && node.sources.contains(&i.node_id)
                        && !progress.arrivals.contains_key(&i.node_id)
                        && i.frames.iter().any(|frame| frame.batch == batch.id)
                })
                .map(|i| i.id.clone())
                .collect();
            for id in pending {
                let index = self.index(&id)?;
                self.instances[index].status = "cancelled".into();
                self.instances[index].updated_at = now;
                self.event(
                    "node.cancelled",
                    Some(&id),
                    "Join obtained sufficient results",
                    json!({"joinNodeId":node.id}),
                    now,
                );
            }
        }
        let mut outgoing_frames = batch.frames;
        outgoing_frames.push(Frame {
            batch: batch.id.clone(),
            branch: format!("$join:{}", node.id),
        });
        let mut merged = batch.traversals;
        for (edge, count) in &progress.traversals {
            merged
                .entry(*edge)
                .and_modify(|current| *current = (*current).max(*count))
                .or_insert(*count);
        }
        let result = json!(progress.arrivals);
        let id = self.insert(
            node,
            result.clone(),
            None,
            outgoing_frames,
            merged,
            "completed",
            now,
        )?;
        self.event(
            "join.completed",
            Some(&id),
            "Join released its result",
            json!({"batchId":batch.id}),
            now,
        );
        self.route(&id, &[node.exits[0].id.clone()], result, now)
    }

    pub(super) fn source_join_impossible(&self) -> bool {
        self.batches.iter().any(|batch| {
            batch.joins.iter().any(|(id, progress)| {
                if progress.joined {
                    return false;
                }
                let join = self.definition.node(id);
                let required = match join.wait.as_str() {
                    "firstValid" => 1,
                    "quorum" => join.quorum.unwrap_or(1),
                    _ => join.sources.len(),
                };
                let possible = join
                    .sources
                    .iter()
                    .filter(|source| {
                        progress.arrivals.contains_key(*source)
                            || self.instances.iter().any(|i| {
                                live(i)
                                    && i.frames.iter().any(|frame| frame.batch == batch.id)
                                    && self.definition.reaches_without(&i.node_id, source, None)
                            })
                    })
                    .count();
                possible < required
            })
        })
    }
}
