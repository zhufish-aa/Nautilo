//! Versioned Agent workflow contracts and deterministic execution.
pub mod definition;
pub mod engine;
mod acceptance;
mod attention;
mod bindings;
mod language;
mod native_work;
mod workspace;
mod task_projection;

pub use definition::*;
pub use engine::*;
pub use acceptance::Acceptance;
pub use language::language_reference;
pub use native_work::NativeWork;
pub use workspace::{Workspace,NodeWorkspace};
pub use task_projection::{ProjectTaskPlan, TaskAttempt, TaskProjection};
#[cfg(test)]
mod tests;
#[cfg(test)]
mod dispatch_tests;
