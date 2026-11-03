//! App-managed account directories. No credential contents cross this boundary.
use serde_json::{json, Value};
use std::fs::{self, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const PENDING_MANIFEST: &str = ".nautilo-pending-login.json";
const MAX_MANIFEST_BYTES: u64 = 4096;
const MAX_RECOVERABLE_ENTRIES: usize = 128;

#[cfg(unix)]
extern "C" {
    fn getuid() -> u32;
}

struct DirectoryOwner {
    #[cfg(unix)]
    uid: u32,
    #[cfg(windows)]
    sid: String,
}

impl DirectoryOwner {
    fn current() -> Result<Self, String> {
        #[cfg(unix)]
        {
            // getuid has no arguments or failure case on the supported Unix targets.
            Ok(Self { uid: unsafe { getuid() } })
        }
        #[cfg(windows)]
        {
            Ok(Self { sid: windows_identity()? })
        }
        #[cfg(not(any(unix, windows)))]
        {
            Err("Private account directories are unsupported on this platform".into())
        }
    }

    fn validate_directory_metadata(&self, directory: &Path) -> Result<(), String> {
        let metadata = fs::symlink_metadata(directory)
            .map_err(|_| "Cannot inspect account directory".to_string())?;
        regular_directory(&metadata)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.uid() != self.uid || metadata.permissions().mode() & 0o7777 != 0o700 {
                return Err("Account directory must be owned by the current user with mode 0700".into());
            }
        }
        Ok(())
    }

    fn protect(&self, directory: &Path) -> Result<(), String> {
        self.validate_directory_metadata(directory)?;
        #[cfg(windows)]
        protect_windows_directory(directory, &self.sid)?;
        Ok(())
    }

    fn validate(&self, directory: &Path) -> Result<(), String> {
        self.validate_directory_metadata(directory)?;
        #[cfg(windows)]
        validate_windows_entry(directory, &self.sid, true)?;
        Ok(())
    }
}

fn regular_directory(metadata: &Metadata) -> Result<(), String> {
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Account directory is not a regular directory".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes junctions and other reparse point types, not only symlinks.
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Account directory reparse points are not allowed".into());
        }
    }
    Ok(())
}

fn prepare_account_profile(base_directory: &Path, provider_id: &str) -> Result<Value, String> {
    if !["codex", "claude-code"].contains(&provider_id) {
        return Err("This harness does not support isolated account login".into());
    }
    if !base_directory.is_absolute() {
        return Err("Application data directory must be absolute".into());
    }
    let owner = DirectoryOwner::current()?;
    let root = base_directory.join("account-profiles");
    let mut root_builder = fs::DirBuilder::new();
    root_builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        root_builder.mode(0o700);
    }
    root_builder.create(&root).map_err(|_| "Cannot create account profile root".to_string())?;
    // Protect the root before creating its child. No auth process may use either
    // directory until both checks succeed and this command returns.
    owner.protect(&root)?;

    let profile_id = format!("account-{}", uuid::Uuid::new_v4());
    let directory = root.join(format!("{provider_id}-{profile_id}"));
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    // No recursive create or reuse: a collision must fail closed.
    builder.create(&directory).map_err(|_| "Cannot create account directory".to_string())?;
    owner.protect(&directory)?;
    if provider_id == "claude-code" {
        // Isolate the SDK's default federation profile as well as Claude's CLI
        // settings. The caller sets ANTHROPIC_CONFIG_DIR to this protected child.
        let anthropic = directory.join("anthropic");
        builder.create(&anthropic).map_err(|_| "Cannot create Anthropic account directory".to_string())?;
        owner.protect(&anthropic)?;
    }
    let directory_text = directory.to_str().ok_or("Account directory is not valid Unicode")?;
    let created_at = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_| "Cannot determine account creation time".to_string())?.as_millis();
    let created_at = u64::try_from(created_at).map_err(|_| "Invalid account creation time".to_string())?;
    let pending = json!({ "profileId": profile_id, "providerId": provider_id, "directory": directory_text, "createdAt": created_at });
    let bytes = serde_json::to_vec(&pending).map_err(|_| "Cannot encode pending account metadata".to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Pending account metadata is too large".into());
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut manifest = options.open(directory.join(PENDING_MANIFEST))
        .map_err(|_| "Cannot create pending account metadata".to_string())?;
    manifest.write_all(&bytes).and_then(|_| manifest.sync_all())
        .map_err(|_| "Cannot persist pending account metadata".to_string())?;
    Ok(json!({ "profileId": profile_id, "directory": directory_text }))
}

