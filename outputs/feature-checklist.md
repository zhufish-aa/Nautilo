# AgentHub 功能完成清单

> 更新时间：2026-07-22  
> 状态依据：当前工作区实际文件和已完成的规划工作  
> 规则：√ = 已完成；× = 未完成  
> 说明：前端 3.1～3.4 已实现并接入 Core Daemon；生产代码不再包含 Mock 业务数据或 Mock 运行引擎。F-012 经范围调整已在 3.3 角色编辑器中实现；Git/worktree/Diff/验收/人工合并、权限、恢复和可观测性均已完成。其余实现项（前端测试 F-037～F-040、其他 Provider、发布）仍为 ×。

## 一、当前总览

| 范围 | 已完成 | 未完成 |
|---|---:|---:|
| 产品/架构规划与跟踪文档 | 3 | 0 |
| 前端实现 | 40 | 4 |
| 后端/运行时实现 | 50 | 2 |
| 共享协议与基础设施 | 8 | 2 |
| 发布与运维 | 0 | 10 |

当前项目状态：**Monorepo、共享契约、前端四个模块、桌面后端持久化、IPC、Process Runtime、主 Agent 可选委派、Git/worktree/Diff/验收/人工合并，以及权限/恢复/审计闭环均已完成；Codex/Kimi Code CLI Adapter 已完成真实验证；Claude Code/OpenCode 目前只有骨架和 Fake CLI 契约，前端自动化测试仍未完成**。

## 一、前端启动门槛

前端已通过以下共享契约接入真实 Core Daemon：

| 门槛 | 状态 | 编号 | 为什么需要 |
|---|---|---|---|
| 已完成 | √ | S-003 | Monorepo、脚本和包目录已经可运行 |
| 已完成 | √ | S-004 | Agent、Session、Team、Task、Run 等实体字段已冻结 |
| 已完成 | √ | S-005 | 聊天时间线和实时事件格式已冻结 |
| 已完成 | √ | S-006 | direct、delegate、plan 三种决策格式已冻结 |
| 已完成 | √ | S-008 | 前端调用 Core Daemon 的 IPC 请求和响应已冻结 |
| 已完成 | √ | S-009 | 状态、转换和按钮可用条件已冻结 |
| 已完成 | √ | S-011 | 错误提示、重试和审批错误展示已冻结 |
| 集成前完成 | × | S-007 | Diff、验收、产物和完成结果面板需要它 |
| 已完成 | √ | S-010 | `event.subscribe`/`event.replay` 已按 afterSequence 补发持久化事件 |
| 不阻塞前端 | × | S-012 | 数据库迁移策略主要由后端负责 |

结论：项目、Agent、团队、会话和 B-023～B-052 已完成真实契约联调；Git/Diff/验收后端闭环已完成，S-007 仍用于后续收敛统一 `AgentResult` 聚合契约。Schema 5 已完成 AgentInstance → TeamMember/Session 执行配置迁移。

## 二、共享规划与基础契约

| 状态 | 编号 | 功能/交付物 | 验收标准 |
|---|---|---|---|
| √ | S-001 | 产品技术规划说明 | 技术规划文档已生成并覆盖完整产品边界 |
| √ | S-002 | 主 Agent direct/delegate/plan 决策模型 | 文档已明确主 Agent 可以自己完成，也可以自主委派 |
| √ | S-013 | 功能完成清单 | 已按前端、后端、共享和发布拆分并记录当前状态 |
| √ | S-003 | Monorepo 初始化 | pnpm workspace、基础脚本和目录可运行；已验证 pnpm install、pnpm check、pnpm dev |
| √ | S-004 | Domain Schema 包 | Agent、Role、Team、Project、Task、Run、Session 类型可共享；已写入 packages/domain |
| √ | S-005 | RuntimeEvent Schema | 所有运行事件有版本、序号和统一 payload；已写入 packages/event-protocol |
| √ | S-006 | PlannerDecision Schema | 支持 direct、delegate、plan 三种路径；已写入 packages/domain 与 packages/schemas |
| × | S-007 | AgentResult Schema | 结果、变更文件、产物、验收和风险可校验 |
| √ | S-008 | IPC API Schema | 前后端请求、响应和错误码有单一事实来源；已写入 packages/schemas/src/ipc.ts |
| √ | S-009 | 状态机定义 | ProjectRun、Task、AgentRun 状态、转换和按钮动作已写入 packages/domain/src/state.ts |
| √ | S-010 | 事件重放协议 | 断线后可按 lastSequence/afterSequence 补发持久化 RuntimeEvent |
| √ | S-011 | 错误码规范 | 用户消息、重试和审批错误展示统一；已写入 packages/domain/src/errors.ts |
| × | S-012 | 版本迁移策略 | Schema、数据库和 Provider 版本有兼容策略 |

