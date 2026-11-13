//! Bounded loopback HTTP framing; no native-account or session policy.
use serde_json::{json, Value};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

pub(super) fn chunk(id: &str, model: &Value, delta: Value, finish: Option<&str>) -> Value {
    json!({"id":id,"object":"chat.completion.chunk","created":chrono::Utc::now().timestamp(),"model":model,"choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
}
pub(super) async fn write_sse(socket: &mut TcpStream, value: &Value) -> anyhow::Result<()> {
    socket
        .write_all(format!("data: {value}\n\n").as_bytes())
        .await?;
    Ok(())
}
pub(super) async fn response(
    socket: &mut TcpStream,
    status: u16,
    value: &Value,
) -> anyhow::Result<()> {
    let bytes = value.to_string();
    socket.write_all(format!("HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{bytes}",bytes.len()).as_bytes()).await?;
    Ok(())
}
pub(super) async fn error(
    socket: &mut TcpStream,
    status: u16,
    code: &str,
    message: &str,
) -> anyhow::Result<()> {
    response(
        socket,
        status,
        &json!({"error":{"code":code,"message":message}}),
    )
    .await
}
pub(super) async fn read_http(socket: &mut TcpStream) -> anyhow::Result<(String, String, Value)> {
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut header = vec![];
        let mut byte = [0];
        while !header.ends_with(b"\r\n\r\n") {
            anyhow::ensure!(header.len() < 32 * 1024, "Headers too large");
            socket.read_exact(&mut byte).await?;
            header.push(byte[0]);
        }
        let header = String::from_utf8(header)?;
        let path = header
            .lines()
            .next()
            .and_then(|s| s.split_whitespace().nth(1))
            .unwrap_or("")
            .to_string();
        let value = |name: &str| {
            header.lines().find_map(|line| {
                line.split_once(':')
                    .filter(|(key, _)| key.eq_ignore_ascii_case(name))
                    .map(|(_, value)| value.trim().to_string())
            })
        };
        let length = value("content-length")
            .map(|s| s.parse::<usize>())
            .transpose()?
            .unwrap_or(0);
        anyhow::ensure!(length <= 20 * 1024 * 1024, "Request body exceeds 20 MiB");
        let mut body = vec![0; length];
        socket.read_exact(&mut body).await?;
        Ok((
            path,
            value("authorization").unwrap_or_default(),
            if body.is_empty() {
                json!({})
            } else {
                serde_json::from_slice(&body)?
            },
        ))
    })
    .await?
}
