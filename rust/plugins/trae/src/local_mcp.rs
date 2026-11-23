use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const RELAY_SPEC: &str = "NAUTILO_LOCAL_MCP_SPEC";

fn loopback_http(url: &reqwest::Url) -> bool {
    url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        && url.port().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

/// Trae Agent only supports stdio. Relay Nautilo's own JSON-over-HTTP endpoints.
pub fn relay_builtin_servers(
    request: &mut Value,
    runtime_server: Option<&str>,
) -> anyhow::Result<()> {
    let Some(servers) = request["mcpServers"].as_array_mut() else {
        return Ok(());
    };
    for server in servers {
        let is_runtime = runtime_server.is_some_and(|name| server["name"] == name);
        if !is_runtime && server["desktopBrowser"] != true {
            continue;
        }
        let url = reqwest::Url::parse(server["url"].as_str().unwrap_or_default())?;
        anyhow::ensure!(loopback_http(&url), "Expected a local HTTP MCP server");
        let spec = json!({"url":url.as_str(),"headers":server["headers"]});
        *server = json!({"name":server["name"],"transport":"stdio",
            "command":std::env::current_exe()?, "args":["--local-mcp-stdio"],
            "env":{(RELAY_SPEC):spec.to_string()}});
    }
    Ok(())
}

pub async fn run_stdio() -> anyhow::Result<()> {
    let spec: Value = serde_json::from_str(&std::env::var(RELAY_SPEC)?)?;
    let url = reqwest::Url::parse(spec["url"].as_str().unwrap_or(""))?;
    anyhow::ensure!(loopback_http(&url), "Expected a local HTTP MCP server");
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in spec["headers"].as_object().into_iter().flatten() {
        headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes())?,
            value
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid MCP header"))?
                .parse()?,
        );
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(180))
        .default_headers(headers)
        .build()?;
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    while let Some(line) = input.next_line().await? {
        let message: Value = serde_json::from_str(&line)?;
        let response = client
            .post(url.clone())
            .header("Accept", "application/json")
            .json(&message)
            .send()
            .await;
        let Some(id) = message.get("id").filter(|id| !id.is_null()) else {
            continue;
        };
        let result = async {
            let response = response?.error_for_status()?;
            response.json::<Value>().await
        }
        .await;
        let reply=result.unwrap_or_else(|error|json!({"jsonrpc":"2.0","id":id,"error":{
            "code":-32001,"message":format!("Nautilo MCP connection failed: {}",error.without_url())
        }}));
        output.write_all(&serde_json::to_vec(&reply)?).await?;
        output.write_all(b"\n").await?;
        output.flush().await?;
    }
    Ok(())
}
