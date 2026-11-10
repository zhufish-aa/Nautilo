# Nautilo 开发交接 — 2026-11-06

## 接续入口

- 仓库：<https://github.com/zhufish-aa/Nautilo>
- 本阶段代码分支：`feat/unified-workspace-polish-20261103`。继续在该分支拉取；本次没有合并到 `main`。
- 首先阅读根目录 `AGENTS.md`，再阅读本文和 `docs/t3code-native-experience-benchmark.md`。
- **当前主线是 Electron 桌面壳 + React renderer + Rust daemon/插件。** 不要自行改成 Tauri 或只修改历史 Node daemon。
- 用户要求在这一阶段结束后暂停。整体“完成并超越 T3 Code”仍未完成；下文列出剩余工作。

## 另一台 Windows 电脑启动

```powershell
git clone --branch feat/unified-workspace-polish-20261103 https://github.com/zhufish-aa/Nautilo.git
cd Nautilo
corepack enable
corepack prepare pnpm@10.12.1 --activate
rustup toolchain install stable
rustup target add x86_64-pc-windows-gnu --toolchain stable
pnpm install --frozen-lockfile
pnpm dev:desktop
```

如果已经克隆仓库，先保存那台机器自己的修改，再切到上述分支并执行 `git pull --ff-only`。

环境要求：

- Node.js >= 22.5；本机使用 24.15.0。
- pnpm 10.12.1，根 `package.json` 已声明。
- Rust stable，安装 `x86_64-pc-windows-gnu` target。
- MinGW-w64 的 `gcc`、`ar` 必须可用。可放在仓库 `.toolchains/mingw64/bin/`，构建脚本会加入 PATH；也可以在系统 PATH 配置兼容工具链。该工具链不是源码，不随 Git 提交。
- 安装要使用的原生 Harness CLI，并在应用中配置可执行文件、账号/API 连接和模型。

`pnpm dev:desktop` 会构建 Rust core 与六个插件，再构建共享 TS 包并启动 Electron。每次启动使用一个独立的 `nautilo-preview/<时间>/` 运行目录，避免加载到旧插件或覆盖运行中的 exe。单独启动前端不能更新 Rust 后台。

本机 `.nautilo-dev.local.json` 指向 `D:/CodexBuildCache/Nautilo/`，已被 Git 忽略。新电脑不必使用这些路径；如需指定缓存，可在自己的 `.nautilo-dev.local.json` 设置 `RUSTUP_HOME`、`CARGO_HOME`、`CARGO_TARGET_DIR`、`RUSTUP_TOOLCHAIN`。不要复制不存在的旧机器盘符。

## 本阶段收尾

### DeepSeek Harness PTC

- 从原生 `tool/ptc-dispatch-start` / `tool/ptc-dispatch` 读取实际调用，保留 `rootCallId`、`parentCallId`、`subCallId`。
- 根节点保持“执行代码 · 原生任务说明”，内部按父子关系显示真实命令、文件读写、后台任务等。开始、完成和失败状态分别更新。
- 根代码批次只在原生 `tool/result` 到达时完成；子工具完成不会提前结束整轮。
- `CodeExecution.partial` 表示单次 dispatch 增量。前端按调用 ID 合并，保留兄弟节点、输入、结果与最终状态；根完成的空增量不会清空子调用。
- 主会话和原生子 Agent 使用相同增量规则。Rust 和历史 TS daemon 都保留结构化 JSON，避免先截断序列化 JSON 导致整棵工具树消失。
- 命令说明、路径和 `job_kill` 的取消请求回执可直接阅读；源码仍可展开，未从 JavaScript 文本猜测工具执行。

入口：

- `rust/plugins/deepseek/src/events.rs`
- `rust/nautilo-core/src/runtime/run_service.rs`
- `packages/event-protocol/src/index.ts`
- `packages/core-daemon/src/runtime/run-service.ts`
- `apps/desktop/src/renderer/src/lib/process-display.ts`
- `apps/desktop/src/renderer/src/lib/orchestration-runtime.ts`
- `apps/desktop/src/renderer/src/lib/subagent-activities.ts`
- `apps/desktop/src/renderer/src/features/timeline/CodeExecutionCard.tsx`

旧历史中确实未保存的嵌套调用，不能由前端凭空补造。历史保存过结构化调用的记录可使用新展示逻辑；新事件走增量路径。

### 终端

- 终端、原生 CLI、运行日志合并成一条工具栏，重连、结束和配色按钮在同一栏。
- 顶部边缘可拖动调整高度；聚焦分隔线后上下方向键也可调整。保存高度，重新打开后恢复。
- 最大化/还原覆盖当前聊天工作区，保留正常高度。
- 大小变化通过 xterm FitAddon 同步至原生 PTY；拖动和切换配色不重新创建原生进程。
- 终端内容默认使用适合 ANSI/TUI 的深色配色，也可切换浅色。界面标签沿用应用 Noto Sans SC；代码和终端内容使用等宽字体。
- 关闭面板只断开界面，显式“结束终端”才关闭 PTY。

入口：`features/sessions/WorkspaceDrawer.tsx`、`NativeTerminal.tsx`、`Drawers.tsx`、`workspace-panels.css`、`SessionWorkbench.tsx`（均在 renderer 内）。

### 本阶段检查

