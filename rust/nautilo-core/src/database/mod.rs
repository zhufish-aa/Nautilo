//! Persistence composition root — mirrors database/index.ts.

pub mod connection;
pub mod migrations;
pub mod repositories;

pub use connection::Database;
pub use repositories::Repositories;

/// Locks the shared database handle (services hold it behind Arc<Mutex<>>).
pub fn lock(db: &std::sync::Arc<std::sync::Mutex<Database>>) -> std::sync::MutexGuard<'_, Database> {
    db.lock().unwrap()
}

pub mod assistant;
pub mod history_projection;
pub mod project_poll;
pub mod native_history;
pub mod remote;
