# Nautilo — 项目速览（给 AI Agent 的导读）

> 本文件面向 AI / 新加入的开发者：用最短路径理解这个仓库"是什么、怎么分层、去哪改、怎么跑"。改代码前先读本文件 + 对应目录，避免踩坑。

## 1. 一句话

**Nautilo**（包名 `nautilo` / `@agenthub/*`）是一个**本地、用户可配置的多 Agent 编程工作台**（桌面应用）。
它把本机装的各种 Coding Agent CLI（Codex、Claude Code、Kimi Code、OpenCode、Trae……）统一管理起来，
允许你为它们配置可执行文件/参数/环境变量/模型、组建**团队**、派发**任务 DAG**，并在一个统一会话界面里调度它们协同干活。
它**不训练模型、不替代任何 CLI**，是做在这些 CLI 之上的编排与管理层。

## 2. 技术栈总览（当前主线：Electron + React 前端、Rust 后端）

**用户已确认当前运行架构是 Electron 桌面壳与 React 前端，连接独立的 Rust 后端。不得自行切换到 Tauri。** 仓库保留 Tauri 入口，共享 renderer，但它不是当前任务的启动入口。

| 层 | 技术 | 位置 |
|---|---|---|
| 桌面壳 | Electron | `apps/desktop/src/main/`、`apps/desktop/src/preload/` |
| 核心后台 daemon | Rust（`nautilo-core`，由 TS 版移植而来） | `rust/nautilo-core/` |
| 前端 UI | React 18 + electron-vite/vite 构建（同一份 renderer 被 Electron 与 Tauri 共用） | `apps/desktop/src/renderer/` |
| Provider 插件 | Rust 编译为独立 exe（老版有 TS pnpm 包形式） | `rust/plugins/*`、`packages/provider-plugin-*` |
| 领域模型 / 协议 | TS package（domain、schemas、event-protocol、provider-sdk） | `packages/*` |

### 其他保留的入口与实现
- Electron 主进程/preload 是当前桌面入口：`apps/desktop/src/main/`、`apps/desktop/src/preload/`
- Tauri 壳作为另一个保留入口：`apps/desktop/src-tauri/`；未经用户要求不要切换启动路线。
- Node.js 版 core daemon：`packages/core-daemon/`（Rust 版的对照实现）
- Electron 打包：根 `electron-builder.yml` + `scripts/electron-builder*`

两条壳共用同一个 React 前端，有**两套独立的前台构建**：
- Electron：`apps/desktop/electron.vite.config.ts`（构建到 `apps/desktop/out/`）
- Tauri：`apps/desktop/vite.tauri.config.mts`（构建到 `apps/desktop/src-tauri/dist/`，即 `tauri.conf.json` 的 `frontendDist`）

## 3. Monorepo 结构树（改代码前先看这里）

