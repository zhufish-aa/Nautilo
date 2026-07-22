# 主 Agent 运行与可选委派实现说明

> 日期：2026-07-21  
> 范围：B-023～B-031  
> 状态：已实现并接入桌面前端

## 1. 行为定义

主 Agent 不会被强制委派。每次团队目标先由用户选择的主 Agent 返回一个结构化决策：

- `direct`：主 Agent 自己继续执行原目标，不创建 Task 或子 Session；
- `delegate`：创建一个由主 Agent 指定成员执行的局部 Task；
- `plan`：创建多个 Task，并按无环依赖图顺序执行。

Orchestrator 不替模型决定是否需要成员，只负责校验、持久化、执行和回传。

## 2. 后端职责拆分

```text
application/orchestration-service.ts
  └─ 编排用例、生命周期和 IPC 入口

runtime/orchestration/
  ├─ decision-validator.ts  决策、成员、任务类型和 DAG 校验
  ├─ member-router.ts       用户 TeamMember → AgentInstance 动态路由
  ├─ prompt-builder.ts      规划、direct、子任务、回传和恢复 Prompt
  ├─ task-graph.ts          Task 创建、解锁和依赖取消
  ├─ session-router.ts      主 Session 与子 Session 隔离
  ├─ message-router.ts      用户、主 Agent、成员之间消息关联
  └─ json-extractor.ts      Provider 文本中的结构化决策提取
```

`RunService` 仍只负责 CLI 运行生命周期。本轮增加可等待的 `RunHandle/RunCompletion`，让 Orchestrator 能依据真实退出状态和最终消息继续流程。数据库新增独立 `ProjectRunRepository`，没有把编排状态塞入 Session 或 Task Repository。

## 3. 用户配置与路由

路由只接受当前 TeamDefinition 中启用的成员，并继续校验：

- 成员 `enabled`；
- 绑定的 AgentInstance 存在且启用；
- `allowedTaskTypes` 允许当前 taskType；
- PlannerDecision 引用的成员、任务和依赖均有效；
- plan 的任务 ID 唯一、依赖存在且不存在循环。

成员名称、角色、Provider、模型、强项和任务类型均来自用户配置，没有固定“前端、后端、审查”成员。

## 4. 委派策略

| 策略 | 行为 |
|---|---|
| `direct_only` | 规划提示只允许 direct；delegate/plan 决策会被后端拒绝 |
| `ask_before_delegate` | Task 进入 waiting_approval；用户批准后执行，拒绝后由主 Agent 自己完成 |
| `autonomous` | 合法 delegate/plan 立即执行 |

桌面审批卡调用 `orchestration.resolveDelegation`，不是只修改前端状态。

## 5. 消息、Session 与结果回传

主 Agent 和每个实际被委派成员拥有独立 Session。Session 使用 `projectRunId`、`parentSessionId` 和 `taskId` 关联；Message 使用 `fromMemberId`、`toMemberId`、`taskId`、`runId`、`kind` 和 `correlationId` 记录路由。

子 Agent 完成后：

1. 结果保存在子 Session；
2. `result` 消息写入主 Session；
3. 发布 `handoff.created`；
4. 通过主 Agent 的原生 Resume（Provider 支持时）把结果交回；
5. 所有可运行任务结束后由主 Agent生成最终用户答复。

## 6. 失败重新规划

子任务失败后，主 Agent返回 `RecoveryDecision`：

- `retry`：原成员重试，或改派另一个启用成员，最多三次；
- `take_over`：主 Agent接管失败任务；
- `continue`：接受该失败，取消依赖它的下游任务，继续执行无关任务。

每个恢复决策都会发布 `recovery.decision`，并保留任务尝试次数、完成成员和接受的失败任务。

## 7. 前端联调

Electron Renderer 不直接访问数据库或启动 CLI。`orchestration-runtime.ts` 通过 preload 白名单调用 Core Daemon：

```text
用户在团队 Session 发送消息
  → upsert Project / AgentInstance / Team / Session
  → orchestration.start
  → 轮询 projectRun.get + session.list + task.list
  → event.subscribe / event.replay
  → 更新左侧 Session、中间 Timeline、右侧成员与 DAG
```

已接入的 IPC：

- `project.upsert`
- `agent.upsert`
- `team.upsert`
- `session.upsert`
- `projectRun.list/get`
- `orchestration.start`
- `orchestration.resolveDelegation`
- `orchestration.cancel`

Renderer 已删除 Mock 动态导入。Electron 使用真实 Core Daemon；没有 Electron bridge 的浏览器预览只展示空状态，不能发起业务运行。

## 8. 验证结果

自动化测试 `packages/core-daemon/test/orchestration.test.mjs` 覆盖：

- direct 不创建 Task；
- delegate 子 Session 与结果回传；
- plan DAG 依赖顺序；
- direct_only、ask_before_delegate、autonomous；
- 禁用成员和非法路由；
- retry、take_over、continue。

验证命令：

```powershell
pnpm check
pnpm build:desktop
```

Core Daemon 当前 30 项测试中 28 项通过，2 项真实 Provider Smoke 默认跳过；其中包含桌面侧实体 upsert 和编排 IPC 集成测试。桌面生产构建通过。

## 9. 当前边界

B-023～B-031 已完成，但它们不会替代下一阶段：

- B-032～B-041 的 Git/worktree、Diff、Verification 和合并；
- B-042～B-052 的命令/路径权限、凭证、重启恢复和审计指标；
- F-037～F-040 的组件、Electron E2E 和截图回归。

因此当前可以真实完成主 Agent 决策、委派和消息闭环，但代码隔离、验收与合并仍按后续清单保持未完成。
