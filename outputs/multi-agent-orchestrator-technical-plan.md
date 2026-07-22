# 多 Agent 编程调度平台：技术规划说明

> 文档版本：0.1  
> 日期：2026-07-20  
> 状态：立项与架构设计基线  
> 工作名称：AgentHub（名称可更换）

## 1. 产品定义

### 1.1 一句话定位

一个以本地 CLI 为执行后端、以用户定义团队为配置、以聊天式工作台为入口的多 Agent 软件工程编排平台。

产品不训练新的模型，也不替代 Codex、Claude Code、Kimi Code 或 OpenCode；它把这些 Agent 集成到一个应用中，并负责会话、任务、上下文、代码工作区、验收和审计。

### 1.2 用户价值

用户只打开一个应用，就可以：

- 检测和配置多个 Coding Agent CLI；
- 在同一个项目中分别与不同 Agent 聊天；
- 保存、恢复和搜索项目会话；
- 自定义主 Agent、子 Agent、角色、能力和限制；
- 让主 Agent 拆分目标并分配任务；
- 在 Agent 之间传递摘要、接口契约、Diff 和测试结果；
- 查看实时状态、命令、文件变更、审批和验收；
- 用 Git worktree 隔离并行任务；
- 在审查和测试通过后确认合并。

### 1.3 两种工作模式

单 Agent 模式：

    选择项目 → 选择 Agent → 聊天输入任务 → 查看事件和 Diff → 测试并保存会话

Agent 团队模式：

    提交项目目标
    → 主 Agent 自主判断：自己完成、委派一部分，或拆成多个任务
    → 只有主 Agent 选择委派时，才调用团队工具
    → 系统校验并执行已选择的委派
    → 验收、审查、修复
    → 用户批准合并
    → 主 Agent 汇总或继续工作

单 Agent 模式不是临时简化功能，而是团队模式中每个成员会话的基础。

## 2. 范围与边界

### 2.1 首版必须包含

- Windows 桌面应用；
- React 聊天式工作台；
- Codex、Claude Code、Kimi Code、OpenCode 的适配框架；
- 自定义 CLI 注册；
- CLI 检测、版本、配置和会话管理；
- 统一 Agent 事件协议；
- 用户定义 Agent 实例、角色、团队和主 Agent；
- 可选的结构化任务计划、DAG、依赖和有限并行；
- 每个代码任务独立 Git worktree；
- 路径、命令、环境变量和审批策略；
- 测试、Lint、构建等验收；
- Diff、审查和人工合并；
- 崩溃和重启恢复；
- 日志、审计和诊断；
- 聊天界面为默认入口，原始终端仅作调试兜底。

### 2.2 首版不做

- 自研模型或统一模型 API；
- 云端多人协作；
- Kubernetes 或跨机器 Worker；
- 完整 A2A 标准；
- 自动购买或管理第三方订阅；
- 自动替用户处理各家账号验证；
- 无审计的任意 Shell 执行；
- 以终端屏幕抓取作为主要统一协议。

## 3. 核心原则

### 3.1 主 Agent 可替换

任何 Agent Instance 都可以担任主 Agent。Provider、模型、角色、能力和成员数量全部由用户定义；Codex 不固定是后端，Claude Code 不固定是规划者。

### 3.2 主 Agent 自主决定是否委派，Orchestrator 负责执行已选择的委派

主 Agent 不需要在每个任务中调用子 Agent。它可以：

- 直接在当前会话完成整个目标；
- 只把某个局部问题交给一个成员；
- 创建多个并行任务；
- 先自己分析，再决定是否委派；
- 根据子 Agent 结果继续自己工作。

平台不替模型做这个判断，只提供选择和工具：

    主 Agent：判断是否需要委派，以及委派给谁
    Orchestrator：校验、启动、监管、验收、回传实际被委派的任务

主 Agent 可以调用 team.create_task、team.assign_task、team.send_message、team.get_progress、team.request_review、team.retry_task 和 team.cancel_task 等业务工具。没有调用这些工具时，系统不会强行创建子任务。

