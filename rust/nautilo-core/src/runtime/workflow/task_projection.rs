//! Internal ownership link for legacy task views. Public workflow requests
//! cannot supply this link; it is attached while claiming persisted tasks.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProjection {
    pub project_run_id: String,
    pub team_id: String,
    pub main_member_id: String,
    /// Graph node ID -> original task identity and reserved attempt.
    pub tasks: BTreeMap<String, TaskAttempt>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sessions: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_working_directory: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub workspaces: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub task_texts: BTreeMap<String, String>,
    #[serde(default = "return_to_main")]
    pub return_to_main: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_plan: Option<ProjectTaskPlan>,
}
fn return_to_main() -> bool {
    true
}

/// Lifecycle of a graph launched through an existing team orchestration entry.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTaskPlan {
    pub mode: String,
    pub invoking_run_id: Option<String>,
    pub finalize: bool,
    pub stage: String,
    pub goal: String,
    pub from_planner: bool,
    #[serde(default)]
    pub rejected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_work: Option<super::NativeWork>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttempt {
    pub task_id: String,
    pub attempt: u32,
    pub member_id: String,
}
