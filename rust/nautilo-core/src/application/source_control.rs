use crate::{
    application::core_daemon::Daemon,
    database::Repositories,
    errors::{invalid, not_found, CoreResult},
};
use serde_json::Value;

/// Resolve the same persisted working directory as native CLI handoff.
pub fn working_directory(daemon: &Daemon, input: &Value) -> CoreResult<String> {
    let guard = daemon.db.lock().unwrap();
    let repositories = Repositories::new(&guard.raw);
    let session = input["sessionId"]
        .as_str()
        .map(|id| {
            repositories
                .sessions()
                .get(id)
                .and_then(|session| session.ok_or_else(|| not_found("session", id)))
        })
        .transpose()?;
    if session.as_ref().is_some_and(|session| {
        input["projectId"]
            .as_str()
            .is_some_and(|id| session["projectId"] != id)
    }) {
        return Err(invalid("projectId", "会话与项目不匹配。"));
    }
    let project_id = input["projectId"]
        .as_str()
        .or_else(|| {
            session
                .as_ref()
                .and_then(|session| session["projectId"].as_str())
        })
        .ok_or_else(|| invalid("projectId", "请选择项目或会话。"))?;
    let project = repositories
        .projects()
        .get(project_id)?
        .ok_or_else(|| not_found("project", project_id))?;
    Ok(session
        .as_ref()
        .and_then(|session| session["nativeWorkingDirectory"].as_str())
        .or_else(|| project["rootPath"].as_str())
        .unwrap_or("")
        .into())
}