建议提供用户级委派策略：

    autonomous       主 Agent 自主决定（默认）
    ask_before_delegate  主 Agent 提议后等待用户批准
    direct_only      禁止调用子 Agent，仅允许主 Agent 自己完成

### 3.3 聊天优先，终端兜底

默认 UI 展示 Agent 消息、计划、任务分配、文件变更、命令、测试、审批、交接和错误卡片。Provider 没有结构化输出、用户调试或明确要求时，再打开原始终端。

### 3.4 系统事实优先

Agent 说“完成”不等于完成。完成条件是：

    进程正常结束
    + 结构化结果合法
    + 变更文件在允许范围
    + 验收命令通过
    + 必要的审查或批准完成

### 3.5 可恢复优先

任务、运行、审批和事件都持久化，支持应用重启、CLI 崩溃、超时、冲突和稍后继续。

## 4. 总体架构

    用户
      ↓
    React 聊天工作台
      ↓ 受控 IPC
    Electron Main / IPC Gateway
      ↓ 本地 Named Pipe 或 Unix Domain Socket
    Core Daemon
      ├─ Domain 与状态机
      ├─ Orchestrator
      ├─ Agent Adapter Registry
      ├─ Process Runtime / PTY
      ├─ Git 与 Worktree Runtime
      ├─ Verification Engine
      ├─ Policy Engine
      ├─ SQLite Persistence
      └─ Event Store / Audit Log
      ↓
    Codex / Claude Code / Kimi Code / OpenCode / Custom CLI

Renderer 只负责界面、交互、缓存和展示。Core Daemon 负责进程、文件、Git、任务、权限和数据库。Core Daemon 独立于 Renderer，保证 UI 崩溃或窗口关闭时任务仍可恢复。

Windows 首选 Named Pipe；macOS/Linux 使用 Unix Domain Socket；连接需要随机令牌。

### 4.1 技术选型

| 层 | 方案 | 原因 |
|---|---|---|
| 桌面 | Electron | Node CLI、PTY 和 Windows 集成风险低 |
| 前端 | React + TypeScript + Vite | 适合复杂工作台 |
| UI | Tailwind CSS + Radix UI 或等价组件 | 一致、可访问、易定制 |
| 状态 | TanStack Query + Zustand | 区分服务端状态和 UI 状态 |
| 终端兜底 | xterm.js + node-pty | 支持 PTY Provider 和诊断 |
| Core | Node.js + TypeScript | 与 CLI、Git、JSONL 共享类型 |
| 数据库 | SQLite + better-sqlite3 + Drizzle | 本地优先、事务和迁移清晰 |
| 协议 | Zod + JSON Schema | 运行时校验、跨进程共享 |
| Git | 受控封装的系统 Git CLI | 兼容性和可诊断性好 |
| 测试 | Vitest + Playwright + Electron E2E | 覆盖协议、核心和桌面流程 |

未来可以替换 Tauri 作为桌面外壳，但不应让首版同时承担 Rust 迁移和 CLI 运行时风险。

## 5. 领域模型

领域关系：

    Provider
      一种 CLI 的能力定义
    AgentInstance
      本机某个可执行文件、参数、配置和账户环境
    Role
      职责、能力、限制和权限
    TeamMember
      AgentInstance + Role
    TeamDefinition
      成员集合、主 Agent、路由规则和规划策略
    Project
      本地仓库、技术栈、目录映射和项目策略
    ProjectRun
      用户提交的一次完整目标
    Task
      可交付工作单元、依赖、路径和验收标准
    AgentRun
      Task 的一次具体执行尝试
    Session
      用户或团队与 Provider 的逻辑会话
    Event
      运行中的不可变事实

