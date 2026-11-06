# DeepSeek Harness（DSH）项目目录结构详解

> 本文面向第一次接触 DSH 仓库的开发者，目标是让你打开这个仓库就能看懂：每个目录是干什么的、包之间怎么分家、代码入口在哪里、从哪开始读。
>
> 本文基于本地 study 用的源码：
>
> ```text
> work/deepseek-harness/
> ```
>
> 版本 `v0.1.0-rc.7`（commit `99f6f02fe`，2026-08-17）。

---

## 0. 先说结论：这是一个"巨型包仓库"（monorepo）

DSH 不是一个普通项目，它是一个 **pnpm workspace（工作区）**，装着 **几百个 npm 包**，全部以 `@deepseek-ai/dsh-` 命名。

它的组织哲学只有一句话：

> **Everything is a plugin（一切都是插件）。**

也就是说：模型适配器是插件、工具注册表是插件、会话日志是插件、连 Agent 循环本身也是插件。任何一个部件都可以单独替换。

所以仓库布局的第一原则是：

```text
按"能力"分组（capability），而不是按"页面"或"功能模块"分组。
```

一个"能力"（比如压缩）通常拆成三件套：

```text
Service Definition（定义接口）  —— 这个能力"是什么"
Service Provider（具体实现）   —— 这个能力"怎么做"
Consumer（消费方）             —— 谁在使用这个能力（工具、命令、UI）
```

这是读懂整个仓库的钥匙。

---

## 1. 顶层目录一览

```text
deepseek-harness/
│
├── packages/      ★ 绝大部分代码：几百个 npm 包，按能力分组
├── docs/          架构文档、子系统文档、教程、目录册（中英双语）
├── examples/      可运行的示例项目（cordis.yml 叶子配置）
├── apps/          CLI 入口（cli）和 Web 应用（web）
├── vendor/        二手依赖的固定副本（Cordis 全家桶）
├── scripts/       仓库级工具：生成器、质量门禁、发布脚本
├── python/        Python SDK 和打包运行时
├── native/        原生模块（landlock 沙箱）
├── website/       VitePress 文档站
├── assets/        公共图片资源
├── patches/       第三方包补丁
├── .agents/       Agent 工作流和"Agent Notes"（决策记录）
│
├── package.json            workspace 根
├── pnpm-workspace.yaml     workspace 声明
├── pnpm-lock.yaml          依赖锁文件
├── tsconfig*.json          TypeScript 工程配置（base/client/host）
├── vitest*.config.ts       测试配置（单元/e2e/快照/web）
├── tsdown.config.ts        打包配置
├── AGENTS.md / CLAUDE.md   给 AI 代理看的协作规则
├── README.md / README.zh.md
├── CONTRIBUTING.md         贡献指南
└── LICENSE                 MIT
```

---

## 2. 最关键的 `packages/`：分组地图

`packages/` 下每一层子目录是一个"分组"，每个分组里是若干个包。按功能可以归成几大类：

### A. 产品核心（`core/`）+ 会话（`session/`）

| 分组/包 | 干什么 | 对应前面讲过的概念 |
|---|---|---|
| `core/session` | append-only 会话事件日志 + 内存存储 + 派生消息 | **账本** |
| `core/agent` | Agent 接口、注册表、生命周期事件 | 项目经理的"身份" |
| `core/agent-loop` | **唯一的真实循环逻辑** `ReactLoopAgent` | **循环引擎** |
| `core/system-prompt` | system prompt 分节组装 + 工具 schema 组装 | 开场白拼装 |
| `core/tools` | 工具注册、校验、pre/execute/post 执行管线 | 工具运行时 |
| `core/scope` | 按 agent 作用域注册插件的能力 | 部门隔离 |
| `core/agent-tool-presentation` | 工具调用/结果的 UI 呈现意图（card/diff 等） | 前端展示约定 |
| `core/agent-default-model` | 默认模型选择 | 默认路由 |
| `session/session-persistence*` | 持久化后端：JSONL / SQLite | 存档方式 |
| `session/session-projection*` | 从日志折叠"投影"，`-cache` 是持久化投影缓存 | 便签投影 |
| `session/session-checkpoint-policy` | 检查点写策略 | 何时存档 |
| `session/session-title*` | 给会话起标题（多版实现） | 起名 |
| `session/session-telemetry*` | 遥测（含 otel） | 监控 |
| `session/session-stats` | 会话统计 | 统计 |

### B. 模型层（`llm/`）+ 压缩（`compaction/`）

