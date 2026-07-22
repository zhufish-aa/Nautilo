# AgentHub 权限、恢复与可观测性实现说明

> 对应清单：B-042～B-052  
> 完成日期：2026-07-21

## 1. 实现结果

本轮完成了权限控制、应用重启恢复、主 Agent 故障转移、事件补发、审计、指标和脱敏诊断包，并已接入 Electron 前端的真实 Core IPC。生产路径不使用 Mock 数据。

代码按单一职责拆分：

```text
packages/core-daemon/src/runtime/
├─ security/
│  ├─ command-policy.ts
│  ├─ environment-policy.ts
│  ├─ credential-service.ts
│  ├─ redaction-service.ts
│  └─ approval-service.ts
├─ observability/
│  ├─ audit-service.ts
│  ├─ metrics-service.ts
│  └─ diagnostics-service.ts
├─ recovery-service.ts
└─ event-subscription-service.ts
```

数据库也按领域拆分为 `PolicyRepository`、`ApprovalRepository`、`AuditRepository` 和 `CredentialRepository`，迁移版本更新为 schema 4。

## 2. 权限能力

- 命令策略支持 `safe`、`approval`、`blocked`，用于 AgentHub 启动的 Agent CLI、注册验收命令和系统命令。
- 子进程不再默认继承 `process.env`，只接收平台运行必需项、策略白名单项和明确注入项。
- API Key 使用 AES-256-GCM 加密后写入独立凭证表，密钥文件与数据库分离；Renderer 只能写入或查询“是否已配置”，不能读回明文。
- 日志、RuntimeEvent、IPC 审计和诊断包经过统一字段与内容脱敏。
- 路径校验会规范化路径，并对最近存在的父路径执行 `realpath`，阻止 symlink/junction 跳出工作区。
- 审批记录持久化，支持 `once`、`run`、`task`、`project`、`global`；`once` 授权使用后自动消费。

命令策略的边界需要明确：AgentHub 可以在启动外部进程前阻止或要求审批；Provider CLI 内部的工具命令仍需由 Codex/Kimi 等各自的原生 sandbox/approval 机制在执行前控制。JSONL 中已经发生的命令事件只用于记录，不能被当作事前拦截。

## 3. 恢复能力

Core Daemon 启动时会扫描 SQLite：

- 未结束的 AgentRun 标记为 `crashed`，失败码为 `DAEMON_RESTARTED`；
- 运行中的 ProjectRun 标记为 `paused`；
- 运行/验收中的 Task 标记为 `waiting_user`；
- 相关 Session 标记为等待输入；
- 恢复动作写入审计日志。

用户可以：

- 使用原主 Agent 和原 Provider Session 重新规划；
- 在用户启用的团队成员中选择另一成员作为主 Agent；
- 保留旧主会话，并为替代主 Agent 创建关联的新会话；
- 查看主 Agent 更换历史和恢复原因。

## 4. 可观测性

- 事件订阅 ID 为 Core 内存中生成的随机值，不再把过滤条件编码成可伪造 JSON。
- `event.replay` 接收 `afterSequence`，只返回断线期间缺失事件和最新 sequence。
- IPC 请求、Agent 运行、命令阻断、审批请求和恢复动作写入审计表。
- 指标包含运行总数、完成/失败、平均耗时、任务重试、Git 冲突和验收通过率。
- 诊断包导出为本地 JSON，包含平台、指标、项目、Agent、运行、事件和审计记录；写出前再次执行脱敏。

## 5. 前端联调

前端已接入以下真实 IPC：

```text
policy.list / policy.upsert / policy.evaluate
approval.list / approval.resolve
credential.set / credential.status / credential.delete
recovery.list / orchestration.recover
audit.list / metrics.get / diagnostics.export
event.subscribe / event.replay
```

具体界面：

- Agent 编辑器保存 API Key 到 Core 凭证库；列表只显示“已配置”。
- Timeline 审批卡提供五种作用域，并把用户选择传给后端。
- 设置页新增运行指标、待恢复运行、原主恢复、主 Agent 更换、策略摘要、近期审计和诊断包导出。
- 暂停运行在聊天工作台显示为等待用户，不再被轮询器当作仍在执行。

## 6. 验证

新增测试：

```text
packages/core-daemon/test/security-recovery-observability.test.mjs
apps/desktop/test/core-data-source.test.mjs
```

验证结果：

- B-042～B-052：11/11 通过；
- Core Daemon 全套：47 通过，2 个显式真实 Provider Smoke 默认跳过，0 失败；
- `pnpm check`：通过；
- `pnpm build:desktop`：通过。

