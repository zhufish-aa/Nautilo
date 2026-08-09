//! JSON-lines IPC gateway over a Windows named pipe / Unix socket.
//! Wire-compatible port of packages/core-daemon/src/ipc-gateway.ts:
//! the Tauri/Electron shell and headless clients must not notice a difference.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use uuid::Uuid;

use crate::errors::{to_agent_hub_error, AgentHubError, ErrorCode};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayRequest {
    #[serde(default)]
    pub request_id: Option<String>,
    pub method: String,
    #[serde(default)]
    pub input: Value,
}

/// Route table shared by all connections. Handlers are registered per method,
/// mirroring IpcGateway.register in the TS daemon.
pub type Handler =
    Arc<dyn Fn(Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<Value>> + Send>> + Send + Sync>;

#[derive(Default)]
pub struct Router {
    handlers: std::collections::HashMap<String, Handler>,
    observer: Option<Arc<dyn Fn(&GatewayRequest, &GatewayResponse) + Send + Sync>>,
}

impl Router {
    pub fn set_observer(&mut self, observer: Arc<dyn Fn(&GatewayRequest, &GatewayResponse) + Send + Sync>) {
        self.observer = Some(observer);
    }

    pub fn register<F, Fut>(&mut self, method: &str, handler: F)
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = anyhow::Result<Value>> + Send + 'static,
    {
        self.handlers.insert(method.to_string(), Arc::new(move |input| Box::pin(handler(input))));
    }

    pub async fn dispatch(&self, request: &GatewayRequest) -> GatewayResponse {
        let request_id = request
            .request_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let Some(handler) = self.handlers.get(&request.method) else {
            let mut details = Map::new();
            details.insert("method".to_string(), Value::String(request.method.clone()));
            let response = GatewayResponse::failure(request_id, AgentHubError::new(ErrorCode::IpcNotFound, Some(details)));
            self.notify(request, &response);
            return response;
        };
        let response = match handler(request.input.clone()).await {
            Ok(data) => GatewayResponse::success(request_id, data),
            Err(error) => GatewayResponse::failure(request_id, to_agent_hub_error(&error)),
        };
        self.notify(request, &response);
        response
    }

    fn notify(&self, request: &GatewayRequest, response: &GatewayResponse) {
        if let Some(observer) = &self.observer {
            // Audit/telemetry must never break the request path.
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| observer(request, response))).ok();
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub struct GatewayResponse {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AgentHubError>,
}

impl GatewayResponse {
    pub fn success(request_id: String, data: Value) -> Self {
        Self { request_id, ok: true, data: Some(data), error: None }
    }

    pub fn failure(request_id: String, error: AgentHubError) -> Self {
        Self { request_id, ok: false, data: None, error: Some(error) }
    }
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

/// Pre-created pipe instances so concurrent clients rarely hit
/// ERROR_PIPE_BUSY (os error 231): the accept loop pops a ready instance,
/// connects it, then refills the pool instead of creating the next instance
/// only after the previous client has connected.
const PIPE_INSTANCE_POOL: usize = 4;

enum Listener {
    #[cfg(windows)]
    Pipe {
        path: String,
        instances: std::collections::VecDeque<tokio::net::windows::named_pipe::NamedPipeServer>,
    },
    #[cfg(unix)]
    Unix(tokio::net::UnixListener),
}

impl Listener {
    fn bind(path: &str) -> std::io::Result<Self> {
        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ServerOptions;
            let mut instances = std::collections::VecDeque::new();
            // Windows named pipes default to a 4KB kernel buffer per direction.
            // Replaying a large session can return multi-MB JSON over one
            // response; the 4KB default turns that into thousands of blocking
            // pipe round-trips (~2MB/s) and multi-second replays. Large
            // buffers keep big responses flowing at line rate instead.
            let options = || {
                let mut options = ServerOptions::new();
                options.in_buffer_size(1024 * 1024);
                options.out_buffer_size(4 * 1024 * 1024);
                options
            };
            // The first instance establishes the pipe name; the rest are extra
            // instances of the same pipe (up to PIPE_UNLIMITED_INSTANCES).
            let first = options().first_pipe_instance(true).create(path)?;
            instances.push_back(first);
            for _ in 1..PIPE_INSTANCE_POOL {
                match options().create(path) {
                    Ok(instance) => instances.push_back(instance),
                    Err(_) => break, // pool is best-effort; single instance still works
                }
            }
            return Ok(Self::Pipe { path: path.to_string(), instances });
        }
        #[cfg(unix)]
        {
            // A stale socket file from a crashed daemon must not block startup.
            if Path::new(path).exists() {
                let _ = std::fs::remove_file(path);
            }
            return Ok(Self::Unix(tokio::net::UnixListener::bind(path)?));
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = path;
            Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "unsupported platform"))
        }
    }

    async fn accept(&mut self) -> std::io::Result<Box<dyn Stream>> {
        match self {
            #[cfg(windows)]
            Self::Pipe { path, instances } => {
                use tokio::net::windows::named_pipe::ServerOptions;
                // Refill the pool first so concurrent clients have a ready
                // instance to connect to.
                while instances.len() < PIPE_INSTANCE_POOL {
                    let mut options = ServerOptions::new();
                    options.in_buffer_size(1024 * 1024);
                    options.out_buffer_size(4 * 1024 * 1024);
                    match options.create(path.as_str()) {
                        Ok(instance) => instances.push_back(instance),
                        Err(_) => break,
                    }
                }
                let server = instances.pop_front().expect("named pipe instance pool must not be empty");
                server.connect().await?;
                Ok(Box::new(server))
            }
            #[cfg(unix)]
            Self::Unix(listener) => {
                let (stream, _) = listener.accept().await?;
                Ok(Box::new(stream))
            }
        }
    }
}