## 三、前端功能清单

### 3.1 桌面壳与基础体验

| 状态 | 编号 | 功能 | 验收标准 |
|---|---|---|---|
| √ | F-001 | Electron 桌面壳 | 应用可启动、关闭和恢复窗口 |
| √ | F-002 | Renderer/Main/Preload 隔离 | Renderer 无 Node 直接访问权限 |
| √ | F-003 | 动态导航 | Projects、Agents、Teams、Tasks、Sessions、Runs、Settings 可配置显示 |
| √ | F-004 | 主题系统 | 深色/浅色主题和用户偏好可保存 |
| √ | F-005 | 中英文界面 | 核心页面可切换语言 |
| √ | F-006 | 无障碍基础 | 键盘导航、焦点、对比度和语义标签通过检查 |

> 实现：apps/desktop（Electron main/preload + React renderer）；窗口状态持久化于 userData/window-state.json；contextIsolation + sandbox + 白名单 preload；主题/语言/导航可见性经 zustand persist 保存；Radix 语义组件 + focus-visible + skip link。  
> 验证：`pnpm check`、`pnpm build:desktop` 通过；`pnpm dev:desktop` 启动后由用户人工验证界面与交互。

### 3.2 项目与 Agent 管理

| 状态 | 编号 | 功能 | 验收标准 |
|---|---|---|---|
| √ | F-007 | 项目列表 | 显示用户添加的本地项目和当前运行 |
| √ | F-008 | 添加/移除项目 | 选择本地目录并保存项目配置 |
| √ | F-009 | 项目扫描结果 | 显示 Git、技术栈、前后端路径和风险提示 |
| √ | F-010 | Agent 安装状态页 | 显示 Provider、可执行路径、版本和检测状态 |
| √ | F-011 | Agent Instance 编辑器 | 用户可配置 CLI 连接名称、Provider、可执行文件、参数、Profile、环境策略、凭证和 Base URL；不绑定模型或推理深度 |
| √ | F-012 | Agent 能力编辑器 | 已在 3.3 角色编辑器实现：strengths（自由文本 + 1–5 分）、limitations、任务类型（预设 + 自定义）、并发上限 |
| √ | F-013 | Agent 启用/禁用 | 禁用成员不会被主 Agent 委派 |
| √ | F-014 | 登录/可用状态提示 | 仅展示 CLI 检测结果，不伪造第三方登录流程 |

> 实现：项目列表/添加/移除/扫描调用 `project.list/add/remove/scan`；Agent 实例调用 `agent.list/upsert`，CLI 探测调用 `provider.detect`；目录选择走 Electron 原生 dialog。AgentInstance 仅表示可复用的 CLI 连接，不保存模型、推理深度或速度档位。项目、AgentInstance 均持久化到 Core Daemon 的 SQLite，Renderer 不再生成种子数据。API Key 已通过 B-044/B-045 接入加密本地凭证库、环境白名单注入和统一脱敏。
> 范围说明：F-012 依据领域模型分层（AgentInstance 不含 strengths/limitations，见技术规划第 5 节）移出 3.2，与 F-016/F-017 的「成员/角色完全用户自定义」保持一致。  
> 验证：`pnpm check` 通过；界面由用户人工验证。

### 3.3 用户自定义团队

