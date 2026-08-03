# Nautilo

[English](README.en.md) | 中文

Nautilo 是一个**本地、可自由配置的多 Agent 编程工作台**。它以 Electron 桌面应用的形式运行，帮你统一管理本机已安装的各种 Coding Agent CLI（Codex、Claude Code、Kimi Code 等），把它们组建成团队，接入本地项目，并通过统一的会话界面调度它们协同完成任务。

Nautilo 不训练模型、不替代任何 Provider CLI——它是这些 CLI 之上的**编排层与管理工作台**。

## 下载安装

预编译安装包发布在 [GitHub Releases](https://github.com/zhufish-aa/Nautilo/releases)：

| 平台 | 资产 |
|---|---|
| Windows x64 | `Nautilo-Setup-*.exe`（NSIS 安装程序）/ `Nautilo-*-win.zip`（免安装） |
| macOS | `Nautilo-*-arm64.dmg`（Apple Silicon）/ `Nautilo-*-x64.dmg`（Intel） |
| Linux x64 | `.AppImage` / `.deb` / `.rpm` |

安装包目前**未做代码签名**：Windows 首次运行会出现 SmartScreen 提示（选「仍要运行」），macOS 需在「系统设置 → 隐私与安全性」中允许打开。

## 功能特性

- **多 Provider / CLI 管理**：内置 Codex、Claude Code、Kimi Code 和 Custom CLI 适配器；OpenCode、Trae 通过可选插件接入。自动检测本机已安装的 CLI 及版本。
- **Agent 实例配置**：为每个 Agent 实例配置可执行文件、参数、环境变量、凭证、Base URL、权限模式与模型。
- **团队编排**：自定义团队成员的名称、角色、能力、限制、任务类型、并发上限，绑定 Agent 实例并配置委派策略。
- **主 Agent 任务决策**：主 Agent 可以直接完成、委派局部任务，或生成带依赖关系的任务 DAG，由编排器执行并持久化决策；支持结果回传、失败重试、接管与继续。
- **会话工作台**：流式消息、思考过程、工具调用、命令执行、文件变更、审批交互与会话恢复，全部在统一界面呈现。
- **项目管理**：添加/删除本地项目、扫描目录、Git 状态感知与工作区模式。
- **Provider 插件机制**：从本地目录或插件市场安装插件，SHA-256 校验，可启用/禁用/卸载；插件可覆盖同 ID 的内置 Provider（详见 [docs/provider-plugins.md](docs/provider-plugins.md)）。
## 架构总览

```text
Electron Renderer (React)  →  Electron Main / Preload (contextBridge 白名单)
        →  IPC Gateway（认证 JSON Lines：Windows 命名管道 / macOS·Linux Unix socket）
        →  Application Services
        →  Runtime Services / Repositories
        →  SQLite / 子进程 / PTY / CLI
```

分层与依赖方向的详细决策见 [docs/adr/0001-core-daemon-boundaries.md](docs/adr/0001-core-daemon-boundaries.md)。

- **Core Daemon**：独立的本地 Node.js 守护进程，由 Electron 主进程拉起。负责 SQLite 持久化、CLI 进程运行、Provider 适配器、编排、Git、权限、恢复、审计与指标。默认数据目录 `~/.agenthub`，数据库 `agenthub.sqlite`（Node 原生 `node:sqlite`，WAL 模式）。IPC 首行发送随机 token 认证，之后每行一个 JSON 请求/响应，默认不监听固定 TCP 端口。
- **Electron Desktop**：Renderer 禁用 Node integration、启用 context isolation 与 sandbox；Preload 仅暴露白名单 API，业务数据全部经由 daemon 请求。

### Monorepo 结构（pnpm workspace）

| 路径 | 说明 |
|---|---|
| `apps/desktop` | Electron 桌面端（主进程 / Preload / Renderer） |
| `packages/core-daemon` | 本地核心守护进程（运行时入口） |
| `packages/domain` | 共享领域模型与状态机定义 |
| `packages/event-protocol` | 统一运行时事件协议 |
| `packages/schemas` | 版本化数据与 IPC schema |
| `packages/provider-sdk` | Provider 插件公共 SDK（Adapter 接口、Descriptor、manifest） |
| `packages/provider-plugin-opencode` | OpenCode Provider 插件 |
| `packages/provider-plugin-trae` | Trae Provider 插件 |
| `packages/provider-plugin-template` | 插件模板：把任意 Agent CLI 包装成 Nautilo Provider |
| `tests/contract` | 共享领域 / Schema 契约测试 |
| `docs` | 插件机制文档与架构决策记录（ADR） |

## 技术栈

- **桌面端**：Electron 33 · electron-vite · React 18 · React Router 6 · Zustand · Tailwind CSS v4 · Radix UI · Framer Motion · Lucide
- **Core Daemon**：Node.js ESM · TypeScript（strict / NodeNext / project references）· `node:sqlite` · JSON Lines IPC · node-pty · ACP / MCP SDK
- **工程**：pnpm 10 workspace · TypeScript 5.8 · Node 内置 test runner

## 快速开始

### 环境要求

- Node.js **>= 22.5**（daemon 依赖 `node:sqlite`）
- pnpm **10.12.1**（仓库已声明 `packageManager`）
- 至少安装一个受支持的 Agent CLI，例如 [Codex](https://github.com/openai/codex)、Claude Code、[Kimi Code](https://github.com/MoonshotAI/kimi-cli) 等；OpenCode / Trae 可通过插件接入

### 开发运行

```bash
pnpm install
pnpm dev:desktop   # 构建 Core Daemon 并启动 Electron 开发模式
```

首次启动会进入新手引导教程，按提示完成：检测 CLI → 创建 Agent 实例 →（可选）组建团队 → 新建项目 → 开始会话。

### 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 启动 Core Daemon 开发流程 |
| `pnpm dev:daemon` | 构建并以 serve 模式启动 daemon |
| `pnpm build` | TypeScript project references 全量构建 |
| `pnpm build:desktop` | 构建 daemon + 桌面端 |
| `pnpm typecheck` | 根项目与桌面端类型检查 |
| `pnpm test` | workspace 全部测试 + 契约测试 |
| `pnpm check` | typecheck + test |
| `pnpm package:win` | 构建并产出 Windows portable 包（旧脚本） |
| `pnpm package` | 构建并用 electron-builder 产出当前平台安装包 |

### 打包

```bash
pnpm package          # 当前平台安装包（Windows: NSIS + zip）
pnpm package:win      # 旧版 Windows portable ZIP 脚本（保留）
```

electron-builder 产出在 `release/`：`Nautilo-Setup-*.exe`（NSIS 安装程序）与 zip 免安装包；macOS 为 dmg/zip，Linux 为 AppImage/deb/rpm。打包前会自动执行 `scripts/prepare-packaged-resources.mjs`，把 daemon 运行依赖（`pnpm deploy --prod`）和当前平台的 Node runtime 放入 `build/packaged/`，作为 `extraResources` 打进安装包。

### 发布流程（GitHub Release）

打 tag 即触发 `.github/workflows/release.yml`，在 Windows / macOS(arm64+x64) / Linux 四个 runner 上并行构建并自动把产物挂到对应 Release：

```bash
# 1. bump apps/desktop/package.json 的 version 并提交
# 2. 打 tag 推送
git tag v0.2.0
git push origin v0.2.0
```

注意：`electron-builder.yml` 里的 `electronVersion` 需与 `apps/desktop/package.json` 的 electron 版本保持同步（pnpm 虚拟 store 无法自动探测）。

## 插件开发

内置 Provider 与第三方插件走同一套契约：`@agenthub/provider-sdk` 的 `AgentCliAdapter` 接口 + `agenthub-plugin.json` 清单。接入自己的 Agent CLI 只需三步：

```bash
# 1. 复制最小模板（可编译、可安装，含详细注释）
cp -r packages/provider-plugin-template packages/provider-plugin-my-cli

# 2. 改 agenthub-plugin.json（id / descriptor）和 src/index.ts（协议翻译）
# 3. 构建
pnpm --filter <你的包> build
```

然后在「Agent → 插件市场 → 从本地目录安装」选择插件目录，或手动复制到 `~/.agenthub/plugins/<plugin-id>/` 重启应用。

插件的核心工作只有一个：**把 CLI 的输出协议翻译成统一的 `AdapterEvent` 流**（消息、思考、工具调用、命令、文件变更、用量、产物……）。Provider Descriptor 会自动驱动 CLI 检测页、实例编辑器和权限模式选择器，**无需修改任何前端代码**。能力边界包括：

- 会话恢复（`resume` + `session` 事件）、流式增量输出
- 斜杠命令上报与 `compact` 专用传输
- 用户交互桥接（结构化提问 / 权限确认）
- 运行时工具（任务委派）、MCP server 注入
- 覆盖同 ID 的内置 Provider（禁用/卸载后自动恢复内置实现）

完整开发指南（清单字段参考、事件协议、生命周期、市场发布、调试 FAQ）见 **[docs/provider-plugins.md](docs/provider-plugins.md)**；`packages/provider-plugin-opencode/`（server 复用、超时控制、模型发现）和 `packages/provider-plugin-trae/`（双传输切换、ACP 桥接）是两个完整的真实参考实现。