| 分组/包 | 干什么 | 对应介绍过的概念 |
|---|---|---|
| `llm/llm` | 模型抽象层：消息、chunk、usage、适配器注册 | 打电话的统一接口 |
| `llm/llm-deepseek` | **DeepSeek 官方适配器**（fetch+SSE） | DeepSeek 电话线 |
| `llm/llm-pi-ai` | 通用多厂商适配器（基于 pi-ai） | 其他厂家的电话线 |
| `llm/llm-retry` | 请求重试与退避 | 打电话失败重拨 |
| `llm/token-meter` | Token 估算、缓存/输出用量统计 | 量纸的厚度 |
| `compaction/compaction` | 压缩**接口定义**（Service Definition） | 压缩的"合同" |
| `compaction/compaction-basic` | 压缩**默认实现**（策略+摘要） | 压缩的"干活人" |
| `compaction/compaction-tool-result-pruner` | 无模型工具结果裁剪 | 剪刀手 |
| `compaction/command-compact` | `/compact` 命令 | 手动压缩按钮 |

### C. 子 Agent 与交互（`subagent/`、`interaction/`）

| 分组/包 | 干什么 |
|---|---|
| `subagent/subagent` | 子 Agent 能力接口（服务定义） |
| `subagent/subagent-spawn-in-process` | 全新子 Agent（同进程） |
| `subagent/subagent-fork-in-process` | **继承父对话前缀**的子 Agent |
| `subagent/subagent-acp` | ACP 协议子 Agent |
| `subagent/subagent-codex` / `-claude-code` / `-dsh-sdk` | 外部 CLI/SDK 子 Agent |
| `subagent/tool-subagent` | 模型可调用的"启动子 Agent"工具 |
| `subagent/tool-subagent-control` / `-report` | 子 Agent 的控制与回报工具 |
| `interaction/user-approval` | **审批服务**（ask/never 策略、审计） |
| `interaction/permission-presets` | 权限预设（sandbox + approval 打包） |
| `interaction/tool-ask-user` / `user-questions` | 问用户问题 |
| `interaction/commands` | 斜杠命令注册表 |

### D. 能力插件（沙箱、shell、文件、Web、工作流……）

| 分组/包 | 干什么 |
|---|---|
| `sandbox/*` | 沙箱：sandbox 定义、local、策略、Windows ACL |
| `shell/*` | bash / pwsh：本地执行、沙箱执行、持久 shell、工具 |
| `fs/*` | 文件系统：fs 定义、local、沙箱、观察策略、工具 |
| `subprocess/*` | 子进程能力 |
| `web/*` | 网页搜索与抓取（deepseek/exa/perplexity 搜索提供商） |
| `mcp/mcp-client` | MCP（Model Context Protocol）客户端 |
| `lsp/*` | 语言服务器协议能力 |
| `skill/*` | 技能（skill）注册与加载 |
| `workflow/*` | 工作流编排：workflow、worker-thread 提供商、`tool-workflow`、`tool-ralph` |
| `jobs/*` | 后台任务服务与工具 |
| `todo/tool-todo` | `todo_write` 工具 |
| `plan/plan-mode` | 计划模式（作为日志化状态） |
| `goal/*` | 目标能力：goal service、goal-round-driver、tool-goal、command-goal |
| `guard/*` | 循环卫生：重复工具提醒、工具超时策略 |
| `handle` `hooks/*` | Claude Code / Codex hook 桥接（第三方钩子） |
| `terminal/*` | 持久化终端 |
| `code-runtime/*` | 代码运行沙箱（worker-thread 等） |
| `feedback/*` | 用户反馈（消息反馈、命令反馈） |
| `spill/*` | 超大内容 spill（溢出到磁盘/恢复） |
| `attachment/attachment*` | 附件上传与本地存储 |

### E. 宿主/前端/装配（`client/`、`host/`、`api/`、`bundle/`、`boot/`、`sdk/`）

| 分组/包 | 干什么 |
|---|---|
| `bundle/base` | **每个 profile 的第一层**：默认装配所有模型适配器、工具、持久化、沙箱、设置 |
| `bundle/web-app` / `bundle/headless` | 应用的两种装配：Web 版 / 无头 CLI 版 |
| `boot/app-boot` / `boot/cmdline` | 启动装配、命令行入口 |
| `client/web-react` + `client/ui-*`（几十个 ui 包） | 前端 React 组件库（对话、工具、设置、子 Agent UI 等） |
| `client/connection` / `client/runtime` / `client/hmr` / `client/modules` | 前端运行时：连接、模块加载、HMR |
| `host/webserver` / `host/frontend-static` / `host/apiproxy` | 宿主服务：Web 服务器、静态文件、API 网关 |
| `host/directory-picker*` | 目录选择 |
| `api/gateway` / `api/remotes` | 远程 BFF 组装 + Typert RPC 网关 |
| `sdk/protocol` / `sdk/server` / `sdk/client` | JSON-RPC 协议、服务端、TS 客户端 |
| `acp/acp` | Agent Client Protocol 自动化服务器 |
| `preset/agent-presets` / `preset/persona` | 每会话 Agent 预设组合 / 人格 |
| `extensions/*` | 让 Cordis 的 host/client 双向运行、`tool-cordis` |

