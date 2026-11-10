# Nautilo｜本地多 Agent 编程工作台（简历项目介绍）

> 说明：本文按"简历条目 + 可直接粘贴的段落"组织，分为**精简版（1 段）**、**标准版（项目经历条目）**、**详版（面试追问备用）**三种粒度，可按简历篇幅取用。

---

## 一、一句话概括（用于个人简介 / 项目列表）

**Nautilo**：独立设计并实现的本地多 Agent 编程工作台——把本机已安装的 Codex、Claude Code、Kimi Code 等 Coding Agent CLI 统一接入，组建成可编排的 Agent 团队，通过 Electron 桌面端与统一会话界面调度它们协同完成复杂开发任务（TS + Rust 双实现，约 9 万行代码，135 次提交，13 个正式版本）。

## 二、精简版（约 120 字，适合项目栏一行说明）

> 从零设计并落地 Nautilo——一个本地、可自由配置的多 Agent 编程工作台。它以 Electron 桌面应用形态统一管理 Codex / Claude Code / Kimi Code 等 Agent CLI，提供 Provider 插件体系、团队编排与任务 DAG 调度、追加式事件时间线与会话恢复能力；TypeScript 与 Rust 双守护进程实现，共享同一套 70 个方法的 IPC 契约，约 9 万行代码，迭代发布 13 个版本。

## 三、标准版（简历"项目经历"条目，可直接粘贴）

### Nautilo｜本地多 Agent 编程工作台（个人项目 / 主导设计与开发）
**技术栈**：Electron 33 · React 18 · TypeScript 5.8（strict / NodeNext / project references）· Node.js ESM · Rust · pnpm 10 monorepo · `node:sqlite`(WAL) · JSON Lines IPC · node-pty · Tauri 2 · Vite · Zustand · Tailwind v4 · ACP / MCP SDK
**时间**：2026.07 – 2026.08（135 commits / 13 releases，v0.2.0 → v0.2.13）
**规模**：TypeScript 约 6.5 万行（共享包 169 文件 / daemon 146 文件 / 桌面端 142 文件）+ Rust 约 2.4 万行（104 文件），另有 ADR、插件开发指南、Rust 移植差距分析等设计文档

**项目背景**：市面上 Codex、Claude Code、Kimi Code 等 CLI Agent 各自为政，会话、权限、上下文互不相通，也无法组队协作。Nautilo 定位为这些 CLI 之上的**编排层与管理工作台**——不训练模型、不替代任何 Provider，而是把"多个 Agent 当一个团队用"这件事产品化。

**核心工作**：

1. **分层架构与 IPC 契约设计**：确立 Electron Renderer → Main/Preload（contextBridge 白名单）→ IPC Gateway（随机 token 认证的 JSON Lines；Windows 命名管道 / macOS·Linux Unix socket）→ Application Services → Runtime/Repositories → SQLite·子进程·PTY 的单向依赖分层（写入 ADR-0001）；daemon 默认不监听固定 TCP 端口，Renderer 禁用 Node integration 并启用 context isolation + sandbox，业务数据一律经 daemon。
2. **多 Provider 插件体系**：抽象 `AgentCliAdapter` 接口 + `ProviderDescriptor` 清单 + `AdapterEvent` 统一事件流，把任意 CLI 的输出协议翻译成消息/思考/工具调用/命令/文件变更/用量/产物七类事件；内置 Codex、Claude Code、Kimi Code、Custom 四个适配器，OpenCode、Trae 以插件形式提供；配套可编译可安装的最小插件模板、SHA-256 校验、本地目录与插件市场安装、热重载（cache-buster）、可覆盖同 ID 内置 Provider 并在卸载后自动回退。
3. **多 Agent 团队编排**：实现主 Agent 决策链路——直接执行 / 委派局部任务 / 生成带依赖关系的任务 DAG；编排器持久化决策，支持结果回传、失败重试、人工接管与继续执行；团队成员可配置角色、能力、限制、任务类型、并发上限与委派策略。
4. **追加式事件内核与会话时间线**：RuntimeEvent 只追加、状态由投影服务（projection）重建；支持事件订阅 / 增量 replay / 长轮询 wait（TTL 与 timeout clamp）、中断恢复（recovery + heal orphaned interaction）、流式 delta 合并广播与按需加载的历史折叠卡。
5. **Rust 守护进程移植（双实现并行演进）**：以同一 `packages/schemas` 契约为基准，把 TS daemon 逐方法移植为 Rust（`nautilo-core`，104 文件 / 约 2.4 万行），覆盖 **IPC 70/70 方法对齐**、SQL 迁移对齐、事件序列分配（`append_allocating_sequence`）、claude/codex/kimi 三个 Provider 适配器（含 codex app-server 与 chat-compat 双通道、kimi ACP 与 session-usage）、命令策略 / 审批 / 凭证保险箱与脱敏；同步产出 Electron 壳与 Tauri 壳双打包链路。
6. **安全与可观测性**：命令策略引擎（`COMMAND_BLOCKED` 拦截）、审批服务（非阻塞审批）、凭证加密存储与日志脱敏、审计日志、指标与诊断导出、只读 IPC 白名单。
7. **性能与内存治理**：渲染层 LRU 淘汰 + 按需构建 + 大字段截断 + WAL checkpoint 组合优化，修复流式期间事件缓存二次增长（**峰值内存 500MB → 198MB**）；时间线图片改磁盘缓存缩略图（渲染进程**再省约 180MB**）；DOM 虚拟滚动 + 事件窗口化；delta 广播 100ms 合并，消除流式期间重复全量传输；Codex 常驻 app-server 进程池跨消息复用连接；长会话 replay 裁剪与增量拉取（传输 **-25%**）。
8. **工程化与发布链路**：pnpm workspace monorepo + TypeScript project references 全量构建；Node 内置 test runner + 共享领域/Schema 契约测试（`tests/contract`）；`pnpm check` 一键 typecheck + test；electron-builder（NSIS / zip / dmg / AppImage / deb / rpm）与 Tauri 便携包双产物；GitHub Actions tag 触发多 runner 并行构建并自动挂载 Release 资产。