fn valid_profile_identity(provider_id: &str, profile_id: &str) -> bool {
    if !["codex", "claude-code"].contains(&provider_id) { return false; }
    let Some(suffix) = profile_id.strip_prefix("account-") else { return false; };
    uuid::Uuid::parse_str(suffix).is_ok_and(|id| id.hyphenated().to_string() == suffix)
}

fn manifest_metadata(metadata: &Metadata, owner: &DirectoryOwner) -> Result<(), String> {
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_MANIFEST_BYTES {
        return Err("Invalid pending account metadata file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != owner.uid || metadata.permissions().mode() & 0o7777 != 0o600 || metadata.nlink() != 1 {
            return Err("Pending account metadata must be private and owned by the current user".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Pending account metadata reparse points are not allowed".into());
        }
    }
    Ok(())
}

fn read_pending_manifest(directory: &Path, provider_id: &str, profile_id: &str, owner: &DirectoryOwner) -> Result<Option<Value>, String> {
    let path = directory.join(PENDING_MANIFEST);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect pending account metadata".into()),
    };
    manifest_metadata(&metadata, owner)?;
    #[cfg(windows)]
    validate_windows_entry(&path, &owner.sid, false)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Inspect a reparse point itself rather than following a raced-in link.
        options.custom_flags(0x00200000);
    }
    let file = options.open(&path).map_err(|_| "Cannot open pending account metadata".to_string())?;
    let opened = file.metadata().map_err(|_| "Cannot inspect opened pending account metadata".to_string())?;
    manifest_metadata(&opened, owner)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // Do not read if a link or another file replaced the checked manifest.
        if metadata.dev() != opened.dev() || metadata.ino() != opened.ino() {
            return Err("Pending account metadata changed while opening".into());
        }
    }
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|_| "Cannot read pending account metadata".to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES { return Err("Pending account metadata is too large".into()); }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid pending account metadata".to_string())?;
    let Some(created_at) = value["createdAt"].as_u64().filter(|time| *time > 0 && *time <= 9_007_199_254_740_991) else {
        return Err("Invalid pending account creation time".into());
    };
    let directory_text = directory.to_str().ok_or("Account directory is not valid Unicode")?;
    if !valid_profile_identity(provider_id, profile_id)
        || value.as_object().map_or(true, |object| object.len() != 4)
        || value["profileId"].as_str() != Some(profile_id)
        || value["providerId"].as_str() != Some(provider_id)
        || value["directory"].as_str() != Some(directory_text)
    {
        return Err("Pending account metadata does not match its managed directory".into());
    }
    // Never pass arbitrary file contents through IPC, even from a valid manifest.
    Ok(Some(json!({ "profileId": profile_id, "providerId": provider_id, "directory": directory_text, "createdAt": created_at })))
}

fn recoverable_profiles(base_directory: &Path) -> Result<Vec<Value>, String> {
    if !base_directory.is_absolute() { return Err("Application data directory must be absolute".into()); }
    let root = base_directory.join("account-profiles");
    match fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Cannot inspect account profile root".into()),
        Ok(metadata) => regular_directory(&metadata)?,
    }
    let owner = DirectoryOwner::current()?;
    owner.validate(&root)?;
    let entries = fs::read_dir(&root).map_err(|_| "Cannot list account profiles".to_string())?;
    let mut profiles = Vec::new();
    for entry in entries.take(MAX_RECOVERABLE_ENTRIES).flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue; };
        let Some((provider_id, profile_id)) = ["codex", "claude-code"].iter()
            .find_map(|provider| {
                let prefix = format!("{provider}-");
                name.strip_prefix(prefix.as_str()).map(|id| (*provider, id))
            })
        else { continue; };
        if !valid_profile_identity(provider_id, profile_id) { continue; }
        let directory = root.join(name);
        if owner.validate(&directory).is_err() { continue; }
        if provider_id == "claude-code" && owner.validate(&directory.join("anthropic")).is_err() { continue; }
        if let Ok(Some(profile)) = read_pending_manifest(&directory, provider_id, profile_id, &owner) {
            profiles.push(profile);
        }
    }
    profiles.sort_by_key(|profile| std::cmp::Reverse(profile["createdAt"].as_u64().unwrap_or(0)));
    Ok(profiles)
}

