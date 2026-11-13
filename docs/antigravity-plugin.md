# Antigravity 插件

Nautilo 通过 Google 官方 `agy acp` 接入 Antigravity。桌面入口仍为 Electron，运行与事件适配在 Rust 插件 `rust/plugins/antigravity/`，登录流程在 Electron 主进程。

## 使用

1. 安装插件，在 **Harness 管理 → Antigravity** 配置官方 `agy` 可执行文件。
2. 在 **供应商与账号 → 登录账号 → 添加账号 → Antigravity** 发起 Google 登录。授权页面由官方 CLI 打开，完成授权后才保存连接。
3. 新建任务选择 **Antigravity** 和该登录账号，获取账号实际提供的模型后发送消息。

当前开发机的官方 CLI 位于 `D:\CodexBuildCache\Nautilo\antigravity\agy.exe`。下载版本为 1.5.7，已校验官方 manifest 的 SHA-512。CLI、Rust 产物和构建日志均在 D 盘，不纳入仓库。

Antigravity 的凭据保存在系统凭据库，由 Google 官方 CLI 管理。Nautilo 不读取、复制或存储 Google refresh token。Antigravity App、CLI、IDE 和 SDK 共享这一官方身份，因此界面提供一个统一的 Antigravity 账号连接；登录恢复目录只存 Nautilo 的流程元数据，不用于隔离 Google 账号。重新登录可能改变其他 Antigravity 客户端正在使用的账号。

## 实现范围

- 每个 Nautilo 会话复用一个 ACP 进程；下一轮不重启，切换模型和推理强度通过原生配置接口生效。
- 保存原生 session ID，使用官方 `session/resume` 或 `session/load` 恢复，不把历史拼接为提示词。
- 流式文本、思考、并行工具、编辑内容、上下文用量和原生命令进入 Nautilo 事件流。响应投影屏障保证最后一段文本先于本轮完成事件。
- 权限选择按原生 option ID 回传；表单提问支持文本、数字、布尔、单选与多选；取消会传给原生 Agent，取消后进程仍可继续服务下一轮。
- 图片附件通过 ACP image content 发送；是否接受由实际模型决定。
- Nautilo 的 MCP 按 ACP 格式传入。编排工具通过会话独立的 loopback MCP 端点接入，名称不会覆盖用户 MCP。官方要求的 HTTP MCP worker 参数仅在传入 HTTP MCP 时添加。
- 官方原生 MCP、Skills、插件和默认定制继续由 `agy` 加载，没有新增禁用参数或覆盖整份原生配置。
- 原生 CLI 终端可通过当前执行文件及会话 ID 启动。

## 边界

- Google 当前没有为任意 ACP 客户端开放全部模型。Nautilo 如实声明客户端身份，只显示官方接口实际返回的模型，不伪装成其他 IDE。
- 这个插件接入官方 Google 账号；不把 OpenAI Responses、Chat Completions 或 Anthropic 端点冒充 Antigravity 原生 API。
- `usage_update.used/size` 表示当前上下文占用，不是累计输入输出消耗。仅当原生响应实际返回 turn usage 时才记录该项，不推算账单。
- 原生 Skills 会照常加载；Nautilo 管理的 Skills 注入及历史文件读取尚未声明支持。原生子 Agent 等未被 ACP 单独暴露的结构仍保留在原始事件中，不宣称已具备独立子会话展示。
- 账号授权必须由用户完成。本次已用未登录的官方 CLI 验证 `initialize` 和明确的 `Authentication required`；登录后的真实模型收发需在授权后验证。

## 验证

`cargo test -p agenthub-plugin-antigravity` 使用独立 ACP fixture，覆盖两轮同进程、最终文本顺序、原生恢复、权限与提问往返、取消后复用、未登录错误和并行工具增量更新。Electron 登录测试覆盖 Google ACP 授权成功、协议错误与进程提前退出；原有 Codex / Claude Code 登录测试同时保留。

## 官方资料

- [安装与统一账号](https://antigravity.google/docs/install)
- [ACP 客户端集成](https://antigravity.google/docs/ide/extensions/acp/)
- [CLI ACP](https://antigravity.google/docs/cli/acp/)
- [Skills](https://antigravity.google/docs/skills/)

参考官方协议独立实现，未复制第三方插件代码。
