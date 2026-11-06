//! Independent app-server processes with optional user-selected capacity. A process belongs to one local
//! session for its entire lifetime; hard cancellation cannot kill a sibling.
use super::*;
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use std::sync::atomic::{AtomicU64, AtomicUsize};
use tokio::sync::Notify;

const BOOTSTRAP_TTL: Duration = Duration::from_secs(60);
static MANAGER: LazyLock<Mutex<HashMap<String, InstancePool>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static CHANGED: LazyLock<Notify> = LazyLock::new(Notify::new);
// Only the first successful initialize for a shared HOME needs a bootstrap
// gate. Warm homes and unrelated homes launch independently afterwards.
struct Bootstrap { lock: tokio::sync::Mutex<()>, ready: AtomicBool }
const BOOTSTRAP_CACHE_LIMIT: usize = 256;
static BOOTSTRAPS: LazyLock<Mutex<HashMap<u64, (Arc<Bootstrap>, Instant)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static STOPPING: AtomicBool = AtomicBool::new(false);
static STARTING: AtomicUsize = AtomicUsize::new(0);
static NEXT_WAITER: AtomicU64 = AtomicU64::new(0);
struct Starting;
impl Drop for Starting {
    fn drop(&mut self) { STARTING.fetch_sub(1, Ordering::SeqCst); CHANGED.notify_waiters(); }
}
struct Probe {instance:String,session:String,token:String}
impl Drop for Probe {
    fn drop(&mut self){
        if let Some(slot)=MANAGER.lock().unwrap().get_mut(&self.instance).and_then(|pool|pool.slots.get_mut(&self.session)).filter(|slot|slot.token==self.token) {
            slot.closing=false;slot.used=Instant::now();
        }
        CHANGED.notify_waiters();
    }
}
fn bootstrap_for(request: &AdapterStartRequest) -> Arc<Bootstrap> {
    use std::hash::{Hash, Hasher};
    let env = request.env.as_ref();
    let home = env.and_then(|env| env.get("CODEX_HOME")).cloned()
        .or_else(|| env.and_then(|env| env.get("HOME").or_else(|| env.get("USERPROFILE"))).map(|home| format!("{home}/.codex")));
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    if let Some(home) = home {
        let home = std::path::Path::new(&home);
        let home = if home.is_absolute() { home.to_path_buf() } else { std::path::Path::new(&request.cwd).join(home) };
        home.hash(&mut hash);
    } else {
        "default-codex-home".hash(&mut hash);
    }
    let key = hash.finish();
    let mut cache = BOOTSTRAPS.lock().unwrap();
    cache.retain(|_, (entry, used)| Arc::strong_count(entry) > 1 || used.elapsed() < BOOTSTRAP_TTL);
    // The cache cap bounds only inert hash metadata, never active sessions or
    // bootstrap work. Eviction merely repeats a conservative first-init gate.
    while cache.len() >= BOOTSTRAP_CACHE_LIMIT && !cache.contains_key(&key) {
        let oldest = cache.iter().filter(|(_, (entry, _))| Arc::strong_count(entry) == 1)
            .min_by_key(|(_, (_, used))| *used).map(|(key, _)| *key);
        if let Some(oldest) = oldest { cache.remove(&oldest); } else { break; }
    }
    let (entry, used) = cache.entry(key).or_insert_with(|| (
        Arc::new(Bootstrap { lock: tokio::sync::Mutex::new(()), ready: AtomicBool::new(false) }), Instant::now(),
    ));
    *used = Instant::now();
    entry.clone()
}

#[derive(Default)]
struct InstancePool {
    closed: bool,
    capacity: Option<usize>,
    slots: HashMap<String, Slot>,
    queue: VecDeque<Waiter>,
    targets: HashMap<String, u64>,
}
struct Slot {
    token: String,
    fingerprint: u64,
    connection: Option<Arc<PooledCodexAppServer>>,
    committed: bool,
    busy: bool,
    closing: bool,
    used: Instant,
}
struct Waiter { order: u64, token: String, session: String, fingerprint: u64 }
struct Lease { instance: String, session: String, token: String, connection: Arc<PooledCodexAppServer>, transient: bool }
struct Hooks {
    steer: Option<Arc<dyn Fn(String) -> crate::adapters::BoxFuture<CoreResult<()>> + Send + Sync>>,
    write: Box<dyn Fn(String) + Send + Sync>,
}

pub(super) fn capacity(instance: &Value) -> Option<usize> {
    instance.pointer("/providerOptions/appServerPoolSize").and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 1.0 && value.fract() == 0.0 && *value <= 9_007_199_254_740_991.0 && *value < usize::MAX as f64)
        .map(|value| value as usize)
}

fn is_cancelled(receiver: &watch::Receiver<bool>) -> bool {
    *receiver.borrow() || receiver.has_changed().is_err()
}

