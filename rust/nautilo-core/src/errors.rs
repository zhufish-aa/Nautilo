//! Port of packages/domain/src/errors.ts — keep messages and retry metadata
//! byte-identical so the renderer's error handling behaves the same.

use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    AgentNotFound,
    AgentNotAuthenticated,
    ProviderVersionUnsupported,
    RunStartFailed,
    ProviderCommandFailed,
    RunTimeout,
    RunIdleTimeout,
    RunCancelled,
    PlanSchemaInvalid,
    PlanMemberNotFound,
    PlanDelegationNotAllowed,
    PlanTaskTypeNotAllowed,
    PlanDependencyNotFound,
    PlanDependencyCycle,
    PlanApprovalNotFound,
    RecoverySchemaInvalid,
    PathPolicyViolation,
    CommandApprovalRequired,
    CommandBlocked,
    ApprovalNotFound,
    InteractionNotFound,
    RecoveryNotAvailable,
    CredentialStoreFailed,
    VerificationFailed,
    WorktreeCreateFailed,
    MergeConflict,
    RecoveryRequired,
    IpcInvalidRequest,
    IpcNotFound,
    IpcInternalError,
    PluginRegistryUnavailable,
    PluginDownloadFailed,
    PluginChecksumMismatch,
    PluginManifestMissing,
    PluginInvalid,
    PluginRemoveFailed,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgentNotFound => "AGENT_NOT_FOUND",
            Self::AgentNotAuthenticated => "AGENT_NOT_AUTHENTICATED",
            Self::ProviderVersionUnsupported => "PROVIDER_VERSION_UNSUPPORTED",
            Self::RunStartFailed => "RUN_START_FAILED",
            Self::ProviderCommandFailed => "PROVIDER_COMMAND_FAILED",
            Self::RunTimeout => "RUN_TIMEOUT",
            Self::RunIdleTimeout => "RUN_IDLE_TIMEOUT",
            Self::RunCancelled => "RUN_CANCELLED",
            Self::PlanSchemaInvalid => "PLAN_SCHEMA_INVALID",
            Self::PlanMemberNotFound => "PLAN_MEMBER_NOT_FOUND",
            Self::PlanDelegationNotAllowed => "PLAN_DELEGATION_NOT_ALLOWED",
            Self::PlanTaskTypeNotAllowed => "PLAN_TASK_TYPE_NOT_ALLOWED",
            Self::PlanDependencyNotFound => "PLAN_DEPENDENCY_NOT_FOUND",
            Self::PlanDependencyCycle => "PLAN_DEPENDENCY_CYCLE",
            Self::PlanApprovalNotFound => "PLAN_APPROVAL_NOT_FOUND",
            Self::RecoverySchemaInvalid => "RECOVERY_SCHEMA_INVALID",
            Self::PathPolicyViolation => "PATH_POLICY_VIOLATION",
            Self::CommandApprovalRequired => "COMMAND_APPROVAL_REQUIRED",
            Self::CommandBlocked => "COMMAND_BLOCKED",
            Self::ApprovalNotFound => "APPROVAL_NOT_FOUND",
            Self::InteractionNotFound => "INTERACTION_NOT_FOUND",
            Self::RecoveryNotAvailable => "RECOVERY_NOT_AVAILABLE",
            Self::CredentialStoreFailed => "CREDENTIAL_STORE_FAILED",
            Self::VerificationFailed => "VERIFICATION_FAILED",
            Self::WorktreeCreateFailed => "WORKTREE_CREATE_FAILED",
            Self::MergeConflict => "MERGE_CONFLICT",
            Self::RecoveryRequired => "RECOVERY_REQUIRED",
            Self::IpcInvalidRequest => "IPC_INVALID_REQUEST",
            Self::IpcNotFound => "IPC_NOT_FOUND",
            Self::IpcInternalError => "IPC_INTERNAL_ERROR",
            Self::PluginRegistryUnavailable => "PLUGIN_REGISTRY_UNAVAILABLE",
            Self::PluginDownloadFailed => "PLUGIN_DOWNLOAD_FAILED",
            Self::PluginChecksumMismatch => "PLUGIN_CHECKSUM_MISMATCH",
            Self::PluginManifestMissing => "PLUGIN_MANIFEST_MISSING",
            Self::PluginInvalid => "PLUGIN_INVALID",
            Self::PluginRemoveFailed => "PLUGIN_REMOVE_FAILED",
        }
    }

    /// (message, retryable, retryStrategy, userAction)
    fn descriptor(self) -> (&'static str, bool, &'static str, &'static str) {
        match self {
            Self::AgentNotFound => ("找不到指定 Agent。", false, "user_action", "检查 Agent 和团队成员配置。"),
            Self::AgentNotAuthenticated => ("Agent 尚未完成登录。", false, "user_action", "先在对应 CLI 中完成登录。"),
            Self::ProviderVersionUnsupported => ("当前 Provider 版本不受支持。", false, "user_action", "升级 CLI 或调整兼容配置。"),
            Self::ProviderCommandFailed => ("指令执行失败。", false, "user_action", "查看 Harness 返回的错误详情。"),
            Self::RunStartFailed => ("Agent 进程启动失败。", true, "backoff", "检查可执行路径、权限和 CLI 安装。"),
            Self::RunTimeout => ("Agent 运行超时。", true, "backoff", "重试或增加任务超时时间。"),
            Self::RunIdleTimeout => ("Agent 长时间没有输出。", true, "backoff", "检查是否等待输入，或重试运行。"),
            Self::RunCancelled => ("运行已取消。", false, "never", "需要时重新启动任务。"),
            Self::PlanSchemaInvalid => ("主 Agent 返回的计划格式无效。", true, "immediate", "让主 Agent 按协议重新输出。"),
            Self::PlanMemberNotFound => ("计划引用了不存在、禁用或不可用的成员。", true, "immediate", "从用户启用的团队成员中重新选择。"),
            Self::PlanDelegationNotAllowed => ("当前团队策略不允许委派。", true, "immediate", "选择 direct，或修改团队委派策略。"),
            Self::PlanTaskTypeNotAllowed => ("所选成员不接受该任务类型。", true, "immediate", "改选允许该任务类型的启用成员。"),
            Self::PlanDependencyNotFound => ("计划引用了不存在的任务依赖。", true, "immediate", "返回依赖 ID 完整且自包含的任务图。"),
            Self::PlanDependencyCycle => ("任务依赖存在循环。", true, "immediate", "修改任务依赖后重试。"),
            Self::PlanApprovalNotFound => ("当前运行没有等待处理的委派审批。", false, "user_action", "刷新运行状态后再审批。"),
            Self::RecoverySchemaInvalid => ("主 Agent 返回的失败处理决策无效。", true, "immediate", "按 retry、take_over 或 continue 格式重新输出。"),
            Self::PathPolicyViolation => ("Agent 修改了不允许的路径。", false, "user_action", "检查任务路径权限。"),
            Self::CommandApprovalRequired => ("该命令需要用户审批。", false, "user_action", "批准或拒绝该命令。"),
            Self::CommandBlocked => ("该命令被权限策略阻止。", false, "never", "修改项目权限策略后重试。"),
            Self::ApprovalNotFound => ("找不到待处理的审批请求。", false, "user_action", "刷新审批列表后重试。"),
            Self::InteractionNotFound => ("该提问或审批已被处理或已过期。", false, "user_action", "刷新对话后重试。"),
            Self::RecoveryNotAvailable => ("当前运行不可恢复。", false, "user_action", "选择处于暂停或失败状态的运行。"),
            Self::CredentialStoreFailed => ("凭证存储操作失败。", false, "user_action", "检查本地数据目录权限。"),
            Self::VerificationFailed => ("验收命令失败。", true, "user_action", "查看测试结果并修复后重试。"),
            Self::WorktreeCreateFailed => ("Git worktree 创建失败。", true, "backoff", "检查 Git 状态和目录权限。"),
            Self::MergeConflict => ("合并产生冲突。", false, "user_action", "处理冲突后重新验证。"),
            Self::RecoveryRequired => ("运行需要恢复处理。", false, "user_action", "选择恢复、重试或结束运行。"),
            Self::IpcInvalidRequest => ("请求格式无效。", false, "never", "刷新应用或检查客户端版本。"),
            Self::IpcNotFound => ("请求的资源不存在。", false, "user_action", "刷新列表后重试。"),
            Self::IpcInternalError => ("Core Daemon 发生内部错误。", true, "backoff", "重试并导出诊断信息。"),
            Self::PluginRegistryUnavailable => ("插件市场注册表暂时不可用。", true, "backoff", "检查网络后重试，或更换 registry 地址。"),
            Self::PluginDownloadFailed => ("插件包下载失败。", true, "backoff", "检查网络后重试。"),
            Self::PluginChecksumMismatch => ("插件包校验和不匹配，可能已被篡改。", false, "never", "不要安装该插件，并向 registry 维护者报告。"),
            Self::PluginManifestMissing => ("插件包中缺少 agenthub-plugin.json 清单。", false, "user_action", "确认选择的是有效的插件目录或安装包。"),
            Self::PluginInvalid => ("插件清单或入口无效。", false, "user_action", "检查插件的 agenthub-plugin.json 与入口文件。"),
            Self::PluginRemoveFailed => ("插件文件删除失败，插件进程可能仍在运行。", true, "backoff", "结束正在使用该插件的会话后重试。"),
        }
    }
}

