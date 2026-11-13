#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod config;
mod events;
mod interactions;
mod rpc;
mod runtime_tools;
mod session;
#[cfg(test)]
mod tests;

use agenthub_plugin_sdk::{
    process::{self, ProcessEvent},
    DaemonChannel, ProviderPlugin,
};
use serde_json::{json, Value};
use session::Session;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};
use tokio::sync::{mpsc, watch};

static CHANNEL: OnceLock<Arc<dyn DaemonChannel>> = OnceLock::new();
fn raw_channel() -> Option<Arc<dyn DaemonChannel>> {
    CHANNEL.get().cloned()
}

struct RunChannel {
    inner: Arc<dyn DaemonChannel>,
    run: String,
}
impl DaemonChannel for RunChannel {
    fn ask(
        &self,
        _: &str,
        input: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        self.inner.ask(&self.run, input)
    }
    fn call_tool(
        &self,
        _: &str,
        name: &str,
        input: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        self.inner.call_tool(&self.run, name, input)
    }
}
fn bound_channel(request: &Value, run: &str) -> Option<Arc<dyn DaemonChannel>> {
    let channel = raw_channel();
    agenthub_plugin_sdk::session_channel(&channel, request).or_else(|| {
        channel.map(|inner| {
            Arc::new(RunChannel {
                inner,
                run: run.into(),
            }) as Arc<dyn DaemonChannel>
        })
    })
}

#[derive(Default, Clone)]
struct Plugin {
    sessions: Arc<tokio::sync::Mutex<HashMap<String, Arc<Session>>>>,
    runs: Arc<Mutex<HashMap<String, (watch::Sender<bool>, Option<Arc<Session>>)>>>,
    opening: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
}

impl Plugin {
    async fn get_session(
        &self,
        request: &Value,
        resume: Option<&str>,
        run: &str,
    ) -> anyhow::Result<(Arc<Session>, bool)> {
        let key = request["localSessionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Antigravity requires a local session identity"))?;
        // Serialize only this conversation; independent sessions can start concurrently.
        let opening = self
            .opening
            .lock()
            .unwrap()
            .entry(key.into())
            .or_default()
            .clone();
        let _opening = opening.lock().await;
        let old = self.sessions.lock().await.get(key).cloned();
        if let Some(old) = old {
            let same = old.identity == session::config_identity(request)
                && old.rpc.process_handle().is_alive()
                && resume.is_none_or(|id| old.native_id == id);
            if same {
                return Ok((old, true));
            }
            self.sessions.lock().await.remove(key);
            old.close().await;
        }
        let native = Arc::new(Session::open(request, resume, bound_channel(request, run)).await?);
        self.sessions
            .lock()
            .await
            .insert(key.into(), native.clone());
        Ok((native, false))
    }
    async fn probe_session(&self, instance: &Value, context: &Value) -> anyhow::Result<Session> {
        let request = json!({"instance":instance,"cwd":context["cwd"].as_str().map(str::to_owned).unwrap_or_else(||std::env::current_dir().unwrap().to_string_lossy().into()),"env":context.get("env").cloned().unwrap_or_else(||json!(std::env::vars().collect::<HashMap<_,_>>()))});
        Session::open(&request, None, None).await
    }
}

