# AgentHub 项目介绍与当前进度

> 更新时间：2026-07-22  
> 当前版本：0.1.0  
> 项目状态：基础工程、共享契约、桌面工作台、持久化、IPC、CLI Runtime、主 Agent 可选委派、Git/验收、安全/恢复与自动化测试已完成；Codex/Kimi Code Adapter 已按官方文档和真实 CLI 验证，Claude Code/OpenCode 仍为未验证骨架

## 1. 项目简介

AgentHub 是一个本地多 Agent 编程工作台。

它不训练新模型，也不替代 Codex、Claude Code、Kimi Code 或 OpenCode，而是把这些本地 Coding Agent CLI 集成到一个应用中，让用户能够：

- 在一个界面管理多个 Coding Agent；
- 为每个 Agent 实例配置 CLI 连接、参数、环境、凭证与接入地址；
- 为每个团队成员配置模型、推理深度、角色、能力和限制；
- 自定义团队成员数量和职责；
- 新建主会话时自行选择 CLI，团队只提供可选的子 Agent；
- 让主 Agent 自己完成任务，或自主委派给其他成员；
- 通过统一聊天界面查看不同 Agent 的 Session；
- 管理任务、文件变更、测试、审批、Diff 和 Git 合并。

## 2. 核心产品规则

### 2.1 成员完全由用户定义

系统不预设前端、后端、审查等固定成员，也不固定主 Agent 的 Provider 或模型。

用户在团队成员上定义：

- 成员名称；
- 绑定的 Agent 实例；
- 模型；
- 角色；
- 擅长领域；
- 限制；
- 权限；
- 并发和资源上限。

用户不创建的角色，界面不显示。

### 2.2 主 Agent 自主选择是否委派

主 Agent 支持三种模式：

    direct    自己完成任务
    delegate  委派一个局部任务
    plan      拆分多个带依赖的任务

平台不会强迫主 Agent 调用子 Agent，也不会自动制造任务 DAG。

Orchestrator 只负责执行主 Agent 已选择的委派，并提供成员校验、权限、进程、任务状态、Git、验收、重试和审计。

## 3. UI 交互模型

主界面是类似 Codex 的聊天界面：

    左侧：Session 列表
    中间：当前 Session 的聊天窗口
    右侧：用户定义 Agent 的分配、Provider、模型、角色和状态

交互规则：

- 点击左侧 Session，恢复对应会话；
- 点击右侧 Agent，打开它最近的 Session；
- 没有 Session 时，可以创建新会话；
- Diff、测试、审批和原始终端通过当前会话抽屉打开；
- 主 Agent 没有委派时，不显示虚假的子任务；
- 只有用户定义的 Agent 才出现在右侧分配栏；
- 每个 Agent 可以有多个独立 Session。

## 4. 已完成的基础工程

### S-003：Monorepo 初始化

已创建 pnpm workspace 和 TypeScript project references：

    apps/desktop
    packages/domain
    packages/schemas
    packages/event-protocol
    packages/core-daemon
    tests/contract
    docs/adr

已验证：

    pnpm install
    pnpm check
    pnpm dev

Core Daemon 已输出：

    {"service":"core-daemon","status":"ok","version":"0.1.0"}

### S-004：领域实体

已定义 AgentInstance、Role、TeamMember、TeamDefinition、Project、ProjectRun、Session、Task、AgentRun、Message、Artifact 和 PlannerDecision。

代码位置：

    packages/domain/src/index.ts

### S-005：RuntimeEvent

已定义运行开始、Agent 消息、规划决策、任务更新、工具调用、命令、文件变更、审批、验收、等待、完成和失败事件。

每个事件具有 schemaVersion、eventId、sequence、项目/任务/运行关联 ID、type、timestamp 和 payload。

代码位置：

    packages/event-protocol/src/index.ts

### S-006：PlannerDecision

已支持并校验：

    direct
    delegate
    plan

代码位置：

    packages/domain/src/index.ts
    packages/schemas/src/index.ts

### S-008：IPC 请求和响应