| 状态 | 编号 | 功能 | 验收标准 |
|---|---|---|---|
| √ | F-015 | Team Builder | 用户可创建任意数量的成员 |
| √ | F-016 | 自定义成员名称 | 不出现固定的前端/后端/审查成员 |
| √ | F-017 | 自定义角色 | 角色名称、职责、能力、限制均由用户填写 |
| √ | F-018 | 主会话 CLI 选择 | 新建会话时从启用的 Agent 实例中选择主会话 CLI，不在团队中固定主 Agent |
| √ | F-019 | 成员执行配置 | 团队成员单独配置模型和推理深度；新委派会话创建时固化为 Session 快照 |
| √ | F-020 | Provider/模型绑定展示 | 每个成员显示用户绑定的 CLI 和模型 |
| √ | F-021 | 委派策略设置 | autonomous、ask_before_delegate、direct_only 可配置 |
| √ | F-022 | 团队校验提示 | 成员重复、缺失、禁用、权限冲突可见 |

> 实现：features/teams（TeamsPage + TeamEditorPage + MemberEditorDialog）；`team.list/upsert/remove` 连接 SQLite；团队只维护可委派成员。每个 TeamMember 绑定一个 AgentInstance，并从该实例对应的本机 CLI 动态获取模型与推理深度，也允许手填模型或使用 Provider 默认值；角色编辑含职责/擅长领域（自由文本 + 1–5 分）/限制/系统提示词。Schema 5 会把旧 AgentInstance 上的模型、推理深度与速度档位迁移到对应 TeamMember 和既有 Session。  
> 验证：`pnpm check` 通过；界面由用户人工验证。

### 3.4 聊天与运行工作台

| 状态 | 编号 | 功能 | 验收标准 |
|---|---|---|---|
| √ | F-023 | Chat-first 工作区 | 默认入口是聊天，不是命令行 |
| √ | F-024 | 动态成员/任务树 | 只显示用户定义的成员和实际产生的任务 |
| √ | F-025 | 主 Agent 直接完成视图 | 主 Agent 不委派时不显示虚假的子任务 |
| √ | F-026 | 委派任务视图 | 只有主 Agent 实际委派后才出现对应成员卡片 |
| √ | F-041 | 左侧会话列表 | 按项目、Agent 和最近活动显示 Session，点击可恢复 |
| √ | F-042 | 中央 Codex 类聊天区 | 当前 Session 以聊天为主，不默认显示命令行 |
| √ | F-043 | 右侧动态 Agent 分配栏 | 只显示用户定义的成员、Provider、模型、角色和状态 |
| √ | F-044 | Agent/Session 联动 | 点击右侧 Agent 打开其最近 Session；点击左侧 Session 直接切换 |
| √ | F-045 | 会话模型与推理控制 | 输入框下方使用 Codex 式汇总胶囊；默认弹层显示 Effort 拖动条，Advanced 展开时改为 Model/Effort/Speed 详细设置；设置持久化并传入 CLI |
| √ | F-027 | Timeline 消息卡片 | 支持消息、计划、委派、交接、错误 |
| √ | F-028 | 命令执行卡片 | 命令默认折叠，显示退出码和审批状态 |
| √ | F-029 | 文件变更卡片 | 显示新增/修改/删除和 Diff 入口 |
| √ | F-030 | 测试结果卡片 | 显示命令、耗时、通过/失败和日志 |
| √ | F-031 | 审批卡片 | 支持批准、拒绝和审批范围 |
| √ | F-032 | 消息输入与停止 | 可向当前 Agent/团队发送消息并停止运行 |
| √ | F-033 | 原始终端抽屉 | 仅作为 PTY/调试兜底，不替代聊天界面 |
| √ | F-034 | 任务 DAG 视图 | 仅在主 Agent 创建 plan 时显示依赖图 |
| √ | F-035 | Diff/产物面板 | 查看 Diff、API 契约、测试报告和提交 |
| √ | F-036 | 断线重连 | 前端按 sequence 补齐遗漏事件 |

> 实现：features/sessions（三栏工作台）+ features/timeline（卡片族）+ `orchestration-runtime.ts`（真实 direct/delegate/plan、审批、停止和事件回放）。**会话隔离模型**：主会话在创建时选择 CLI，并通过 Composer 选择该会话的模型/Effort/Speed；每个被委派成员有独立 Session（parentSessionId/projectRunId 关联），创建时从 TeamMember 固化模型/Effort/Speed 快照。成员执行细节流进子会话，主会话保存决策、交接与结果回传（B-030）；右侧栏为主会话 + 实际产生的子 Agent 会话，未委派时不出现子会话。模型目录按具体 AgentInstance 缓存，避免同 Provider 的不同 Profile/Base URL 配置串用。Renderer 冷启动从 `session.list/get` 与 `event.subscribe/replay` 重建视图，不读取 localStorage 业务数据。  
> 验证：`pnpm check`、`pnpm build:desktop` 通过；Electron 冷启动正常；界面由用户人工验证。

