# Provider 插件开发指南

AgentHub 的 Provider（agent CLI 接入层）是插件式的。内置 codex / kimi-code / claude-code / custom 四个 Provider 与第三方插件走同一套契约：`@agenthub/provider-sdk` 的 `AgentCliAdapter` 接口 + `ProviderDescriptor` 元数据。OpenCode 不内置，由 `packages/provider-plugin-opencode/` 插件提供。

## 快速开始

最快的路径是复制模板：`packages/provider-plugin-template/`（一个可编译、可安装的最小插件，含详细注释）。

```bash
pnpm install
pnpm --filter @agenthub/provider-plugin-template build
```

然后在应用的「Agent → 插件市场 → 从本地目录安装」选择该目录，或手动把整个目录复制到 `~/.agenthub/plugins/<id>/` 并重启应用。

## 插件包结构

```
<plugin-id>/
  agenthub-plugin.json   # 清单（必填）
  dist/index.js          # 入口（ESM，默认导出工厂函数）
  node_modules/          # 自带依赖（可选）
```

`agenthub-plugin.json`：

```json
{
  "id": "my-cli",                  // 小写短横线；同时是 providerId
  "apiVersion": 1,                  // 必须等于宿主 PROVIDER_API_VERSION
  "main": "dist/index.js",
  "version": "0.1.0",               // 市场更新检测用
  "descriptor": {
    "providerId": "my-cli",
    "name": "My CLI",
    "vendor": "ACME",
    "capabilities": ["headless_text"],
    "defaultExecutable": "my-cli",  // 探测 CLI 时的默认可执行名
    "credentialEnv": ["MY_API_KEY"],// 用户在 UI 存的 API Key 注入为哪个环境变量
    "envPassthrough": ["MY_BASE_URL"],
    "baseUrlEnv": "MY_BASE_URL",    // 实例 baseUrl 配置写入哪个环境变量
    "configProfile": true,          // CLI 支持命名配置档案时开启（如 codex --profile），否则实例编辑器隐藏该字段
    "permissionModes": [            // CLI 自带的权限模式（可选）
      { "value": "yolo",
        "name": { "zh-CN": "完全自主", "en-US": "YOLO" },
        "description": { "zh-CN": "自动批准一切", "en-US": "Approve everything" } }
    ]
  }
}
```

渲染端的 Provider 检测页、实例编辑器、权限模式选择器全部按 descriptor 渲染，插件不需要改任何 AgentHub 界面代码。

## 入口约定

```ts
import type { ProviderPluginFactory } from "@agenthub/provider-sdk";

const factory: ProviderPluginFactory = (context) => new MyCliAdapter();
export default factory;
```

`context.sdkVersion` 是宿主 SDK 版本。适配器实现 `AgentCliAdapter`：

- `detect(instance)`：探测 CLI 是否安装、版本是否兼容；
- `start(request)` / `resume?(request)`：启动一次运行，返回 `AdapterRun`（进程句柄 + `AdapterEvent` 异步流）；
- `listModels?`：模型发现（可选）。

关键 `AdapterEvent`：`message`（delta/completed 流式文本）、`thinking`、`tool`、`command`、`session`（providerSessionId，续聊必需）、`usage`（`contextUsed` 驱动宿主上下文指示器）、`commands`（斜杠命令）、`artifact`（图片/文件产物）。

`commands` 事件是插件暴露斜杠命令的通道：在运行开始时上报一次，宿主把它转成该 Provider 的 `/` 指令目录（插件只需上报自己确实能无头执行的命令）。命令项可声明 `providerCommand: "compact"`：执行该指令时宿主会把 `providerCommand` 传回 `start`/`resume` 请求，适配器应改用专用传输（如 OpenCode server 的 `POST /session/:id/summarize`）而不是把 `/compact` 当聊天文本发送；这类指令要求会话已有 `providerSessionId`。

建议对 SDK 只做类型导入（`import type`），让编译产物自包含；需要运行时工具（如 JSON-RPC 客户端）就把依赖打包进插件目录的 node_modules。

## 覆盖内置 Provider

插件 id 允许与内置 Provider（codex / kimi-code / claude-code / custom）相同：加载后插件适配器**替换**内置实现，停用或卸载时内置适配器自动恢复。可以用这个机制独立发布某个 Provider 的升级版支持。OpenCode 走了另一条路：它完全没有内置实现，`packages/provider-plugin-opencode/` 插件就是它唯一的接入方式（含超时/输出上限控制、`.cmd` shim 解析、`models --verbose` 模型发现），可作为比模板更真实的开发参考。`packages/provider-plugin-trae/` 是另一个完整示例：同一适配器按二进制探测结果在两种传输间切换（官方 `traecli` 走 ACP JSON-RPC，开源 `trae-agent` 走纯文本 `run`），并演示了 ACP 权限桥接、`session/load` 恢复与 `usage_update` 上报。

## 生命周期与信任模型

- 插件 = 任意本机代码。安装（市场或本地目录）必须经过用户显式确认；不做自动更新。
- 停用/启用即时生效（写入/移除插件目录的 `.disabled` 标记），运行中的会话不受影响。
- 单个插件加载失败不会阻塞宿主：状态在市场页标记为「加载失败」并附错误信息。

## 插件市场（registry）

市场数据来自一个 GitHub 仓库里的 `registry.json`（默认地址可用环境变量 `AGENTHUB_PLUGIN_REGISTRY` 覆盖）：

```json
{
  "plugins": [{
    "id": "my-cli",
    "name": "My CLI",
    "version": "0.1.0",
    "vendor": "ACME",
    "description": { "zh-CN": "……", "en-US": "……" },
    "tarball": "https://github.com/acme/agenthub-provider-my-cli/releases/download/v0.1.0/plugin.tgz",
    "sha256": "<tarball 的 sha256，十六进制小写>",
    "minAppVersion": "0.1.0"
  }]
}
```

安装流程：下载 tarball → 校验 sha256 → 解压（系统 tar）→ 校验清单 → 加载。tarball 可以把插件包在一层顶层目录里（如 npm pack 的 `package/`）。

上架 = 向 registry 仓库提 PR，包含：清单审核、tarball 下载地址与 sha256。
