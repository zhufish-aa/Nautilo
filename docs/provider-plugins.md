# Provider 插件开发指南

Nautilo 的 Provider（agent CLI 接入层）是插件式的。内置的 codex / kimi-code / claude-code / custom 四个 Provider 与第三方插件走**同一套契约**：`@agenthub/provider-sdk` 定义的 `AgentCliAdapter` 接口 + `ProviderDescriptor` 元数据。OpenCode 和 Trae 不内置，分别由 `packages/provider-plugin-opencode/`、`packages/provider-plugin-trae/` 插件提供——它们是本指南之外最好的参考实现。

本文档基于以下源码整理，引用类型时以这些文件为准：

- `packages/provider-sdk/src/types.ts` — 运行时契约（Adapter、事件、进程）
- `packages/provider-sdk/src/descriptor.ts` — 展示元数据与插件清单
- `packages/core-daemon/src/runtime/plugins/plugin-service.ts` — 安装、加载、校验、生命周期
- `packages/provider-plugin-template/` — 可编译可安装的最小模板

## 目录

1. [快速开始](#快速开始)
2. [插件包结构](#插件包结构)
3. [清单 agenthub-plugin.json](#清单-agenthub-pluginjson)
4. [ProviderDescriptor 字段参考](#providerdescriptor-字段参考)
5. [入口约定与工厂函数](#入口约定与工厂函数)
6. [AgentCliAdapter 接口详解](#agentcliadapter-接口详解)
7. [AdapterEvent 事件协议](#adapterevent-事件协议)
8. [AdapterRun 与 ProcessHandle](#adapterrun-与-processhandle)
9. [进阶能力](#进阶能力)
10. [覆盖内置 Provider](#覆盖内置-provider)
11. [生命周期与信任模型](#生命周期与信任模型)
12. [插件市场（registry）](#插件市场registry)
13. [调试与常见问题](#调试与常见问题)

## 快速开始

最快的路径是复制模板 `packages/provider-plugin-template/`：一个可编译、可安装的最小插件，把"接收 prompt 参数、把回答流式输出到 stdout"的任意 CLI 包装成 Provider。

```bash
pnpm install
pnpm --filter @agenthub/provider-plugin-template build
```

然后二选一安装：

- **应用内**：「Agent → 插件市场 → 从本地目录安装」，选择该目录；
- **手动**：把整个目录复制到 `~/.agenthub/plugins/<id>/`，重启应用。

安装后该 Provider 会出现在「Agent → CLI 检测」页，可以创建实例、发起会话。

接入自己的 CLI 只需改三处：

1. `agenthub-plugin.json`：`id`（同时是 providerId）、`descriptor`（名称、厂商、能力标签、默认可执行文件、凭证环境变量、权限模式）；
2. `src/index.ts`：`providerId` 与清单保持一致，按需改写 `detect()` 探测逻辑和 `start()` 的协议翻译；
3. 需要续聊就实现 `resume()`，并把 `supportsResume` / `capabilities.nativeResume` 置真。

## 插件包结构

```text
<plugin-id>/
  agenthub-plugin.json   # 清单（必填）
  dist/index.js          # 入口（ESM，默认导出工厂函数）
  node_modules/          # 自带依赖（可选）
```

要点：

- 插件目录安装在 `~/.agenthub/plugins/<id>/`，**id 必须与清单 `id` 一致**。
- 建议对 SDK 只做类型导入（`import type`），让编译产物自包含、运行时不依赖宿主解析任何模块。模板就是这么做的：编译后的 `dist/index.js` 只引用 Node 内置模块。
- 确实需要运行时依赖（如 JSON-RPC 客户端）时，把依赖打包进插件目录的 `node_modules/`。安装本地目录时 daemon 会**跳过符号链接**（pnpm workspace 的 link 在 Windows 上无法复制），所以请用真实文件（如 `pnpm deploy` 产物）。
- 重新安装同一插件时，daemon 用 `?v=<timestamp>` 的 cache-buster 重新 import，新代码立即生效，无需重启。

## 清单 agenthub-plugin.json

类型定义见 `ProviderPluginManifest`（`descriptor.ts`）。完整示例：

```json
{
  "id": "my-cli",
  "apiVersion": 1,
  "main": "dist/index.js",
  "version": "0.1.0",
  "minAppVersion": "0.1.0",
  "descriptor": {
    "providerId": "my-cli",
    "name": "My CLI",
    "vendor": "ACME",
    "capabilities": ["headless_text"],
    "defaultExecutable": "my-cli",
    "credentialEnv": ["MY_API_KEY"],
    "envPassthrough": ["MY_PROXY"],
    "baseUrlEnv": "MY_BASE_URL",
    "configProfile": true,
    "modelSuggestions": ["my-model-large", "my-model-small"],
    "contextWindowDiscovery": false,
    "permissionModes": [
      {
        "value": "yolo",
        "name": { "zh-CN": "完全自主", "en-US": "YOLO" },
        "description": { "zh-CN": "自动批准一切", "en-US": "Approve everything" }
      }
    ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `id` | string | 是 | 插件唯一 ID，同时是适配器注册的 `providerId` |
| `apiVersion` | number | 是 | 必须等于宿主的 `PROVIDER_API_VERSION`（当前为 **1**，见 `provider-sdk/src/index.ts`） |
| `main` | string | 是 | 相对插件根目录的 ESM 入口 |
| `version` | string | 否 | 插件版本，市场用于更新检测 |
| `minAppVersion` | string | 否 | 最低应用版本（当前为保留字段，宿主暂未强制校验） |
| `descriptor` | object | 是 | 见下节 |

**运行时校验规则**（`plugin-service.ts` `validateManifest`，不满足即加载失败）：

- `id` 必须匹配 `/^[a-z0-9][a-z0-9-]*$/`（小写字母数字开头，可含短横线）；
- `apiVersion` 必须严格等于宿主版本；
- `main` 不能为空；
- `descriptor.providerId` 必须等于 `id`；
- `descriptor.name`、`descriptor.vendor` 必须存在；
- `descriptor.capabilities` 必须是数组。

此外，入口模块默认导出的工厂返回的适配器，其 `providerId` 也必须等于清单 `id`，否则加载时报错"适配器 providerId 与插件 id 不一致"。

## ProviderDescriptor 字段参考

Descriptor 是 Provider 的"展示 + 集成"元数据：**渲染端的 CLI 检测页、Agent 实例编辑器、权限模式选择器完全按它渲染**，插件不需要改动任何 Nautilo 前端代码。注意清单里的 descriptor 和适配器代码里的 descriptor 是两份拷贝，要保持同步——这样宿主不加载插件代码就能渲染市场条目。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `providerId` | string | 是 | 与清单 `id` 一致 |
| `name` | string | 是 | UI 显示名称 |
| `vendor` | string | 是 | 厂商 |
| `capabilities` | string[] | 是 | UI 能力标签，如 `headless_text`、`headless_structured`、`provider_server` |
| `defaultExecutable` | string | 否 | 用户未配置可执行路径时，检测探测用的默认命令名 |
| `credentialEnv` | string[] | 否 | 用户在 UI 保存的 API Key 注入为哪些环境变量。**每个列出的变量都会注入同一把 key**（例如 Codex 同时需要 `OPENAI_API_KEY` 和 `CODEX_API_KEY`） |
| `envPassthrough` | string[] | 否 | 允许从 shell 环境透传给探测/运行进程的变量名 |
| `baseUrlEnv` | string | 否 | 实例配置的 `baseUrl` 写入哪个环境变量 |
| `permissionModes` | array | 否 | CLI 原生权限模式（见下）；不配则 UI 不显示模式选择器 |
| `configProfile` | boolean | 否 | CLI 支持命名配置档案（如 `codex --profile`）时开启；否则实例编辑器隐藏 profile 字段 |
| `modelSuggestions` | string[] | 否 | 模型发现完成前，在模型选择器里展示的静态建议 |
| `contextWindowDiscovery` | boolean | 否 | 运行启动时是否通过 `listModels` 探测当前模型的上下文窗口（kimi/claude 的行为；发现慢的 CLI 不要开） |

`permissionModes` 的每一项：

```ts
interface ProviderPermissionMode {
  value: string;              // 传给 CLI 的值，运行时在 AdapterStartRequest.permissionMode 中收到
  name: LocalizedText;        // { "zh-CN": "...", "en-US": "..." }
  description: LocalizedText;
}
```

所有面向用户的文本都是 `LocalizedText`（中英双语），渲染端按当前界面语言选取。

## 入口约定与工厂函数

插件入口必须是 ESM 模块，**默认导出一个工厂函数**：

```ts
import type { ProviderPluginFactory } from "@agenthub/provider-sdk";

const factory: ProviderPluginFactory = (context) => new MyCliAdapter();
export default factory;
```

- `context.sdkVersion` 是宿主 SDK 版本（字符串，当前 `"1"`），可用于兼容性分支；
- 工厂在**每次加载**时调用（安装、启用、重装、daemon 启动扫描），应轻量，不要在工厂里启动进程；
- 宿主缺少默认导出或导出不是函数时，插件标记为加载失败，不影响其他插件。

## AgentCliAdapter 接口详解

```ts
interface AgentCliAdapter {
  readonly providerId: string;
  readonly descriptor: ProviderDescriptor;
  readonly supportsStructuredOutput: boolean;
  readonly supportsResume: boolean;
  readonly capabilities: AdapterCapabilities;
  detect(instance: AgentInstance): Promise<AdapterDetectionResult>;
  listModels?(instance: AgentInstance, context?: AdapterDiscoveryContext): Promise<ProviderModelCatalog>;
  start(request: AdapterStartRequest): AdapterRun;
  resume?(request: AdapterResumeRequest): AdapterRun;
  dispose?(): void | Promise<void>;
}
```

### capabilities

```ts
interface AdapterCapabilities {
  structuredOutput: boolean;   // 支持 outputSchemaPath 结构化输出
  textOutput: boolean;         // 有文本回答流
  interactiveStdin: boolean;   // 运行中可通过 write() 交互
  nativeResume: boolean;       // 支持 provider 原生会话恢复
  pty: boolean;                // 需要伪终端运行
}
```

### detect(instance)

探测 CLI 是否安装、版本是否兼容。约定：

- 用 `instance.executable || descriptor.defaultExecutable` 确定探测命令；
- 典型实现：跑 `<exe> --version` 拿版本，跑 `<exe> --help` 判断兼容（OpenCode 插件就是这么做的）；
- **永远不要 reject**：未安装或出错时返回 `{ installed: false, executable, error }`。

```ts
interface AdapterDetectionResult {
  installed: boolean;
  compatible?: boolean;
  executable: string;
  version?: string;
  help?: string;    // --help 输出截断（OpenCode 截到 16KB，模板截到 4KB）
  error?: string;
}
```

### start(request) / resume(request)

启动一次运行，返回 `AdapterRun`。**同步返回**，事件通过 `events` 异步流持续产出。

`AdapterStartRequest` 关键字段：

| 字段 | 说明 |
|---|---|
| `instance` | Agent 实例配置（可执行文件、`baseArgs`、providerOptions 等） |
| `prompt` | 用户/编排器传入的提示词 |
| `cwd` | 运行工作目录（通常是项目路径） |
| `model` / `reasoningEffort` / `serviceTier` | 会话级模型设置（不属于实例） |
| `permissionMode` | 会话级权限模式，覆盖实例级设置；对应 descriptor 里 `permissionModes[].value` |
| `env` | 已处理好的环境变量（含注入的凭证、baseUrl），直接透传给子进程 |
| `timeoutMs` / `idleTimeoutMs` / `maxOutputBytes` | 运行限制，适配器应在 ProcessHandle 层落实（见下） |
| `outputSchemaPath` | 请求结构化输出时的 schema 文件路径 |
| `localImagePaths` | 用户附带的本地图片 |
| `runtimeTools` / `executeRuntimeTool` | 宿主注入的运行时工具（如任务委派），见[进阶能力](#进阶能力) |
| `requestInteraction` | Provider 发起结构化提问/权限确认的回调，见[进阶能力](#进阶能力) |
| `mcpServers` | 用户为该 Provider 启用的 MCP server，会话启动时注入 |
| `providerCommand` | Provider 原生控制指令（目前仅 `"compact"`），有专用传输时不要当聊天文本发送 |

`resume` 额外携带 `providerSessionId`（之前通过 `session` 事件上报的 ID），适配器据此恢复 Provider 原生会话。

`baseArgs` 约定：如果实例配置了 `baseArgs`，把 `{prompt}` 占位符替换为实际 prompt（模板的做法）；否则按 CLI 自己的方式传 prompt。OpenCode 插件演示了另一种分支：`baseArgs` 为空时走 server 模式以获得完整交互能力。

### listModels(instance, context)

可选。返回 `ProviderModelCatalog`（模型列表，来自 `@agenthub/domain`）。`context.env` 是含凭证的实例级环境。参考 OpenCode 的实现：执行 `opencode models --verbose` 并解析输出。

### dispose()

可选。插件被重载、禁用或宿主停止时调用，用来释放适配器持有的长生命周期资源（如 OpenCode 插件复用的 server 进程）。实现要幂等。

## AdapterEvent 事件协议

适配器把 CLI 的原始输出翻译成统一的 `AdapterEvent` 流，宿主据此渲染时间线、驱动状态机。完整联合类型（`types.ts`）：

### 内容事件

| kind | 关键字段 | 用途与约定 |
|---|---|---|
| `message` | `text`, `phase: delta/completed`, `messageId` | 助手回复。流式发 `delta`，宿主按 `messageId` 聚合；结束时发一条 `completed`（`text` 为空表示"用已聚合的 delta"） |
| `thinking` | 同 `message` | 思考/推理过程，UI 单独展示 |
| `tool` | `name`, `phase: started/completed`, `input`, `output`, `success`, `fileDiff` | 工具调用。`fileDiff`（`{operation, path, before, after}`）让 UI 渲染内联差异 |
| `command` | `command`, `phase`, `exitCode`, `output` | CLI 执行的 shell 命令 |
| `file` | `path`, `changeType`, `additions`, `deletions`, `diff` | 文件变更通知 |
| `artifact` | `artifactType: image/file`, `name`, `mimeType`, `data/path` | 产物（生成的图片、文件） |

### 会话与状态事件

| kind | 用途与约定 |
|---|---|
| `session` | 上报 `providerSessionId`。**要支持续聊（resume）就必须发**，宿主保存它并在 `resume` 时回传 |
| `status` | `turn_started` / `turn_completed` / `turn_failed`，驱动运行状态机 |
| `usage` | token 用量。`contextUsed` / `contextWindow` 驱动 UI 的上下文占用指示器 |
| `commands` | 斜杠命令目录，运行开始时上报一次，见下文 |
| `raw` | 未归一化的 stdout/stderr 原文，用于诊断 |
| `exit` | 进程退出（`exitCode` / `signal`） |
| `error` | 运行期错误 |
| `timeout` | `reason: timeout / idle / max_output`，配合 ProcessHandle 的限制触发 |

### `commands` 事件与 providerCommand

`commands` 是插件暴露斜杠命令的通道：在运行开始时上报一次，宿主转成该 Provider 的 `/` 指令目录。只上报插件确实能无头执行的命令。

命令项可声明 `providerCommand: "compact"`：用户执行该指令时，宿主把 `providerCommand` 放进 `start`/`resume` 请求，适配器应改用**专用传输**而不是把 `/compact` 当聊天文本发送。例如 OpenCode 插件走 server 的 `POST /session/:id/summarize`。这类指令要求会话已有 `providerSessionId`（即先跑过至少一轮）。

### `subagentDispatchId`

所有内容类事件都可带 `subagentDispatchId`：标记 Provider 原生子代理产生的活动（Claude 的 `parent_tool_use_id`、OpenCode 子会话的 task part、Codex 的 collab 工具调用）。主代理自己的活动不带。宿主用它把子代理活动折叠到对应的 dispatch 节点下。

## AdapterRun 与 ProcessHandle

```ts
interface AdapterRun {
  readonly process: ProcessHandle;
  readonly events: AsyncIterable<AdapterEvent>;
  cancel(): Promise<void>;
  steer?(input: string): Promise<void>;  // 运行中追加输入（steering）
  write(input: string): void;            // 写子进程 stdin
}
```

`ProcessHandle` 是对子进程的最低封装（模板里的 `PluginProcessHandle` 是一个 60 行的完整参考实现）：

```ts
interface ProcessHandle {
  readonly pid?: number;
  readonly events: AsyncIterable<ProcessEvent>;  // stdout/stderr/exit/error/timeout
  readonly child: ChildProcessWithoutNullStreams;
  write(input: string): void;
  cancel(): Promise<void>;
  wait(): Promise<{ exitCode: number | null; signal?: string }>;
}
```

实现要点：

- `events` 用"队列 + 等待者"模式把 `child.stdout/stderr` 的 data 回调转成 async iterable（模板代码可直接抄）；
- `cancel()` 发 `SIGTERM` 并等待退出；
- 落实 `timeoutMs` / `idleTimeoutMs` / `maxOutputBytes`：超时或输出超限就 kill 进程并发出对应的 `timeout` 事件（OpenCode 插件的 `PluginProcessHandle` 演示了完整实现，默认输出上限 20MB）；
- 非交互式运行时记得 `child.stdin.end()`，避免 CLI 空等输入。

## 进阶能力

### 结构化输出（structuredOutput）

`capabilities.structuredOutput = true` 且 `supportsStructuredOutput = true` 时，宿主可能通过 `request.outputSchemaPath` 传入 JSON Schema 文件，要求 CLI 按 schema 产出最终结果。

### 用户交互（requestInteraction）

CLI 运行中需要向用户提问（结构化选择题、计划确认、权限确认）时，调用 `request.requestInteraction(input)` 并**阻塞等待**返回的 `InteractionResponse`。`input` 可携带 `kind`、`title`、`detail`、`questions`、`options`、`plan`。回调不存在时应回退到适配器原来的自动应答行为。OpenCode 插件演示了完整桥接：`run --format json` 明确拒绝交互请求，所以它改用 server API，把 `question.asked` 桥给 Nautilo 再通过 HTTP 回复。

### 运行时工具（runtimeTools / executeRuntimeTool）

宿主会为会话注入运行时工具（目前主要是**任务委派**，团队编排的核心）。`runtimeTools` 是工具规格（name/description/inputSchema），适配器应把它们以 CLI 原生方式注册给模型；模型调用这些工具时，适配器把调用转发给 `executeRuntimeTool(call)` 并把 `RuntimeToolResult` 回传给 CLI。

### MCP servers

`request.mcpServers` 是用户为该 Provider 启用的 MCP server 列表（stdio/http 两种 transport），适配器在会话启动时按 CLI 的原生方式注入。

### Steering

CLI 支持在一轮运行中追加输入时，实现 `AdapterRun.steer(input)`，UI 的"即时引导"功能会用到。

## 覆盖内置 Provider

插件 `id` 允许与内置 Provider（codex / kimi-code / claude-code / custom）相同：加载后插件适配器**替换**内置实现；禁用或卸载时，内置适配器自动恢复。可以用这个机制独立发布某个 Provider 的升级版支持。

两个真实参考：

- `packages/provider-plugin-opencode/`（约 1200 行）：完全没有内置实现，插件是唯一接入方式。演示了 server 进程复用（避免每轮冷启动）、超时/空闲/输出上限控制、Windows `.cmd` shim 解析、`models --verbose` 模型发现、`compact` 专用传输、`commands` 上报。
- `packages/provider-plugin-trae/`（约 950 行）：同一适配器按二进制探测结果在两种传输间切换——官方 `traecli` 走 ACP JSON-RPC，开源 `trae-agent` 走纯文本 `run`；演示了 ACP 权限桥接、`session/load` 恢复与 `usage_update` 上报。

## 生命周期与信任模型

- **插件 = 任意本机代码**。安装（市场或本地目录）必须经过用户显式确认；不做自动更新。只安装可信来源的插件。
- **安装**：本地安装 = 校验清单 → 复制目录（跳过符号链接）→ 加载；市场安装 = 下载 tarball → 校验 SHA-256 → 系统 `tar` 解压 → 定位清单（允许包一层顶层目录，如 npm pack 的 `package/`）→ 走本地安装流程。
- **启用/禁用**：即时生效。禁用 = 在插件目录写入 `.disabled` 标记文件并卸载适配器；启用 = 移除标记并重新加载。运行中的会话不受影响。
- **失败隔离**：单个插件加载失败不会阻塞 daemon——状态在市场页标记为「加载失败」并附错误原因，其他插件正常工作。
- **卸载**：移除目录；若插件曾覆盖内置 Provider，内置适配器自动恢复。
- **重载**：重新安装同 id 插件时以 cache-buster 重新 import，新代码立即生效。

## 插件市场（registry）

市场数据来自官方 registry 仓库 [zhufish-aa/nautilo-provider-registry](https://github.com/zhufish-aa/nautilo-provider-registry) 里的 `registry.json`（raw 地址 `https://raw.githubusercontent.com/zhufish-aa/nautilo-provider-registry/main/registry.json`，可用环境变量 `AGENTHUB_PLUGIN_REGISTRY` 覆盖）：

```json
{
  "plugins": [{
    "id": "my-cli",
    "name": "My CLI",
    "version": "0.1.0",
    "vendor": "ACME",
    "description": { "zh-CN": "……", "en-US": "……" },
    "tarball": "https://github.com/acme/nautilo-provider-my-cli/releases/download/v0.1.0/plugin.tgz",
    "sha256": "<tarball 的 sha256，十六进制小写>",
    "minAppVersion": "0.1.0"
  }]
}
```

上架 = 向 [registry 仓库](https://github.com/zhufish-aa/nautilo-provider-registry)提 PR：官方插件把 `.tgz` 放进 PR 的 `packages/` 目录（raw URL 直接可下载），第三方插件把 tar 球托管在自己仓库的 Release 里；条目需带 `sha256`（缺失会跳过校验，不建议）。详细流程和自检清单见 registry 仓库的 README 与 PR 模板。

## 调试与常见问题

**插件显示「加载失败」？**
市场页会附错误原因。按出现频率排查：

1. `插件 API 版本不兼容` — 清单 `apiVersion` 与宿主 `PROVIDER_API_VERSION`（当前 1）不一致；
2. `descriptor.providerId 必须与插件 id 一致` / `适配器 providerId 与插件 id 不一致` — 三处（清单 `id`、`descriptor.providerId`、适配器类 `providerId`）必须完全相同；
3. `插件入口缺少默认导出的工厂函数` — 入口没有 `export default factory`，或构建产物不是 ESM；
4. 运行时依赖没打包 — 编译产物里出现了对宿主的运行时 import，或 `node_modules` 是符号链接（安装时被跳过）。

**检测页一直显示未安装？**
`detect()` 里实际执行的命令是 `instance.executable || descriptor.defaultExecutable`。在实例编辑器里确认可执行路径；并保证 `detect` 不 reject——未安装要返回 `{ installed: false, error }`。

**会话发出去了但没有流式输出？**
检查 `message` 事件是否带稳定的 `messageId` 且 `phase: "delta"`，结束时是否补了 `phase: "completed"`。宿主按 `messageId` 聚合 delta，缺 `completed` 会导致消息一直处于"进行中"。

**resume 不生效？**
确认三点：`start` 时发出过 `session` 事件上报 `providerSessionId`；`supportsResume` 和 `capabilities.nativeResume` 都为 true；`resume()` 里真正使用了 `request.providerSessionId`。

**如何本地迭代？**
改代码 → `pnpm --filter <你的包> build` → 应用内重新从本地目录安装（会覆盖 `~/.agenthub/plugins/<id>/` 并热重载，无需重启应用）。