#[async_trait::async_trait]
impl ProviderPlugin for Plugin {
    fn descriptor(&self) -> Value {
        config::descriptor()
    }
    fn capabilities(&self) -> Value {
        let mut profile = agenthub_plugin_sdk::capabilities::profile(
            "acp",
            true,
            &["approval", "question"],
            true,
            true,
            true,
            false,
        );
        profile["resources"]["managedSkills"] = json!("unknown");
        agenthub_plugin_sdk::capabilities::with_profile(
            json!({"structuredOutput":true,"textOutput":true,"interactiveStdin":true,"nativeResume":true,"pty":true}),
            json!({"default":profile,"evidenceSource":"official-agy-acp"}),
        )
    }
    fn set_daemon_channel(&self, channel: Arc<dyn DaemonChannel>) {
        let _ = CHANNEL.set(channel);
    }
    async fn detect(&self, instance: &Value) -> Value {
        let mut plan = match config::process_request(&json!({"instance":instance})) {
            Ok(p) => p,
            Err(e) => return json!({"installed":false,"error":e.to_string()}),
        };
        plan.args = vec!["--version".into()];
        plan.env = Some(std::env::vars().collect());
        plan.timeout_ms = Some(8000);
        plan.max_output_bytes = Some(65536);
        let mut p = match process::start(&plan) {
            Ok(p) => p,
            Err(e) => {
                return json!({"installed":false,"executable":plan.command,"error":e.to_string()})
            }
        };
        let mut text = String::new();
        let mut exit = None;
        while let Some(event) = p.events.recv().await {
            match event {
                ProcessEvent::Stdout(s) | ProcessEvent::Stderr(s) => text.push_str(&s),
                ProcessEvent::Exit { exit_code, .. } => exit = exit_code,
                _ => {}
            }
        }
        json!({"installed":exit==Some(0),"compatible":exit==Some(0),"executable":plan.command,"version":text.trim()})
    }
    async fn list_models(&self, instance: &Value, context: &Value) -> anyhow::Result<Value> {
        let native = self.probe_session(instance, context).await?;
        let catalog = config::catalog(&*native.state.lock().await);
        native.close().await;
        Ok(catalog)
    }
    async fn list_modes(&self, instance: &Value, context: &Value) -> anyhow::Result<Value> {
        let native = self.probe_session(instance, context).await?;
        let modes = native.state.lock().await["modes"].clone();
        native.close().await;
        Ok(json!({"modes":modes["availableModes"],"currentModeId":modes["currentModeId"]}))
    }
    async fn start(
        &self,
        run: &str,
        request: Value,
        resume: Option<String>,
    ) -> anyhow::Result<mpsc::UnboundedReceiver<Value>> {
        let (sender, receiver) = mpsc::unbounded_channel();
        let (cancel, mut cancelled) = watch::channel(false);
        self.runs.lock().unwrap().insert(run.into(), (cancel, None));
        let plugin = self.clone();
        let run = run.to_owned();
        tokio::spawn(async move {
            let started = Instant::now();
            let result=async{
                let (native,reused)=tokio::select!{
                    result=plugin.get_session(&request,resume.as_deref(),&run)=>result?,
                    _=cancelled.changed()=>anyhow::bail!("Antigravity startup cancelled"),
                };
                if let Some(slot)=plugin.runs.lock().unwrap().get_mut(&run){slot.1=Some(native.clone());}
                sender.send(json!({"kind":"status","phase":"configuration_ready","raw":{"elapsedMs":started.elapsed().as_millis()}}))?;
                let result=native.turn(&request,sender.clone(),reused).await;
                if result.is_err(){plugin.sessions.lock().await.remove(request["localSessionId"].as_str().unwrap_or(""));native.close().await;}
                result
            }.await;
            plugin.runs.lock().unwrap().remove(&run);
            let code = if let Err(e) = result {
                let _ = sender.send(json!({"kind":"error","message":e.to_string()}));
                1
            } else {
                0
            };
            let _ = sender.send(json!({"kind":"exit","exitCode":code}));
        });
        Ok(receiver)
    }
    async fn cancel(&self, run: &str) {
        let native = {
            let mut runs = self.runs.lock().unwrap();
            runs.get_mut(run)
                .map(|(cancel, native)| {
                    let _ = cancel.send(true);
                    native.clone()
                })
                .flatten()
        };
        if let Some(native) = native {
            native.cancel().await;
            // A non-responsive agent must not retain a blocked turn forever.
            let p = native.rpc.process_handle();
            let runs = self.runs.clone();
            let run = run.to_owned();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                if runs.lock().unwrap().contains_key(&run) {
                    p.cancel().await;
                }
            });
        }
    }
    async fn steer(&self, run: &str, input: &str) -> anyhow::Result<()> {
        let native = self
            .runs
            .lock()
            .unwrap()
            .get(run)
            .and_then(|(_, s)| s.clone())
            .ok_or_else(|| anyhow::anyhow!("Antigravity has no active turn"))?;
        let id = native.state.lock().await["sessionId"].clone();
        // Official ACP treats another prompt during an active turn as steering.
        let result = native
            .rpc
            .request(
                "session/prompt",
                json!({"sessionId":id,"prompt":[{"type":"text","text":input}]}),
            )
            .await?;
        anyhow::ensure!(
            result.get("stopReason").is_some(),
            "Antigravity did not acknowledge the guidance"
        );
        Ok(())
    }
    async fn release_session(&self, request: &Value) -> anyhow::Result<()> {
        let native = self
            .sessions
            .lock()
            .await
            .remove(request["localSessionId"].as_str().unwrap_or(""));
        if let Some(native) = native {
            native.close().await;
        }
        Ok(())
    }
    async fn dispose(&self) {
        let natives: Vec<_> = self.sessions.lock().await.drain().map(|(_, s)| s).collect();
        for s in natives {
            s.close().await;
        }
    }
    fn native_terminal_supported(&self) -> bool {
        true
    }
    async fn terminal_plan(
        &self,
        request: &Value,
        resume: Option<String>,
    ) -> anyhow::Result<Value> {
        let mut p = config::process_request(request)?;
        p.args = request["instance"]["baseArgs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        if request["permissionMode"] == "bypassPermissions" {
            p.args.push("--dangerously-skip-permissions".into());
        } else if let Some(mode) = request["permissionMode"]
            .as_str()
            .filter(|m| matches!(*m, "accept-edits" | "plan" | "auto"))
        {
            p.args.extend(["--mode".into(), mode.into()]);
        }
        if let Some(id) = resume {
            p.args.extend(["--conversation".into(), id]);
        }
        if let Some(m) = request["model"].as_str() {
            p.args.extend(["--model".into(), m.into()]);
        }
        if let Some(e) = request["reasoningEffort"].as_str() {
            // ACP advertises "extra"; the native interactive CLI calls it "xhigh".
            p.args.extend([
                "--effort".into(),
                if e == "extra" { "xhigh" } else { e }.into(),
            ]);
        }
        Ok(json!({"command":p.command,"args":p.args,"env":p.env}))
    }
}
#[tokio::main]
async fn main() {
    agenthub_plugin_sdk::serve(Plugin::default()).await;
}