/// Matches the AgentHubError JSON shape: {code, message, retryable, retryStrategy, userAction, details?}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHubError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub retry_strategy: String,
    pub user_action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Map<String, Value>>,
}

impl AgentHubError {
    pub fn new(code: ErrorCode, details: Option<Map<String, Value>>) -> Self {
        let (message, retryable, retry_strategy, user_action) = code.descriptor();
        Self {
            code: code.as_str().to_string(),
            message: message.to_string(),
            retryable,
            retry_strategy: retry_strategy.to_string(),
            user_action: user_action.to_string(),
            details,
        }
    }

    pub fn simple(code: ErrorCode) -> Self {
        Self::new(code, None)
    }

    pub fn with_reason(code: ErrorCode, reason: impl Into<String>) -> Self {
        let mut details = Map::new();
        details.insert("reason".to_string(), Value::String(reason.into()));
        Self::new(code, Some(details))
    }
}

/// Internal error type: carries an AgentHubError through the call stack,
/// mirroring CoreError / toAgentHubError in the TS daemon.
#[derive(Debug)]
pub struct CoreError(pub AgentHubError);

impl CoreError {
    pub fn new(code: ErrorCode) -> Self {
        Self(AgentHubError::simple(code))
    }

    pub fn reason(code: ErrorCode, reason: impl Into<String>) -> Self {
        Self(AgentHubError::with_reason(code, reason))
    }

