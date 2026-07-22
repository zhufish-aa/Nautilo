# ADR-0001: Core Daemon 分层与依赖方向

- 状态：Accepted
- 日期：2026-07-20

## 决策

Core Daemon 采用单向依赖的分层结构：

```text
Electron Main / Socket Client
            ↓
       IPC Gateway
            ↓
   Application Services
            ↓
 Runtime Services / Repositories
            ↓
 SQLite / Process / PTY / CLI
```

约束如下：

1. `application/core-daemon.ts` 仅负责对象组合和生命周期。
2. 每个领域实体拥有独立 Repository；迁移、连接和查询不混在应用服务中。
3. 每个 Provider Adapter 独立成文件，共享逻辑只能进入 `process-adapter.ts` 或 `normalize.ts`。
4. Renderer 不直接访问 Node、SQLite、Shell、Git 或 CLI。
5. 业务 IPC 必须先经过白名单 Gateway；Socket 客户端还必须通过随机令牌认证。
6. RuntimeEvent 采用追加写入，状态由投影服务重建。
7. 可选能力（PTY、原生 Resume、结构化输出）必须显式声明并支持安全降级。

## 原因

这些边界保证 Provider、存储、桌面壳和 UI 可以独立演进，也避免把 Core Daemon 发展成难以测试和维护的单体类。