fn instance_key(request: &AdapterStartRequest) -> String {
    request.instance.get("id").and_then(Value::as_str)
        .or_else(|| request.instance.get("executable").and_then(Value::as_str)).unwrap_or("codex").to_string()
}
fn prune(pool: &mut InstancePool) {
    let slots = &pool.slots;
    let queue = &pool.queue;
    pool.targets.retain(|session, _| slots.contains_key(session) || queue.iter().any(|waiter| &waiter.session == session));
}
fn remove_waiter(instance: &str, token: &str) {
    let mut pools = MANAGER.lock().unwrap();
    if let Some(pool) = pools.get_mut(instance) {
        pool.queue.retain(|waiter| waiter.token != token);
        prune(pool);
        if pool.queue.is_empty() && pool.slots.is_empty() { pools.remove(instance); }
    }
    CHANGED.notify_waiters();
}
async fn close_slot(instance: &str, session: &str, token: &str, connection: Option<Arc<PooledCodexAppServer>>) {
    if let Some(connection) = connection {
        connection.rpc.process_handle().cancel().await;
        discard_codex_app_server(&connection);
    }
    let mut pools = MANAGER.lock().unwrap();
    if let Some(pool) = pools.get_mut(instance) {
        if pool.slots.get(session).is_some_and(|slot| slot.token == token) { pool.slots.remove(session); }
        prune(pool);
        if pool.queue.is_empty() && pool.slots.is_empty() { pools.remove(instance); }
    }
    CHANGED.notify_waiters();
}

impl Lease {
    async fn release(self) {
        let close = {
            let mut pools = MANAGER.lock().unwrap();
            let Some(pool) = pools.get_mut(&self.instance) else { return; };
            let current = pool.targets.get(&self.session).copied();
            let closed = pool.closed;
            let Some(slot) = pool.slots.get_mut(&self.session).filter(|slot| slot.token == self.token) else { return; };
            if self.transient || closed || !self.connection.rpc.process_handle().is_alive() || current != Some(slot.fingerprint) {
                slot.closing = true;
                true
            } else {
                slot.busy = false;
                slot.used = Instant::now();
                false
            }
        };
        if close {
            close_slot(&self.instance, &self.session, &self.token, Some(self.connection)).await;
        } else {
            CHANGED.notify_waiters();
        }
    }
}

pub(super) fn background_changed(){CHANGED.notify_waiters();}
pub(super) async fn release_session(request:&AdapterStartRequest)->CoreResult<()> {
    let instance=instance_key(request);let session=request.local_session_id.as_deref().unwrap_or("");
    let retired={let mut pools=MANAGER.lock().unwrap();
        if let Some(slot)=pools.get_mut(&instance).and_then(|pool|pool.slots.get_mut(session)) {
            if slot.busy{return Err(crate::errors::invalid("sessionId","Codex is still running"));}
            slot.closing=true;Some((slot.token.clone(),slot.connection.clone()))
        }else{None}};
    if let Some((token,connection))=retired {close_slot(&instance,session,&token,connection).await;}Ok(())
}

async fn stopped(instance: &str) {
    loop {
        let notified = CHANGED.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let closed = STOPPING.load(Ordering::SeqCst) || MANAGER.lock().unwrap().get(instance).map_or(true, |pool| pool.closed);
        if closed { return; }
        notified.await;
    }
}
async fn shutdown_instance(instance: &str) {
    let slots: Vec<_> = {
        let mut pools = MANAGER.lock().unwrap();
        if let Some(pool) = pools.get_mut(instance) {
            pool.closed = true;
            pool.slots.iter().map(|(session, slot)| (session.clone(), slot.token.clone(), slot.connection.clone())).collect()
        } else { vec![] }
    };
    CHANGED.notify_waiters();
    for (session, token, connection) in slots { close_slot(instance, &session, &token, connection).await; }
}
pub(super) async fn shutdown() {
    STOPPING.store(true, Ordering::SeqCst);
    let instances: Vec<_> = MANAGER.lock().unwrap().keys().cloned().collect();
    CHANGED.notify_waiters();
    for instance in &instances { shutdown_instance(instance).await; }
    loop {
        let notified = CHANGED.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if STARTING.load(Ordering::SeqCst) == 0 { break; }
        notified.await;
    }
    for instance in instances { shutdown_instance(&instance).await; }
    BOOTSTRAPS.lock().unwrap().clear();
}