### 5.1 核心类型

    interface AgentInstance {
      id: string;
      providerId: string;
      name: string;
      executable: string;
      baseArgs: string[];
      model?: string;
      profile?: string;
      environmentPolicyId: string;
      enabled: boolean;
    }

    interface Role {
      id: string;
      name: string;
      description: string;
      responsibilities: string[];
      strengths: Record<string, number>;
      limitations: string[];
      systemInstructions: string;
      permissionPolicyId: string;
    }

    interface TeamMember {
      id: string;
      agentInstanceId: string;
      roleId: string;
      allowedTaskTypes: string[];
      maxConcurrentTasks: number;
      enabled: boolean;
    }

    interface TeamDefinition {
      id: string;
      name: string;
      mainMemberId: string;
      memberIds: string[];
      routingRules: RoutingRule[];
    }

    interface Task {
      id: string;
      projectRunId: string;
      title: string;
      objective: string;
      taskType: string;
      assignedMemberId?: string;
      dependencies: string[];
      allowedPaths: string[];
      acceptanceCriteria: AcceptanceCriterion[];
      status: TaskStatus;
      attempt: number;
    }

没有 Git 的目录可以使用单 Agent 模式；团队模式要求 Git 仓库，以获得 worktree、提交、合并和完整审计。

## 6. 统一 Agent 适配层

### 6.1 Adapter 接口

    interface AgentCliAdapter {
      detect(request: DetectRequest): Promise<DetectionResult>;
      getVersion(request: VersionRequest): Promise<VersionResult>;
      capabilities(): AdapterCapabilities;
      start(request: StartAgentRequest): AsyncIterable<RuntimeEvent>;
      send(request: SendAgentInputRequest): Promise<void>;
      cancel(request: CancelRunRequest): Promise<void>;
      resume?(request: ResumeAgentRequest): AsyncIterable<RuntimeEvent>;
    }

Adapter 隐藏各家 CLI 的启动参数、输出格式、会话 ID、恢复方式、退出码、交互输入、权限参数和错误格式。

### 6.2 运行模式

    headless_structured
    headless_text
    long_running_stdin
    pty_interactive
    provider_server

选择顺序：

1. 结构化无头；
2. 结构化无头加原生恢复；
3. 长驻 stdin；
4. PTY；
5. 纯文本兼容。

每个 Provider 都有版本矩阵、fixture 和契约测试。背景会话中的具体命令不能视为永久 API，实际参数以本机版本 help 和官方文档为准。

### 6.3 统一事件

    run.started
    agent.message
    tool.started
    tool.finished
    command.started
    command.finished
    file.changed
    approval.requested
    usage.updated
    run.waiting
    run.completed
    run.failed

事件外层字段：

    schemaVersion
    eventId
    sequence
    projectId
    projectRunId
    taskId
    runId
    type
    timestamp
    payload

每个运行的 sequence 单调递增。客户端断线后按 lastSequence 补发，不重新解析整段终端输出。

### 6.4 Codex 适配器

当前官方 Codex 文档将 codex exec 定义为稳定的非交互命令；使用 --json 时，stdout 是 JSON Lines 事件流，可包含 thread、turn、item 和 error 事件；也支持用 --output-schema 约束最终结构化输出。默认执行权限是只读，需要修改工作区时应显式选择 workspace-write 等策略。

因此首版 CodexAdapter：

- 默认使用 codex exec；
- 需要实时事件时使用 codex exec --json；
- 规划和结果回传使用 JSON Schema 校验；
- 根据任务策略显式设置 sandbox 和 approval；
- 保存并关联 Provider 返回的 session/thread ID；
- 不把 app-server 作为首版核心依赖，因为官方文档当前标记为 experimental；
- codex mcp-server 作为未来可选桥接，不作为内部调度必要条件；
- 不直接读取或复制 Codex 私有认证文件；
- 自动化时按单次运行最小化注入密钥并脱敏日志。

适配器必须覆盖未安装、未登录、版本过低、未知 JSONL 事件、解析失败、超时、取消、进程树终止、Schema 不合法和 resume 不可用。

### 6.5 其他 Provider 和自定义 CLI

Claude Code、Kimi Code 和 OpenCode 的参数必须以本机版本和官方文档为准。优先使用 headless/JSON/JSONL；只有 PTY 时保留原始终端，并把结构化能力标记为 degraded。

