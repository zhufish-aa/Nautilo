# @agenthub/provider-plugin-opencode

OpenCode 的 Nautilo Provider 插件，封装 `opencode run --format json`。**OpenCode 不内置在 Nautilo 中，本插件是它的唯一接入方式**——安装后 Provider 列表出现 OpenCode，卸载后即移除。

- 通过可复用的 `opencode serve` 事件流和问答 API 接入，同一实例/工作区只冷启动一次，并支持原生会话恢复与模型透传
- 支持 Build / Plan 模式；`plan_exit` 会在 Nautilo 中显示专用计划审批卡，审批结果原路回复 OpenCode
- 上下文用量：从 `step-finish` 的 tokens 上报 input + cache read/write 作为已用上下文
- 压缩上下文：会话 `/compact` 走 server 的 `POST /session/:id/summarize`（沿用会话当前模型）
- 模型发现：`opencode models --verbose`（含显示名与上下文窗口）
- 检测：`opencode --version` + `opencode --help`；Windows 下自动解析 npm 的 `.cmd` shim
- 凭证环境变量：`OPENCODE_API_KEY`

## 构建

```bash
pnpm install
pnpm --filter @agenthub/provider-plugin-opencode build
```

## 安装

在 Nautilo「Agents → 插件市场」页选择"本地安装"，选中本目录（需先构建出 `dist/`）；或将本目录打包为 `.tgz` 上架到插件市场 registry。
