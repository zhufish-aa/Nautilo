//! Generated secret-bearing Claude configuration never goes into process argv.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub(super) struct PrivateClaudeConfig { pub args: Vec<String>, directory: Option<PathBuf> }
impl PrivateClaudeConfig {
    pub fn record_child(&self, pid: Option<u32>) -> std::io::Result<()> {
        if let Some(directory) = &self.directory {
            let marker = serde_json::json!({ "magic": "nautilo-private-claude-v1", "parentPid": std::process::id(), "childPid": pid });
            let mut options = std::fs::OpenOptions::new(); options.write(true).create(true).truncate(true);
            #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
            options.open(directory.join(".nautilo-run.json"))?.write_all(marker.to_string().as_bytes())?;
        }
        Ok(())
    }
}
impl Drop for PrivateClaudeConfig {
    fn drop(&mut self) { if let Some(directory) = &self.directory { let _ = std::fs::remove_dir_all(directory); } }
}
pub(super) fn materialize(args: Vec<String>) -> std::io::Result<PrivateClaudeConfig> {
    let mut config = PrivateClaudeConfig { args, directory: None };
    // The final argument is the prompt, never an option.
    let mut index = 0;
    while index + 2 < config.args.len() {
        if ["--settings", "--mcp-config"].contains(&config.args[index].as_str()) && config.args[index + 1].trim_start().starts_with('{') {
            let value = config.args[index + 1].clone();
            serde_json::from_str::<serde_json::Value>(&value).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "Invalid generated Claude configuration"))?;
            if config.directory.is_none() {
                let root = private_root()?;
                cleanup_stale(&root);
                let directory = root.join(format!("{}-{}", std::process::id(), uuid::Uuid::new_v4()));
                let mut builder = std::fs::DirBuilder::new();
                #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
                builder.create(&directory)?;
                config.directory = Some(directory);
                config.record_child(None)?;
            }
            let path = config.directory.as_ref().unwrap().join(format!("config-{index}.json"));
            let mut options = std::fs::OpenOptions::new(); options.write(true).create_new(true);
            #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
            let mut file = options.open(&path)?; file.write_all(value.as_bytes())?; drop(file);
            config.args[index + 1] = path.to_string_lossy().to_string();
            index += 1;
        }
        index += 1;
    }
    Ok(config)
}