自定义 CLI 至少要能确定可执行路径、接收 prompt 或 stdin、返回退出码，并可配置解析器、超时和环境白名单。默认是 text-only，不自动获得高级事件卡片。

## 7. 主 Agent 决策与委派协议

主 Agent 的输出不一定是任务计划。它可以返回最终答复，也可以在需要时调用委派工具。系统必须支持以下三种合法路径：

1. 直接完成：主 Agent 自己完成目标，不创建子任务；
2. 单次委派：把一个局部目标交给一个成员；
3. 任务计划：在确有必要时创建带依赖的多个任务。

主 Agent 输出声明式委派意图，不直接提交 Shell 命令。

    interface PlanResponse {
      planVersion: 1;
      summary: string;
      tasks: PlannedTask[];
      unresolvedQuestions: string[];
      completionCriteria: string[];
    }

    interface PlannedTask {
      id: string;
      title: string;
      objective: string;
      taskType: string;
      assignedMemberId: string;
      dependencies: string[];
      allowedPaths: string[];
      acceptanceCriteria: AcceptanceCriterion[];
      contextNeeds: ContextNeed[];
      assignmentReason: string;
    }

校验规则：

- assignedMemberId 必须存在且启用；
- 依赖必须存在且不能成环；
- allowedPaths 必须是项目策略的子集；
- taskType 必须在注册表中；
- acceptance 只能引用项目允许的命令模板；
- 任务数、并发数、规划轮数和预算不能超限；
- 不能注入未声明的环境变量、密钥或任意执行脚本。

非法委派或计划会被拒绝，并把具体错误反馈给主 Agent。直接完成路径不需要伪造一个空的 DAG。

推荐的顶层决策记录：

    interface PlannerDecision {
      mode: "direct" | "delegate" | "plan";
      rationale: string;
      task?: PlannedTask;
      tasks?: PlannedTask[];
    }

mode 为 direct 时，系统只记录主 Agent 的运行和结果；mode 为 delegate 或 plan 时，才创建对应的 AgentRun/Task。

## 8. Orchestrator 与状态机

### 8.1 Project Run 状态

    planning
    plan_review
    queued
    executing
    verifying
    review_required
    merge_ready
    merging
    completed
    waiting_user
    paused
    rework
    conflict
    failed
    cancelled

### 8.2 Task 状态

    draft
    ready
    blocked_dependency
    queued
    running
    waiting_user
    waiting_approval
    verifying
    review_required
    merge_ready
    completed
    failed
    cancelled

状态只能由 Orchestrator 事务化更新，Renderer 不直接写状态。

### 8.3 调度循环

调度器只处理主 Agent 已经选择委派的任务：

1. 找到依赖完成的 ready 任务；
2. 按用户路由规则、能力、负载和资源上限排序；
3. 校验路径、命令和权限；
4. 创建 worktree（代码委派时）；
5. 创建 AgentRun；
6. 启动 Provider CLI；
7. 采集事件；
8. 运行验收；
9. 发布结果给主 Agent；
10. 由主 Agent决定继续自己做、再次委派、重试、拆分或询问用户。

如果主 Agent 选择 direct，系统不创建子 Agent、不自动拆分，也不为了满足团队模式而制造任务图。

默认限制：

    max_parallel_tasks: 2
    max_planning_rounds: 8
    max_task_attempts: 3
    max_task_minutes: 60
    max_idle_minutes: 10
    max_project_run_minutes: 240
    max_context_bytes: 200000

## 9. Git 与工作区隔离

### 9.1 基本规则

- 团队委派任务默认使用独立 worktree；
- 主 Agent 直接修改代码时，默认也使用一个独立 run worktree，用户可以在设置中选择直接使用当前工作区；
- 不在用户当前脏工作区执行并行任务；
- 每个代码运行固定 base commit；
- 下游任务只能读取已发布的依赖产物或已合并的集成分支；
- 合并默认需要用户批准；
- 平台不自动执行 git push。