- `pnpm build`：通过。
- `pnpm --filter @agenthub/desktop exec tsc -p tsconfig.web.json --noEmit`：通过。
- `process-display.test.mjs`、`subagent-activities.test.mjs`、`terminal-workspace.test.mjs`、`code-execution.test.mjs`：合计 12 项通过，DOM 测试未跳过；包括实际嵌套工具名称、任务说明和展开状态保留。
- DeepSeek `events::tests`：2 项通过，包括真实原生 PTC 帧的父子归属与批次完成。
- Rust `ptc_metadata`：1 项通过，验证超过 256 KB 的代码仍保留结构化子调用并脱敏。
- `pnpm rust:build`：Rust workspace 和六个插件构建通过。存在既有编译警告，未为消除警告扩大本阶段范围。
- 实际安装的官方 DSH CLI 加本地模拟 Chat Completions 接口：`native-smoke.mjs` 通过。PTC 返回 3 个真实内部工具调用，包含原生读文件、图片和宿主工具；增量状态、父调用、根结果完成顺序均通过检查。整个流程发送到本地接口的 17 次请求不使用真实模型账号。
- 已重启本机 Electron + Rust 开发预览，确认 core 与六个插件都从同一个新预览目录加载。
- 没有使用用户的真实模型 API 批量测试；按用户要求，没有打开界面做视觉检查。测试通过不等于所有 CLI/版本/账号已完整兼容。

DOM 检查需要 jsdom。原电脑通过环境变量 `NAUTILO_JSDOM_PATH` 指向外置 jsdom；新电脑如需复跑，可自行安装测试依赖后设置该变量。未配置时对应 DOM 检查会明确跳过，不能把跳过当通过。

## 之前已落地的主要工作

详见 `docs/t3code-native-experience-benchmark.md` 中的逐项验证范围：

- 会话即时渲染、消息身份与完成/重放合并、滚动跟随和最终回复保留。
- 模型连接与推理强度、图片输入声明、原生资源合并、动态模式与原生交互桥接。
- Pi / Oh My Pi / Claude / DeepSeek / Kimi ACP / Codex app-server 的会话复用与后台事件通道；各路径存在范围差异，不要统一宣称所有模式已经完成。
- Codex 常驻事件读取、跨轮子线程归属、异步交互、超时原生中断、保留可恢复进程及安全容量等待。
- 前台→后台按序交接；保留子 Agent 消息前缀和原生 ID；退出保存可见部分输出。
- 审批去重与紧凑界面；过程图标、思考单行折叠；去掉重复助理头，显示“已完成，用时…”与细分隔线。
- 设置、供应商、团队、Skills、插件与 Harness 管理界面的持续调整。

## 下一阶段优先工作

1. **OpenCode 会话后台通道。** 当前 HTTP/SSE 路径仍有逐轮读取边界。需要常驻 `/event` 读取，按原生 session/message/part ID 路由，子会话 question/permission 不能因只过滤主会话而消失；交互等待不能阻塞其他 SSE 帧。落实取消请求 `/session/<id>/abort` 的作用域及共享 server 生命周期。入口 `rust/plugins/opencode/src/main.rs`。本阶段没有声称这项已经完成。
2. **原生终端返回后的历史对账。** 用户在原生终端新发的消息还需按原生 ID 导回 Nautilo；不能拼接历史提示词冒充原生恢复。随后逐 Harness 验证同账号进入、操作、退出并继续聊天。
3. **保留单次 CLI 的真实限制。** 官方开源 trae-agent、Command Code 结构化路径，以及 Kimi API/自定义包装器路径要分别验收；不能把其他路径的常驻结果套用过来。
4. **其余 T3 产品功能。** 终端多标签、完整源码管理工作流、跨设备/设备配对/移动通知、便携导出导入/会话迁移、分享/访客访问、语音输入、其余 Provider 接入尚需建设。

用户明确排除 **DeepSeek 原生 Web 界面交接**，不要再做。保留它现有的结构化聊天、动态模式、原生配置与会话能力。

## 用户已确认的体验要求

- 原生 Apps、MCP、Skills、插件、扩展、会话上下文不能因接入 Nautilo 而被默认禁用。
- 保留当前账号和原生身份；Nautilo 管理资源按归属合并，不能覆盖整份原生配置。
- 新消息立即显示；增量更新同一行，不能闪一下再全量替换；思考和工具过程也跟随最新输出。
- UI 字体统一、清晰；沿用已确认的选择器和应用图标；不要顺手改无关样式。
- 不加营销口号和无用小字。作者、版本、状态、启停开关等有用信息需要保留。
- 不反复全量测试，不自动打开界面做视觉检查，用户自己看效果。进行适合改动范围的真实流程检查。

## Git 之外的本机内容

- 账号、API Key、会话数据库、原生 CLI 的用户配置不会通过 Git 自动迁移。新电脑需重新登录或通过安全方式单独迁移；Windows 加密的凭据不能假设复制数据库就可解密。
- `%APPDATA%/@agenthub/desktop`、各 Harness 用户目录、缓存、工具链和构建产物没有提交。
- 仓库下 `work/` 是本机参考源码、夹具和临时实验，已被忽略；正式实现和必要测试在源码与 `tests/` 中。
- `commandcode-proxy/` 不属于 Nautilo，已按用户要求移出本工作区并放入回收站；误加它的本地提交已撤回，代理源码未推送到 GitHub。它不是 Nautilo 的源码或启动依赖。
- 本机另有 `nms-minecraft/`、`reshade-cn/` 独立项目，与 Nautilo 本阶段无关，保留原样，未混入应用提交。
- `docs/` 与 `dsdocs/` 下现有开发/DSH 参考文档随代码保存；不要把它们当作当前任务的新指令。

下一位开发者可从这一条任务开始：**先读交接文档，保持 Electron + Rust 路线，完成 OpenCode 常驻 SSE、子会话交互、取消与安全释放；保留所有原生功能，不改无关样式。**