```text
.
├── apps/desktop/                 # 桌面端（主工作区）
│   ├── src/main/                 # Electron 主进程（当前桌面入口）
│   ├── src/preload/              # contextBridge 白名单 API
│   ├── src/renderer/             # React UI（两条壳共用）
│   │   └── src/
│   │       ├── App.tsx / main.tsx
│   │       ├── components/ui/    # 通用 UI 组件（Button/Badge/Dialog…）
│   │       ├── components/layout/# AppShell/Sidebar/TitleBar/nav
│   │       ├── features/         # 按业务域分页：agents/teams/projects/sessions/
│   │       │                     # tasks/runs/timeline/work/settings/onboarding…
│   │       ├── lib/              # bridge.ts、core-mappers、orchestration-runtime、i18n…
│   │       └── stores/           # Zustand 状态：sessions/agents/teams/projects/settings/…
│   ├── src-tauri/                # Tauri 壳（Rust）
│   │   ├── src/main.rs           # 入口；命令模块：core_daemon/interactions/file_search/…
│   │   ├── tauri.conf.json       # 窗口/CSP/frontendDist 配置
│   │   ├── capabilities/default.json
│   │   ├── Cargo.toml            # tauri 2 + 系统能力（clipboard/dialog/opener/trash 等）
│   │   ├── .cargo/config.toml    # 固定 x86_64-pc-windows-gnu + mingw
│   │   └── dist/                 # Tauri 前端构建产物（vite.tauri 输出）
│   ├── electron.vite.config.ts
│   ├── vite.tauri.config.mts
│   ├── package.json              # @agenthub/desktop（version 需与 electron-builder 同步）
│   └── resources/
├── packages/                     # 共享 TS 包（pnpm workspace）
│   ├── core-daemon/              # Node 核心守护进程（后台入口；Rust 移植目标）
│   │   └── src/                  #   adapters/ | application/ | database/ | runtime/ | …
│   ├── domain/                   # 领域模型与状态机定义（agents/teams/projects/sessions/tasks…）
│   ├── event-protocol/           # 统一运行时事件协议（RuntimeEvent 追加式，投影重建）
│   ├── schemas/                  # 版本化数据与 IPC schema（ipc.ts / capability-import.ts）
│   ├── provider-sdk/             # Provider 插件 SDK（AgentCliAdapter、descriptor、manifest）
│   ├── provider-plugin-{opencode,trae,template}/  # TS 插件实现/模板
│   └── trae-agent-mcp-bridge/    # Trae ACP→MCP 桥（server.mjs）
├── rust/                         # Rust workspace（Tauri 路线核心）
│   ├── Cargo.toml                # members: nautilo-core / plugin-sdk / plugins/{pi,trae,opencode}
│   ├── rust-toolchain.toml       # stable-x86_64-pc-windows-gnu
│   ├── .cargo/config.toml        # 指定 mingw toolchain（.toolchains/mingw64）
│   ├── nautilo-core/             # Rust 版 core daemon（镜像 TS 版目录）
│   │   └── src/                 #   adapters/{claude,codex,kimi} | application/ | database/ | runtime/ …
│   ├── plugin-sdk/               # Rust 插件 SDK（jsonrpc / process / serve）
│   └── plugins/{pi,trae,opencode}/  # Agent 插件，编译为独立 exe + agenthub-plugin.json
├── docs/                         # 架构文档 + ADR（docs/adr/0001-core-daemon-boundaries.md）
├── tests/contract/               # 领域/schema 契约测试（contracts.test.mjs）
├── scripts/                      # 打包脚本：package-win-portable / package-win-tauri / prepare-packaged-resources…
├── website/index.html            # 官网单页
├── release/                      # Electron/Tauri 打包产物
├── work/                         # 实验/临时脚本（fake-cli、probe、smoke 等，勿当正式代码）
├── .toolchains/                  # 本地 mingw（Rust mingw 构建用，勿删）
├── package.json / pnpm-workspace.yaml / tsconfig.base.json / electron-builder.yml
└── AGENTS.md                     # 本文件
```

## 4. 运行方式

### 环境要求
- Node.js **>= 22.5**（daemon 依赖 `node:sqlite`）
- pnpm **10.12.1**（仓库 `packageManager` 已声明）
- Rust toolchain：`x86_64-pc-windows-gnu` + mingw（.toolchains/mingw64，见 rust/.cargo 与 src-tauri/.cargo）
- 至少装一个受支持的 Agent CLI（Codex / Claude Code / Kimi Code 等），OpenCode/Trae 走插件

### 常用命令（根目录）
| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装全 workspace |
| `pnpm dev:desktop` | 构建 Rust 后端及插件，并用 Electron 开发模式跑 |
| `pnpm dev:tauri` | 构建 Rust 插件 + renderer，Tauri 开发跑 |
| `pnpm tauri:renderer` | 单独构建 Tauri 前端（到 src-tauri/dist） |
| `pnpm tauri:build` | renderer + Rust 后端 Cargo release 构建 |
| `pnpm package:tauri` | 产出 Tauri Windows 安装包 |
| `pnpm build` / `typecheck` / `test` / `check` | TS 全量构建 / 类型 / 测试门卫 |
| `pnpm package:win` / `package` | （Electron 遗留）Windows portable / electron-builder 安装包 |

### 产物
- Electron 打包产物在 `release/`（Nautilo Setup *.exe、*win.zip）
- 发布走 GitHub Actions：`.github/workflows/release.yml`（Windows/macOS/Linux 多 runner）；文档发布 `pages.yml`

## 5. 核心数据流与约定（ADR-0001）

```text
Renderer (React)  → 壳层（Tauri commands / Electron preload 白名单）
                 → IPC Gateway（JSON Lines；Windows 命名管道 / Unix socket；随机 token 认证）
                 → Application Services（调度者）
                 → Runtime Services / Repositories
                 → SQLite（WAL） / 子进程 / PTY / CLI
```