### 9.2 推荐流程

    用户项目工作区
      ↓ 只读检测分支和脏状态
    主 Agent 选择 direct 或 delegate
      ↓
    direct：创建一个主运行 worktree（默认）
    delegate：为每个代码任务创建 task worktree
      ↓
    Agent 修改并提交
      ↓
    系统验收和 Diff
      ↓
    单运行：用户确认导出
    多任务：进入 merge queue，用户批准后合并

worktree 放在应用数据目录，例如：

    <app-data>/projects/<project-id>/worktrees/<run-or-task-id>

路径必须规范化，并处理 Windows 大小写、junction、symlink 和相对路径穿越。

### 9.3 冲突策略

发生冲突时：

1. 暂停自动合并；
2. 标记 conflict；
3. 展示冲突文件和父提交摘要；
4. 创建可选的 rework 委派；
5. 由主 Agent、指定成员或用户处理；
6. 重新运行受影响验收；
7. 不自动覆盖用户文件。

## 10. 上下文交接

上下文交接只在主 Agent 选择委派，或用户点击“交给另一个 Agent”时发生。主 Agent 直接完成时，不需要生成虚假的交接记录。

Context Bundle 包括：

- 目标和局部任务；
- 角色、限制和权限；
- 相关文件索引；
- base commit 和 worktree；
- 已完成的 commit；
- API/数据契约；
- 测试结果；
- 已知风险；
- 必要的用户决策。

不默认传递：

- 全部原始终端输出；
- 无关文件；
- 完整内部思考过程；
- 其他成员的敏感环境变量；
- 未筛选的长日志。

上下文生成器按字节预算裁剪，优先保留接口契约、失败信息和最近变更。

## 11. 权限与安全

### 11.1 桌面边界

Renderer 必须：

- 禁用 Node integration；
- 开启 context isolation；
- 只通过白名单 IPC；
- 使用严格 CSP；
- 不接受任意命令执行接口；
- 不直接读写项目或数据库。

### 11.2 命令策略

命令分为：

    safe      自动允许
    approval  按范围询问用户
    blocked   默认拒绝

项目可以注册安全命令模板，但主 Agent 只能引用模板 ID，不能提交任意 Shell。示例：

    safe: pnpm test, pnpm lint, go test ./...
    approval: package install, git commit, network request
    blocked: git push --force, 删除项目根目录, 读取凭证目录

### 11.3 路径策略

每次文件事件和任务结束时检查：

- 规范化绝对路径是否位于 project root；
- 是否位于成员 allowedPaths；
- 是否触碰 secrets、.git 或系统目录；
- 是否经 junction/symlink 越界；
- 是否修改了任务声明外的文件。

本地同用户权限下的路径检查不是绝对 OS 沙箱。需要强隔离时提供 Docker/WSL executor，并在 UI 显示运行安全等级。

### 11.4 凭证和审批

- 默认不把宿主机全部环境传给 CLI；
- 使用 Provider 环境白名单；
- 机密通过系统凭证存储或一次性注入；
- 输出、事件、崩溃报告和诊断包必须脱敏；
- 不读取或复制第三方 CLI 私有 auth 文件；
- 审批范围支持 once、run、task、project、global；
- 默认策略为 on-request。

## 12. 聊天式工作台

### 12.1 主布局

    ┌────────────────────────────────────────────────────────────────┐
    │ 项目 / 分支 / 当前运行 / 设置                                   │
    ├──────────────────┬────────────────────────────────┬────────────┤
    │ 会话列表          │ 当前会话：Codex                 │ Agent 分配 │
    │                  │                                │            │
    │ 本项目            │ 类似 Codex 的聊天窗口            │ 用户定义   │
    │  • 会话 1         │ Agent 消息、工具摘要、审批和结果  │ Agent A    │
    │  • 会话 2         │                                │ ● 运行中   │
    │                  │                                │            │
    │ 其他项目          │                                │ Agent B    │
    │  • 会话 3         │                                │ ○ 空闲     │
    │                  │                                │            │
    │ [新建会话]        │ [Diff] [测试] [任务] [原始终端]（抽屉）│ Agent C    │
    │                  │                                │ ○ 等待审批 │
    ├──────────────────┴────────────────────────────────┴────────────┤
    │ 向当前会话中的 Agent 或用户定义团队输入消息          [发送] [停止] │
    └────────────────────────────────────────────────────────────────┘

