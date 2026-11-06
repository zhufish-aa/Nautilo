//! SQLite connection — port of database/connection.ts.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::errors::{CoreError, CoreResult, ErrorCode};

pub struct Database {
    pub raw: Connection,
    path: PathBuf,
}

impl Database {
    pub fn open(file_path: &Path) -> CoreResult<Self> {
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).map_err(io_fail)?;
        }
        let raw = Connection::open(file_path).map_err(db_fail)?;
        // busy_timeout: two daemon processes can share one data dir during the
        // Electron→Tauri migration; writers must wait for each other instead
        // of failing (or racing) on the write lock.
        raw.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
            .map_err(db_fail)?;
        crate::database::migrations::migrate(&raw)?;
        // One-time compaction: drop verbatim message deltas journaled by older
        // builds (writes are coalesced now, and message text also lives in the
        // final agent.message event). Thinking deltas are NOT purged here —
        // they are the only record of past reasoning. Best-effort: VACUUM
        // just fails while another daemon holds the database open.
        let purged = raw
            .execute("DELETE FROM runtime_events AS delta WHERE json_extract(delta.data, '$.type') = 'agent.message_delta' AND EXISTS (SELECT 1 FROM runtime_events AS saved WHERE saved.session_id = delta.session_id AND COALESCE(saved.run_id, '') = COALESCE(delta.run_id, '') AND json_extract(saved.data, '$.type') = 'agent.message' AND json_extract(saved.data, '$.payload.providerMessageId') = json_extract(delta.data, '$.payload.messageId'))", [])
            .unwrap_or(0);
        if purged > 50_000 {
            let _ = raw.execute_batch("VACUUM");
        }
        Ok(Self { raw, path: file_path.to_path_buf() })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub(crate) fn io_fail(error: std::io::Error) -> CoreError {
    CoreError::reason(ErrorCode::IpcInternalError, error.to_string())
}

pub(crate) fn db_fail(error: rusqlite::Error) -> CoreError {
    CoreError::reason(ErrorCode::IpcInternalError, error.to_string())
}
