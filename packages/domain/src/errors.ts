export type AgentHubErrorCode =
  | "AGENT_NOT_FOUND"
  | "AGENT_NOT_AUTHENTICATED"
  | "PROVIDER_VERSION_UNSUPPORTED"
  | "RUN_START_FAILED"
  | "RUN_TIMEOUT"
  | "RUN_IDLE_TIMEOUT"
  | "RUN_CANCELLED"
  | "PLAN_SCHEMA_INVALID"
  | "PLAN_MEMBER_NOT_FOUND"
  | "PLAN_DELEGATION_NOT_ALLOWED"
  | "PLAN_TASK_TYPE_NOT_ALLOWED"
  | "PLAN_DEPENDENCY_NOT_FOUND"
  | "PLAN_DEPENDENCY_CYCLE"
  | "PLAN_APPROVAL_NOT_FOUND"
  | "RECOVERY_SCHEMA_INVALID"
  | "PATH_POLICY_VIOLATION"
  | "COMMAND_APPROVAL_REQUIRED"
  | "COMMAND_BLOCKED"
  | "APPROVAL_NOT_FOUND"
  | "RECOVERY_NOT_AVAILABLE"
  | "CREDENTIAL_STORE_FAILED"
  | "VERIFICATION_FAILED"
  | "WORKTREE_CREATE_FAILED"
  | "MERGE_CONFLICT"
  | "RECOVERY_REQUIRED"
  | "IPC_INVALID_REQUEST"
  | "IPC_NOT_FOUND"
  | "IPC_INTERNAL_ERROR";

export type RetryStrategy = "immediate" | "backoff" | "user_action" | "never";

export interface ErrorDescriptor {
  message: string;
  retryable: boolean;
  retryStrategy: RetryStrategy;
  userAction: string;
}

export const errorCatalog: Record<AgentHubErrorCode, ErrorDescriptor> = {
  AGENT_NOT_FOUND: { message: "找不到指定 Agent。", retryable: false, retryStrategy: "user_action", userAction: "检查 Agent 和团队成员配置。" },
  AGENT_NOT_AUTHENTICATED: { message: "Agent 尚未完成登录。", retryable: false, retryStrategy: "user_action", userAction: "先在对应 CLI 中完成登录。" },
  PROVIDER_VERSION_UNSUPPORTED: { message: "当前 Provider 版本不受支持。", retryable: false, retryStrategy: "user_action", userAction: "升级 CLI 或调整兼容配置。" },
  RUN_START_FAILED: { message: "Agent 进程启动失败。", retryable: true, retryStrategy: "backoff", userAction: "检查可执行路径、权限和 CLI 安装。" },
  RUN_TIMEOUT: { message: "Agent 运行超时。", retryable: true, retryStrategy: "backoff", userAction: "重试或增加任务超时时间。" },
  RUN_IDLE_TIMEOUT: { message: "Agent 长时间没有输出。", retryable: true, retryStrategy: "backoff", userAction: "检查是否等待输入，或重试运行。" },
  RUN_CANCELLED: { message: "运行已取消。", retryable: false, retryStrategy: "never", userAction: "需要时重新启动任务。" },
  PLAN_SCHEMA_INVALID: { message: "主 Agent 返回的计划格式无效。", retryable: true, retryStrategy: "immediate", userAction: "让主 Agent 按协议重新输出。" },
  PLAN_MEMBER_NOT_FOUND: { message: "计划引用了不存在、禁用或不可用的成员。", retryable: true, retryStrategy: "immediate", userAction: "从用户启用的团队成员中重新选择。" },
  PLAN_DELEGATION_NOT_ALLOWED: { message: "当前团队策略不允许委派。", retryable: true, retryStrategy: "immediate", userAction: "选择 direct，或修改团队委派策略。" },
  PLAN_TASK_TYPE_NOT_ALLOWED: { message: "所选成员不接受该任务类型。", retryable: true, retryStrategy: "immediate", userAction: "改选允许该任务类型的启用成员。" },
  PLAN_DEPENDENCY_NOT_FOUND: { message: "计划引用了不存在的任务依赖。", retryable: true, retryStrategy: "immediate", userAction: "返回依赖 ID 完整且自包含的任务图。" },
  PLAN_DEPENDENCY_CYCLE: { message: "任务依赖存在循环。", retryable: true, retryStrategy: "immediate", userAction: "修改任务依赖后重试。" },
  PLAN_APPROVAL_NOT_FOUND: { message: "当前运行没有等待处理的委派审批。", retryable: false, retryStrategy: "user_action", userAction: "刷新运行状态后再审批。" },
  RECOVERY_SCHEMA_INVALID: { message: "主 Agent 返回的失败处理决策无效。", retryable: true, retryStrategy: "immediate", userAction: "按 retry、take_over 或 continue 格式重新输出。" },
  PATH_POLICY_VIOLATION: { message: "Agent 修改了不允许的路径。", retryable: false, retryStrategy: "user_action", userAction: "检查任务路径权限。" },
  COMMAND_APPROVAL_REQUIRED: { message: "该命令需要用户审批。", retryable: false, retryStrategy: "user_action", userAction: "批准或拒绝该命令。" },
  COMMAND_BLOCKED: { message: "该命令被权限策略阻止。", retryable: false, retryStrategy: "never", userAction: "修改项目权限策略后重试。" },
  APPROVAL_NOT_FOUND: { message: "找不到待处理的审批请求。", retryable: false, retryStrategy: "user_action", userAction: "刷新审批列表后重试。" },
  RECOVERY_NOT_AVAILABLE: { message: "当前运行不可恢复。", retryable: false, retryStrategy: "user_action", userAction: "选择处于暂停或失败状态的运行。" },
  CREDENTIAL_STORE_FAILED: { message: "凭证存储操作失败。", retryable: false, retryStrategy: "user_action", userAction: "检查本地数据目录权限。" },
  VERIFICATION_FAILED: { message: "验收命令失败。", retryable: true, retryStrategy: "user_action", userAction: "查看测试结果并修复后重试。" },
  WORKTREE_CREATE_FAILED: { message: "Git worktree 创建失败。", retryable: true, retryStrategy: "backoff", userAction: "检查 Git 状态和目录权限。" },
  MERGE_CONFLICT: { message: "合并产生冲突。", retryable: false, retryStrategy: "user_action", userAction: "处理冲突后重新验证。" },
  RECOVERY_REQUIRED: { message: "运行需要恢复处理。", retryable: false, retryStrategy: "user_action", userAction: "选择恢复、重试或结束运行。" },
  IPC_INVALID_REQUEST: { message: "请求格式无效。", retryable: false, retryStrategy: "never", userAction: "刷新应用或检查客户端版本。" },
  IPC_NOT_FOUND: { message: "请求的资源不存在。", retryable: false, retryStrategy: "user_action", userAction: "刷新列表后重试。" },
  IPC_INTERNAL_ERROR: { message: "Core Daemon 发生内部错误。", retryable: true, retryStrategy: "backoff", userAction: "重试并导出诊断信息。" }
};

export interface AgentHubError {
  code: AgentHubErrorCode;
  message: string;
  retryable: boolean;
  retryStrategy: RetryStrategy;
  userAction: string;
  details?: Record<string, unknown>;
}

export function createAgentHubError(
  code: AgentHubErrorCode,
  details?: Record<string, unknown>
): AgentHubError {
  return { code, ...errorCatalog[code], details };
}
