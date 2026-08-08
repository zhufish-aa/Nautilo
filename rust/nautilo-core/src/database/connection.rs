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
        raw.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
            .map_err(db_fail)?;
        crate::database::migrations::migrate(&raw)?;
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