fn mark_profile_attached(base_directory: &Path, provider_id: &str, profile_id: &str) -> Result<(), String> {
    if !base_directory.is_absolute() || !valid_profile_identity(provider_id, profile_id) {
        return Err("Invalid managed account profile".into());
    }
    let root = base_directory.join("account-profiles");
    let directory = root.join(format!("{provider_id}-{profile_id}"));
    let owner = DirectoryOwner::current()?;
    for path in [&root, &directory] {
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err("Cannot inspect managed account directory".into()),
            Ok(_) => owner.validate(path)?,
        }
    }
    if read_pending_manifest(&directory, provider_id, profile_id, &owner)?.is_none() { return Ok(()); }
    // The connection is saved by the caller before this command. Remove only
    // our marker, never credentials, provider files, or the profile directory.
    match fs::remove_file(directory.join(PENDING_MANIFEST)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Connection saved, but pending account metadata could not be cleared".into()),
    }
}

#[tauri::command]
pub fn account_login_prepare(app: AppHandle, provider_id: String) -> Result<Value, String> {
    let directory = app.path().app_data_dir()
        .map_err(|_| "Cannot locate application data directory".to_string())?;
    prepare_account_profile(&directory, &provider_id)
}

#[tauri::command]
pub fn account_login_recoverable(app: AppHandle) -> Result<Vec<Value>, String> {
    let directory = app.path().app_data_dir()
        .map_err(|_| "Cannot locate application data directory".to_string())?;
    recoverable_profiles(&directory)
}

#[tauri::command]
pub fn account_login_attached(app: AppHandle, provider_id: String, profile_id: String) -> Result<(), String> {
    let directory = app.path().app_data_dir()
        .map_err(|_| "Cannot locate application data directory".to_string())?;
    mark_profile_attached(&directory, &provider_id, &profile_id)
}

#[cfg(windows)]
fn system_directory() -> Result<std::path::PathBuf, String> {
    let system = std::path::PathBuf::from(std::env::var_os("SystemRoot")
        .unwrap_or_else(|| "C:\\Windows".into()));
    if !system.is_absolute() {
        return Err("Windows system directory must be absolute".into());
    }
    Ok(system)
}

#[cfg(windows)]
fn windows_tool(command: &mut std::process::Command) -> Result<String, String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "Cannot start Windows directory protection tool".to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err("Windows account directory ownership or ACL verification failed".into());
                }
                let mut output = Vec::new();
                if let Some(stdout) = child.stdout.take() {
                    stdout.take(4097).read_to_end(&mut output)
                        .map_err(|_| "Cannot read Windows directory protection result".to_string())?;
                }
                if output.len() > 4096 {
                    return Err("Windows directory protection result is too large".into());
                }
                // whoami may encode a non-ASCII account name in the active OEM
                // code page. Its SID is ASCII and must still be readable.
                return Ok(String::from_utf8_lossy(&output).into_owned());
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Cannot check Windows directory protection process".into());
            }
            Ok(None) => {}
        }
        if started.elapsed() >= Duration::from_secs(10) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Windows directory protection timed out".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(any(windows, test))]
fn parse_windows_sid(output: &str) -> Option<String> {
    output.split(|c: char| c == ',' || c == '"' || c.is_whitespace())
        .find(|field| {
            let Some(suffix) = field.strip_prefix("S-1-") else { return false; };
            let parts: Vec<_> = suffix.split('-').collect();
            parts.len() >= 2 && parts.len() <= 16 && parts.iter().all(|part| {
                !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()) && part.parse::<u64>().is_ok()
            })
        })
        .map(str::to_string)
}

#[cfg(windows)]
fn windows_identity() -> Result<String, String> {
    let system = system_directory()?;
    let output = windows_tool(std::process::Command::new(system.join("System32").join("whoami.exe"))
        .args(["/user", "/fo", "csv", "/nh"]))?;
    parse_windows_sid(&output).ok_or_else(|| "Cannot determine the current Windows account SID".into())
}