### F. 基础设施（`util/`、`storage/`、`settings/`、`credentials/`……）

| 分组/包 | 干什么 |
|---|---|
| `util/*` | 零依赖工具：brand（类型标记）、timeout、atomic-write、home-paths 等 |
| `storage/storage` + `-json` + `-sqlite` + `-domain` | 可插拔 KV 存储后端 |
| `settings/settings` + `-file` | 用户设置能力 + 文件实现 |
| `credentials/credentials` + `-local` | 密钥引用 + .env 实现 |
| `identity/anonymous-user-id` | 匿名用户 ID |
| `schedule/schedule` | 定时任务 |
| `typert/*` | 类型图生成器/加载器/注册表（RPC 类型系统） |
| `runtime-diagnostics/invariants` | 运行时不变量检查（每个包可注册自己的关系检查） |
| `test-support/*` | 测试设施：headless 重放、mock LLM 服务器、loader smoke |
| `session-query/*` | 会话查询与日志导出 |

> 注意分组名是"目录"，不是"包"。真正被 npm 安装的包在**分组的下一层**，名字形如 `@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-compaction-basic`。

---

## 3. 一个包内部长什么样

以 `packages/compaction/compaction-basic` 为例：微微查看任何包，结构都差不多：

```text
compaction-basic/
├── package.json        # 包元数据；peerDependencies 里声明 @deepseek-ai/cordis
├── README.md            # ★包的使用说明书（含 Model Experience：Token/Cache 影响）
├── README.zh.md         # 中文版
├── src/
│   ├── index.ts         # 插件入口：服务类 + config schema + 注册
│   ├── config.ts        # 配置校验与解析
│   ├── region.ts        # 核心事务：选范围、锁定、提交、稳定性检查
│   ├── summarizer.ts    # 摘要调用（复用请求前缀）
│   ├── types.ts         # 类型
│   └── invariant.ts     # 该包自己的运行时不变量
├── tests/               # 单元测试（vitest）
├── tsconfig.json        # 继承根 tsconfig.base.json
└── invariant/           # 可选：打包级不变量注册
```

约定：

- 每个包**默认导出自己的服务类**；函数插件导出 `name/inject/Config/apply`。
- `src/types.ts` 只放类型、不放运行时代码。
- 测试放在包内的 `tests/`，不是 `src/__tests__/`。
- 每个包的 README 都强制写 **模型体验**（Model Experience）章节：这个包会怎样影响输入 Token、怎样影响 KV Cache。

这条规则非常重要：**DSH 要求每个包的设计者把"我这个改动会不会破坏缓存前缀"写进文档。**

---

## 4. 运行时，这些包是怎么"拼"起来的

理解完目录，再看一次装配链（关键文件 `docs/architecture.md`）：

```text
dsh --profile web
  └── 加载 profile（一个插件组合配置）
        └── 按顺序装载 bundle：
              dsh-base       ← 第一层：模型适配器、工具、持久化、沙箱、审批、设置
              dsh-web-app    ← 浏览器应用层
        └── 再叠加用户自己的 cordis.patch.yml
```

- profile / bundle 由包 `package.json` 的 `dsh` 字段声明：
  - `dsh.profile` → 这个 profile 由哪些 bundle 组成
  - `dsh.bundle` → 这个 bundle 的配置补丁文件（cordis.yml 片段）
- 最终每个插件（session、agent、llm、compaction…）在同一张 Cordis Context 上互相服务。

```text
Context（Cordis）
 ├── ctx.sessions        来自 core/session
 ├── ctx.agents          来自 core/agent
 ├── ctx.agentLoop       来自 core/agent-loop
 ├── ctx.systemPrompt    来自 core/system-prompt
 ├── ctx.tools           来自 core/tools
 ├── ctx.llm             来自 llm/llm（+ llm-deepseek 注册适配器）
 ├── ctx.tokenMeter      来自 llm/token-meter
 ├── ctx.compaction      来自 compaction/compaction-basic（实现接口）
 ├── ctx.approval        来自 interaction/user-approval
 ├── ctx.subagents       来自 subagent/subagent
 └── …
```