enum Action { Wait, Reuse(Arc<PooledCodexAppServer>), Spawn, Close(String, String, Option<Arc<PooledCodexAppServer>>), Check(String,String,Arc<PooledCodexAppServer>) }
async fn acquire(
    request: &AdapterStartRequest, cancel: &mut watch::Receiver<bool>, deadline: tokio::time::Instant,
    sender: &mpsc::UnboundedSender<AdapterEvent>, transient: bool, independent: bool,
) -> CoreResult<Option<Lease>> {
    if STOPPING.load(Ordering::SeqCst) { return Err(CoreError::reason(ErrorCode::RunStartFailed, "Codex pool is shutting down")); }
    let session = request.local_session_id.clone().expect("session assigned by pool wrapper");
    // Native tool subcalls may be awaited by a turn already occupying the
    // explicit conversation limit. Give sessionless one-shot calls their own
    // admission scope, while retaining HOME gating and shutdown tracking.
    let instance = if independent { format!("transient:{session}") } else { instance_key(request) };
    let fingerprint = codex_config_fingerprint(request);
    let token = Uuid::new_v4().to_string();
    let order = NEXT_WAITER.fetch_add(1, Ordering::Relaxed);
    {
        let mut pools = MANAGER.lock().unwrap();
        let pool = pools.entry(instance.clone()).or_default();
        if pool.closed { return Err(CoreError::reason(ErrorCode::RunStartFailed, "Codex pool is shutting down")); }
        pool.capacity = capacity(&request.instance);
        pool.targets.insert(session.clone(), fingerprint);
        pool.queue.push_back(Waiter { order, token: token.clone(), session: session.clone(), fingerprint });
    }
    CHANGED.notify_waiters();
    let mut announced = false;
    loop {
        let notified = CHANGED.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if is_cancelled(cancel) { remove_waiter(&instance, &token); return Ok(None); }
        if tokio::time::Instant::now() >= deadline {
            remove_waiter(&instance, &token);
            let _ = sender.send(AdapterEvent::Timeout { reason: TimeoutKind::Timeout });
            return Ok(None);
        }
        let action = {
            let mut pools = MANAGER.lock().unwrap();
            let Some(pool) = pools.get_mut(&instance) else { return Err(CoreError::reason(ErrorCode::RunStartFailed, "Codex pool was closed")); };
            if pool.closed || STOPPING.load(Ordering::SeqCst) {
                pool.queue.retain(|waiter| waiter.token != token);
                prune(pool);
                return Err(CoreError::reason(ErrorCode::RunStartFailed, "Codex pool is shutting down"));
            }
            if pool.targets.get(&session) != Some(&fingerprint) {
                pool.queue.retain(|waiter| waiter.token != token);
                prune(pool);
                CHANGED.notify_waiters();
                return Err(CoreError::reason(ErrorCode::RunStartFailed, "Codex configuration changed while this session was queued"));
            }
            // First admissible FIFO: a same-session waiter must not block an
            // unrelated session from using another free process slot.
            let eligible = pool.queue.iter().find(|waiter| {
                pool.targets.get(&waiter.session) == Some(&waiter.fingerprint)
                    && !pool.slots.get(&waiter.session).is_some_and(|slot| slot.busy || slot.closing)
            }).is_some_and(|waiter| waiter.token == token);
            if !eligible { Action::Wait }
            else if pool.capacity.is_some_and(|limit| pool.slots.values().filter(|slot| slot.busy || slot.closing).count() >= limit) {
                Action::Wait
            }
            else if let Some(slot) = pool.slots.get_mut(&session) {
                if slot.fingerprint == fingerprint && slot.connection.as_ref().is_some_and(|c| c.rpc.process_handle().is_alive()) {
                    slot.busy = true;
                    slot.token = token.clone();
                    let connection = slot.connection.clone().unwrap();
                    pool.queue.retain(|waiter| waiter.token != token);
                    CHANGED.notify_waiters();
                    Action::Reuse(connection)
                } else {
                    slot.closing = true;
                    Action::Close(session.clone(), slot.token.clone(), slot.connection.clone())
                }
            } else if pool.capacity.map_or(true, |limit| pool.slots.len() < limit) {
                pool.slots.insert(session.clone(), Slot { token: token.clone(), fingerprint, connection: None, committed: false, busy: true, closing: false, used: Instant::now() });
                pool.queue.retain(|waiter| waiter.token != token);
                STARTING.fetch_add(1, Ordering::SeqCst);
                CHANGED.notify_waiters();
                Action::Spawn
            } else if let Some((key, slot)) = pool.slots.iter_mut().filter(|(_, slot)| !slot.busy && !slot.closing).min_by_key(|(_, slot)| slot.used) {
                slot.closing = true;
                match slot.connection.clone() {
                    Some(connection)=>Action::Check(key.clone(),slot.token.clone(),connection),
                    None=>Action::Close(key.clone(),slot.token.clone(),None),
                }
            } else { Action::Wait }
        };
        match action {
            Action::Reuse(connection) => return Ok(Some(Lease { instance, session, token, connection, transient })),
            Action::Close(retired_session, retired_token, connection) => {
                close_slot(&instance, &retired_session, &retired_token, connection).await;
            }
            Action::Check(retired_session,retired_token,connection)=>{
                let probe=Probe{instance:instance.clone(),session:retired_session.clone(),token:retired_token.clone()};
                let ready=tokio::select! {
                    biased;
                    _=cancel.changed()=>{remove_waiter(&instance,&token);return Ok(None);}
                    _=tokio::time::sleep_until(deadline)=>{
                        remove_waiter(&instance,&token);let _=sender.send(AdapterEvent::Timeout{reason:TimeoutKind::Timeout});return Ok(None);
                    }
                    ready=connection.events.retirement_ready(&connection.rpc)=>ready,
                };
                if ready {
                    close_slot(&instance,&retired_session,&retired_token,Some(connection)).await;
                } else {
                    drop(probe);
                    if !announced {
                        announced=true;
                        let _=sender.send(AdapterEvent::Status{phase:"provider_queued".into(),raw:Some(json!({"reason":"codex_native_background_work","capacity":capacity(&request.instance)}))});
                    }
                    // Native terminal jobs may end without another foreground
                    // notification. Recheck only while admission is blocked.
                    tokio::select!{_=cancel.changed()=>{remove_waiter(&instance,&token);return Ok(None);},_=tokio::time::sleep(Duration::from_millis(300))=>{}}
                    CHANGED.notify_waiters();
                }
            }
            Action::Spawn => {
                let _starting = Starting;
                let bootstrap = bootstrap_for(request);
                let mut bootstrap_guard = if bootstrap.ready.load(Ordering::SeqCst) { None } else {
                    let guard = tokio::select! {
                        biased;
                        _ = cancel.changed() => None,
                        _ = stopped(&instance) => None,
                        _ = tokio::time::sleep_until(deadline) => {
                            let _ = sender.send(AdapterEvent::Timeout { reason: TimeoutKind::Timeout }); None
                        }
                        guard = bootstrap.lock.lock() => Some(guard),
                    };
                    let Some(guard) = guard else { close_slot(&instance, &session, &token, None).await; return Ok(None); };
                    if bootstrap.ready.load(Ordering::SeqCst) { drop(guard); None } else { Some(guard) }
                };
                if is_cancelled(cancel) || STOPPING.load(Ordering::SeqCst) || tokio::time::Instant::now() >= deadline {
                    if !is_cancelled(cancel) && tokio::time::Instant::now() >= deadline { let _ = sender.send(AdapterEvent::Timeout { reason: TimeoutKind::Timeout }); }
                    close_slot(&instance, &session, &token, None).await;
                    return Ok(None);
                }
                let admission = {
                    let mut pools = MANAGER.lock().unwrap();
                    if let Some(pool) = pools.get_mut(&instance).filter(|pool| !pool.closed && pool.targets.get(&session) == Some(&fingerprint)) {
                        let full = pool.capacity.is_some_and(|limit| pool.slots.values().filter(|slot| slot.committed).count() >= limit);
                        if full {
                            pool.slots.remove(&session);
                            let index = pool.queue.iter().position(|waiter| waiter.order > order).unwrap_or(pool.queue.len());
                            pool.queue.insert(index, Waiter { order, token: token.clone(), session: session.clone(), fingerprint });
                            0
                        } else if let Some(slot) = pool.slots.get_mut(&session) {
                            slot.committed = true;
                            1
                        } else { -1 }
                    } else { -1 }
                };
                if admission == 0 { drop(bootstrap_guard); CHANGED.notify_waiters(); continue; }
                if admission < 0 {
                    close_slot(&instance, &session, &token, None).await;
                    return Err(CoreError::reason(ErrorCode::RunStartFailed, "Codex configuration changed before startup"));
                }
                let connection = match acquire_codex_app_server(request) {
                    Ok(connection) => connection,
                    Err(error) => { close_slot(&instance, &session, &token, None).await; return Err(error); }
                };
                let reserved = {
                    let mut pools = MANAGER.lock().unwrap();
                    pools.get_mut(&instance).filter(|pool| !pool.closed).and_then(|pool| pool.slots.get_mut(&session))
                        .filter(|slot| slot.token == token).map(|slot| { slot.connection = Some(connection.clone()); }).is_some()
                };
                if !reserved {
                    close_slot(&instance, &session, &token, Some(connection)).await;
                    return Err(CoreError::reason(ErrorCode::RunStartFailed, "Codex pool closed during startup"));
                }
                let initialize = async {
                    if !connection.initialized.load(Ordering::SeqCst) {
                        connection.rpc.request("initialize", codex_app_server_initialize_params()).await?;
                        connection.rpc.notify("initialized", json!({}));
                        connection.initialized.store(true, Ordering::SeqCst);
                    }
                    Ok::<(), anyhow::Error>(())
                };
                let initialized = tokio::select! {
                    biased;
                    _ = cancel.changed() => None,
                    _ = stopped(&instance) => None,
                    _ = tokio::time::sleep_until(deadline) => {
                        let _ = sender.send(AdapterEvent::Timeout { reason: TimeoutKind::Timeout }); None
                    }
                    result = initialize => Some(result),
                };
                match initialized {
                    Some(Ok(())) => {
                        bootstrap.ready.store(true, Ordering::SeqCst);
                        drop(bootstrap_guard.take());
                        let current = {
                            let mut pools = MANAGER.lock().unwrap();
                            pools.get_mut(&instance).is_some_and(|pool| !pool.closed && pool.targets.get(&session) == Some(&fingerprint))
                        };
                        if !current || is_cancelled(cancel) {
                            close_slot(&instance, &session, &token, Some(connection)).await;
                            return if is_cancelled(cancel) { Ok(None) } else { Err(CoreError::reason(ErrorCode::RunStartFailed, "Codex configuration changed during startup")) };
                        }
                        return Ok(Some(Lease { instance, session, token, connection, transient }));
                    }
                    result => {
                        close_slot(&instance, &session, &token, Some(connection)).await;
                        return match result { Some(Err(error)) => Err(CoreError::reason(ErrorCode::RunStartFailed, error.to_string())), _ => Ok(None) };
                    }
                }
            }
            Action::Wait => {
                if !announced {
                    announced = true;
                    let _ = sender.send(AdapterEvent::Status { phase: "provider_queued".to_string(), raw: Some(json!({ "reason": "codex_session_capacity", "capacity": capacity(&request.instance) })) });
                }
                tokio::select! {
                    biased;
                    _ = cancel.changed() => { remove_waiter(&instance, &token); return Ok(None); }
                    _ = tokio::time::sleep_until(deadline) => {
                        remove_waiter(&instance, &token);
                        let _ = sender.send(AdapterEvent::Timeout { reason: TimeoutKind::Timeout });
                        return Ok(None);
                    }
                    _ = &mut notified => {}
                }
            }
        }
    }
}

