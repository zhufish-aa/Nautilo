//! Windows needs WRITE_OWNER to put a low integrity label on a confined tool's
//! workspace and temporary directory. DSH still creates and enforces its own sandbox.
use agenthub_plugin_sdk::DaemonChannel;
use anyhow::{bail, ensure, Context, Result};
use serde_json::json;
use std::collections::HashMap;
use std::ffi::c_void;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::Mutex as AsyncMutex;
use windows_sys::Win32::Foundation::{LocalFree, ERROR_ACCESS_DENIED};
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

#[derive(Default)]
pub struct WorkspaceAccess {
    folders: Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>,
    temp: Mutex<Option<PrivateTemp>>,
}

impl WorkspaceAccess {
    pub fn configure_temp(&self, env: &mut HashMap<String, String>) -> Result<()> {
        let mut temp = self.temp.lock().unwrap();
        if temp.is_none() {
            *temp = Some(PrivateTemp::create()?);
        }
        let path = temp.as_ref().unwrap().0.to_string_lossy();
        for key in ["TEMP", "TMP", "TMPDIR"] {
            env.insert(key.to_string(), path.to_string());
        }
        Ok(())
    }

    pub async fn prepare(
        &self,
        cwd: &Path,
        run: &str,
        channel: Option<&Arc<dyn DaemonChannel>>,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        ensure!(cwd.is_absolute(), "工作区目录必须是绝对路径");
        let canonical = std::fs::canonicalize(cwd)?;
        let gate = {
            let mut folders = self.folders.lock().unwrap();
            folders.retain(|_, value| value.strong_count() > 0);
            let entry = folders.entry(canonical.clone()).or_default();
            entry.upgrade().unwrap_or_else(|| {
                let gate = Arc::new(AsyncMutex::new(()));
                *entry = Arc::downgrade(&gate);
                gate
            })
        };
        let _guard = gate.lock().await;
        if has_workspace_rights(&canonical)? {
            return Ok(());
        }
        let display = canonical.display().to_string();
        let display = display.strip_prefix(r"\\?\").unwrap_or(&display);
        let dir = open_dir(&canonical, READ_CONTROL | WRITE_DAC).with_context(|| format!("当前 Windows 账号不能调整「{display}」的权限。请让文件夹所有者授予权限，或选择你能管理的项目目录。"))?;
        ensure!(dir.metadata()?.is_dir(), "工作区路径不是文件夹");
        let channel = channel.context("需要在鹦鹉螺中确认此工作区的 Windows 权限")?;
        let answer = channel.ask(run, json!({
            "kind":"approval", "nativeRequestId":uuid::Uuid::new_v4().to_string(),
            "title":"允许 DeepSeek 使用这个工作区？",
            "detail":format!("允许当前 Windows 账号设置「{display}」的安全标签。Windows 将此权限与更改所有者归为同一项。授权仅加在此文件夹本身，以后的会话可继续使用。"),
            "options":[{"id":"authorize-workspace","label":"授权此文件夹"},{"id":"reject","label":"拒绝"}]
        })).await;
        ensure!(
            answer["outcome"] == "selected"
                && answer["optionId"] == "authorize-workspace"
                && !cancelled.load(Ordering::Acquire),
            "未授权此文件夹，已取消本次工作区操作。"
        );
        // The handle still refers to the same directory even if a junction or
        // path is replaced while the user is reading the prompt.
        tokio::task::spawn_blocking(move || grant_write_owner(&dir, &canonical)).await??;
        Ok(())
    }
}

fn open_dir(path: &Path, rights: u32) -> io::Result<File> {
    OpenOptions::new()
        .access_mode(rights | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

fn has_workspace_rights(path: &Path) -> io::Result<bool> {
    match open_dir(path, WRITE_DAC | WRITE_OWNER) {
        Ok(_) => Ok(true),
        Err(e) if e.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => Ok(false),
        Err(e) => Err(e),
    }
}

struct LocalMemory(*mut c_void);
impl Drop for LocalMemory {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn check(code: u32) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code as i32))
    }
}

fn with_user_sid<T>(use_sid: impl FnOnce(PSID) -> Result<T>) -> Result<T> {
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error().into());
        }
        let token = OwnedHandle::from_raw_handle(token);
        let mut bytes = 0;
        GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut bytes);
        ensure!(
            bytes as usize >= size_of::<TOKEN_USER>(),
            "无法读取当前 Windows 用户"
        );
        let mut buffer = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
        if GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        ) == 0
        {
            return Err(io::Error::last_os_error().into());
        }
        use_sid((*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid)
    }
}

fn directory_id(dir: &File) -> io::Result<(u32, u32, u32)> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(dir.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}

fn grant_write_owner(access: &File, path: &Path) -> Result<()> {
    ensure!(
        directory_id(access)? == directory_id(&open_dir(path, FILE_READ_ATTRIBUTES)?)?,
        "授权期间工作区路径已改变，请重试。"
    );
    if has_workspace_rights(path)? {
        return Ok(());
    }
    with_user_sid(|sid| unsafe {
        let mut old_acl = null_mut();
        let mut descriptor = null_mut();
        check(GetSecurityInfo(
            access.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_acl,
            null_mut(),
            &mut descriptor,
        ))?;
        let _descriptor = LocalMemory(descriptor);
        ensure!(!old_acl.is_null(), "无法安全调整此文件夹的权限");
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: WRITE_OWNER,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: TRUSTEE_W {
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: sid.cast(),
                ..Default::default()
            },
        };
        let mut acl = null_mut();
        check(SetEntriesInAclW(1, &entry, old_acl, &mut acl))?;
        let _acl = LocalMemory(acl.cast());
        let apply = |acl| {
            check(SetSecurityInfo(
                access.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null(),
            ))
        };
        apply(acl)?;
        if !matches!(has_workspace_rights(path), Ok(true)) {
            apply(old_acl).context("授权未生效，还原文件夹权限失败")?;
            bail!("Windows 仍拒绝设置工作区安全标签；已还原此授权。请联系文件夹所有者。");
        }
        Ok(())
    })
}

// A fresh protected directory avoids changing ACLs on the OS temp folder or
// other applications' files. DSH's private per-session children inherit the
// signed-in user's rights when the OS creates them, before DSH sets its label.
struct PrivateTemp(PathBuf);
impl PrivateTemp {
    fn create() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("nautilo-dsh-{}", uuid::Uuid::new_v4()));
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        with_user_sid(|sid| unsafe {
            let mut name = null_mut();
            if ConvertSidToStringSidW(sid, &mut name) == 0 {
                return Err(io::Error::last_os_error().into());
            }
            let _name = LocalMemory(name.cast());
            let mut length = 0;
            while *name.add(length) != 0 {
                length += 1;
            }
            let sid = String::from_utf16(std::slice::from_raw_parts(name, length))?;
            let sddl: Vec<u16> = format!("D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut descriptor = null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error().into());
            }
            let _descriptor = LocalMemory(descriptor);
            let attributes = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            };
            if CreateDirectoryW(wide.as_ptr(), &attributes) == 0 {
                return Err(io::Error::last_os_error().into());
            }
            Ok(())
        })?;
        Ok(Self(path))
    }
}
impl Drop for PrivateTemp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