要查看你机器上实际拼接出来的树：

```sh
dsh --profile web --dump-config
```

---

## 5. 配套目录说明

| 目录 | 说明 |
|---|---|
| `docs/` | 文档中枢：`architecture.md`（架构地图）、`subsystems/`（每个子系统的参考页）、`cookbook/`（怎么做一件事）、`cordis-primer.md`（Cordis 入门）、`postmortem/`（事故复盘）、`user/`（面向用户文档）。一律中英双语（`.zh.md` 后缀） |
| `examples/` | 可运行的示例叶子：`web-cordis`、`headless-agent`、`acp-agent`、`jsonrpc-agent`、`mcp-memory`、`web-schedule` |
| `apps/` | `cli/`（`dsh` 命令行）和 `web/`（Web 前端壳） |
| `vendor/` | 固定的 Cordis 源码副本（含同步说明），rescale 成 `@deepseek-ai/cordis` 等 |
| `scripts/` | 仓库门禁/生成器：文档校验、配置校验、发布、快照录制等 |
| `python/` | Python SDK（`sdk/`）和内置运行时（`sdk-runtime/`） |
| `native/` | 原生组件（landlock 沙箱） |
| `website/` | VitePress 构建的文档网站 |
| `.agents/` | Agent Notes：**技术决策记录**，每个非平凡改动都要附带一篇（`notes/implemented/` 是已实现决策、`notes/archived/` 是历史） |

---

## 6. 常用命令（根目录执行）

```sh
pnpm install               # 安装（Node ^22.19 || >=24，pnpm 11.x）
pnpm run test              # 单元测试（vitest）
pnpm run test:e2e          # 真实 API 测试（需要 DEEPSEEK_API_KEY，没有就自动跳过）
pnpm run test:snapshot     # 无 key 的 ACP/headless 回放快照测试
pnpm run typecheck         # 全仓类型检查
pnpm run lint              # oxlint
pnpm run build             # tsc 输出 lib/ + tsdown 打包
pnpm run doc-sync          # 文档门禁
pnpm dsh --profile headless "任务"  # 本地跑一个无头任务（需要 key）
```

---

## 7. 新手阅读路线图（按目录走）

**第一站：文档**

```text
docs/architecture.md        ← 先读这个，整个系统的地图
docs/cordis-primer.md       ← 不懂 Cordis 就读它（插件系统基础）
```

**第二站：核心包代码**

```text
packages/core/session/src/*        ← 事件日志 + surface（账本）
packages/core/agent-loop/src/*
  ├── agent.ts                     ← 循环驱动（turn/step/请求）
  └── tool-calls.ts                ← 工具调度
packages/core/tools/src/*          ← 工具执行管线
```

**第三站：模型与缓存**

```text
packages/llm/llm/src/types.ts      ← 消息/流/usage 统一类型
packages/llm/llm-deepseek/src/*    ← DeepSeek 适配器（SSE、缓存字段映射）
packages/llm/token-meter/src/*     ← Token 估算
```

**第四站：压缩（结合已讲过的内容）**

```text
packages/compaction/compaction/src/*              ← 接口
packages/compaction/compaction-basic/src/
  ├── index.ts         ← 自动触发（pre-step 压力 / overflow）
  ├── region.ts        ← 事务（选段→摘要→提交→稳定检查）
  └── summarizer.ts    ← 摘要请求（复用缓存前缀）
packages/compaction/compaction-tool-result-pruner/src/*  ← 裁剪
```

**第五站：子 Agent / 权限**

```text
packages/subagent/subagent-fork-in-process/src/*   ← fork 语义
packages/interaction/user-approval/src/*           ← 审批
```

---

## 8. 一句话记忆法

```text
packages/ 按能力分组（capability），一个能力 = 定义 + 实现 + 消费方
core/       是"循环骨架"（session 账本 + agent 循环 + 工具 + 提示词）
llm/        是"电话线集合"（统一抽象 + 各厂商适配器 + token 计量）
session/    是"存档系统"（持久化、投影、标题、遥测）
compaction/ 是"整理档案"（裁剪 + 摘要 + 事务）
subagent/   是"分派任务"（spawn / fork / ACP / 外部 CLI）
interaction/ 是"请示批准"（审批、权限、问用户）
client/ host/ bundle/ boot/ 是"怎么装起来跑给用户看"
```

打开目录先读 `docs/architecture.md`，再顺着 `core/ → llm/ → compaction/` 一层层往里走，就是最快的入门路。