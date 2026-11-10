# Harness 参数与事件接入修复

日期：2026-11-05。主线为 Tauri / Rust；本地正在使用的开发窗口是 Electron + Rust 后端，共用同一份 renderer。

## 当前结果

范围补充（2026-11-06）：本记录仅覆盖下文列出的参数与事件修复，不能作为全部 Harness 原生能力已完整接入的证明。后续源码对标确认仍有会话生命周期、Pi/OMP 扩展交互和原生终端入口等缺口，详见 [T3 Code 原生体验对标](t3code-native-experience-benchmark.md)。

上轮审计记录中的接入遗漏已继续落实到代码。本轮覆盖参数、附件、工具进度、原生子 Agent、用量、连续对话、异常结束和自定义启动程序；没有新增禁用原生 Apps、MCP、Skills、扩展或会话持久化的开关。

## 本轮完成

| 范围 | 已修复的行为 |
| --- | --- |
| Command Code 的 `os error 3` | 实际定位到 `~/.commandcode/skills/ego-browser` 的失效 Windows Junction。合并资源时跳过失效链接，继续加载有效资源，保留用户原始链接；其他路径错误带出具体位置。此修复已先单独构建并重新加载 Command Code 插件。 |
| Pi / Oh My Pi / OpenCode 用量 | 保留最新请求的上下文占用，同时生成单轮累计用量；同一原生请求 / part 的重复快照替换旧值，不重复累加；子会话单独累计；未知缓存字段保持未知。 |
| Pi / Oh My Pi 工具进度 | 接入 `tool_execution_update`，通过统一 `tool.updated` / `command.updated` 事件更新原来的记录。执行中不标成完成，也不新增重复行；迟到进度不覆盖完成结果。 |
| Oh My Pi 原生子 Agent | 主动订阅原生 `set_subagent_subscription: events`，接入生命周期、消息、推理和工具活动，保持父调用关联；子会话状态和用量不污染主会话。 |
| Pi 子 Agent 扩展 | 对接随 Pi 分发的官方示例扩展 `partialResult.details.results[].messages`；展开文本、推理和工具记录，按快照去重；识别单任务、并行任务与串行链的委派元数据。 |
| Claude 图片 | 使用原生 `--input-format stream-json` 用户消息发送文本与 base64 图片，图片不放进命令行参数。 |
| Kimi / Trae ACP 图片 | 发送 ACP image content blocks。图片读取失败明确返回错误。 |
| Kimi prompt / Command Code 图片 | 这两个 CLI 的当前文本入口没有结构化图片参数，改为验证图片并把绝对路径加入原生会话，交由它们的原生文件 / 图片读取工具查看；不再丢弃附件。 |
| Trae 开源连续对话 | 在 Nautilo 管理的会话目录保存原生 provider 消息历史，下一轮恢复；保留已完成的工具调用与回执；不重放没有回执的结束控制调用或中断调用。 |
| Trae 开源执行事件 | 在调用进程内桥接已安装的原生 Python CLI，回传 Anthropic / OpenAI 兼容客户端的流式文本、推理、工具开始 / 结束和用量；不修改原生安装文件。 |
| Trae 开源推理与图片 | 传递选中的 effort；给原生 provider 请求加入结构化图片。旧版 Anthropic SDK 通过 `extra_body` 传递 effort，避免因 SDK 方法签名较旧而丢失参数。 |
| Trae 取消 | 登记并终止实际子进程；启动阶段取消也会阻止后续留下孤立进程；退出清理不会只更新界面状态。 |
| Kimi / Trae ACP 参数 | 根据模型切换响应刷新 configOptions；旧版使用已声明的 `session/set_model`；只有确已由协议桥绑定的参数才跳过重复设置。无法应用的选择返回具体错误。 |
| Claude 自定义启动参数 | 自定义程序 / 参数前缀仍经过统一启动路径，保留模型、effort、权限、图片、MCP 和原生 JSONL / 包装器 JSONL 解析。 |
| Codex / Kimi / OpenCode 自定义参数 | 选中的参数仍会传入；保留无关用户配置，替换冲突的单值选项，不因为存在 baseArgs 就整组跳过。OpenCode 续聊使用同一组设置，CLI 附件使用原生 `--file`。 |
| Codex 可执行文件 | npm 快捷入口解析仅适用于 `codex` 本身，不再把配置的 `node` 或其他包装程序替换成 PATH 中的另一份 Codex。 |
| 输出 Schema | Codex app-server 的 `turn/start.outputSchema`、exec / resume 的 schema 参数与 Claude 的 `--json-schema` 已接通。 |
| Custom CLI | 提供 `{model}`、`{reasoningEffort}`、`{permissionMode}`、`{serviceTier}`、`{contextWindow}`、`{outputSchemaPath}`、`{localImagePaths}` 等参数模板，同时通过 `NAUTILO_INPUT_JSON` 和对应环境变量提供请求参数，供自定义程序消费。 |
| 输出结束帧 | 通用进程适配器及 OpenCode CLI 路径在 exit 之前解析没有尾换行的最后一帧，不再当作普通日志或放到退出之后。 |

