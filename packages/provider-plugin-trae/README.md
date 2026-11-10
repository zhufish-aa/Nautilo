# @agenthub/provider-plugin-trae

Trae 的 Nautilo Provider 插件。**Trae 不内置在 Nautilo 中，本插件是它的唯一接入方式**——安装后 Provider 列表出现 Trae，卸载后即移除。

一个插件同时支持两个 Trae CLI，按二进制探测结果自动选择传输：

- **官方 TRAE CLI（`traecli`，仅企业版）**：ACP 协议接入（`traecli acp serve`，ndjson JSON-RPC）。支持流式消息/思考、工具调用卡片、`usage_update` 上下文用量、`available_commands_update` 原生指令、权限请求桥接到 Nautilo 审批、`session/load` 会话恢复、经 `configOptions` 的模型/推理档位透传。
- **开源 trae-agent（`trae-cli`，默认）**：无头 `trae-cli run`，直接使用 Nautilo 保存的 API。插件为连接版本和会话分别生成配置，使用所选模型，从 trajectory 读取最终回答与用量。没有原生会话恢复，后续消息由工作台重建文本上下文。

其他行为：

- 探测：`--version` + `--help`（help 含 `acp` 即官方 CLI，含 `run` 子命令即 trae-agent）。
- `baseArgs` 始终置于插件自有参数之前，因此 `uv run trae-cli` 这类包装写法可用（executable 填 `uv`，baseArgs 填 `run trae-cli`）。
- Windows 下自动解析 npm 的 `.cmd` shim；凭证环境变量：`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `OPENROUTER_API_KEY` / `DOUBAO_API_KEY`。

API Key 只通过本次执行的环境变量提供，不写入配置、命令参数或 trajectory。Windows 执行强制使用 UTF-8，避免控制台符号导致 GBK 编码错误。开源 CLI 的工具执行遵循其自身行为，不提供 ACP 的逐次权限交互能力。

隔离集成脚本 `apps/desktop/test/native-connection-smoke.mjs` 可以使用真实 CLI 和本地测试服务验证模型、认证、请求路径与回答持久化。

## 构建

```bash
pnpm install
pnpm --filter @agenthub/provider-plugin-trae build
```

## 安装

在 Nautilo「Agents → 插件市场」页选择"本地安装"，选中本目录（需先构建出 `dist/`）；或将本目录打包为 `.tgz` 上架到插件市场 registry。实例的可执行文件默认为 `trae-cli`，也可以填写已安装开源 trae-agent 的绝对路径。