上图中的成员 A/B 只是动态占位符，不是内置角色。实际显示内容来自用户的 TeamDefinition，可以是任意名称、Provider、模型和职责；成员数量可以为 1 个或多个，用户可以随时添加、删除、禁用或更换主 Agent。

界面不得出现固定的“前端成员”“后端成员”“审查成员”栏目。用户若想定义这些角色，可以自己创建；不定义就不显示。

主 Agent 直接完成时，右侧仍显示用户定义的 Agent 状态，但不显示虚假的子任务。只有发生委派才在对应 Agent 下显示任务分配。

左侧是 Session 列表，按项目、Agent 和最近活动分组；点击会话直接恢复该 Session。右侧是动态 Agent 分配栏，显示用户定义的成员、Provider、模型、角色摘要、当前状态、已分配任务和未读数。点击右侧 Agent 时，系统打开该 Agent 最近的 Session；若没有 Session，则创建新会话或提示用户确认。聊天消息、运行状态、未读数和任务上下文按 Session 隔离。

### 12.2 Timeline 卡片

- agent.message：自然语言回复；
- planner.decision：直接完成、单次委派或任务计划；
- task.assigned：成员分配；
- handoff.created：上下文交接；
- command.execution：折叠命令和退出码；
- file.change：文件和 Diff 入口；
- verification.result：测试、Lint、构建；
- approval.request：用户审批；
- run.waiting：等待输入或依赖；
- run.failed：错误和重试。

原始终端通过“查看原始输出”抽屉打开，不占据默认主界面。

### 12.3 前端职责

负责工作台视觉、项目/Agent/团队/任务表单、聊天时间线、任务 DAG、Diff、测试结果、审批、终端抽屉、IPC 客户端、断线重连、主题、国际化、无障碍和 E2E。

不负责 spawn CLI、执行 Shell、管理 Git、决定任务完成或直接写数据库。

## 13. IPC 与业务 API

IPC 是业务级、类型安全的接口，不能暴露 runShell。

### 13.1 查询

    project.list
    project.get
    agent.list
    agent.detect
    team.list
    team.get
    task.list
    task.get
    session.list
    run.get
    git.status
    git.diff
    artifact.get

### 13.2 命令

    project.add
    project.scan
    agent.create
    agent.update
    session.create
    session.send
    run.start
    run.cancel
    run.pause
    run.resume
    team.create
    team.update
    team.validate
    team.plan
    team.delegate
    task.approve
    task.retry
    task.cancel
    verification.run
    git.merge.prepare
    git.merge.approve

### 13.3 实时事件

    event.subscribe
    event.replay
    event.ack

客户端断线后带 projectRunId 和 lastSequence 重新订阅；Core Daemon 从事件存储补发。

统一错误码示例：

    AGENT_NOT_FOUND
    AGENT_NOT_AUTHENTICATED
    PROVIDER_VERSION_UNSUPPORTED
    RUN_START_FAILED
    RUN_TIMEOUT
    RUN_CANCELLED
    PLAN_SCHEMA_INVALID
    PLAN_MEMBER_NOT_FOUND
    PLAN_DEPENDENCY_CYCLE
    PATH_POLICY_VIOLATION
    COMMAND_APPROVAL_REQUIRED
    VERIFICATION_FAILED
    WORKTREE_CREATE_FAILED
    MERGE_CONFLICT
    RECOVERY_REQUIRED

## 14. 数据持久化

核心表：

| 表 | 用途 |
|---|---|
| projects | 项目和 Git 信息 |
| provider_installations | CLI 路径、版本和检测状态 |
| agent_instances | Agent 实例和参数 |
| roles | 职责、能力、权限 |
| team_definitions | 团队和主 Agent |
| team_members | 成员绑定关系 |
| sessions | 用户/Provider 会话 |
| project_runs | 一次完整目标 |
| tasks | 委派任务和状态 |
| task_dependencies | DAG 依赖 |
| agent_runs | 每次进程执行 |
| runtime_events | 不可变事件 |
| messages | Agent 间消息 |
| artifacts | Diff、契约、测试和摘要 |
| worktrees | worktree、分支和 base commit |
| verification_runs | 验收命令和结果 |
| approvals | 审批记录 |
| audit_logs | 审计 |
| capability_scores | 后续的历史表现统计 |