## 上轮修复继续保留

- Codex 动态工具 `contentItems`、显式失败与 MCP 错误标识。
- Kimi 工具发起与回执的原生 call ID。
- OpenCode 独立 delta 事件、part 身份、先到 delta 的类型归属，以及子会话标识不覆盖主会话。
- Pi / Oh My Pi 附件读取错误不再静默吞掉，OpenCode 图片 MIME 与文件 URL 修正。
- Trae 连接配置只覆盖所需字段，保留其他 Agent、模型、供应商与原生资源。
- Command Code 尾帧与用量范围修正。
- 插件 SDK 断流、取消和结束事件收尾。

## 支持方式与边界

- 接入层只能展示上游实际返回的推理内容，不生成虚假的推理文本。
- Pi 自定义扩展没有统一的子 Agent 协议。本轮支持已核实的官方示例扩展结构，其他扩展仍可通过正常工具输出展示；不能承诺任意第三方私有字段都自动映射成子 Agent 树。
- Trae 连续对话桥接验证使用当前安装的官方开源 `trae-agent 0.1.0`，对接其 Anthropic / OpenAI 兼容客户端。不能将这一结论等同于所有未来版本、所有私有分支均已实测。
- `serviceTier` 等仅在部分原生工具中存在的参数按其实际接口传递；不向其他 CLI 添加不存在的开关。
- `contextWindow` 是模型配置与上下文预算信息，并不意味着可以扩大上游模型的实际上下文限制。
- Custom CLI 收到参数模板 / 环境字段后，仍由用户配置的程序决定如何使用；不存在能够猜中所有命令行程序私有协议的通用转换。
- 图片通过原生读取工具传入的路径与结构化图片输入在报告中明确区分，不能把“发了文件路径”说成“发送了图片内容块”。

## 验证

- TS 相关测试合计 106 项通过，包含参数、事件、原生配置合并、插件续聊、图片、用量和子 Agent 投影。
- Rust 适配器测试 75 项通过。该组共享进程池测试采用串行执行；并行运行曾出现一次配置退休测试等待，单项复测和整组串行执行均通过。
- Rust 插件 / SDK 20 项通过；新增 Pi 子 Agent 解析同时经过编译及对应 TS 协议夹具验证。
- 真实 Trae CLI + 本地模拟 Anthropic SSE 接口验证通过：两轮对话、原生只读工具、历史与回执恢复、图片输入、`max` effort、文本 / 推理增量和用量。没有使用用户的上游 API 凭证。
- TS 构建、桌面类型检查、Tauri renderer 构建、Rust workspace 构建通过。
- 使用的构建缓存位于 `D:/CodexBuildCache/Nautilo`，没有清理用户会话、项目、原生配置或活跃 worktree。
- 已更新本机安装的五个 Rust 插件并重新启动桌面开发实例，当前使用新构建的 Rust core；启动后 IPC 与插件列表读取正常。插件原有启停状态保留。

## 主要代码入口

- `rust/nautilo-core/src/adapters/` 与 `packages/core-daemon/src/adapters/`：内建 Harness、图片、参数和进程事件。
- `rust/plugins/{pi,omp,opencode,commandcode,trae}/`：原生插件。
- `rust/plugin-sdk/src/{native_config,images,usage,process,serve}.rs`：资源、附件、用量、进程和结束状态。
- `packages/provider-plugin-trae/resources/sitecustomize.py`：仅当前 Trae 进程加载的桥接。
- `packages/provider-plugin-trae/test/native_bridge_smoke.py`：真实 CLI 的无付费接口验证。
- `packages/event-protocol/src/index.ts`、Rust / TS run service、renderer 的 `orchestration-runtime.ts` / `subagent-activities.ts`：执行中工具记录的增量投影。


## 2026-11-06 原生体验实施

本轮补充扩展 UI 往返、Claude/Pi/OMP/Kimi ACP 会话复用、原生命令发现、真实 PTY、原生终端交接、运行时能力证据与正常取消流程。当前完整状态及验证边界见 [T3 Code 实施记录](t3code-native-experience-benchmark.md)。

仍需完成空闲后台事件实时转发、原生终端新增消息的历史对账、DeepSeek Web UI 交接与逐 CLI 真实终端往返；不以插件加载或编译结果代替这些验收。T3 其他产品功能也单独列入对标记录，尚未宣称全面完成。
