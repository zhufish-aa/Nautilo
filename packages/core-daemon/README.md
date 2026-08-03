# @agenthub/core-daemon

Nautilo 的本地控制面。它负责持久化、IPC、CLI 进程和 Provider Adapter，不负责页面渲染或主 Agent 的任务规划策略。

## 目录边界

```text
src/
├── application/       # 用例、IPC handler、组合根
├── adapters/          # Provider 命令、事件解析与 Adapter
├── database/          # 连接、迁移、各领域 Repository
├── runtime/           # 运行、事件、投影、保留策略
│   ├── orchestration/ # 决策校验、成员路由、任务图、Session/消息交接
│   └── git/           # Git 命令、仓库、worktree、路径、Diff、Merge Queue
├── ipc-gateway.ts     # 白名单 JSONL IPC 与认证
├── process-runtime.ts # 无 Shell 的子进程运行时
├── pty-runtime.ts     # node-pty 可选运行时
└── errors.ts          # Core 错误到领域错误的映射
```

## 质量门槛

```powershell
pnpm --filter @agenthub/core-daemon typecheck
pnpm --filter @agenthub/core-daemon test
pnpm check
pnpm build:desktop
```

新增 Provider 时必须：

1. 新建独立 Adapter 文件；
2. 声明结构化输出、PTY、stdin、Resume 等能力；
3. 在 Registry 注册；
4. 使用 Fake CLI 增加契约测试；
5. 不在 Adapter 中访问 Renderer Store 或直接写 SQLite。

## 主 Agent 编排边界

`application/orchestration-service.ts` 负责 direct/delegate/plan 用例，`runtime/orchestration` 提供单一职责组件。主 Agent 只提交结构化决策；Orchestrator 仅在 decision 为 delegate 或 plan 时创建任务。用户配置的成员和角色是唯一的路由来源。

桌面端通过 `orchestration.start`、`orchestration.resolveDelegation`、`orchestration.resolveMerge` 和 `orchestration.cancel` 调用，不允许 Renderer 直接启动 Agent CLI。

## Git 与验收边界

`runtime/git` 的组件只负责各自的 Git 能力；`GitWorkflowService` 负责用例编排，`VerificationEngine` 只执行 Project 已注册的命令模板。direct 主运行和委派任务都在独立 worktree 中执行。任务分支按队列合并到主运行分支并重新验收，最终写入用户分支必须经过 merge 审批；Core Daemon 不执行 `git push`。

桌面端通过 `project.upsert` 管理验收模板，通过 `artifact.list`、`verification.list` 和 Event Replay 显示真实 Diff、提交补丁、测试日志与冲突。

## 权限、恢复与可观测性边界

`runtime/security` 拆分命令策略、环境白名单、加密凭证、脱敏和审批；`runtime/observability` 拆分审计、指标和诊断包；`RecoveryService` 只负责重启状态修复，`EventSubscriptionService` 只负责随机订阅和 sequence 补发。数据库分别使用策略、审批、审计和凭证 Repository，不在 IPC handler 中直接写 SQL。

桌面端通过 `credential.*`、`approval.*`、`recovery.list`、`orchestration.recover`、`metrics.get`、`audit.list`、`policy.list` 和 `diagnostics.export` 联调。Renderer 不读凭证明文，也不直接操作进程或恢复数据库状态。

命令策略控制 Nautilo 自己启动的 CLI、注册验收命令和系统进程。Provider CLI 内部工具的事前授权仍使用 Provider 原生 sandbox/approval；运行事件只用于持久化和审计，不假装能够撤销已经发生的命令。

对应测试：`test/security-recovery-observability.test.mjs`。

## 已验证 Provider

| Provider | 启动 | 结构化输出 | Resume | 当前状态 |
|---|---|---|---|---|
| Codex | `codex exec` | `--json` JSONL | `codex exec resume` | 官方文档、本机 0.128.0、真实 Smoke 已验证 |
| Kimi Code | `kimi --prompt` | `--output-format stream-json` | `--session <id>` | 官方文档、本机 0.27.0、真实 Smoke 已验证 |
| Claude Code | 未验证 | 未验证 | 未验证 | 仅骨架 |

OpenCode 不内置，由插件提供：`packages/provider-plugin-opencode/`（检测、`run --format json`、原生 resume、`models --verbose` 模型发现均已对本机 1.18.7 验证）。

真实 Provider Smoke 默认跳过，显式执行：

```powershell
$env:AGENTHUB_PROVIDER_SMOKE='1'
$env:AGENTHUB_CODEX_SMOKE_MODEL='<当前账户支持的模型>'
pnpm --filter @agenthub/core-daemon build
node --test packages/core-daemon/test/provider-smoke.test.mjs
```