pub struct Gateway {
    token: String,
    socket_path: String,
    token_path: PathBuf,
    router: Arc<Router>,
}

impl Gateway {
    /// Binds the socket and writes the auth token file (mode 0600 on unix).
    pub fn start(socket_path: String, token_path: PathBuf, router: Router) -> anyhow::Result<(Arc<Self>, tokio::task::JoinHandle<()>)> {
        let token = Uuid::new_v4().to_string();
        if let Some(parent) = token_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&token_path, &token)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600));
        }
        let listener = Listener::bind(&socket_path)?;
        let gateway = Arc::new(Self { token, socket_path, token_path, router: Arc::new(router) });
        let accept_gateway = gateway.clone();
        let task = tokio::spawn(async move {
            let mut listener = listener;
            loop {
                match listener.accept().await {
                    Ok(stream) => {
                        let gateway = accept_gateway.clone();
                        tokio::spawn(async move {
                            if let Err(error) = handle_connection(stream, gateway).await {
                                eprintln!("[nautilo-core] connection error: {error}");
                            }
                        });
                    }
                    Err(error) => {
                        eprintln!("[nautilo-core] accept error: {error}");
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                }
            }
        });
        Ok((gateway, task))
    }

    pub fn socket_path(&self) -> &str {
        &self.socket_path
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn cleanup(&self) {
        if cfg!(unix) {
            let _ = std::fs::remove_file(&self.socket_path);
        }
        let _ = std::fs::remove_file(&self.token_path);
    }
}

async fn handle_connection(stream: Box<dyn Stream>, gateway: Arc<Gateway>) -> anyhow::Result<()> {
    let (read, mut write) = tokio::io::split(stream);
    let mut lines = BufReader::new(read).lines();
    let mut authenticated = false;
    // Requests are answered sequentially per connection, matching the TS
    // gateway's processing chain — clients rely on response order.
    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if !authenticated {
            let token = serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|value| value.get("token")?.as_str().map(str::to_string));
            if token.as_deref() == Some(gateway.token.as_str()) {
                authenticated = true;
                write_line(&mut write, &serde_json::json!({
                    "requestId": "auth",
                    "ok": true,
                    "data": { "authenticated": true }
                }))
                .await?;
            } else {
                write_line(&mut write, &serde_json::json!({
                    "requestId": "auth",
                    "ok": false,
                    "error": AgentHubError::simple(ErrorCode::IpcInvalidRequest)
                }))
                .await?;
                return Ok(()); // destroy the socket on auth failure
            }
            continue;
        }
        let parsed = serde_json::from_str::<Value>(line);
        let request = parsed
            .ok()
            .and_then(|value| value.get("request").cloned())
            .and_then(|value| serde_json::from_value::<GatewayRequest>(value).ok())
        ;
        match request {
            Some(request) => {
                let response = gateway.router.dispatch(&request).await;
                write_line(&mut write, &serde_json::to_value(&response)?).await?;
            }
            None => {
                let mut details = Map::new();
                details.insert("cause".to_string(), Value::String("request is missing".to_string()));
                write_line(&mut write, &serde_json::json!({
                    "requestId": "invalid",
                    "ok": false,
                    "error": AgentHubError::new(ErrorCode::IpcInvalidRequest, Some(details))
                }))
                .await?;
            }
        }
    }
    Ok(())
}

async fn write_line(write: &mut (impl AsyncWrite + Unpin), value: &Value) -> anyhow::Result<()> {
    let mut payload = serde_json::to_vec(value)?;
    payload.push(b'\n');
    write.write_all(&payload).await?;
    write.flush().await?;
    Ok(())
}

pub fn read_gateway_token(token_path: &Path) -> std::io::Result<String> {
    Ok(std::fs::read_to_string(token_path)?.trim().to_string())
}
