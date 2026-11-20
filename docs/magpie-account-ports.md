# Magpie 账号模型代码移植

2026-11-18，当前入口：Electron + React + Nautilo Rust daemon。

按用户要求，将 Magpie 的账号模型实现移入 Nautilo。没有将 Magpie 应用、Go 可执行文件或单独的 Magpie 网关作为运行依赖。现有账号选择、连接版本和外层 Harness 的原生会话仍由 Nautilo 管理。

Electron 使用的 Rust 后台为跨 Harness 的账号模型提供同一个本地 Chat Completions 地址。每个会话的账号修订各有独立的本地凭据，请求进来时据此固定路由。换账号时下一条消息使用新绑定；已发出的请求继续使用原绑定。

## 来源与实际接线

主要参考固定提交 [`yetone/magpie@4a1ac84421145de4c4078898c6441487ac45bd5e`](https://github.com/yetone/magpie/tree/4a1ac84421145de4c4078898c6441487ac45bd5e)。Go 部分按其认证、请求和事件算法移植为 Rust；复制/移植部分保留 MIT 许可，见 [MAGPIE-LICENSE.txt](third-party/MAGPIE-LICENSE.txt)。

| 账号来源 | 上游代码 | Nautilo 实现 |
| --- | --- | --- |
| Codex | `internal/provider/codex_request.go`、`codex_names.go`、`codex_store.go`、`account.go` | `rust/nautilo-core/src/runtime/codex_account/`。读取所选原生凭据，协调刷新，直接发送 Codex Responses 请求；规范化工具名称/调用 ID、恢复加密 reasoning、转换流式结果。没有 Codex Agent 推理中转。 |
| Claude Code | `internal/gateway/claude_subscription.go`、`claude_text_calls.go` | `runtime/account_gateway/{claude,native,events,conversations}.rs` 与现有 Claude resident adapter。账号模型工作进程按 Magpie 的 `-p`/stream-json/MCP 路线启动，调用方执行工具并交回真实结果。匹配已有原生会话只是复用提示；独立请求、压缩历史和工具变化可新建工作会话，原生 resume 缺失时可用完整 API 上下文重建。 |
| OpenCode Zen / Go | `internal/provider/opencode_client.go`、`opencode_endpoints.go`、`internal/gateway/zenfree.go`、`chat.go` | `runtime/opencode_account/`。直接 HTTP 推理；复制核心工具 schema、客户端头、原生 session ID/trace 格式、项目标识、环境消息和工具名回映。免费模型上游始终流式，下游按请求流式或聚合。模型能力发现仍可使用本机 CLI；它不执行这条模型推理。 |
| Antigravity | Magpie 当前使用的社区 `agy-cli` 插件 | [`magpie-community/plugins@34edf938da4007b4e2990c7449963a4f5be317dc/packages/agy-cli`](https://github.com/magpie-community/plugins/tree/34edf938da4007b4e2990c7449963a4f5be317dc/packages/agy-cli)，版本 0.1.90。`rust/plugins/antigravity/resources/model-gateway/upstream/` 保留所需源码、LICENSE、NOTICE，未改其中的账号/ACP/模型实现；Nautilo 的 `server.mjs`、`protocol.mjs` 与 `runtime/antigravity_account.rs` 负责接入现有进程管理和 Chat API。沿用上游真实 `agy acp` 工作进程及 MCP 工具闭环，没有重写已退役的 Google CodeAssist 路由。 |

Antigravity 的 JavaScript 是复制进 Nautilo 的适配源码，由现有 Node 运行环境执行。不是下载、安装或启动 Magpie 应用。`UPSTREAM.json` 标记准确来源和版本。

## OpenCode Console 登录

所选账号目录里的 `data/opencode/opencode.db` 保存原生 `account` / `account_state`。实现读取当前账号与组织，并请求该原生 Console 的 `/api/config`。本机 OpenCode 1.19.5 的 `Config.loadActiveOrgConfig` 会把所选账号令牌放入 `OPENCODE_CONSOLE_TOKEN`，再解析 Console 返回的 `{env:OPENCODE_CONSOLE_TOKEN}`。Nautilo 按这个已核实的原生行为解析该占位符，不能把占位符本身当 API key 发送。

刷新使用原生 `/auth/device/token`、`client_id=opencode-cli` 和原生数据库字段。各路由按账号目录串行刷新，发出轮换后即使模型 HTTP 调用被取消也完成落盘；保存前比较 refresh token，避免覆盖并发的原生登录。Console 端点不跟随重定向。普通服务凭据与旧版 `auth.json` 按原有形式读取；没有借用其他账号或要求用户另填 API key。

免费模型的 HTTP 429 保留为 429，不伪装为成功或登录失效。上游的 401 才会触发一次所选账号配置重取，再按实际结果报告。

## 模型工作进程与原生 Harness

Claude 模型工作进程的 `--tools ""`、`--strict-mcp-config`、`--setting-sources ""` 来自 Magpie 的 `claudeCLIArgs`：此处让模型使用调用方提供的工具，权限仍由调用方 Harness 处理。它们只作用于私有 `accountModelRelay` 工作进程，没有添加到用户直接运行 Claude Harness 的启动配置。账号模型工作进程仍保留原生会话持久化。当前安装版本帮助未声明 `--thinking-display`，因此没有强加该参数。

外层 Harness 的 Apps、插件、MCP、Skills、权限交互、原生 ID 和配置优先级沿用原有实现。把传入 API 历史交给新的模型工作进程，明确作为重建上下文；不称为恢复原来的原生会话。

Codex 的 `auto` 凭据模式按 Magpie 规则读取存在的原生文件回退。显式 keyring/ephemeral 的不可读取存储不借用旧文件，也不再暗中改走 Codex Agent。Windows 原生加密存储和 macOS keychain 路径不能从本次文件凭据测试推断已完成支持。

## 验证记录与边界

- Rust 定向回归覆盖账号路由、独立/并发 API 请求、标题与正文、工具结果、历史重写、分支、断流取消、原生恢复、保存会话缺失后的重建、Console 占位符、401 重取配置、OAuth 轮换在取消后落盘、免费工具回映、SSE 分段 UTF-8、Codex 名称/调用 ID 规范化。Claude stream-json 夹具还验证两轮内容变化仍复用同一进程，普通原生 Harness 参数不受模型工作进程参数影响。
- Antigravity Chat/Messages 协议测试 3 项通过：历史/图片/真实工具结果，分段文字/思考/并行工具/usage，真实错误和不完整流。共享 TS 构建与桌面类型检查通过。
- 显式真实请求：真实 DeepSeek 0.2.1-rc.3 → Nautilo Rust → 当前选中的 Codex 账号，`gpt-6.1-sol` / Low 返回 `NAUTILO_ACCOUNT_OK`；同一外层 Harness → 所选 Antigravity 账号，`gemini-3.8-flash` 返回预期文本。
- OpenCode：本机已登录的 Console 配置返回 88 个模型。Nautilo Rust 直接 HTTP → 该账号的 `opencode/deepseek-v4.1-flash-free` 返回 HTTP 200 和 `NAUTILO_ACCOUNT_OK`。此项没有启动 OpenCode Agent 推理。
- **DeepSeek 完整请求 → OpenCode 免费模型仍未通过**：当前返回 HTTP 429。将同一调用方请求、同一账号、同一工作目录交给固定提交的原版 Magpie 对照，也返回相同的 `FreeUsageLimitError`。普通短请求可以成功，不能仅凭这条错误断言账号免费额度耗尽，也不能宣称所有 Harness/工具集组合已兼容。没有为通过测试擅自替换调用方工具的参数语义。
- 当前保存的连接中没有 Claude Code 订阅账号，因此未运行真实 Claude 订阅推理；本次 Claude 结论限于协议、工具桥和 resident 夹具。OpenCode Go 的实际付费请求未消耗额度测试。

这些改造在当前 Electron + Rust 路径生效。保留的旧 TS daemon 仍是参考实现，不能将它过去的原生 CLI 中转测试当作上述 Rust HTTP 移植的验证。没有声称全量测试或所有原生终端流程都已完成。