已定义基础 IPC：

    health.get
    project.list
    project.add
    agent.list
    team.get
    session.list
    session.get
    session.create
    session.send
    run.cancel
    task.list
    run.get
    event.subscribe
    event.replay

代码位置：

    packages/schemas/src/ipc.ts

### S-009：状态机和按钮动作

已定义 Agent、Session、ProjectRun、Task 和 AgentRun 状态，并实现状态转换校验和 UI 可用动作判断。

代码位置：

    packages/domain/src/state.ts

### S-011：错误码和重试规则

已定义 Agent 不存在、未登录、版本不支持、启动失败、超时、计划非法、路径越权、审批、验收失败、Git 冲突、恢复和 IPC 错误等错误。

每个错误包含用户提示、是否可重试、重试策略和用户下一步操作。

代码位置：

    packages/domain/src/errors.ts

### B-001～B-008：桌面后端与持久化

Core Daemon 已按单一职责拆分为：组合根、IPC Gateway、应用服务、Runtime Service、数据库连接/迁移和各领域 Repository。它作为独立 Node 子进程运行，Electron Main 通过带随机令牌的本地 Socket 访问，不直接加载 SQLite。SQLite 使用 WAL；RuntimeEvent 追加写入并支持 afterSequence 重放；ProjectionService 可以重建状态；MaintenanceService 管理事件和产物保留周期。

代码位置：

    packages/core-daemon/src/application
    packages/core-daemon/src/database
    packages/core-daemon/src/runtime
    packages/core-daemon/src/ipc-gateway.ts

### B-009～B-022：CLI Runtime 与 Adapter

已实现无 Shell 的 Process Runtime、可选 node-pty Runtime、Windows 进程树取消、总超时/空闲超时/输出上限、Adapter Registry、能力协商和 Session Resume。

Codex 与 Kimi Code 已按 Provider 拆分命令构建、事件解析和 Adapter，且通过真实 CLI Smoke Test。Codex 额外处理了 Windows npm shim（`codex.ps1`/`codex.cmd`）无法被无 Shell spawn 的问题；非交互进程会主动关闭 stdin，避免 Codex 等待 EOF。模型发现也已接入真实 Provider 能力：Codex 使用官方 app-server `model/list`，Kimi 使用官方 `kimi provider list --json`，统一通过 `provider.models` IPC 返回 Renderer。AgentInstance 只保存 CLI 连接；团队成员可从绑定实例的动态模型目录选择或自由输入模型，并设置推理深度；主会话在 Composer 中单独选择。Claude Code 与 OpenCode 当前只有初版骨架和 Fake CLI 契约，不再标记为真实完成。

代码位置：

    packages/core-daemon/src/process-runtime.ts
    packages/core-daemon/src/pty-runtime.ts
    packages/core-daemon/src/adapters
    packages/core-daemon/test

### B-023～B-031：主 Agent 运行与可选委派

已实现完整 direct/delegate/plan 闭环。主 Agent 先返回结构化决策：选择 direct 时由主 Agent 继续执行原目标且不创建 Task；选择 delegate/plan 时才创建单任务或依赖图。成员路由只读取用户保存并启用的 TeamMember、AgentInstance、Role、任务类型和委派策略，不含固定角色。

`ask_before_delegate` 会保存待审批任务并暂停；批准后继续，拒绝后取消待委派任务并让主 Agent 自己接管。子 Agent 使用独立 Session，消息、交接和结果均保存关联 ID；失败后由主 Agent 返回 retry、take_over 或 continue 决策。

桌面前端已完成真实联调：启动时通过 Core Daemon 加载 Project、AgentInstance、Team、Session 和 ProjectRun；团队聊天通过 `orchestration.start` 启动；`projectRun/session/task/event` 回放更新左侧会话、中间 Timeline 和右侧动态成员；委派审批与停止分别调用 `orchestration.resolveDelegation` 和 `orchestration.cancel`。Renderer 的 Mock 种子和 Mock 运行引擎已删除，浏览器预览不会伪造业务数据。

