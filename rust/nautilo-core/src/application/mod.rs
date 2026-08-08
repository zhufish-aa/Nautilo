//! Application layer — mirrors application/.

pub mod agent_service;
pub mod artifact_read;
pub mod capability_import;
pub mod capability_service;
pub mod core_daemon;
pub mod interaction_service;
pub mod ipc_handlers;
pub mod orchestration_service;
pub mod project_inspector;
pub mod project_service;
pub mod session_context;
pub mod slash_commands;
pub mod session_service;
pub mod team_service;

pub use agent_service::AgentService;
pub use capability_service::CapabilityService;
pub use interaction_service::InteractionService;
pub use core_daemon::Daemon;
pub use project_service::ProjectService;
pub use session_service::SessionService;
pub use team_service::TeamService;