pub(super) fn start(mut request: AdapterStartRequest, resume: Option<String>, force_transient: bool) -> CoreResult<AdapterRun> {
    let missing_session = request.local_session_id.as_deref().map_or(true, str::is_empty);
    let transient = force_transient || missing_session;
    if missing_session { request.local_session_id = Some(format!("transient-{}", Uuid::new_v4())); }
    let deadline = tokio::time::Instant::now() + Duration::from_millis(request.timeout_ms.unwrap_or(30 * 60_000));
    let queued_at = Instant::now();
    let (sender, receiver) = mpsc::unbounded_channel();
    let (cancel_sender, mut cancelled) = watch::channel(false);
    let (done_sender, done) = oneshot::channel();
    let hooks: Arc<Mutex<Option<Hooks>>> = Arc::new(Mutex::new(None));
    let active_hooks = hooks.clone();
    tokio::spawn(async move {
        let acquired = acquire(&request, &mut cancelled, deadline, &sender, transient, missing_session).await;
        match acquired {
            Ok(Some(lease)) => {
                if is_cancelled(&cancelled) || tokio::time::Instant::now() >= deadline {
                    if !is_cancelled(&cancelled) { let _ = sender.send(AdapterEvent::Timeout { reason: TimeoutKind::Timeout }); }
                    lease.release().await;
                } else {
                    request.timeout_ms = Some(deadline.saturating_duration_since(tokio::time::Instant::now()).as_millis().max(1) as u64);
                    match start_on_connection(request, resume, lease.connection.clone(), false) {
                        Ok(inner) => {
                            let (mut events, cancel, steer, write) = inner.into_parts();
                            *active_hooks.lock().unwrap() = Some(Hooks { steer, write });
                            let mut cancel = Some(cancel);
                            let mut is_cancelled = false;
                            loop {
                                tokio::select! {
                                    biased;
                                    _ = cancelled.changed(), if !is_cancelled => {
                                        is_cancelled = true;
                                        if let Some(cancel) = cancel.take() { cancel().await; }
                                    }
                                    event = events.recv() => {
                                        let Some(mut event) = event else { break; };
                                        if let AdapterEvent::Status { phase, raw } = &mut event {
                                            if phase == "provider_starting" {
                                                let mut data = raw.take().and_then(|value| value.as_object().cloned()).unwrap_or_default();
                                                data.insert("queueWaitMs".to_string(), json!(queued_at.elapsed().as_millis() as u64));
                                                *raw = Some(Value::Object(data));
                                            }
                                        }
                                        if sender.send(event).is_err() {
                                            if let Some(cancel) = cancel.take() { cancel().await; }
                                            break;
                                        }
                                    }
                                }
                            }
                            *active_hooks.lock().unwrap() = None;
                            lease.release().await;
                        }
                        Err(error) => {
                            let _ = sender.send(AdapterEvent::Error { message: error.to_string() });
                            lease.release().await;
                        }
                    }
                }
            }
            Err(error) => { let _ = sender.send(AdapterEvent::Error { message: error.to_string() }); }
            Ok(None) => {}
        }
        let _ = done_sender.send(());
    });
    let write_hooks = hooks.clone();
    Ok(AdapterRun::new(receiver, move || Box::pin(async move {
        let _ = cancel_sender.send(true);
        let _ = done.await;
    }), move |input| {
        if let Some(hooks) = write_hooks.lock().unwrap().as_ref() { (hooks.write)(input); }
    }).with_steer(Arc::new(move |input| {
        let steer = hooks.lock().unwrap().as_ref().and_then(|hooks| hooks.steer.clone());
        Box::pin(async move {
            match steer {
                Some(steer) => steer(input).await,
                None => Err(CoreError::reason(ErrorCode::IpcInvalidRequest, "No active Codex turn is available to steer")),
            }
        })
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(session: &str, prompt: &str, limit: Option<usize>) -> (AdapterStartRequest, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("nautilo-session-pool-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("app-server"), include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/core-daemon/test/fixtures/fake-codex-pool.cjs"))).unwrap();
        let mut env: HashMap<String, String> = std::env::vars().filter(|(key, _)| ["PATH", "SystemRoot", "PATHEXT"].contains(&key.as_str())).collect();
        env.insert("CODEX_FAKE_LOG".to_string(), root.join("rpc.ndjson").to_string_lossy().into_owned());
        env.insert("CODEX_HOME".to_string(), root.to_string_lossy().into_owned());
        (AdapterStartRequest {
            instance: json!({ "id": Uuid::new_v4().to_string(), "providerId": "codex", "executable": std::env::var("NAUTILO_TEST_NODE").unwrap_or_else(|_| "node".to_string()), "providerOptions": { "appServerPoolSize": limit } }),
            local_session_id: Some(session.to_string()), prompt: prompt.to_string(), cwd: root.to_string_lossy().into_owned(), env: Some(env), timeout_ms: Some(6_000),
            ..Default::default()
        }, root)
    }
    fn logs(root: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(root.join("rpc.ndjson")).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }
    async fn phase(run: &mut AdapterRun, expected: &str) {
        tokio::time::timeout(Duration::from_secs(4), async {
            while let Some(event) = run.events.recv().await {
                if matches!(event, AdapterEvent::Status { ref phase, .. } if phase == expected) { return; }
            }
            panic!("missing phase {expected}");
        }).await.unwrap();
    }
    async fn collect(run: &mut AdapterRun) -> Vec<AdapterEvent> {
        tokio::time::timeout(Duration::from_secs(7), async {
            let mut events = vec![];
            while let Some(event) = run.events.recv().await { events.push(event); }
            events
        }).await.unwrap()
    }
    async fn finish(request: &AdapterStartRequest, root: std::path::PathBuf) {
        shutdown_instance(&instance_key(request)).await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn unlimited_default_and_only_positive_integer_limits() {
        for value in [Value::Null, json!(0), json!(-1), json!(2.5), json!("4"), json!(9_007_199_254_740_992_u64)] {
            assert_eq!(capacity(&json!({ "providerOptions": { "appServerPoolSize": value } })), None);
        }
        for value in [1, 2, 4, 6, 12] {
            assert_eq!(capacity(&json!({ "providerOptions": { "appServerPoolSize": value } })), Some(value));
        }
    }

    #[tokio::test]
    async fn warm_turn_skips_resume_but_updates_turn_settings_and_cold_process_restores_identity() {
        let (base, root) = request("a", "fast-a", Some(1));
        let mut first = start_codex_app_server(base.clone(), None).unwrap();
        let events = collect(&mut first).await;
        let thread_id = events.iter().find_map(|event| match event {
            AdapterEvent::Session { provider_session_id, .. } => Some(provider_session_id.clone()), _ => None
        }).unwrap();
        let mut next = base.clone(); next.prompt = "fast-b".to_string();
        next.permission_mode = Some("full-access".to_string());
        next.reasoning_effort = Some("max".to_string());
        let mut second = start_codex_app_server(next.clone(), Some(thread_id.clone())).unwrap();
        assert!(!collect(&mut second).await.iter().any(|event| matches!(event, AdapterEvent::Error { .. })));
        let recorded = logs(&root);
        assert_eq!(recorded.iter().filter(|v| v["method"] == "initialize").count(), 1);
        assert_eq!(recorded.iter().filter(|v| v["method"] == "thread/start").count(), 1);
        assert_eq!(recorded.iter().filter(|v| v["method"] == "thread/resume").count(), 0);
        let turns: Vec<_> = recorded.iter().filter(|v| v["method"] == "turn/start").collect();
        assert_eq!(turns[1]["params"]["threadId"], thread_id);
        assert_eq!(turns[1]["params"]["approvalPolicy"], "never");
        assert_eq!(turns[1]["params"]["sandboxPolicy"]["type"], "dangerFullAccess");
        assert_eq!(turns[1]["params"]["effort"], "max");
        let previous_pid = turns[0]["pid"].clone();
        shutdown_instance(&instance_key(&base)).await;
        next.prompt = "fast-c".to_string(); next.permission_mode = Some("ask".to_string());
        let mut third = start_codex_app_server(next, Some(thread_id.clone())).unwrap();
        assert!(!collect(&mut third).await.iter().any(|event| matches!(event, AdapterEvent::Error { .. })));
        let recorded = logs(&root);
        let resumed: Vec<_> = recorded.iter().filter(|v| v["method"] == "thread/resume").collect();
        assert_eq!(resumed.len(), 1);
        assert_eq!(resumed[0]["params"]["threadId"], thread_id);
        assert_eq!(resumed[0]["params"]["excludeTurns"], true);
        assert_ne!(resumed[0]["pid"], previous_pid);
        finish(&base, root).await;
    }

    #[tokio::test]
    async fn default_allows_parent_and_five_children_before_any_completion() {
        let (base, root) = request("parent", "hang", None);
        let mut runs = vec![];
        for index in 0..6 {
            let mut next = base.clone(); next.local_session_id = Some(format!("session-{index}"));
            runs.push(start_codex_app_server(next, None).unwrap());
        }
        for run in &mut runs { phase(run, "turn_started").await; }
        let recorded = logs(&root);
        assert_eq!(recorded.iter().filter(|value| value["method"] == "turn/start").count(), 6);
        assert_eq!(recorded.iter().filter(|value| value.get("done").is_some()).count(), 0);
        let pids: std::collections::HashSet<_> = recorded.iter().filter(|value| value["method"] == "turn/start").filter_map(|value| value["pid"].as_u64()).collect();
        assert_eq!(pids.len(), 6);
        for run in runs { run.cancel().await; }
        finish(&base, root).await;
    }

    #[tokio::test]
    async fn explicit_limit_queues_third_and_cancel_does_not_hurt_sibling() {
        let (base, root) = request("a", "hang", Some(2));
        let mut a = start_codex_app_server(base.clone(), None).unwrap();
        let mut next = base.clone(); next.local_session_id = Some("b".to_string());
        let mut b = start_codex_app_server(next, None).unwrap();
        phase(&mut a, "turn_started").await; phase(&mut b, "turn_started").await;
        let mut next = base.clone(); next.local_session_id = Some("c".to_string()); next.prompt = "fast-c".to_string();
        let mut c = start_codex_app_server(next, None).unwrap(); phase(&mut c, "provider_queued").await;
        assert_eq!(logs(&root).iter().filter(|value| value["method"] == "turn/start").count(), 2);
        a.cancel().await;
        let events = collect(&mut c).await;
        assert!(events.iter().any(|event| matches!(event, AdapterEvent::Message { text, .. } if text == "done:fast-c")));
        assert!(MANAGER.lock().unwrap().get(&instance_key(&base)).unwrap().slots["b"].connection.as_ref().unwrap().rpc.process_handle().is_alive());
        b.cancel().await; finish(&base, root).await;
    }

    #[tokio::test]
    async fn same_session_serial_and_fifo_does_not_block_free_sibling_slot() {
        let (base, root) = request("a", "hang", Some(2));
        let mut a = start_codex_app_server(base.clone(), None).unwrap(); phase(&mut a, "turn_started").await;
        let pid = logs(&root).iter().find(|value| value["method"] == "turn/start").unwrap()["pid"].as_u64().unwrap();
        let mut next = base.clone(); next.prompt = "fast-next".to_string();
        let mut queued = start_codex_app_server(next, Some(format!("thread-{pid}"))).unwrap(); phase(&mut queued, "provider_queued").await;
        let mut next = base.clone(); next.local_session_id = Some("b".to_string());
        let mut b = start_codex_app_server(next, None).unwrap(); phase(&mut b, "turn_started").await;
        a.cancel().await;
        let events = collect(&mut queued).await;
        assert!(events.iter().any(|event| matches!(event, AdapterEvent::Message { text, .. } if text == "done:fast-next")));
        assert_eq!(logs(&root).iter().filter(|value| value["pid"] == pid && value["method"] == "initialize").count(), 1);
        b.cancel().await; finish(&base, root).await;
    }

    #[tokio::test]
    async fn distinct_session_contexts_and_identical_request_ids_stay_isolated() {
        let (base, root) = request("a", "tools", None);
        let calls = Arc::new(Mutex::new(vec![]));
        let mut runs = vec![];
        for session in ["a", "b"] {
            let mut next = base.clone(); next.local_session_id = Some(session.to_string());
            next.env.as_mut().unwrap().insert("SESSION_CONTEXT".to_string(), session.to_string());
            next.permission_mode = Some(if session == "a" { "ask" } else { "full-access" }.to_string());
            let calls = calls.clone(); let owned = session.to_string();
            next.execute_runtime_tool = Some(Arc::new(move |input| {
                calls.lock().unwrap().push((owned.clone(), input["arguments"]["pid"].clone()));
                Box::pin(async { Ok(json!({ "success": true, "content": "scoped" })) })
            }));
            next.request_interaction = Some(Arc::new(|_| Box::pin(async { Ok(json!({ "outcome": "selected", "optionId": "accept" })) })));
            runs.push(start_codex_app_server(next, None).unwrap());
        }
        for run in &mut runs { assert!(!collect(run).await.iter().any(|event| matches!(event, AdapterEvent::Error { .. }))); }
        let calls = calls.lock().unwrap(); assert_eq!(calls.len(), 2); assert_ne!(calls[0].1, calls[1].1); drop(calls);
        let recorded = logs(&root);
        let approvals: Vec<_> = recorded.iter().filter(|value| value["method"] == "thread/start").map(|value| value["params"]["approvalPolicy"].clone()).collect();
        assert!(approvals.contains(&json!("on-request"))); assert!(approvals.contains(&json!("never")));
        finish(&base, root).await;
    }

    #[tokio::test]
    async fn queue_timeout_and_drop_do_not_spawn_more_processes() {
        let (base, root) = request("a", "hang", Some(1));
        let mut a = start_codex_app_server(base.clone(), None).unwrap(); phase(&mut a, "turn_started").await;
        let mut next = base.clone(); next.local_session_id = Some("b".to_string()); next.timeout_ms = Some(20);
        let mut b = start_codex_app_server(next, None).unwrap();
        assert!(collect(&mut b).await.iter().any(|event| matches!(event, AdapterEvent::Timeout { .. })));
        let mut next = base.clone(); next.local_session_id = Some("c".to_string());
        let mut c = start_codex_app_server(next, None).unwrap(); phase(&mut c, "provider_queued").await; drop(c);
        tokio::task::yield_now().await;
        assert_eq!(logs(&root).iter().filter(|value| value["spawned"] == true).count(), 1);
        a.cancel().await; finish(&base, root).await;
    }

    #[tokio::test]
    async fn failed_bootstrap_releases_capacity_and_warm_process_requires_explicit_release() {
        let (base, root) = request("a", "forbidden", Some(1));
        let mut slow = base.clone(); slow.env.as_mut().unwrap().insert("INIT_DELAY".to_string(), "10000".to_string()); slow.timeout_ms = Some(50);
        let mut a = start_codex_app_server(slow, None).unwrap();
        let mut next = base.clone(); next.local_session_id = Some("b".to_string()); next.prompt = "fast".to_string();
        let mut b = start_codex_app_server(next, None).unwrap();
        assert!(collect(&mut a).await.iter().any(|event| matches!(event, AdapterEvent::Timeout { .. })));
        assert!(collect(&mut b).await.iter().any(|event| matches!(event, AdapterEvent::Message { text, .. } if text == "done:fast")));
        let key = instance_key(&base);
        let connection = {
            let mut pools = MANAGER.lock().unwrap(); let slot = pools.get_mut(&key).unwrap().slots.get_mut("b").unwrap();
            slot.used = Instant::now() - Duration::from_secs(600);
            slot.connection.clone().unwrap()
        };
        assert!(connection.rpc.process_handle().is_alive());
        let mut released=base.clone();released.local_session_id=Some("b".into());release_session(&released).await.unwrap();
        assert!(!connection.rpc.process_handle().is_alive());
        finish(&base, root).await;
    }

    #[tokio::test]
    async fn transient_bridge_and_missing_session_never_remain_warm() {
        let (mut base, root) = request("bridge", "fast", None);
        let mut bridge = start(base.clone(), None, true).unwrap(); collect(&mut bridge).await;
        assert!(MANAGER.lock().unwrap().get(&instance_key(&base)).map_or(true, |pool| pool.slots.is_empty()));
        base.local_session_id = None;
        let mut search = start_codex_app_server(base.clone(), None).unwrap(); collect(&mut search).await;
        assert!(MANAGER.lock().unwrap().get(&instance_key(&base)).map_or(true, |pool| pool.slots.is_empty()));
        finish(&base, root).await;
    }

    #[tokio::test]
    async fn sessionless_nested_tool_does_not_deadlock_at_conversation_limit_one() {
        let (base, root) = request("parent", "hang", Some(1));
        let mut parent = start_codex_app_server(base.clone(), None).unwrap();
        phase(&mut parent, "turn_started").await;
        let mut nested = base.clone(); nested.local_session_id = None; nested.prompt = "fast-search".to_string();
        let mut search = start_codex_app_server(nested, None).unwrap();
        assert!(collect(&mut search).await.iter().any(|event| matches!(event, AdapterEvent::Message { text, .. } if text == "done:fast-search")));
        assert!(MANAGER.lock().unwrap().get(&instance_key(&base)).unwrap().slots["parent"].connection.as_ref().unwrap().rpc.process_handle().is_alive());
        assert_eq!(logs(&root).iter().filter(|value| value["spawned"] == true).count(), 2);
        parent.cancel().await; finish(&base, root).await;
    }

    #[tokio::test]
    async fn shutdown_during_initialization_resolves_active_and_reserved_runs() {
        let (base, root) = request("a", "forbidden", Some(2));
        let mut slow = base.clone(); slow.env.as_mut().unwrap().insert("INIT_DELAY".to_string(), "10000".to_string());
        let mut a = start_codex_app_server(slow, None).unwrap();
        let mut next = base.clone(); next.local_session_id = Some("b".to_string());
        let mut b = start_codex_app_server(next, None).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async { while !logs(&root).iter().any(|value| value["spawned"] == true) { tokio::time::sleep(Duration::from_millis(5)).await; } }).await.unwrap();
        shutdown_instance(&instance_key(&base)).await;
        collect(&mut a).await; collect(&mut b).await;
        assert!(MANAGER.lock().unwrap().get(&instance_key(&base)).map_or(true, |pool| pool.slots.is_empty()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn process_capacity_preserves_native_background_terminal_until_it_finishes() {
        let (base,root)=request("background","background-terminal",Some(1));
        let connection=acquire_codex_app_server(&base).unwrap();let scenario=base.clone();let directory=root.clone();
        let result=tokio::spawn(async move {
            let mut first=start_codex_app_server(scenario.clone(),None).unwrap();collect(&mut first).await;
            let mut next=scenario.clone();next.local_session_id=Some("next".into());next.prompt="fast".into();
            let mut queued=start_codex_app_server(next,None).unwrap();phase(&mut queued,"provider_queued").await;
            tokio::time::timeout(Duration::from_secs(2),async {
                while !logs(&directory).iter().any(|event|event["method"]=="thread/backgroundTerminals/list") {tokio::time::sleep(Duration::from_millis(5)).await;}
            }).await.unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
            let old=acquire_codex_app_server(&scenario).unwrap();assert!(old.rpc.process_handle().is_alive());
            assert_eq!(logs(&directory).iter().filter(|event|event["spawned"]==true).count(),1,"capacity retired a live native terminal");
            old.rpc.request("test/finish-background",json!({})).await.unwrap();
            assert!(collect(&mut queued).await.iter().any(|event|matches!(event,AdapterEvent::Message{text,..} if text=="done:fast")));
            assert!(!old.rpc.process_handle().is_alive());
        }).await;
        connection.rpc.process_handle().cancel().await;discard_codex_app_server(&connection);
        finish(&base,root).await;result.unwrap();
    }
}