### 3.5 前端测试

| 状态 | 编号 | 功能 | 验收标准 |
|---|---|---|---|
| × | F-037 | 组件测试 | 核心卡片和表单有自动化测试 |
| × | F-038 | Timeline 回归测试 | direct、delegate、plan 三种路径均可渲染 |
| × | F-039 | Playwright E2E | 添加项目、聊天、委派、审批、Diff 流程通过 |
| × | F-040 | 截图回归 | 关键页面视觉变化可检测 |

## 四、后端/运行时功能清单

### 4.1 桌面后端与持久化

| 状态 | 编号 | 功能 | 验收标准 |
|---|---|---|---|
| √ | B-001 | Core Daemon | `--serve` 作为独立 Node 子进程启动，支持健康检查、Electron 生命周期托管和优雅停止 |
| √ | B-002 | IPC Gateway | 只暴露注册过的白名单业务接口，未知方法返回统一错误 |
| √ | B-003 | 本地连接认证 | TCP/Named Pipe/Unix Socket 首帧使用随机令牌认证，令牌写入受限文件 |
| √ | B-004 | SQLite 初始化 | 使用 Node `node:sqlite`，启用 WAL、外键和迁移；要求 Node >= 22.5 |
| √ | B-005 | 领域表 | Projects、Agents、Teams、Tasks、Runs、Sessions、Messages、Artifacts 可保存 |
| √ | B-006 | 事件存储 | RuntimeEvent 追加写入，并按 Session/Run/ProjectRun 与 sequence 查询 |
| √ | B-007 | 状态投影 | `ProjectionService` 可从事件重建 Session/Run 当前状态 |
| √ | B-008 | 日志保留 | `MaintenanceService` 按事件/产物保留策略清理过期记录 |

### 4.2 CLI Runtime 与 Adapter

| 状态 | 编号 | 功能 | 验收标准 |
|---|---|---|---|
| √ | B-009 | 可执行文件探测 | Adapter 执行 `--version`/`--help`，返回路径、版本和帮助摘要 |
| √ | B-010 | Process Runtime | 无 Shell spawn，统一 stdin/stdout/stderr、退出码和异步事件 |
| √ | B-011 | PTY Runtime | 可选 `node-pty` 运行时，缺失时安全降级；Fake CLI PTY smoke 测试通过 |
| √ | B-012 | 进程树取消 | Windows 使用 `taskkill /T /F`，其他平台使用进程信号 |
| √ | B-013 | 超时/空闲超时 | 总超时、空闲超时和输出上限产生明确 Runtime 事件 |
| √ | B-014 | Adapter Registry | Provider 可注册、检测、启动、发现模型，并按能力协商运行模式 |
| √ | B-015 | Codex Adapter | 官方 `codex exec --json`、app-server `model/list`、Provider 专属 JSONL、Session ID、用量、错误、输出 Schema、进程取消和 `codex exec resume` 已封装；真实 CLI Start/Resume/模型目录 Smoke 已验证 |
| × | B-016 | Claude Code Adapter | 目前只有初版命令骨架和 Fake CLI 契约；尚未按官方文档与真实账号验证 |
| √ | B-017 | Kimi Code Adapter | 官方 `kimi --prompt ... --output-format stream-json`、`kimi provider list --json` 模型目录、Assistant/Tool/Resume Hint 事件、进程取消和 `--session` Resume 已封装；真实 CLI Start/Resume/模型目录 Smoke 已验证 |
| × | B-018 | OpenCode Adapter | 目前只有初版命令骨架和 Fake CLI 契约；尚未按官方文档与真实环境验证 |
| √ | B-019 | Custom CLI Adapter | 支持参数模板、stdin/argument 输入、text/JSONL 输出和资源限制 |
| √ | B-020 | 能力降级 | structured/text/stdin/PTY/Resume 能力显式声明并确定性降级 |
| √ | B-021 | Session/Resume | Provider 支持时走原生 Resume；否则可声明 prompt reconstruction 或 none |
| √ | B-022 | Fake CLI Fixtures | `packages/core-daemon/test/fixtures/fake-cli.mjs` 覆盖探测、结构化输出、超时和适配器契约 |

