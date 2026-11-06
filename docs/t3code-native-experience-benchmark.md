# T3 Code 原生体验对标与实施记录

更新：2026-11-06。参考 T3 Code 固定提交 `86d8838e91b81d328fd8ced042860c7c60160dcd`，实现使用 Nautilo 自己的代码。

目标是完整、连续地使用各 Harness。下表区分已经实现的机制、验证范围和剩余工作；不能把“插件已加载”或能力标签当成完整验收。

## 本批已实现

| 范围 | 实现 | 验证 |
|---|---|---|
| Pi / Oh My Pi 原生 UI | confirm/select/input/editor 双向桥接；原生 request ID；空字符串、缩进、多行和用户取消保持原义；超时和迟到取消不会留下悬空对话框 | SDK 往返测试；两个实际安装 CLI 的隔离扩展探测；前端 DOM 提交与取消测试 |
| 扩展状态 | notify/status/widget/title 进入统一事件；状态按原生 key 替换；实时修改编辑器仅应用一次，历史重放不覆盖用户草稿；open_url 为可点击入口 | 状态折叠、草稿防重放、输入框内容测试 |
| Claude / Pi / Oh My Pi / Kimi ACP | 会话级复用；单轮结束保持进程及所需配置/代理资源；回调重新绑定当前轮；按实际原生会话 ID 复用；超时后丢弃失效进程并原生恢复 | 确定性协议夹具验证连续两轮同 PID、超时、恢复；Pi/OMP 额外验证原生命令结束帧 |
| Codex / OpenCode / DeepSeek | 保留已有常驻路径；补充运行时连接证据。OpenCode 启动串行化、死进程检测和配置身份纳入缓存键 | Rust 构建；既有 Codex 原生协议测试；本机能力接口读取。没有将这些检查当成所有真实模型的性能实测 |
| 原生命令 | 移除 Claude/Kimi 固定命令清单过滤；Pi get_commands、OMP get_available_commands 动态发现；Pi 扩展命令无 agent_settled 时按原生空闲状态结束；OMP 的提前 ACK 不再冒充完成 | 实际 CLI 探测加夹具；普通模型轮仍按原生终止事件收尾 |
| 真正终端 | Rust portable-pty、前端 xterm；输入、resize、游标增量、输出背压、断开面板后重连；有界滚屏；终端、原生 CLI 与日志共用单行工具栏；拖动/键盘调整高度、记忆高度、最大化/还原；独立终端配色 | Windows ConPTY 实际输入、resize、重连；字节游标、保留上限测试；前端 DOM 验证调整大小和配色不重启原生进程 |
| DeepSeek PTC 展示 | 原生 `tool/ptc-dispatch-start` 和 `tool/ptc-dispatch` 更新同一代码批次；按真实调用 ID 和父 ID 展示工具；保留代码说明、命令、读写路径、后台任务状态；子 Agent 中的 PTC 同样保留；根工具结束不覆盖已收集的子调用 | Rust 原生事件与大代码持久化检查；前端主会话及子 Agent 增量合并、完成重放和 DOM 展示检查；实际安装的 DSH CLI 配合本地模拟接口验证 3 个内部工具调用。本阶段未调用真实模型 API |
| 原生 CLI 交接 | Codex、Claude、Kimi、Pi、OMP、OpenCode、Command Code 使用当前会话、选定账号/API、工作目录及模型参数；交接前释放对应常驻实例；同一会话的聊天和原生终端排他写入；保留命令策略 | 各路径编译、本机 capability/插件握手读取。尚未逐个真实账号完成 TUI 往返验收，不扩大这一验证范围 |
| 停止 | 独立 run.cancelled 事件；先解除原生交互等待，再中断进程；迟到 error/timeout 不覆盖取消状态；流中已有主回复保存，时间线显示“已停止” | 停止时有部分文本和未回答对话框的流程测试；保留最终回复、过程折叠和滚动跟随测试 |
| 能力证据 | agent.runtimeCapabilities 返回版本化契约；原生握手与运行时连接信息分开记录，包含 transport/reused/pid/attachMs；新旧插件用握手确定原生终端入口 | 本机新版后台与六个插件读取成功；attachMs 只描述连接阶段，不冒充首字或完整回复延迟 |
| TS 历史宿主 | 同步事件/交互契约和停止修复，补 shell PTY 输入/resize/重连与能力查询 | TS 构建、隔离 PTY 服务测试。原生 CLI 交接目前以 Rust 主线为准，历史宿主不显示未实现的入口 |
| Pi / Oh My Pi / Claude 会话后台事件 | 主轮结束后保留后台读取、原生扩展交互与宿主工具；同一读取块的终止帧后续字节和跨轮半帧不丢失；按原生调用/消息 ID 保留来源轮次；后台错误不重写已完成主轮状态 | 三个 CLI 协议夹具覆盖主轮结束、同块尾部、迟到工具/子 Agent、扩展确认、下一轮同 PID；Rust wire/持久化与前端订阅测试；本行验证范围仅为这三个 Harness |
| DeepSeek 会话后台事件 | 保留原生读取器和解析状态；主轮完成后切换会话通道；子会话始终归属创建它的轮次；后台审批、提问和宿主工具继续往返，原生取消/进程退出撤销等待；删除会话释放运行环境 | 真实 `bridge.mjs` 加确定性原生事件源验证迟到消息、审批与宿主工具、旧子 Agent 在下一轮发消息、同 PID 复用、取消、删除；四个缓存会话均保留。未使用真实模型 API 验证所有 DeepSeek 模式 |
| Kimi ACP 会话后台事件 | 空闲时继续消费 ACP 更新并轮询原生子 Agent 文件；保留工具名称、分段编号和文件位置；审批异步等待；跨轮先交付已排队及未完成帧；新进程使用独立消息编号空间；增量工具输出作为更新事件 | 原生 ACP 夹具验证同块尾部、迟到工具、审批等待不阻塞其他事件、跨轮回答审批、同 PID 和消息 ID、延迟出现的子 Agent 目录；JSON-RPC 分帧交接测试。结论不适用于单次 stream-json 的 API/自定义包装器路径 |
| Codex 会话后台事件与回收 | app-server 使用独立的常驻读取器；旧子线程、消息和审批保留来源轮次，提问不阻塞配置/恢复 RPC；原生撤销或退出会取消等待；超时先原生中断，可恢复时保留进程。取消固定空闲时间回收；用户设置进程上限时，先检查子 Agent、交互与原生后台终端，有工作或无法确认状态时继续排队 | 35 项 Codex 协议夹具覆盖跨轮子 Agent、审批与宿主工具、原生请求撤销、取消、超时后继续、恢复、压缩和容量等待；能力契约只对 app-server 声明会话后台事件。没有调用真实模型 API 验证所有安装版本 |
| 后台消息交接 | 后台帧等待主轮队列写完后再按序写入；子 Agent 未完成的文本缓冲随原生消息编号交接；进程退出保存已显示的后台部分文本，不把子 Agent 回复写入主聊天历史 | 4 项 Rust 持久化检查覆盖交接抢先到达、跨通道消息身份、前缀保留、进程退出和账号变更；6 项通用 RPC 检查覆盖请求取消、进程退出及半帧交接 |
| 后台事件显示与资源释放 | 普通会话和团队会话在显示期间继续接收事件；团队使用各会话独立游标；迟到后台更新放回原轮次；取消反向调用时撤销等待问题；删除会话释放原生资源 | 事件订阅、轮次归属、消息身份、流状态和取消测试；没有新增界面样式 |
| 开发预览版本一致性 | `pnpm dev:desktop` 将本次 Rust 核心及六个原生插件放入同一个独立预览目录，调试后台从该目录加载可执行文件；沿用用户已安装插件的启停状态 | 调试构建及启动进程路径检查；正式构建不启用开发目录覆盖 |

