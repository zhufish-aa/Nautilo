# AgentHub Provider 插件模板

把任意 agent CLI 包装成 AgentHub Provider 的最小可用示例。

## 结构

```
agenthub-plugin.json   # 插件清单：id、apiVersion、入口、展示元数据（descriptor）
src/index.ts           # 适配器实现（AgentCliAdapter 接口）
dist/index.js          # 构建产物，清单 main 指向它
```

## 开发

```bash
pnpm install
pnpm --filter @agenthub/provider-plugin-template build
```

## 接入你自己的 CLI

1. 复制本目录，修改 `agenthub-plugin.json`：
   - `id`：全局唯一的小写短横线 id，同时是 providerId；
   - `descriptor`：名称、厂商、能力标签、默认可执行文件名、凭证环境变量、权限模式等（渲染端完全靠它展示，无需改 AgentHub 代码）。
2. 改 `src/index.ts`：
   - `providerId` 改为同样的 id；
   - `detect()`：探测 CLI 是否安装/兼容；
   - `start()`：把 CLI 的输出协议（纯文本 / JSONL / ACP…）翻译成 `AdapterEvent` 流；
   - 需要续聊就实现 `resume()` 并把 `supportsResume` / `capabilities.nativeResume` 置真。
3. `pnpm --filter <你的包> build`。

## 安装到 AgentHub

- 应用内：插件市场页 → 从本地目录安装，选择本目录；
- 或手动：把整个目录复制到 `~/.agenthub/plugins/<id>/`，重启应用。

## 注意

- 插件是**任意本机代码**，只安装可信来源的插件；
- `apiVersion` 必须与宿主的 `PROVIDER_API_VERSION`（当前为 1）一致；
- SDK 只做类型导入，编译产物自包含、运行时不依赖宿主；
- 插件特有配置放进实例的 `providerOptions`（自由 JSON），不需要改 schema。