### 4.3 主 Agent 运行与可选委派

| 状态 | 编号 | 功能 | 验收标准 |
|---|---|---|---|
| √ | B-023 | direct 运行路径 | 主 Agent 可独立完成任务，不创建子任务 |
| √ | B-024 | delegate 工具 | 主 Agent 可主动创建/分配局部任务 |
| √ | B-025 | plan 工具 | 主 Agent 可主动创建带依赖的任务图 |
| √ | B-026 | PlannerDecision 校验 | direct、delegate、plan 三种决策可验证 |
| √ | B-027 | 成员动态路由 | 只从用户启用的成员中选择 |
| √ | B-028 | 用户委派策略 | direct_only/ask_before_delegate/autonomous 生效 |
| √ | B-029 | 消息路由 | 主 Agent、成员和用户之间消息可追踪 |
| √ | B-030 | 结果回传 | 子 Agent 结果回到发起委派的主 Agent |
| √ | B-031 | 重新规划 | 子任务失败后主 Agent 可决定重试、接管或继续 |

> 实现：`OrchestrationService` 负责 ProjectRun 用例；`runtime/orchestration` 按决策校验、成员路由、任务图、Prompt、Session 和消息路由拆分。前端 `core-bootstrap.ts` 和 `orchestration-runtime.ts` 接入实体 list/upsert、`orchestration.start/resolveDelegation/cancel`、Session/Task/Event 回放；Electron 只走真实 Core Daemon，浏览器预览不生成业务数据。  
> 验证：`packages/core-daemon/test/orchestration.test.mjs` 覆盖 direct、delegate、plan、DAG、三种委派策略、禁用成员、结果回传，以及 retry/take_over/continue；`pnpm check` 与 `pnpm build:desktop` 通过。

### 4.4 Git、任务和验收

| 状态 | 编号 | 功能 | 验收标准 |
|---|---|---|---|
| √ | B-032 | Git 仓库检测 | 检测分支、脏状态和默认分支 |
| √ | B-033 | 主运行 worktree | direct 代码运行默认隔离 |
| √ | B-034 | 任务 worktree | 每个委派代码任务独立目录和分支 |
| √ | B-035 | 文件范围校验 | 变更超出 allowedPaths 时阻断/告警 |
| √ | B-036 | Diff 采集 | 生成文件级和提交级 Diff |
| √ | B-037 | Merge Queue | 多任务按顺序合并并重新验证 |
| √ | B-038 | 冲突处理 | 标记冲突，不覆盖用户文件 |
| √ | B-039 | 验收命令模板 | 只允许项目注册的测试/Lint/构建命令 |
| √ | B-040 | Verification Engine | 验收结果决定任务是否可完成 |
| √ | B-041 | 人工合并批准 | 默认不自动 push，合并需用户确认 |

> 实现：Git 命令、仓库检查、worktree、路径策略、变更采集和 Merge Queue 分别位于 `runtime/git`；`GitWorkflowService` 负责编排 Git 用例，`VerificationEngine` 只运行 Project 中注册的命令模板。direct 和每个委派任务均使用独立分支/worktree；任务合并后执行 merge scope 验收，最终合并通过 `orchestration.resolveMerge` 人工批准，系统不执行 push。
>
> 前端联调：项目详情页可通过 `project.upsert` 保存验收模板；聊天 Timeline 与产物抽屉通过 `artifact.list`、`verification.list` 和事件回放显示真实 Diff、测试日志、合并进度与冲突；merge 审批卡调用 `orchestration.resolveMerge`。
>
> 验证：`packages/core-daemon/test/git-workflow.test.mjs` 使用临时真实 Git 仓库覆盖 B-032～B-041，包括多任务顺序合并、越权阻断、验收失败阻断、冲突 abort、脏用户工作区保护，以及 direct 在批准前不写入用户分支。

### 4.5 权限、恢复和可观测性