本批没有更换登录账号、删除原生配置或工作区，也没有新增默认禁用 Apps/插件/MCP/Skills 的参数。原生资源合并实现继续保留。

## 仍需实现或完成验收

- **其余 Harness 的后台事件与回收**：Pi/OMP/Claude、Kimi ACP、DeepSeek、Codex app-server 已接会话后台通道；OpenCode 的持续 SSE、子会话交互和共享服务器回收仍需落实。共享 SessionPool、DeepSeek 和 Codex 已取消按固定空闲时间直接关闭进程；Codex 在显式容量限制下还会查询原生后台终端。不能据此声称所有运行环境都已安全回收，上述实现也不替代各安装版本与真实账号下的完整验收。
- **原生界面返回后的历史对账**：交接恢复同一原生会话，但在原生终端中新输入的消息尚未统一导回 Nautilo 时间线；不同 Harness 的历史导入需要按原生 ID 去重，不能把拼接提示词作为替代。
- **官方开源 trae-agent**：继续使用其真实一次性运行和历史桥接；未核实常驻协议或交互终端接口前，不虚构支持。Command Code 的结构化接口同样仍按原生单次进程运行。
- **Kimi API /自定义包装器**：当前安装版本下仍使用可用的单次结构化路径；ACP 常驻结论只适用于支持该登录/配置方式的路径。
- **逐 CLI 真实往返**：七个原生终端方案还需逐个在当前选定账号下验证进入、原生操作、退出、继续聊天。当前没有使用用户模型 API 批量发测试请求。
- **T3 的其他产品功能**：终端多标签、完整源码管理工作流、跨设备访问与设备配对、移动通知、便携交接/导出导入/会话迁移、分享与访客访问、语音输入，以及其余 Provider（ACP、Muse、Kiro、FX、Antigravity）的接入仍需逐项建设和验收。它们没有因为上述改动就自动完成，不能宣称已全面对齐或超越 T3 Code。

