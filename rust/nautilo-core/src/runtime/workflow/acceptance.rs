//! Durable acceptance gates: valid model output alone does not approve changes.
use super::{Instance, WorkflowRun};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Acceptance {
    pub status: String,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub details: Value,
}
impl Default for Acceptance {
    fn default() -> Self {
        Self {
            status: "pending".into(),
            started_at: None,
            ended_at: None,
            details: Value::Null,
        }
    }
}
impl Instance {
    pub fn active(&self) -> bool {
        [
            "ready",
            "starting",
            "running",
            "waiting_submission",
            "waiting_approval",
            "waiting_retry",
            "verifying",
        ]
        .contains(&self.status.as_str())
    }
    pub fn occupies_slot(&self) -> bool {
        ["starting", "running", "verifying"].contains(&self.status.as_str())
    }
}
impl WorkflowRun {
    pub fn verification_started(&mut self, id: &str, now: i64) -> Result<bool, String> {
        let index = self
            .instances
            .iter()
            .position(|i| i.id == id)
            .ok_or("Missing node instance")?;
        if !self.active() || self.instances[index].status != "verifying" {
            return Ok(false);
        }
        let gate = self.instances[index]
            .acceptance
            .as_mut()
            .ok_or("This node has no acceptance gate")?;
        if gate.status != "pending" {
            return Ok(false);
        }
        gate.status = "running".into();
        gate.started_at = Some(now);
        self.event(
            "node.verification_started",
            Some(id),
            "Verifying node changes",
            json!({"acceptance":self.instances[index].acceptance,"workspace":self.instances[index].workspace}),
            now,
        );
        Ok(true)
    }
    pub fn verification_finished(
        &mut self,
        id: &str,
        passed: bool,
        details: Value,
        now: i64,
    ) -> Result<(), String> {
        let index = self
            .instances
            .iter()
            .position(|i| i.id == id)
            .ok_or("Missing node instance")?;
        if !self.active() || self.instances[index].status != "verifying" {
            return Ok(());
        }
        let gate = self.instances[index]
            .acceptance
            .as_mut()
            .ok_or("This node has no acceptance gate")?;
        gate.status = if passed {
            "passed".into()
        } else {
            "failed".into()
        };
        gate.ended_at = Some(now);
        gate.details = details.clone();
        self.event(
            if passed {
                "node.verified"
            } else {
                "node.verification_failed"
            },
            Some(id),
            if passed {
                "Node acceptance passed"
            } else {
                "Node acceptance failed"
            },
            json!({"acceptance":self.instances[index].acceptance,"workspace":self.instances[index].workspace}),
            now,
        );
        if passed {
            self.finish(id, now)?;
            self.settle(now)
        } else {
            self.fail(
                id,
                details["message"]
                    .as_str()
                    .unwrap_or("Required node acceptance failed"),
                now,
            )
        }
    }
    pub fn final_verification_finished(
        &mut self,
        passed: bool,
        details: Value,
        now: i64,
    ) -> Result<(), String> {
        if !self.active() || self.status != "finalizing" {
            return Ok(());
        }
        let gate = self
            .acceptance
            .as_mut()
            .ok_or("This workflow has no final acceptance gate")?;
        gate.status = if passed {
            "passed".into()
        } else {
            "failed".into()
        };
        gate.ended_at = Some(now);
        gate.details = details.clone();
        self.event(
            if passed {
                "workflow.verified"
            } else {
                "workflow.verification_failed"
            },
            None,
            if passed {
                "Workflow acceptance passed"
            } else {
                "Workflow acceptance failed"
            },
            json!({"acceptance":self.acceptance}),
            now,
        );
        if !passed {
            self.escalate(
                details["message"]
                    .as_str()
                    .unwrap_or("Required workflow acceptance failed"),
                now,
            );
            return Ok(());
        }
        self.status = "running".into();
        self.settle(now)
    }
}
