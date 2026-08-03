# @agenthub/provider-plugin-trae

Trae 的 Nautilo Provider 插件。**Trae 不内置在 Nautilo 中，本插件是它的唯一接入方式**——安装后 Provider 列表出现 Trae，卸载后即移除。

一个插件同时支持两个 Trae CLI，按二进制探测结果自动选择传输：

- **官方 TRAE CLI（`traecli`，仅企业版）**：ACP 协议接入（`traecli acp serve`，ndjson JSON-RPC）。支持流式消息/思考、工具调用卡片、`usage_update` 上下文用量、`available_commands_update` 原生指令、权限请求桥接到 Nautilo 审批、`session/load` 会话恢复、经 `configOptions` 的模型/推理档位透传。
- **开源 trae-agent（`trae-cli`）**：无头 `trae-cli run` 纯文本模式。仅单轮任务：无会话恢复、无用量上报，完整输出作为最终消息返回。

其他行为：

- 探测：`--version` + `--help`（help 含 `acp` 即官方 CLI，含 `run` 子命令即 trae-agent）。
- `baseArgs` 始终置于插件自有参数之前，因此 `uv run trae-cli` 这类包装写法可用（executable 填 `uv`，baseArgs 填 `run trae-cli`）。
- Windows 下自动解析 npm 的 `.cmd` shim；凭证环境变量：`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `OPENROUTER_API_KEY` / `DOUBAO_API_KEY`。

> 验证状态：插件行为由 fake CLI 的契约测试覆盖（`packages/core-daemon/test/plugin-trae.test.mjs`）。官方 `traecli` 仅企业版可用，ACP 细节（`acp serve` 子命令形态、`session/load`、configOptions 结构）按 ACP 协议与公开资料实现，`acp serve` 失败时自动回退 `acp`；如与真实 CLI 有出入请按实际 `--help` 输出反馈。

## 构建

```bash
pnpm install
pnpm --filter @agenthub/provider-plugin-trae build
```

## 安装

在 Nautilo「Agents → 插件市场」页选择"本地安装"，选中本目录（需先构建出 `dist/`）；或将本目录打包为 `.tgz` 上架到插件市场 registry。实例的可执行文件默认为 `traecli`，未安装官方 CLI 时改为 `trae-cli`。