代码位置：

    packages/core-daemon/src/application/orchestration-service.ts
    packages/core-daemon/src/runtime/orchestration
    packages/core-daemon/test/orchestration.test.mjs
    apps/desktop/src/renderer/src/lib/orchestration-runtime.ts

### B-032～B-041：Git、任务与验收

已实现 Git 仓库检测、direct 主运行 worktree、每任务独立 worktree、allowedPaths 校验、文件级/提交级 Diff、顺序 Merge Queue、冲突中止与人工最终合并。Git 命令始终使用参数数组且不经过 Shell；发生冲突时执行 `git merge --abort`，不会用冲突内容覆盖用户工作区。

项目可以注册测试、Lint 和构建命令模板。Verification Engine 只执行已注册的 executable/args，校验相对工作目录并分别支持 task、run、merge scope；必需验收失败会阻止任务完成或回滚隔离运行分支上的任务合并。最终结果停在 `merge_ready`，桌面合并审批卡通过 `orchestration.resolveMerge` 才会写入用户当前分支，系统不会自动 push。

桌面端项目详情页可编辑验收命令；会话恢复时通过 `artifact.list` 和 `verification.list` 读取 SQLite 中的真实 Diff、提交补丁与测试日志，Timeline 展示合并开始、完成和冲突文件。

代码位置：

    packages/core-daemon/src/runtime/git
    packages/core-daemon/src/runtime/git-workflow-service.ts
    packages/core-daemon/src/runtime/verification-engine.ts
    packages/core-daemon/test/git-workflow.test.mjs
    apps/desktop/src/renderer/src/features/projects/VerificationTemplatesCard.tsx
    apps/desktop/src/renderer/src/lib/orchestration-runtime.ts

### B-042～B-052：权限、恢复与可观测性

已完成 `safe/approval/blocked` 命令策略、symlink/junction 越界检测、子进程环境白名单、AES-GCM 本地凭证库、统一脱敏和五级审批范围。Core Daemon 重启后会把未结束运行持久化为 `crashed/paused/waiting_user`，用户可以恢复原主 Agent 会话，也可以从当前启用的自定义团队成员中选择新主 Agent。

事件订阅改为随机不可伪造 ID，并支持按 `afterSequence` 补发；IPC、Agent 运行和恢复动作写入 SQLite 审计日志；指标服务统计耗时、失败、重试、冲突和验收率；诊断服务导出再次脱敏的本地 JSON 包。

桌面端已经真实联调：Agent 编辑器只写入凭证且不回读明文；Timeline 审批卡传递 `once/run/task/project/global`；设置页显示运行指标、恢复入口、主 Agent 更换、权限摘要、审计和诊断包导出。

代码位置：

    packages/core-daemon/src/runtime/security
    packages/core-daemon/src/runtime/observability
    packages/core-daemon/src/runtime/recovery-service.ts
    packages/core-daemon/src/runtime/event-subscription-service.ts
    packages/core-daemon/test/security-recovery-observability.test.mjs
    apps/desktop/src/renderer/src/features/settings/RuntimeOperationsCard.tsx
    apps/desktop/src/renderer/src/features/timeline/Timeline.tsx

命令权限边界：AgentHub 会在启动自己管理的 CLI、验收和系统进程之前执行策略；Provider CLI 内部的工具命令仍由各家的原生 sandbox/approval 机制控制，不能把事后 JSONL 事件当成事前拦截。

## 5. 当前代码结构

    agenthub/
    ├─ apps/desktop
    ├─ packages/domain
    ├─ packages/schemas
    ├─ packages/event-protocol
    ├─ packages/core-daemon
    ├─ tests/contract
    ├─ docs/adr
    ├─ outputs/feature-checklist.md
    ├─ outputs/multi-agent-orchestrator-technical-plan.md
    ├─ package.json
    ├─ pnpm-workspace.yaml
    ├─ pnpm-lock.yaml
    ├─ tsconfig.json
    └─ tsconfig.base.json

## 6. 当前完成情况

| 范围 | 已完成 | 未完成 |
|---|---:|---:|
| 产品/架构规划与跟踪文档 | 3 | 0 |
| 共享协议与基础设施 | 8 | 2 |
| 前端实现 | 40 | 4 |
| 后端/运行时实现 | 50 | 2 |
| 发布与质量 | 0 | 10 |

