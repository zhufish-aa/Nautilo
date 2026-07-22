# AgentHub Git、任务与验收实现说明

更新时间：2026-07-21

## 完成范围

本轮完成 B-032～B-041：

- 检测 Git 根目录、当前分支、默认分支、HEAD 和脏文件；
- direct 主 Agent 运行默认使用独立主运行 worktree；
- 每个委派代码任务使用独立分支和 worktree；
- 根据 Task.allowedPaths 校验实际 Git 变更，包含路径规范化和现有 symlink 越界检查；
- 采集文件状态、增删行数、逐文件 patch 和 baseCommit 到 resultCommit 的提交级 patch；
- 任务结果按 Orchestrator 顺序合并到主运行分支，并执行 merge scope 验收；
- 冲突时记录冲突文件并执行 `git merge --abort`，不覆盖用户文件；
- 项目注册 VerificationCommandTemplate，命令和参数分离、`shell: false` 执行；
- 必需验收失败时阻止 Task/ProjectRun 完成；
- 最终结果停在 `merge_ready`，用户批准后才合并到原分支，且不执行 push。

## 代码边界

```text
runtime/git/git-command.ts          无 Shell Git 子进程
runtime/git/repository-service.ts   仓库状态读取
runtime/git/worktree-service.ts     分支与 worktree
runtime/git/path-policy.ts          allowedPaths 与越界检查
runtime/git/change-collector.ts     文件级和提交级 Diff
runtime/git/merge-queue.ts          顺序合并、冲突 abort、隔离分支回滚
runtime/git-workflow-service.ts     Git/验收用例编排
runtime/verification-engine.ts      注册命令验收
runtime/artifact-service.ts         Diff/测试产物持久化
```

数据库使用独立的 ArtifactRepository 和 VerificationRepository；IPC 新增 `artifact.list`、`verification.list` 和 `orchestration.resolveMerge`，没有把 SQL、Git、进程与 UI 写在同一层。

## 前端真实联调

- 项目详情页的“验收命令模板”通过 `project.upsert` 写入 Core Daemon/SQLite；
- 会话恢复通过 `artifact.list` 和 `verification.list` 读取真实 Diff、提交补丁、测试结果；
- Timeline 显示真实文件增删行、验收日志、合并开始/完成及冲突文件；
- 合并审批卡根据 approval.kind 调用 `orchestration.resolveMerge`，委派审批仍调用 `orchestration.resolveDelegation`；
- `merge_ready`、`waiting_user` 和 `review_required` 停止轮询，等待用户操作；
- Renderer 中没有新增 Mock 业务数据。

## 验证

`packages/core-daemon/test/git-workflow.test.mjs` 使用临时真实 Git 仓库，不用 Git Mock，验证：

- 干净/脏仓库检测；
- 主运行与任务 worktree 隔离；
- 多任务按最新主运行提交顺序合并；
- Diff/Artifact/Verification 持久化；
- allowedPaths 越权阻断；
- 必需验收失败阻断；
- 合并冲突 abort 后目标内容保持不变；
- 用户工作区脏时最终合并被拒绝；
- direct 运行在人工批准前不会写入用户分支。