#[cfg(unix)]
unsafe extern "C" { fn getuid() -> u32; fn kill(pid: i32, signal: i32) -> i32; }
fn private_root() -> std::io::Result<PathBuf> {
    #[cfg(unix)] let identity = unsafe { getuid() }.to_string();
    #[cfg(windows)] let identity = windows_identity()?;
    #[cfg(not(any(unix, windows)))] return Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "Private configuration unsupported on this platform"));
    let root = std::env::temp_dir().join(format!("nautilo-private-cli-{identity}"));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    if let Err(error) = builder.create(&root) { if error.kind() != std::io::ErrorKind::AlreadyExists { return Err(error); } }
    let metadata = std::fs::symlink_metadata(&root)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Invalid private configuration root")); }
    #[cfg(unix)] {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { getuid() } || metadata.permissions().mode() & 0o077 != 0 { return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Configuration root must be owner-private")); }
    }
    #[cfg(windows)] protect_windows_directory(&root, &identity)?;
    Ok(root)
}
#[cfg(windows)]
fn windows_tool(command: &mut std::process::Command) -> std::io::Result<String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let started = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() { return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Windows private configuration ACL setup failed")); }
            let mut output = Vec::new();
            if let Some(stdout) = child.stdout.take() { stdout.take(4096).read_to_end(&mut output)?; }
            return Ok(String::from_utf8_lossy(&output).to_string());
        }
        if started.elapsed() > Duration::from_secs(10) { let _ = child.kill(); let _ = child.wait(); return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "Windows ACL setup timed out")); }
        std::thread::sleep(Duration::from_millis(25));
    }
}
#[cfg(windows)]
fn windows_identity() -> std::io::Result<String> {
    let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()));
    let output = windows_tool(std::process::Command::new(system.join("System32/whoami.exe")).args(["/user", "/fo", "csv", "/nh"]))?;
    output.split(|c: char| c == ',' || c == '"' || c.is_whitespace()).find(|s| s.starts_with("S-1-") && s.chars().all(|c| c.is_ascii_digit() || c == '-' || c == 'S')).map(str::to_string).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Cannot determine Windows account SID"))
}
#[cfg(windows)]
fn protect_windows_directory(root: &Path, sid: &str) -> std::io::Result<()> {
    let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()));
    let mut command = std::process::Command::new(system.join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    command.env_clear().env("SystemRoot", &system).env("WINDIR", &system).env("TEMP", std::env::temp_dir()).env("NAUTILO_CONFIG_DIR", root).env("NAUTILO_OWNER_SID", sid);
    command.args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $item=Get-Item -LiteralPath $env:NAUTILO_CONFIG_DIR -Force; if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point rejected' }; $existing=Get-Acl -LiteralPath $env:NAUTILO_CONFIG_DIR; if ($existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $env:NAUTILO_OWNER_SID) { throw 'Foreign owner rejected' }; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;' + $env:NAUTILO_OWNER_SID + ')', [System.Security.AccessControl.AccessControlSections]::Access); [System.IO.Directory]::SetAccessControl($env:NAUTILO_CONFIG_DIR, $acl)"]);
    windows_tool(&mut command).map(|_| ())
}
fn definitely_dead(pid: u64) -> bool {
    if pid == 0 || pid > i32::MAX as u64 { return false; }
    #[cfg(unix)] { return unsafe { kill(pid as i32, 0) } != 0 && std::io::Error::last_os_error().raw_os_error() == Some(3); }
    #[cfg(not(unix))] { false } // Do not guess Windows process liveness.
}
fn cleanup_stale(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return; };
    for entry in entries.take(128).flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let Some((parent, uuid)) = name.split_once('-') else { continue; };
        let Ok(parent_pid) = parent.parse::<u64>() else { continue; };
        if uuid::Uuid::parse_str(uuid).is_err() { continue; }
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue; };
        if !meta.is_dir() || meta.file_type().is_symlink() || !meta.modified().ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age >= Duration::from_secs(86400)) { continue; }
        #[cfg(unix)] { use std::os::unix::fs::{MetadataExt, PermissionsExt}; if meta.uid() != unsafe { getuid() } || meta.permissions().mode() & 0o077 != 0 { continue; } }
        let marker_path = path.join(".nautilo-run.json");
        let Ok(marker_meta) = std::fs::symlink_metadata(&marker_path) else { continue; };
        if !marker_meta.is_file() || marker_meta.file_type().is_symlink() || marker_meta.len() > 1024 { continue; }
        let Ok(contents) = std::fs::read_to_string(&marker_path) else { continue; };
        let Ok(marker) = serde_json::from_str::<serde_json::Value>(&contents) else { continue; };
        if marker["magic"] != "nautilo-private-claude-v1" || marker["parentPid"].as_u64() != Some(parent_pid) || !definitely_dead(parent_pid) || !marker["childPid"].as_u64().is_some_and(definitely_dead) { continue; }
        let Ok(files) = std::fs::read_dir(&path).and_then(|v| v.collect::<Result<Vec<_>, _>>()) else { continue; };
        if files.iter().any(|f| { let name = f.file_name().to_string_lossy().to_string(); !f.file_type().is_ok_and(|t| t.is_file() && !t.is_symlink()) || (name != ".nautilo-run.json" && !name.strip_prefix("config-").and_then(|s| s.strip_suffix(".json")).is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))) }) { continue; }
        for file in files { let _ = std::fs::remove_file(file.path()); }
        let _ = std::fs::remove_dir(&path);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn hides_secrets_and_cleans_up() {
        let config = materialize(vec!["--settings".into(), r#"{"env":{"ANTHROPIC_API_KEY":"secret-key"}}"#.into(), "--mcp-config".into(), r#"{"mcpServers":{"x":{"headers":{"Authorization":"secret-token"}}}}"#.into(), "prompt".into()]).unwrap();
        assert!(!config.args.join(" ").contains("secret-"));
        let path = PathBuf::from(&config.args[1]);
        assert!(std::fs::read_to_string(&path).unwrap().contains("secret-key"));
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600); }
        drop(config); assert!(!path.exists());
    }
}