// Static code only. Directory and SID are data in a cleared child environment,
// never interpolated into a shell command. Verify the exact protected DACL after
// setting it, so an ACL write that did not take effect cannot permit login.
#[cfg(any(windows, test))]
const PROTECT_WINDOWS_DIRECTORY: &str = r#"
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $env:NAUTILO_ACCOUNT_DIR -Force
if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point or non-directory rejected' }
$old = Get-Acl -LiteralPath $env:NAUTILO_ACCOUNT_DIR
if ($old.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $env:NAUTILO_OWNER_SID) { throw 'Foreign owner rejected' }
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;' + $env:NAUTILO_OWNER_SID + ')')
Set-Acl -LiteralPath $env:NAUTILO_ACCOUNT_DIR -AclObject $acl
$item = Get-Item -LiteralPath $env:NAUTILO_ACCOUNT_DIR -Force
if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point or non-directory rejected' }
$verified = Get-Acl -LiteralPath $env:NAUTILO_ACCOUNT_DIR
if ($verified.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $env:NAUTILO_OWNER_SID -or -not $verified.AreAccessRulesProtected) { throw 'Owner or inheritance verification failed' }
$rules = @($verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1) { throw 'Unexpected account directory access rules' }
$rule = $rules[0]
if ($rule.IdentityReference.Value -ne $env:NAUTILO_OWNER_SID -or $rule.IsInherited -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or [int]$rule.InheritanceFlags -ne 3 -or [int]$rule.PropagationFlags -ne 0) { throw 'Owner-only ACL verification failed' }
"#;

#[cfg(windows)]
fn protect_windows_directory(directory: &Path, sid: &str) -> Result<(), String> {
    let system = system_directory()?;
    let mut command = std::process::Command::new(system.join("System32").join("WindowsPowerShell")
        .join("v1.0").join("powershell.exe"));
    command.env_clear().env("SystemRoot", &system).env("WINDIR", &system)
        .env("NAUTILO_ACCOUNT_DIR", directory).env("NAUTILO_OWNER_SID", sid)
        .args(["-NoProfile", "-NonInteractive", "-Command", PROTECT_WINDOWS_DIRECTORY]);
    windows_tool(&mut command).map(|_| ())
}

#[cfg(any(windows, test))]
const VALIDATE_WINDOWS_ENTRY: &str = r#"
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $env:NAUTILO_ACCOUNT_DIR -Force
$directory = $env:NAUTILO_ENTRY_KIND -eq 'directory'
if ($item.PSIsContainer -ne $directory -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point or wrong entry type rejected' }
$acl = Get-Acl -LiteralPath $env:NAUTILO_ACCOUNT_DIR
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $env:NAUTILO_OWNER_SID) { throw 'Foreign owner rejected' }
if ($directory -and -not $acl.AreAccessRulesProtected) { throw 'Unprotected directory ACL rejected' }
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1) { throw 'Unexpected account entry access rules' }
$rule = $rules[0]
if ($rule.IdentityReference.Value -ne $env:NAUTILO_OWNER_SID -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'Owner-only ACL verification failed' }
if ($directory -and ($rule.IsInherited -or [int]$rule.InheritanceFlags -ne 3 -or [int]$rule.PropagationFlags -ne 0)) { throw 'Directory ACL inheritance rejected' }
"#;