| 状态 | 编号 | 功能 | 验收标准 |
|---|---|---|---|
| √ | B-042 | 命令策略 | safe/approval/blocked 三类规则生效 |
| √ | B-043 | 路径策略 | 规范化、symlink/junction 越界检查 |
| √ | B-044 | 环境白名单 | 不把宿主机全部环境传给 CLI |
| √ | B-045 | 凭证脱敏 | 日志、事件和诊断包不泄露密钥 |
| √ | B-046 | 审批服务 | once/run/task/project/global 范围可用 |
| √ | B-047 | 应用重启恢复 | 未结束运行进入恢复/等待状态 |
| √ | B-048 | 主 Agent 故障转移 | 可恢复会话或更换主 Agent |
| √ | B-049 | 事件重放 | 断线后按 sequence 补发 |
| √ | B-050 | 审计日志 | 记录谁在何时对什么执行了什么动作 |
| √ | B-051 | 运行指标 | 记录耗时、失败、重试、冲突和验收率 |
| √ | B-052 | 诊断包 | 用户可导出脱敏运行信息 |

> 实现：`runtime/security` 按命令、路径、环境、凭证和审批拆分；`runtime/recovery-service.ts` 负责重启状态修复；`runtime/observability` 分别负责审计、指标和诊断包；事件订阅使用不可伪造的随机 ID，并按 `afterSequence` 补发。SQLite 新增策略、审批、审计和加密凭证表。
>
> 前端联调：Agent 编辑器通过 `credential.set/status` 使用写入后不可回读的凭证；Timeline 审批卡把 `once/run/task/project/global` 真实传给 Core；设置页通过 `recovery.list`、`orchestration.recover`、`metrics.get`、`audit.list`、`policy.list` 和 `diagnostics.export` 展示并操作真实数据。
>
> 安全边界：命令策略控制 AgentHub 自身启动的 CLI、注册验收命令和内部进程；Provider 在 CLI 内部执行的工具仍受各家 CLI 原生 sandbox/approval 机制约束，AgentHub 不把事后 JSONL 事件伪装成事前拦截。
>
> 验证：`packages/core-daemon/test/security-recovery-observability.test.mjs` 覆盖 B-042～B-052；`pnpm check` 与 `pnpm build:desktop` 已通过。

## 五、发布与质量

| 状态 | 编号 | 功能 | 验收标准 |
|---|---|---|---|
| × | R-001 | Windows 安装包 | 可安装、卸载和升级 |
| × | R-002 | 代码签名 | 发布包签名并可验证 |
| × | R-003 | 自动更新 | 用户可控制更新策略 |
| × | R-004 | CI 构建 | PR 自动执行类型、单元和集成测试 |
| × | R-005 | Provider Smoke Test | Codex 0.128.0 与 Kimi Code 0.27.0 已通过真实 Smoke；Claude Code/OpenCode 尚未验证，四类全部完成前保持 × |
| × | R-006 | 性能基线 | 长日志、多任务和大量事件不卡顿 |
| × | R-007 | 安全测试 | IPC、路径、命令和凭证测试通过 |
| × | R-008 | 用户文档 | 安装、登录、配置团队和故障排查文档 |
| × | R-009 | 迁移/备份 | 用户配置和会话可备份恢复 |
| × | R-010 | 发布验收 | direct、delegate、plan 三条路径均通过 |

## 六、建议执行顺序

| 阶段 | 重点 | 对应清单 |
|---|---|---|
| M0 | 契约、Daemon、数据库、Fake CLI | S-003～S-012、B-001～B-008 |
| M1 | 单 Agent direct 聊天闭环 | F-001～F-014、F-023、F-025、F-041～F-042、B-009～B-015、B-023 |
| M2 | 用户自定义团队和可选委派 | F-015～F-022、F-024～F-026、F-043～F-044、B-024～B-031 |
| M3 | Git、验收、Diff、合并 | B-032～B-041、F-035 |
| M4 | 其他 Provider 与迁移 | B-016、B-018、S-012 |
| M5 | 测试、打包和发布 | F-037～F-040、R-001～R-010 |

## 七、更新规则

每完成一个功能：

1. 将对应状态从 × 改为 √；
2. 填写实现分支或提交号；
3. 填写验证命令或截图；
4. 如果功能范围改变，先更新技术规划，再更新本清单；
5. 不因“代码能运行”直接标记完成，必须满足该行验收标准。
