use agenthub_plugin_sdk::{
    runtime_tools::{RuntimeTools as Bridge, ToolRoute},
    DaemonChannel,
};
use serde_json::Value;
use std::sync::Arc;

pub(super) const SERVER_NAME: &str = "nautilo_runtime";
pub(super) struct RuntimeTools {
    bridge: Bridge,
}

impl RuntimeTools {
    pub async fn start(
        request: &Value,
        channel: Option<Arc<dyn DaemonChannel>>,
    ) -> anyhow::Result<Option<Self>> {
        if request["runtimeTools"]
            .as_array()
            .is_none_or(|tools| tools.is_empty())
        {
            return Ok(None);
        }
        anyhow::ensure!(
            request["localSessionId"]
                .as_str()
                .is_some_and(|id| !id.is_empty()),
            "Nautilo runtime tools require a local conversation identity"
        );
        let route = session_route(request)?;
        Ok(
            Bridge::start(request, channel, route, SERVER_NAME, |name| name)
                .await?
                .map(|bridge| Self { bridge }),
        )
    }

    #[cfg(test)]
    pub fn url(&self) -> &str {
        &self.bridge.url
    }

    pub fn bind(&self, request: &Value) -> anyhow::Result<()> {
        self.bridge.bind(session_route(request)?);
        Ok(())
    }

    pub fn inject(&self, request: &Value) -> Value {
        let mut request = request.clone();
        self.bridge.append_to(&mut request);
        request
    }

    pub async fn verify(&self, base: &str, cwd: &str) -> anyhow::Result<()> {
        let status = super::api_json(base, cwd, "/mcp", "GET", None).await?;
        anyhow::ensure!(
            status[SERVER_NAME]["status"] == "connected",
            "OpenCode did not connect Nautilo runtime tools: {}",
            status[SERVER_NAME]
        );
        Ok(())
    }

    pub fn close(&self) {
        self.bridge.close();
    }
}

fn session_route(request: &Value) -> anyhow::Result<ToolRoute> {
    let binding = request["sessionBindingId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Nautilo runtime tools require a native session binding"))?;
    Ok(ToolRoute::Session(binding.to_owned()))
}