**难点与解决**：

- **跨语言契约不漂移**：TS 与 Rust 两套 daemon 若各自实现协议极易分叉。做法是以 `packages/schemas/src/ipc.ts` 的 70 个方法为唯一事实源，逐方法对照移植并逐项记录差异（含能力降级项：TS 侧 PTY 交互在 Rust 侧暂以 headless structured 模式等价），形成可核查的移植差距清单。
- **动态插件与静态二进制的矛盾**：Rust daemon 无法像 Node 那样 `import` JS 插件，最终以"插件编译为独立 exe + 同步脚本注入 + 清单声明入口"解决，并保留 `AGENTHUB_NODE_PATH` / `AGENTHUB_CORE_PATH` 逃生舱口。
- **长会话下的渲染内存失控**：通过定位"事件缓存二次增长"与"图片位图常驻"两个根因，分别以增量合并与磁盘缩略图解决，而非简单加限制。
- **打包与运行时的路径漂移**：dev / win-unpacked / NSIS / portable zip 四种运行形态下 daemon 入口与 Node runtime 定位各不相同，统一由 `resolveDaemonEntry()` 抽象，并在打包期自动部署运行依赖与内嵌 Node。

**成果**：Windows / macOS / Linux 三平台可安装产物及 GitHub Release 发布流程；13 个版本连续迭代；第三方只需三步（复制模板 → 改清单与协议翻译 → 构建）即可接入任意 Agent CLI，且 Provider Descriptor 自动驱动 CLI 检测页、实例编辑器与权限模式选择器，**新增 Provider 无需改动任何前端代码**。

## 四、面试追问备用（STAR 素材）

| 追问方向 | 可展开的要点 |
|---|---|
| 为什么要有独立 daemon？ | UI 崩溃不影响任务执行；CLI 进程、SQLite、文件监听天然属于后台；为将来接入 Tauri / 无头服务留出边界；IPC 走本地 socket 而非固定端口，规避端口占用与外部访问风险 |
| 事件为什么追加不更新？ | 时间线需要严格顺序与可重放；状态由投影重建使"崩溃后半途状态"可恢复；为订阅、replay、审计提供同一份事实源 |
| Provider 抽象的边界在哪？ | 只统一"事件语义"，不统一 CLI 参数与协议；能力以 `supportsResume` / `capabilities` 显式声明并支持安全降级，避免为兼容牺牲各 CLI 的原生优势 |
| 编排的失败处理？ | 委派结果回传 + 失败重试 + 人工接管；run 生命周期诊断日志（consume / exit / cancel / plugin death）；provider 进程中途死亡标记 run 为 crashed 并清理子进程 |
| 收益量化 | 内存 500MB→198MB、图片再省 180MB、长会话传输 -25%、delta 合并消除重复全量传输、Codex app-server 进程池跨消息复用连接 |

## 五、可量化指标速查（写进简历时优先保留）

- 代码规模：**约 9 万行**（TS ≈6.5 万：共享包 2.1 万 + daemon 1.5 万 + 桌面端 2.9 万；Rust ≈2.4 万），**约 560 个源文件**
- 架构：**1 套 IPC 契约 / 70 个方法 / TS 与 Rust 双实现 70/70 对齐**
- Provider：**4 个内置适配器（codex / claude-code / kimi-code / custom）+ 4 个 Rust 插件 Provider（pi / trae / opencode / omp）+ 1 套插件 SDK + 1 个最小模板**
- 数据层：**19 个领域 Repository**，SQLite（`node:sqlite`）WAL 模式，追加式事件表 + 投影重建
- 交付：**135 commits / 13 releases（v0.2.0 → v0.2.13）/ 3 平台 4 类安装包**
- 性能：**渲染进程内存 -60%（500MB→198MB）**、**图片位图 -180MB**、**长会话 replay 传输 -25%**、**delta 广播 100ms 合并**