要求：

- SQLite 开启 WAL；
- 迁移带版本且可重复执行；
- runtime_events 只追加；
- 当前状态是事件投影，必要时可重建；
- 大日志和 Diff 以内容哈希文件保存；
- 支持日志保留和用户删除。

## 15. 失败恢复

### 15.1 应用或 Daemon 崩溃

启动扫描：

- running 但进程不存在的 AgentRun；
- 没有结束事件的运行；
- 未完成的 worktree；
- 未完成的验收；
- 等待审批的任务。

根据最后事件标为 crashed、recovery_required 或 waiting_user，不擅自判定成功。

### 15.2 Provider 退出

- 非零退出码记录 provider_exit；
- JSONL 解析失败保留原始片段并降级；
- 无输出超时进入 idle timeout；
- 可重试错误按策略退避；
- 不可重试错误交给用户或主 Agent。

### 15.3 主 Agent 失败

主 Agent 失败不删除已完成的任务或产物。用户可以恢复原会话、更换另一个成员为主 Agent、手动继续或结束 Project Run。

### 15.4 direct 与 delegate 都可恢复

direct 模式恢复主 Agent 的单个 AgentRun；delegate/plan 模式恢复各个子任务和依赖。系统不强制把 direct 运行转换为空的任务 DAG。

## 16. 测试策略

### 16.1 单元测试

覆盖 DAG 环检测、路径规范化、权限匹配、命令模板、状态转换、事件序列、Schema、上下文裁剪、Git 分支命名和委派策略。

### 16.2 Adapter 契约测试

每个 Provider 用 fake CLI fixture 覆盖未安装、版本检测、正常结构化事件、未知事件、malformed JSONL、混合 stderr、最终结果、超时、取消、进程树清理以及 resume 可用/不可用。

### 16.3 Core 集成测试

用临时 Git 仓库验证 direct 单 Agent、单次委派、多任务并行、worktree、验收、merge queue、冲突、事件补发、重启恢复和权限拒绝。

### 16.4 Electron E2E

关键流程：

1. 添加项目；
2. 检测 CLI；
3. 选择主 Agent；
4. 发送任务；
5. 主 Agent 选择 direct，验证不创建子任务；
6. 主 Agent 选择 delegate，验证出现任务和子 Agent；
7. 查看 Diff；
8. 处理审批；
9. 批准合并；
10. 重启后恢复。

## 17. 仓库结构

    agenthub/
    ├─ apps/desktop/
    │  ├─ renderer/
    │  │  ├─ features/projects
    │  │  ├─ features/agents
    │  │  ├─ features/teams
    │  │  ├─ features/tasks
    │  │  ├─ features/timeline
    │  │  ├─ features/diff
    │  │  └─ features/approvals
    │  ├─ main/ipc-gateway
    │  └─ preload
    ├─ packages/
    │  ├─ domain
    │  ├─ schemas
    │  ├─ event-protocol
    │  ├─ core-daemon
    │  ├─ orchestrator
    │  ├─ process-runtime
    │  ├─ pty-runtime
    │  ├─ git-runtime
    │  ├─ verification
    │  ├─ policy
    │  ├─ persistence
    │  └─ cli-adapters/{codex,claude,kimi,opencode,custom}
    ├─ tests/{fixtures,contract,integration,e2e}
    └─ docs/{adr,provider-matrices,schemas}

## 18. 前后端研发分工

### 18.1 前端

- 聊天工作台和视觉系统；
- 项目、Agent、团队、任务配置；
- direct/delegate/plan 三种决策展示；
- Timeline、任务树、Diff、验收和审批；
- 原始终端调试抽屉；
- 状态缓存、事件重连、主题、国际化、无障碍；
- Playwright、截图回归和 UI 组件测试。