已完成：

- S-001、S-002、S-003；
- S-004、S-005、S-006；
- S-008、S-009、S-011；
- S-010 事件重放协议；
- S-013 功能完成清单；
- F-001～F-006 桌面壳、隔离、动态导航、主题、中英文、无障碍；
- F-007～F-009 项目列表、添加/移除、扫描结果；
- F-010、F-011、F-013、F-014 Provider 检测状态、Agent 实例编辑器（CLI 连接/参数/Profile/环境策略/API Key/请求地址）、启用禁用、检测提示；
- F-012、F-015～F-022 自定义团队：成员/角色编辑器、成员级模型与推理深度、委派策略、团队校验；主会话 CLI 不在团队中固定；
- F-023～F-036、F-041～F-045 聊天工作台：三栏布局、Core 会话列表、动态 Agent 分配栏、Timeline 卡片族、真实审批/停止/Event Replay、原始终端/Diff/DAG 抽屉，以及 Codex 式会话模型/Effort/Speed 控件。
- B-001～B-008：Core Daemon、认证 IPC、SQLite/WAL、领域 Repository、事件存储、状态投影和保留策略；
- B-009～B-015、B-017、B-019～B-022：Process/PTY Runtime、进程树取消、超时、Adapter Registry、Codex/Kimi Code 真实 Adapter 与模型发现、Custom CLI、能力降级、Resume 和 Fake CLI 契约测试。
- B-023～B-031：direct/delegate/plan、DAG、成员动态路由、三种委派策略、消息与结果回传、失败重试/接管/继续，以及桌面聊天页真实 IPC 联调。
- B-032～B-041：Git 仓库检测、主/任务 worktree、路径校验、文件级与提交级 Diff、Merge Queue、冲突保护、验收模板、Verification Engine 和人工最终合并。
- B-042～B-052：命令/路径/环境/凭证策略、五级审批、重启恢复、主 Agent 故障转移、按序列事件补发、审计、指标和脱敏诊断包，以及桌面设置页真实 IPC 联调。

仍待完成：

- S-007 AgentResult Schema；
- S-012 版本迁移策略；
- Claude Code/OpenCode 官方命令、Provider 事件解析和真实 Smoke Test（B-016、B-018）；
- 前端测试（F-037～F-040）；
- Windows 安装包。

## 7. 前端现在可以开始的工作

前端主体已完成，并已删除纯 Mock 业务流程、接入 Core Daemon。下一步前端工作是：

1. 为真实 IPC 同步层增加组件/集成测试；
2. 为 direct、delegate、plan 和审批编写 Playwright Electron E2E；
3. 为验收模板编辑器、真实 Diff/Verification 产物和合并审批增加组件测试；
4. 增加关键页面截图回归。

前端禁止写死成员名称、Provider、模型、角色和成员数量。

## 8. 后端下一步

推荐顺序：

1. 完成 S-007 AgentResult；
2. 完成 S-012 数据库与 Provider 版本迁移策略；
3. 完成 Claude Code/OpenCode 官方 Adapter 与真实 Smoke；
4. 增加数据库备份、迁移回滚和性能基线；
5. 完成 Windows 安装、签名和升级链路。

## 9. 验证命令

根目录执行：

    pnpm install
    pnpm check
    pnpm build
    pnpm dev

契约测试位置：

    tests/contract/contracts.test.mjs

目前契约测试覆盖：

- direct 决策；
- delegate 决策；
- 非法决策；
- Task 状态转换；
- UI 可用动作；
- 可重试错误；
- 不可重试错误；
- 错误对象创建。

## 10. 相关文档

- [技术规划说明](multi-agent-orchestrator-technical-plan.md)
- [功能完成清单](feature-checklist.md)
- [主 Agent 运行与可选委派实现说明](main-agent-orchestration-implementation.md)
- [权限、恢复与可观测性实现说明](security-recovery-observability-implementation.md)
- [项目 README](../README.md)