#[cfg(windows)]
fn validate_windows_entry(path: &Path, sid: &str, directory: bool) -> Result<(), String> {
    let system = system_directory()?;
    let mut command = std::process::Command::new(system.join("System32").join("WindowsPowerShell")
        .join("v1.0").join("powershell.exe"));
    command.env_clear().env("SystemRoot", &system).env("WINDIR", &system)
        .env("NAUTILO_ACCOUNT_DIR", path).env("NAUTILO_OWNER_SID", sid)
        .env("NAUTILO_ENTRY_KIND", if directory { "directory" } else { "file" })
        .args(["-NoProfile", "-NonInteractive", "-Command", VALIDATE_WINDOWS_ENTRY]);
    windows_tool(&mut command).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_providers_and_relative_roots_fail_before_creation() {
        let root = std::env::temp_dir().join(format!("nautilo-account-reject-{}", uuid::Uuid::new_v4()));
        for provider in ["kimi", "", "../codex", "codex/../claude-code"] {
            assert!(prepare_account_profile(&root, provider).is_err());
        }
        assert!(!root.exists());
        assert!(prepare_account_profile(Path::new("relative"), "codex").is_err());
    }

    #[test]
    fn windows_sid_parser_rejects_injection_and_malformed_values() {
        assert_eq!(parse_windows_sid("\"HOST\\user\",\"S-1-5-21-11-22-33-1001\"\r\n"), Some("S-1-5-21-11-22-33-1001".into()));
        for value in ["S-1-", "S-1-5-", "S-1-x-123", "S-1-5-21;Write-Output", "S-1-5-21$(whoami)"] {
            assert_eq!(parse_windows_sid(value), None);
        }
        assert!(PROTECT_WINDOWS_DIRECTORY.contains("ReparsePoint"));
        assert!(PROTECT_WINDOWS_DIRECTORY.contains("Foreign owner rejected"));
        assert!(PROTECT_WINDOWS_DIRECTORY.contains("D:P(A;OICI;FA;;;"));
        assert!(PROTECT_WINDOWS_DIRECTORY.contains("$rules.Count -ne 1"));
        assert!(PROTECT_WINDOWS_DIRECTORY.contains("AreAccessRulesProtected"));
    }

    struct TempRoot(std::path::PathBuf);

    impl TempRoot {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("nautilo-account-test-{}", uuid::Uuid::new_v4())))
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn accounts_have_distinct_private_directories_and_private_manifests() {
        let root = TempRoot::new();
        let first = prepare_account_profile(&root.0, "codex").unwrap();
        let second = prepare_account_profile(&root.0, "codex").unwrap();
        let third = prepare_account_profile(&root.0, "claude-code").unwrap();
        assert_ne!(first["profileId"], second["profileId"]);
        assert_ne!(first["directory"], second["directory"]);
        for profile in [first, second, third] {
            let id = profile["profileId"].as_str().unwrap();
            assert!(uuid::Uuid::parse_str(id.strip_prefix("account-").unwrap()).is_ok());
            let directory = Path::new(profile["directory"].as_str().unwrap());
            assert!(directory.is_absolute());
            assert_eq!(directory.parent(), Some(root.0.join("account-profiles").as_path()));
            let expected_entries = if directory.file_name().unwrap().to_string_lossy().starts_with("claude-code-") { 2 } else { 1 };
            assert_eq!(fs::read_dir(directory).unwrap().count(), expected_entries);
            let manifest = fs::symlink_metadata(directory.join(PENDING_MANIFEST)).unwrap();
            manifest_metadata(&manifest, &DirectoryOwner::current().unwrap()).unwrap();
            for path in [directory, directory.parent().unwrap()] {
                let metadata = fs::symlink_metadata(path).unwrap();
                regular_directory(&metadata).unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::{MetadataExt, PermissionsExt};
                    assert_eq!(metadata.permissions().mode() & 0o7777, 0o700);
                    assert_eq!(metadata.uid(), unsafe { getuid() });
                }
            }
            if expected_entries == 2 {
                let anthropic = directory.join("anthropic");
                DirectoryOwner::current().unwrap().validate(&anthropic).unwrap();
                assert_eq!(fs::read_dir(anthropic).unwrap().count(), 0);
            }
        }
    }

    #[test]
    fn pending_profiles_remain_recoverable_until_connection_attachment() {
        let root = TempRoot::new();
        let prepared = prepare_account_profile(&root.0, "claude-code").unwrap();
        let profile_id = prepared["profileId"].as_str().unwrap();
        let directory = Path::new(prepared["directory"].as_str().unwrap());
        // No login or connection-save result removes the marker by itself.
        // Repeated recovery after cancellation/save failure must preserve it.
        let first = recoverable_profiles(&root.0).unwrap();
        let second = recoverable_profiles(&root.0).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["profileId"], prepared["profileId"]);
        assert_eq!(first[0]["providerId"], "claude-code");
        assert!(first[0]["createdAt"].as_u64().unwrap() > 0);
        assert!(directory.join(PENDING_MANIFEST).exists());
        let sentinel = directory.join("provider-owned-test-sentinel");
        fs::write(&sentinel, b"synthetic provider data").unwrap();
        mark_profile_attached(&root.0, "claude-code", profile_id).unwrap();
        assert!(!directory.join(PENDING_MANIFEST).exists());
        assert!(directory.is_dir());
        assert!(directory.join("anthropic").is_dir());
        assert_eq!(fs::metadata(&sentinel).unwrap().len(), 23);
        assert!(recoverable_profiles(&root.0).unwrap().is_empty());
        mark_profile_attached(&root.0, "claude-code", profile_id).unwrap();
    }

    #[test]
    fn recovery_rejects_external_paths_malformed_ids_and_oversized_manifests() {
        let root = TempRoot::new();
        let prepared = prepare_account_profile(&root.0, "codex").unwrap();
        let profile_id = prepared["profileId"].as_str().unwrap();
        let directory = Path::new(prepared["directory"].as_str().unwrap());
        let manifest = directory.join(PENDING_MANIFEST);
        let mut value = recoverable_profiles(&root.0).unwrap().remove(0);
        value["directory"] = json!(std::env::temp_dir());
        fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(recoverable_profiles(&root.0).unwrap().is_empty());
        assert!(mark_profile_attached(&root.0, "codex", profile_id).is_err());
        assert!(manifest.exists());
        fs::write(&manifest, vec![b' '; MAX_MANIFEST_BYTES as usize + 1]).unwrap();
        assert!(recoverable_profiles(&root.0).unwrap().is_empty());
        for (provider, id) in [("../codex", profile_id), ("codex", "../../outside"), ("codex", "account-not-a-uuid")] {
            assert!(mark_profile_attached(&root.0, provider, id).is_err());
        }
        assert!(manifest.exists());
    }

    #[cfg(unix)]
    #[test]
    fn recovery_rejects_symlink_directories_and_manifest_links() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = TempRoot::new();
        let prepared = prepare_account_profile(&root.0, "codex").unwrap();
        let profile_id = prepared["profileId"].as_str().unwrap();
        let directory = Path::new(prepared["directory"].as_str().unwrap());
        let manifest = directory.join(PENDING_MANIFEST);
        let external = root.0.join("external-metadata.json");
        fs::rename(&manifest, &external).unwrap();
        symlink(&external, &manifest).unwrap();
        assert!(recoverable_profiles(&root.0).unwrap().is_empty());
        assert!(mark_profile_attached(&root.0, "codex", profile_id).is_err());
        assert!(external.exists());
        fs::remove_file(&manifest).unwrap();
        fs::hard_link(&external, &manifest).unwrap();
        assert!(recoverable_profiles(&root.0).unwrap().is_empty());
        assert!(mark_profile_attached(&root.0, "codex", profile_id).is_err());
        fs::remove_file(&manifest).unwrap();
        fs::rename(&external, &manifest).unwrap();
        let outside = root.0.join("outside-profile");
        fs::rename(directory, &outside).unwrap();
        symlink(&outside, directory).unwrap();
        assert!(recoverable_profiles(&root.0).unwrap().is_empty());
        assert!(mark_profile_attached(&root.0, "codex", profile_id).is_err());
        assert!(outside.join(PENDING_MANIFEST).exists());
        fs::remove_file(directory).unwrap();
        fs::rename(&outside, directory).unwrap();
        fs::set_permissions(&manifest, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(recoverable_profiles(&root.0).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn recovery_scans_at_most_128_entries() {
        let root = TempRoot::new();
        for _ in 0..=MAX_RECOVERABLE_ENTRIES {
            prepare_account_profile(&root.0, "codex").unwrap();
        }
        assert_eq!(recoverable_profiles(&root.0).unwrap().len(), MAX_RECOVERABLE_ENTRIES);
        assert_eq!(fs::read_dir(root.0.join("account-profiles")).unwrap().count(), MAX_RECOVERABLE_ENTRIES + 1);
    }

    #[cfg(unix)]
    #[test]
    fn recovery_rejects_replaced_anthropic_directories() {
        use std::os::unix::fs::symlink;
        let root = TempRoot::new();
        let prepared = prepare_account_profile(&root.0, "claude-code").unwrap();
        let directory = Path::new(prepared["directory"].as_str().unwrap());
        let anthropic = directory.join("anthropic");
        let outside = root.0.join("outside-anthropic");
        fs::rename(&anthropic, &outside).unwrap();
        symlink(&outside, &anthropic).unwrap();
        assert!(recoverable_profiles(&root.0).unwrap().is_empty());
        assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
        assert!(directory.join(PENDING_MANIFEST).exists());
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_existing_roots_and_foreign_owners_are_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let root = TempRoot::new();
        let managed = root.0.join("account-profiles");
        fs::create_dir_all(&managed).unwrap();
        fs::set_permissions(&managed, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(prepare_account_profile(&root.0, "codex").is_err());
        assert_eq!(fs::read_dir(&managed).unwrap().count(), 0);
        fs::set_permissions(&managed, fs::Permissions::from_mode(0o700)).unwrap();
        let different_owner = DirectoryOwner { uid: unsafe { getuid() }.wrapping_add(1) };
        assert!(different_owner.protect(&managed).is_err());
        fs::remove_dir(&managed).unwrap();
        fs::write(&managed, b"not a directory").unwrap();
        assert!(prepare_account_profile(&root.0, "codex").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_roots_are_rejected_without_writing_into_the_target() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = TempRoot::new();
        let target = root.0.join("outside");
        fs::create_dir_all(&target).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&target, root.0.join("account-profiles")).unwrap();
        assert!(prepare_account_profile(&root.0, "codex").is_err());
        assert_eq!(fs::read_dir(target).unwrap().count(), 0);
    }
}