### 18.2 后端/运行时

- Core Daemon 和 SQLite；
- CLI Adapter、spawn、PTY、取消、超时；
- Orchestrator、委派工具和状态机；
- Git worktree、Diff、merge queue；
- Policy、审批、验收和恢复；
- 事件存储、审计和诊断；
- IPC 服务端和集成测试。

### 18.3 共同冻结的契约

- Domain Schema；
- RuntimeEvent；
- PlannerDecision、PlanResponse、AgentResult；
- TaskStatus 和 RunStatus；
- IPC API；
- 错误码；
- 权限模型；
- 事件重放规则。

## 19. 研发阶段

### M0：架构基线（1–2 周）

交付 monorepo、Electron 壳、Core Daemon 通信、SQLite、Domain/Schema、IPC、事件协议、fake CLI 和 ADR。

### M1：单 Agent 聊天闭环（2–3 周）

交付项目添加、CLI 检测、CodexAdapter、聊天 Timeline、停止/取消、历史会话和原始终端抽屉。

验收：用户无需打开外部终端即可让主 Agent 完成一个任务，并看到消息、文件变更、验证和会话历史。

### M2：Provider 与配置（3–4 周）

交付 Claude、Kimi、OpenCode 适配器、版本矩阵、能力降级、Provider 设置和恢复诊断。

### M3：可选委派与团队（3–4 周）

交付 Role、Team、Member 编辑器，任意主 Agent，PlannerDecision，委派工具，消息和上下文交接。

验收：主 Agent 可以选择 direct；也可以调用委派工具；两条路径都能在同一时间线中追踪。

### M4：Worktree、验收和合并（3–4 周）

交付独立 worktree、命令模板、验收、Diff、merge queue、冲突和人工批准。

### M5：安全、恢复和发布（3–5 周）

交付审批、脱敏、进程树终止、重启恢复、诊断包、Windows 安装包、E2E、性能和安全测试。

两名全职开发者按上述范围，私有 Alpha 约 10–12 周，Beta 约 16–20 周；四个 Provider、跨平台兼容、恢复和安全做稳后再发布 1.0。

## 20. 完成定义

首版完整闭环必须满足：

- 一个应用可配置四类 CLI；
- 主 Agent 可以直接完成任务，也可以自主选择委派；
- 用户可定义主 Agent、子 Agent、角色和能力；
- 委派时系统校验成员、路径、命令和依赖；
- 委派任务使用独立 worktree；
- 事件、消息、Diff、验收和审批可追踪；
- 验收失败不会被标记为完成；
- 合并默认需要用户确认；
- direct 和 delegate 两种运行都能在重启后恢复；
- 危险命令、越界路径和未授权 IPC 会被拦截；
- Provider 能力不足时明确降级；
- 关键动作有审计记录。

## 21. 结论

产品核心不是“强迫主 Agent 组织一支团队”，而是：

    一个聊天优先的本地 AI 编程工作台
    + 可配置的 Agent 团队
    + 主 Agent 自主选择 direct 或 delegate
    + 可靠的进程、Git、验收、权限和恢复控制面

主 Agent 可以像普通 Coding Agent 一样自己完成任务，也可以在判断有价值时调用子 Agent。平台只在它选择协作后提供可靠的执行、验证和交接能力。

## 22. 参考资料与事实边界

- Codex 官方手册：Non-interactive mode、Developer commands、Approvals/Sandboxing。本文据此采用 codex exec、JSONL、output schema 和显式 sandbox 的接入策略。
- Codex 官方手册当前将 app-server 标为 experimental，因此本文没有把它作为首版核心依赖。
- Claude Code、Kimi Code、OpenCode 的具体参数和输出格式必须在实现阶段按各自当前版本官方文档与本机 help 验证；本规划不把背景会话中的命令当作永久 API。

官方文档入口：

    https://developers.openai.com/codex/
    https://learn.chatgpt.com/docs/non-interactive-mode
    https://learn.chatgpt.com/docs/developer-commands