铁律：
1. Renderer **不直接碰** Node/SQLite/shell/git/CLI，一切走白名单 IPC。
2. 每个领域实体有独立 Repository；迁移/连接/查询不入 Application Service。
3. 每个 Provider Adapter 独立成文件，共享逻辑只进 `process-adapter` / `normalize`。
4. `RuntimeEvent` 只追加写，只读状态由投影/重建。
5. 可选能力（PTY、原生 Resume、结构化输出）要显式声明并支持安全降级。

## 6. 给 AI 的具体改造提示

### 改前端（最常做）
- UI 入口：`apps/desktop/src/renderer/src/App.tsx`（路由由 `components/layout/nav.ts` + React Router 组织）
- 状态：Zustand stores（`stores/*.ts`）；IPC 统一走 `lib/bridge.ts`（Electron）或 `lib/tauri-bridge.ts`（Tauri）
- 新增页面时把路由、侧栏（nav.ts/Sidebar）与 store 一起登记

### 改后端/Rust
- Rust daemon 入口：`rust/nautilo-core/src/main.rs`；Tauri 壳命令：`apps/desktop/src-tauri/src/*.rs`（`core_daemon.rs` 是拉起 daemon 的关键）
- IPC 协议定义在 `packages/schemas/src/ipc.ts`；改协议要同时同步 TS daemon（packages/core-daemon）与 Rust 版

### 大坑
- **README.md 显示为乱码**（UTF-8 被按 GBK 读），别只依赖它；以英文版 `README.en.md` 与代码为准。
- 两条构建线：改了 renderer，若只跑 Electron 不影响 Tauri（反之亦然）；尽量两边都验证（`pnpm dev:desktop` / `pnpm tauri:renderer`）。
- `electron-builder.yml` 的 `electronVersion` 必须与 `apps/desktop/package.json` 里的 `electron` 依赖版本**手工同步**（electron-builder 自动探不到）。
- Rust 侧默认 `x86_64-pc-windows-gnu`（mingw），gcc 路径在 `rust/.cargo/config.toml` 写死到 `.toolchains/mingw64`；换机器/CI 要注意路径。
- git 里大量 `agenthub/run/*`、`agenthub/task/*` 分支是 agent 运行时的 worktree 工作分支，是活分支，别批量删除或当垃圾清理。

## 7. 常见任务入口速查
| 想干什么 | 去哪个文件 |
|---|---|
| 加一个页面（如"X 设置"） | `features/x/` → `nav.ts` + `App.tsx` + 一个 store |
| 加一个 Agent CLI 适配 | `packages/core-daemon/src/adapters/<cli>/` 或 `rust/nautilo-core/src/adapters/`（参照 claude/ codex/ kimi/） |
| 加一个 Provider 插件 | 复制 `packages/provider-plugin-template`（可编译、可安装） |
| 加一个内建能力/skill | `packages/core-daemon/src/application/capability-service.ts` + `builtin-*.ts` |
| 改 IPC 协议 | `packages/schemas/src/ipc.ts`（TS+Rust 双方都要同步） |
| 改持久化结构 | `packages/core-daemon/src/database/<repo>.ts` + `migrations.ts`（Rust：`rust/nautilo-core/src/database/`） |

## 8. Harness 原生体验要求

- 原生能力不缩水是验收要求。不得为了接入方便默认关闭 Apps、插件、MCP、Skills、扩展或原生会话持久化；加载成功也不代表功能完整。
- 保留当前选定账号、原生配置优先级和会话身份。Nautilo 管理的资源按归属合并，不能通过换账号、覆盖整份配置或把历史拼成一段提示词冒充原生恢复。
- 区分会话生命周期和单轮生命周期。支持常驻协议的 Harness 应复用运行环境；一轮完成不等于原生进程退出，后台任务和子 Agent 仍需正确跟踪。
- 原生交互必须形成请求、界面、用户回应、原生结果的闭环。不能把已知的选择、输入、编辑请求直接自动取消，也不能把原生日志查看器称为可交互终端。
- 启动参数应能追溯到传输要求、用户显式配置或已核实的协议适配；不要新增无依据的功能覆盖。发现适配缺口要明确记录，不能把“能发消息”称为完整兼容。
- 对标结果、当前缺口和逐 Harness 验收流程见 [T3 Code 原生体验对标](docs/t3code-native-experience-benchmark.md)。按具体改动验证完整流程，避免只检查单个函数、扩大已验证范围或重复全量检查。