用户明确排除 **DeepSeek 原生 Web 界面交接**；继续保留其结构化聊天、动态模式、原生配置和会话能力。这项排除不影响其他已授权工作的范围。

## 验收原则

按同一 CLI 版本、同一账号/连接、同一模型和模式、同一目录比较原生与 Nautilo：

1. 首轮、连续第二轮、切换会话、重启后原生恢复。
2. 发送立即显示，流式、提交、重放保持消息身份与 DOM 稳定。
3. 原生工具、Apps、MCP、Skills、扩展与 Nautilo 管理资源都保留。
4. 用户交互完整往返；拒绝、取消、原生超时、退出均能收尾。
5. 工具并发、PTC、原生子 Agent、团队委派、后台工作和上下文压缩正确归属。
6. 停止、超时、断流后可继续，已显示内容不丢失。
7. 配置/启动原因可追溯；分别测量冷启动、复用连接、首事件和完整回复。
8. 回收只结束已确认可回收的运行环境，不删除原生历史或用户资源。
9. 原生界面入口需实际可操作；未完成的映射必须登记，不能用一个“支持”标签掩盖。

## 本机安装

当前开发预览通过 `pnpm dev:desktop` 使用本次构建的 Electron + Rust，运行文件放在配置的 Cargo target 下 `nautilo-preview/<启动时间>/`。插件启停仍由用户数据目录管理，开发可执行文件从同次预览的 `plugins/` 加载；不覆盖正在加载的 exe 或用户配置。早期安装备份仍位于 `D:/CodexBuildCache/Nautilo/backups/native-experience-20261106-201444`。

已完成 Rust workspace 构建、TS 构建、桌面类型检查、Electron/Tauri renderer 构建，以及上述对应测试。按用户要求未打开界面进行视觉检查。

## T3 Code 参考文件（固定提交）

- [ProviderAdapterV2 会话及操作契约](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/packages/provider-core/src/server/ProviderAdapter.ts)
- [分层能力与身份协议](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/packages/contracts/src/orchestrationV2.ts)
- [Claude 原生 SDK 适配](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts)
- [Pi 交互与常驻 RPC 适配](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/packages/provider-pi/src/server/adapter.ts)
- [Pi 能力及限制说明](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/docs/user/providers-pi.md)
- [Codex 启动参数](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/apps/server/src/provider/codexLaunchArgs.ts)
- [消息发送](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/apps/web/src/components/chat/useComposerSend.ts)
- [滚动跟随与位置管理](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/apps/web/src/components/chat/useTimelineFollow.ts)