    pub fn details(code: ErrorCode, details: Map<String, Value>) -> Self {
        Self(AgentHubError::new(code, Some(details)))
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let reason = self
            .0
            .details
            .as_ref()
            .and_then(|details| details.get("reason"))
            .and_then(Value::as_str)
            .filter(|reason| !reason.is_empty());
        match reason {
            // Diagnostics must surface the underlying cause — the canned
            // message alone makes plugin/CLI failures undebuggable.
            Some(reason) => write!(f, "{}: {}（{}）", self.0.code, self.0.message, reason),
            None => write!(f, "{}: {}", self.0.code, self.0.message),
        }
    }
}

impl std::error::Error for CoreError {}

/// Convert an arbitrary error into an internal-error descriptor,
/// mirroring toAgentHubError in errors.ts.
pub fn to_agent_hub_error(error: &anyhow::Error) -> AgentHubError {
    match error.downcast_ref::<CoreError>() {
        Some(core) => core.0.clone(),
        None => AgentHubError::with_reason(ErrorCode::IpcInternalError, error.to_string()),
    }
}

pub type CoreResult<T> = Result<T, CoreError>;

// ---------------------------------------------------------------- shared helpers

/// ISO-8601 UTC timestamp with milliseconds — `new Date().toISOString()`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// CoreError("IPC_NOT_FOUND", { resource, id })
pub fn not_found(resource: &str, id: &str) -> CoreError {
    let mut details = serde_json::Map::new();
    details.insert("resource".to_string(), serde_json::json!(resource));
    details.insert("id".to_string(), serde_json::json!(id));
    CoreError::details(ErrorCode::IpcNotFound, details)
}

/// CoreError("IPC_INVALID_REQUEST", { field, reason })
pub fn invalid(field: &str, reason: &str) -> CoreError {
    let mut details = serde_json::Map::new();
    details.insert("field".to_string(), serde_json::json!(field));
    details.insert("reason".to_string(), serde_json::json!(reason));
    CoreError::details(ErrorCode::IpcInvalidRequest, details)
}
