use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};

pub(super) async fn read_message(
    reader: &mut (impl AsyncBufRead + Unpin),
) -> anyhow::Result<Value> {
    let mut bytes = Vec::new();
    loop {
        let chunk = reader.fill_buf().await?;
        anyhow::ensure!(!chunk.is_empty(), "MCP stream closed");
        let end = chunk
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1);
        let count = end.unwrap_or(chunk.len());
        bytes.extend_from_slice(&chunk[..count]);
        reader.consume(count);
        if end.is_some() {
            return Ok(serde_json::from_slice(&bytes)?);
        }
    }
}

pub async fn run_relay() -> anyhow::Result<()> {
    let address: std::net::SocketAddr = std::env::var("NAUTILO_MCP_POOL_ADDR")?.parse()?;
    anyhow::ensure!(address.ip().is_loopback(), "MCP pool must be local");
    let mut socket = tokio::net::TcpStream::connect(address).await?;
    let spec: Value = serde_json::from_str(&std::env::var("NAUTILO_MCP_POOL_SPEC")?)?;
    let hello = json!({"token":std::env::var("NAUTILO_MCP_POOL_TOKEN")?,"spec":spec});
    socket.write_all(format!("{hello}\n").as_bytes()).await?;
    let (read, mut write) = socket.into_split();
    let mut read = BufReader::new(read);
    let mut input = tokio::io::stdin();
    let mut output = tokio::io::stdout();
    let mut errors = tokio::io::stderr();
    tokio::select! {
        result = tokio::io::copy(&mut input, &mut write) => { result?; }
        result = async {
            loop {
                let message = read_message(&mut read).await?;
                if message.get("jsonrpc").is_none() && message["nautiloMcpRelay"] == "stderr" {
                    errors.write_all(message["text"].as_str().unwrap_or_default().as_bytes()).await?;
                    errors.flush().await?;
                } else {
                    output.write_all(format!("{message}\n").as_bytes()).await?;
                    output.flush().await?;
                }
            }
            #[allow(unreachable_code)]
            Ok::<(), anyhow::Error>(())
        } => { result?; }
    }
    output.flush().await?;
    Ok(())
}
