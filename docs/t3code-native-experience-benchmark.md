# T3 Code 原生体验对标与实施记录

更新：2026-11-18。参考 T3 Code 固定提交 `86d8838e91b81d328fd8ced042860c7c60160dcd`，实现使用 Nautilo 自己的代码。

目标是完整、连续地使用各 Harness。下表区分已经实现的机制、验证范围和剩余工作；不能把“插件已加载”或能力标签当成完整验收。

### Magpie 账号模型源码移植（2026-11-18）

按用户要求，当前 Electron + Rust 的 Codex、Claude Code、OpenCode 和 Antigravity 账号模型路径改用 Magpie 对应代码移植/复制。没有打包 Magpie 应用或独立 Go 网关。OpenCode 已改为直接 HTTP 推理，Claude/Antigravity 采用 Magpie 本身的原生 CLI/MCP 方案；外层 Harness 原生资源与会话保持原有职责。源码对应、许可证、精确验证范围与未通过项见 [Magpie 账号模型代码移植](magpie-account-ports.md)。

真实 Codex → DeepSeek Harness、Antigravity → DeepSeek Harness 和 OpenCode 登录账号直接 HTTP 的预期回复检查通过。DeepSeek 的完整 OpenCode 免费模型请求仍返回 429；相同请求在原版 Magpie 对照也返回 429，不能判作已验收或直接断言账号用量耗尽。Claude 暂无已保存订阅账号，尚无本次真实订阅推理结论。

DeepSeek Harness 同会话切换账号时，后台从新连接的已启用模型或账号目录解析默认模型，并把实际模型记入本轮运行。会话内的临时路由通过原生模型选择写入该会话，不保存为 DeepSeek 的全局默认。使用隔离的 Nautilo 和 DeepSeek 数据目录，以本机已登录的 Codex 账号完成一轮，从同一会话切换到反重力并清空模型字段，`gemini-3.8-flash` 读取重建的前轮文本并返回预期内容。两轮保持同一个 Nautilo 会话，按现有的账号切换流程重建原生会话；未改用户的会话记录或原生配置。

桌面端的模型菜单可以为下一条消息选择账号或 API。正在运行和已排队的请求保持原连接；下一条发送时才提交新选择，无需单独确认框。若保存新连接失败，草稿与选择都保留。本地账号网关以同一个环回地址接收各 Harness 的模型请求，按每个绑定的本地凭据解析到固定的账号和修订。

验证：本地网关测试在同一地址并行调用两个账号绑定，验证身份隔离及拒绝未授权请求；桌面流程测试覆盖运行中预选、草稿保留、失败重试和原聊天发送。使用隔离的真实 DeepSeek Harness，同一聊天依次调用本地 Chat 测试 API、已登录的反重力 `gemini-3.8-flash`、已登录的 Codex `gpt-6.2-sol`，三轮完成，Gemini 回答包含第一轮的测试内容。该验证不覆盖 OpenCode 免费服务限制或所有 Harness 与账号组合。

手机的新建与修改会话请求使用同一份账号网关能力判断，不再拒绝桌面已支持的反重力与 OpenCode 跨 Harness 绑定。配对后的加密远程协议测试验证 DeepSeek 使用四类账号新建会话，以及现有 DeepSeek 会话切到反重力；Gateway 只启用用户选择的跨 Harness 账号，普通原生登录仍走原生路径。该夹具使用模拟业务路由，不调用真实模型、不替代 Android 真机验证。

移动端 0.1.24 把真实 `run.failed` 事件显示在所属轮次。此前 OpenCode 免费端点在输出前返回 429，Android 因没有正文或可见过程而移除了整轮结果。定向测试覆盖无输出失败、连续两轮失败与重新打开历史；APK 通过发布构建及签名验证。此修复只补齐失败展示，OpenCode 对 DeepSeek 完整请求的 429 仍来自上游。

### OpenCode 登录与旧 CLI 中转的历史记录（2026-11-17）

下列记录描述 11-17 的实现及测试。当前 Rust 模型推理已由上面的 11-18 代码移植替换；这些旧 CLI 中转的成功结果不代表当前直接 HTTP 路径的验收。

- 在“供应商与账号 → 登录账号 → 添加账号 → OpenCode”走与 Codex / Claude Code 相同的独立账号添加流程。使用已核实的 OpenCode 1.19.5 `console login` 原生浏览器设备授权；每个账号分配私有目录，原生凭据/会话写入其 `data/opencode`，原生状态写入 `state/opencode`，不手填 API Key、不复制其他账号凭据。保持原生配置目录、插件、Skills、MCP 和配置优先级；明确清除会覆盖所选账号的 `OPENCODE_AUTH_CONTENT` / `OPENCODE_API_KEY`。旧的无目录共享连接保留原有含义，不自动更换账号。
- 原生 Console 登录可能在拒绝/过期时仍退出 0。必须同时观察到账号已由 CLI 持久化的成功输出及正常退出，才进入保存连接步骤；窗口/浏览器打开或 CLI 检测成功都不等于登录成功。取消和保存失败沿用原有目录锁定及恢复流程。尚未代用户完成真实浏览器授权；拒绝、过期、分段输出、正常退出和保存门禁由夹具验证。
- 开启“用于其他 Harness”后，沿用本机会话绑定的模型中转端点；真正的模型请求仍由原生 OpenCode 执行。浏览器/编程工具调用通过现有中转交付调用方并等待真实结果，保留原生会话编号、流式输出及后续轮次。不会把免费模型改为直接访问官方通用 API，也不会因缺少 API Key 拒绝原生免费模型。
- 模型发现使用所选原生环境，发布 `opencode/*`（含免费模型）与 `opencode-go/*`，保留原生定价元数据。明确绑定原生账号时不生成自定义 `nautilo` API provider，不改写原生模型命名空间，不关闭原生功能。
- 所选 OpenCode 原生模型的能力元数据随请求传给外层 Harness，保留连接的显式覆盖，修复 DeepSeek 因缺少推理档位元数据拒绝 Low / High / Max 的问题。网关地址表示选定账号；流式或非流式标题、正文、并发请求、重试、压缩后的历史和变更工具集分别匹配原生工作会话。历史与上次实际回答匹配时才恢复对应原生 ID；未匹配时处理独立模型请求，不再以 `NATIVE_CONVERSATION_DIVERGED` / `NATIVE_TOOLS_CHANGED` 拒绝外层 Harness。新请求保留传入的消息角色与历史工具结果，不能称为原生恢复。外层 Harness 的原生会话仍独立持久化，标题生成不关闭。
- 验证包括：Rust / Node 独立账号隔离、原生配置保留、显式跨 Harness 路由；OpenCode HTTP/SSE 两轮会话与原生命名空间；Node 工具往返/流式/禁用路由和标题与正文交错；桌面 Console 登录、取消与保存恢复。实际 OpenCode 1.19.5 在无凭据临时目录发现免费模型；Node 参考中转调用 `opencode/big-pickle` 取得 HTTP 200；真实 Codex → Rust 中转 → 独立目录的真实 OpenCode 调用 `opencode/deepseek-v4.1-flash-free`（Max）取得预期文本，显式原生 smoke 测试通过。
- DeepSeek 真实调用复现了流式标题先行导致的 `NATIVE_CONVERSATION_DIVERGED`；不再用“非流式且无工具”猜测标题用途。请求级匹配回归包含标题与工具往返、上下文改写、同输入重试的不同回答分支、并发、失败后重试、重启恢复和首 token 前断开连接；Node 16 项及 Rust 8 项通过。Rust 的两项真实上游检查默认忽略，不能计入这 8 项。
- DeepSeek 临时连接绑定直接合并 Nautilo 所属路由到原生已验证的 volatile 配置，并走原生路由注册通知；不经过会重新套用用户配置的 `Entry.update`，不另注册整套内建供应商目录，不写用户原始配置。真实 DeepSeek 0.2.1-rc.3 + 模拟上游验证多轮、切连接后恢复同一原生会话、工具/图片/PTC、取消、超时、并发与目录授权闭环通过（30 个本地模型请求）。另外显式运行真实 DeepSeek → Rust → 当前选中的真实 Codex 账号，`gpt-6.1-sol` / Low 返回预期文本，无连接绑定错误；该检查使用隔离的外层会话目录和真实选定账号，不复制登录凭据。
- 本次未重复消耗 OpenCode 免费模型额度：先前实际服务已返回免费用量上限，DeepSeek → OpenCode 免费模型的正文生成验收仍未记为通过。Codex Chat 兼容层仅暴露受控错误码/额度提示，任意上游正文仍不直接反射；上游 SSE 错误转为 `response.failed`，不伪装为完成或只断开连接。不能据此宣称所有模型、外层 Harness、CLI 版本与完整交互均已验收。
- 已核实 Magpie 固定提交 `4a1ac84421145de4c4078898c6441487ac45bd5e`：其 [OpenCode 客户端](https://github.com/yetone/magpie/blob/4a1ac84421145de4c4078898c6441487ac45bd5e/internal/provider/opencode_client.go) 直接构造 HTTP 请求及免费模型所需的客户端请求格式；[Claude 订阅桥](https://github.com/yetone/magpie/blob/4a1ac84421145de4c4078898c6441487ac45bd5e/internal/gateway/claude_subscription.go) 通过原生 CLI/MCP 工具暂停、匹配多个运行，并支持新建/恢复等路径。Nautilo 的 Codex 文件凭据路径是直接模型请求；本次 OpenCode 仍经选定账号的原生 CLI，请求级会话匹配借鉴 Claude 桥接的原则。尚未实现 Magpie 的 OpenCode 直连客户端，也不声明任意 API 参数均能经原生 CLI 等价传输。
- 扩大 Node 回归时，`runtime-connections.test.mjs` 的两项已有 Codex 检查仍失败：`codex_home` 残留和登录状态测试夹具。移除新增 OpenCode 分支后复测仍同样失败，与本次 OpenCode 路由无关，未将该测试文件记为全通过。
- DeepSeek 插件现有 8 项单元检查中 5 项通过、3 项在旧模拟夹具缺少 `workspaceRegistry.create` 时失败；现有 HEAD 的生产桥已经依赖该服务，本次连接绑定改动在这些无连接夹具中不会执行。没有将该文件记为全通过，也未改动旧夹具。上述真实 DeepSeek CLI + 本地上游及真实 Codex 账号检查独立执行通过。
- 更新开发预览时还修复了网络初始化拖住本地启动的问题：本地 IPC 就绪后，远程发现仍在同一服务/路由上异步初始化，未关闭远程功能。以现有用户数据重新启动 Electron + Rust，主窗口和本地 IPC 均已就绪；不代表外部网络连接已完成验收。

## 本批已实现

| 范围 | 实现 | 验证 |
|---|---|---|
| Pi / Oh My Pi 原生 UI | confirm/select/input/editor 双向桥接；原生 request ID；空字符串、缩进、多行和用户取消保持原义；超时和迟到取消不会留下悬空对话框 | SDK 往返测试；两个实际安装 CLI 的隔离扩展探测；前端 DOM 提交与取消测试 |
| 扩展状态 | notify/status/widget/title 进入统一事件；状态按原生 key 替换；实时修改编辑器仅应用一次，历史重放不覆盖用户草稿；open_url 为可点击入口 | 状态折叠、草稿防重放、输入框内容测试 |
| Claude / Pi / Oh My Pi / Kimi ACP | 会话级复用；单轮结束保持进程及所需配置/代理资源；回调重新绑定当前轮；按实际原生会话 ID 复用；超时后丢弃失效进程并原生恢复 | 确定性协议夹具验证连续两轮同 PID、超时、恢复；Pi/OMP 额外验证原生命令结束帧 |
| Codex / OpenCode / DeepSeek | 保留已有常驻路径；补充运行时连接证据。OpenCode 启动串行化、死进程检测和配置身份纳入缓存键 | Rust 构建；既有 Codex 原生协议测试；本机能力接口读取。没有将这些检查当成所有真实模型的性能实测 |
| 原生命令 | 移除 Claude/Kimi 固定命令清单过滤；Pi get_commands、OMP get_available_commands 动态发现；Pi 扩展命令无 agent_settled 时按原生空闲状态结束；OMP 的提前 ACK 不再冒充完成 | 实际 CLI 探测加夹具；普通模型轮仍按原生终止事件收尾 |
| 真正终端 | Rust portable-pty、前端 xterm；输入、resize、游标增量、输出背压、断开面板后重连；有界滚屏；终端、原生 CLI 与日志共用单行工具栏；拖动/键盘调整高度、记忆高度、最大化/还原；独立终端配色 | Windows ConPTY 实际输入、resize、重连；字节游标、保留上限测试；前端 DOM 验证调整大小和配色不重启原生进程 |
| 终端多标签 | 普通终端具有会话内独立身份、进程和输出；新建、切换、重命名、关闭及键盘操作；切换标签和收起面板保留屏幕及进程。停止保留输出，关闭移除该标签所有旧进程记录；恢复已退出标签不重启进程，离线标签需要显式重连。原生 CLI 继续保持每会话一个入口，并保留历史同步 | 3 项 Rust PTY/游标检查、2 项 Node 对照检查、8 项实际 DOM 检查，包含关闭未完成启动、会话切换、退出输出恢复、原生终端单实例与键盘焦点；DOM 未跳过。使用本地 shell 和夹具，无模型生成请求。旧版后台仍有终端工作时保留旧入口，新后台启动后启用多标签 |
| 源码管理主流程 | 项目与会话使用真实工作目录；文件复选框选择提交，半选保留部分内容，支持逐块/逐行暂存与取消暂存。Monaco 完整代码高亮、统一/并排差异、可调宽面板。提交记录可选中并展开文件和历史版本，支持首次提交、重命名、二进制和首父合并差异。初始化、分支、原生独立拉取/推送目标、仅快进拉取与合并完成保留 | 14 项 Rust、17 项 Node 和 24 项 DOM/编辑器检查通过；末次统计与交互修改后补充定向检查。真实 Rust 后台经独立认证 IPC 检查完整代码版本、暂存、提交、提交详情、历史差异与 worktree。未对开发仓库执行暂存/提交或真实远程推送；界面依据两张用户要求的 ImageGen 设计稿实现，视觉还原由用户验收 |
| 文本与文件冲突编辑 | 读取原生共同祖先、ours/theirs 和工作目录；独立保存/暂存、采用完整版本或删除，核对文件版本与原生属性；保留 BOM/CRLF、符号链接模式、其他已暂存文件，返回部分保存结果。草稿恢复、外部修改后的核对、采用版本撤销/重做与文件消失后的复制恢复；沿用既定 Git 界面 | 新增 6 项 Rust、9 项 Node 和 11 项编辑/草稿/状态提示/编辑器交互检查，相关桌面合计 35 项；原生 Git 本地夹具覆盖二进制、删除、模式、过滤器失败、外部竞争写入、目录链接和较大文件。编辑能力由后台单独声明，不以配置标签冒充可用能力 |
| DeepSeek PTC 展示 | 原生 `tool/ptc-dispatch-start` 和 `tool/ptc-dispatch` 更新同一代码批次；按真实调用 ID 和父 ID 展示工具；保留代码说明、命令、读写路径、后台任务状态；子 Agent 中的 PTC 同样保留；根工具结束不覆盖已收集的子调用 | Rust 原生事件与大代码持久化检查；前端主会话及子 Agent 增量合并、完成重放和 DOM 展示检查；实际安装的 DSH CLI 配合本地模拟接口验证 3 个内部工具调用。本阶段未调用真实模型 API |
| 原生 CLI 交接 | Codex、Claude、Kimi、Pi、OMP、OpenCode、Command Code 使用当前会话、选定账号/API、工作目录及模型参数；OpenCode 保留共享 server 与原生任务，其余路径按适配器释放对应实例；同一会话的聊天和原生终端排他写入。用户打开已配置 CLI 时直接进入，不再增加 Nautilo 启动审批，原生 CLI 的工具确认保持原样 | 各路径编译、本机 capability/插件握手读取；Rust 原生终端启动回归检查验证审批策略下仍不创建宿主审批。尚未逐个真实账号完成 TUI 往返验收，不扩大这一验证范围 |
| 停止 | 独立 run.cancelled 事件；先解除原生交互等待，再中断进程；迟到 error/timeout 不覆盖取消状态；流中已有主回复保存，时间线显示“已停止” | 停止时有部分文本和未回答对话框的流程测试；保留最终回复、过程折叠和滚动跟随测试 |
| 能力证据 | agent.runtimeCapabilities 返回版本化契约；原生握手与运行时连接信息分开记录，包含 transport/reused/pid/attachMs；新旧插件用握手确定原生终端入口 | 本机新版后台与六个插件读取成功；attachMs 只描述连接阶段，不冒充首字或完整回复延迟 |
| TS 历史宿主 | 同步事件/交互契约和停止修复，补 shell PTY 输入/resize/重连与能力查询 | TS 构建、隔离 PTY 服务测试。原生 CLI 交接目前以 Rust 主线为准，历史宿主不显示未实现的入口 |
| Pi / Oh My Pi / Claude 会话后台事件 | 主轮结束后保留后台读取、原生扩展交互与宿主工具；同一读取块的终止帧后续字节和跨轮半帧不丢失；按原生调用/消息 ID 保留来源轮次；后台错误不重写已完成主轮状态 | 三个 CLI 协议夹具覆盖主轮结束、同块尾部、迟到工具/子 Agent、扩展确认、下一轮同 PID；Rust wire/持久化与前端订阅测试；本行验证范围仅为这三个 Harness |
| DeepSeek 会话后台事件 | 保留原生读取器和解析状态；主轮完成后切换会话通道；子会话始终归属创建它的轮次；后台审批、提问和宿主工具继续往返，原生取消/进程退出撤销等待；删除会话释放运行环境 | 真实 `bridge.mjs` 加确定性原生事件源验证迟到消息、审批与宿主工具、旧子 Agent 在下一轮发消息、同 PID 复用、取消、删除；四个缓存会话均保留。未使用真实模型 API 验证所有 DeepSeek 模式 |
| Kimi ACP 会话后台事件 | 空闲时继续消费 ACP 更新并轮询原生子 Agent 文件；保留工具名称、分段编号和文件位置；审批异步等待；跨轮先交付已排队及未完成帧；新进程使用独立消息编号空间；增量工具输出作为更新事件 | 原生 ACP 夹具验证同块尾部、迟到工具、审批等待不阻塞其他事件、跨轮回答审批、同 PID 和消息 ID、延迟出现的子 Agent 目录；JSON-RPC 分帧交接测试。结论不适用于单次 stream-json 的 API/自定义包装器路径 |
| Codex 会话后台事件与回收 | app-server 使用独立的常驻读取器；旧子线程、消息和审批保留来源轮次，提问不阻塞配置/恢复 RPC；原生撤销或退出会取消等待；超时先原生中断，可恢复时保留进程。取消固定空闲时间回收；用户设置进程上限时，先检查子 Agent、交互与原生后台终端，有工作或无法确认状态时继续排队 | 35 项 Codex 协议夹具覆盖跨轮子 Agent、审批与宿主工具、原生请求撤销、取消、超时后继续、恢复、压缩和容量等待；能力契约只对 app-server 声明会话后台事件。没有调用真实模型 API 验证所有安装版本 |
| OpenCode 会话后台事件与安全释放 | 同一配置/目录的 server 共用一个常驻 `/event` 读取器；按原生 user/message/part ID 和 task 元数据关联父子会话；保留跨轮文本前缀及旧调用归属。提问、计划审批和权限独立等待，原生撤销会关闭宿主请求。停止和超时对目标主会话及其所属子会话调用 `/session/<id>/abort`，不结束其他会话的 server；释放最后一个会话前核对原生状态、问题、权限和 PTY。原生终端有独立租约，使用过 TUI 的 server 保留至插件卸载，避免误杀未能完整追踪的原生后台工作 | 29 项 OpenCode 检查包含 HTTP/SSE 协议夹具、单次 CLI 取消、原生终端交接/交互恢复、历史规范化，以及实际 OpenCode 1.19.5 的隔离接口检查；实际 CLI 检查显式执行，验证建会话、`noReply` 消息 ID、历史读回、abort 与安全释放，不调用模型生成。另有 2 项 SDK 能力契约及 1 项历史契约检查；自定义 `baseArgs` 的单次进程路径不声明会话后台事件。未将这些检查当成真实账号/模型、所有版本或完整 TUI 往返验收 |
| 后台消息交接 | 后台帧等待主轮队列写完后再按序写入；子 Agent 未完成的文本缓冲随原生消息编号交接；进程退出保存已显示的后台部分文本，不把子 Agent 回复写入主聊天历史 | 4 项 Rust 持久化检查覆盖交接抢先到达、跨通道消息身份、前缀保留、进程退出和账号变更；6 项通用 RPC 检查覆盖请求取消、进程退出及半帧交接 |
| 后台事件显示与资源释放 | 普通会话和团队会话在显示期间继续接收事件；团队使用各会话独立游标；迟到后台更新放回原轮次；取消反向调用时撤销等待问题；删除会话释放原生资源 | 事件订阅、轮次归属、消息身份、流状态和取消测试；没有新增界面样式 |
| 开发预览版本一致性 | `pnpm dev:desktop` 将本次 Rust 核心及六个原生插件放入同一个独立预览目录，调试后台从该目录加载可执行文件；沿用用户已安装插件的启停状态 | 调试构建及启动进程路径检查；正式构建不启用开发目录覆盖 |

本批没有更换登录账号、删除原生配置或工作区，也没有新增默认禁用 Apps/插件/MCP/Skills 的参数。原生资源合并实现继续保留。

### OpenCode 后台通道验证（2026-11-07）

实现入口为 `rust/plugins/opencode/src/main.rs` 与 `runtime.rs`；夹具为 `tests/fixtures/opencode-server.mjs`，测试在插件的 `src/tests.rs`。共享能力契约在 `rust/plugin-sdk/src/capabilities.rs`。

- 常规检查：在 `rust/` 目录运行 `cargo test -p agenthub-plugin-opencode`。需要可用的 Node；可用 `NAUTILO_TEST_NODE` 指定绝对路径。常规命令会明确忽略需要实际 CLI 的一项检查。
- 原生接口检查：将 `NAUTILO_TEST_OPENCODE` 指向实际 `opencode.exe` 后，在 `rust/` 运行 `cargo test -p agenthub-plugin-opencode installed_opencode_server -- --ignored`。测试使用独立 XDG 数据/配置/缓存目录和 `noReply`，不使用用户的模型 API。本阶段已显式执行通过；不能将常规命令中的忽略计为通过。
- 覆盖主轮完成后的同块尾部、跨轮 UTF-8 半帧、并行/嵌套和复用子会话、迟到主消息、撤销发生在子会话元数据之前、审批往返、停止范围、整体/空闲/输出限制、启动中取消/卸载、进程退出、断流恢复、共享 server 释放和原生终端租约。
- SSE 断开会显式结束受影响的前台轮次并中断其所属原生会话；成功中断后可从原生持久会话恢复。原生 abort 或活动状态无法确认时保留 server，拒绝未经确认的恢复/回收；不把断流伪装成无损续传。显式卸载会释放读取器、等待请求及本插件启动的进程。
- `OPENCODE_CONFIG*` 与 XDG 目录按原生环境透传，Nautilo 管理的 MCP 继续按归属合并；不删除原生会话历史。终端中新输入的历史导回见下节，其他 Harness 的导入不套用 OpenCode 结论。

### OpenCode 原生终端返回（2026-11-07）

- 终端使用同一 server 和原生 session。常驻 SSE 持续保存消息与子任务归属；TUI 打开期间由原生终端处理提问和权限，退出后重新读取尚未答复的主、子会话请求并交回 Nautilo，不因交接调用原生 abort。
- 使用 `/session/<id>/message` 的原生 user/message/part ID 对账。交接前保存指纹；新消息按 ID 导入，已绑定消息的原生编辑更新同一行，相同文本的不同 ID 保持为不同消息。没有精确 ID 映射的旧消息发生编辑时保留待重试状态，不按文本猜测身份。
- 消息、工具/思考/用量、附件引用、原生轮次映射和同步检查点一起提交。重复同步保持幂等；读回前后核对选定连接、账号环境、目录和原生 session。原生历史尚忙或读取失败时保留资源和重试入口，继续聊天等待同步完成。完整轮次按原生完成标记收尾，未确认完成的输出保留并明确标记失败。
- 原生终端中新增的助理消息、工具和子 Agent 保留原生 turn/call ID；实时 SSE 与终端返回导入复用同一条本地消息和轮次。子 Agent 消息不进入主聊天历史。
- 工具栏显示“同步历史中”“同步待重试”“已同步”及不支持同步的真实状态，重试不重启 CLI。原有字体、配色选择、大小调整和终端进程复用保持一致。缺失或远程附件显示原生会话查看提示；内联附件写入应用数据目录并保留内容版本。
- 10 项 Rust 对账检查、2 项 PTY 检查、19 项前端历史/终端检查全部通过，DOM 未跳过；另有 1 项后台插件通道检查。OpenCode 29 项检查也显式包含 1.19.5 隔离的 `noReply`/历史读回接口。不调用用户模型生成，也不将这些检查视为真实账号下的完整 TUI 往返验收。原生接口依据 [OpenCode Server API](https://opencode.ai/docs/server)。

### 原生 CLI 持续同步与插件边界（2026-11-07 后续）

- 按用户确认，Codex、Claude Code、Kimi Code 保留内置接入，不进行插件化搬迁。六个插件式 harness 的能力声明放在各自的 `native_experience.rs`；SDK 按通用条件选择声明，主程序不再按插件名称猜测历史读取能力。历史可读和流式消息 ID 稳定分别声明，避免新插件的重复编号覆盖旧消息。完整契约见 [Provider 插件开发指南](provider-plugins.md)。
- 当前 Codex 原生消息缺口单独修复：使用同一账号的独立 app-server 读取器调用 `thread/read`、`thread/turns/list`，不通过 resume/start/interrupt 接管正在运行的 TUI。保留真实 thread/turn/item ID，分页读回用户输入、回答、思考、工具与附件引用。接口依据 [Codex app-server](https://learn.chatgpt.com/docs/app-server)；离线协议夹具检查读取方法和进程复用。
- OpenCode 延用原生 HTTP/SSE；Pi、OMP、Command Code 的历史查找、树分支、内容和状态解析放进各自 `history.rs`。SDK 只提供限定目录查找、完整 JSONL 记录读取等通用 I/O。格式依据 [Pi Session File Format](https://pi.dev/docs/latest/session-format)、[OMP 会话存储](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md)、[Command Code Sessions](https://commandcode.ai/docs/sessions)。这些文件读取实现只显示原生 CLI 已持久化的内容，不伪造未落盘的流式 token。
- 通用宿主同步在原生终端运行期间持续工作，抽屉收起后也不停止。原始终端读写与历史 RPC 分离；用户输入和未完成回答可以导入，完成、取消、失败保持原生状态。仅在终端退出、尾部读完并完成对账后释放资源和恢复聊天交互。旧的 unsupported 检查点可升级补回交接后的消息；旧指纹只增加生命周期元数据时不误判为原生文本编辑。
- 消息、轮次和会话提交前进行版本核对，原生新事件抢先落盘时让旧快照重读，不覆盖新输出。相同文本仍按原生 ID 区分，重复同步和部分回答更新不重复计数。已完成 17 项核心历史检查、3 项 Codex 只读历史/完成状态夹具、10 项插件/SDK 历史检查、1 项通用插件能力契约检查和 21 项前端历史/终端检查；DOM 未跳过。共享包与桌面两侧类型检查通过。未调用用户模型生成。

- Codex 外部 TUI 的未结束 rollout 会被独立 app-server 暂时重建为 interrupted；这不能作为用户取消的证据。回读现结合选定账号目录内、原生 thread ID 校验过的 task_started / task_complete / turn_aborted 记录区分运行、完成和取消。界面仅采用同一轮最新的终态，较早临时停止标记不再覆盖后来的完成记录。显示修复已热更新；回读修复在确认原生 CLI 退出后重新加载，没有中断用户正在使用的 CLI。
- 已对旧会话按原始账号连接/版本、首次原生绑定轮次、配置时间和原生文件的 thread/cwd 逐项核对，备份并修复旧检查点；原生回读实际补回 3 条消息，同步状态已完成，没有发送模型测试消息。

## 仍需实现或完成验收

- **各 Harness 的后台事件与回收验收**：Pi/OMP/Claude、Kimi ACP、DeepSeek、Codex app-server 及 OpenCode HTTP/SSE 已接会话后台通道。OpenCode 的实际接口检查覆盖 1.19.5；真实账号/模型和原生 TUI 完整往返仍待逐项验收。共享 SessionPool、DeepSeek 和 Codex 已取消按固定空闲时间直接关闭进程；Codex 在显式容量限制下还会查询原生后台终端。不能据此声称所有运行环境都已安全回收，上述实现也不替代各安装版本与真实账号下的完整验收。
- **原生界面历史对账的剩余项**：OpenCode、Codex 及 Pi/OMP/Command Code 的上述读取路径已接入；原生撤销、分支、删除、首次空白 TUI 的原生身份建立，以及 daemon 崩溃后子会话历史和未完成前缀的完整恢复仍待建设/验收。Trae 尚未声明可靠的终端/历史读取；内置 Claude/Kimi 的历史读取不在本次插件调整内。不能把拼接提示词作为原生恢复的替代。
- **官方开源 trae-agent**：继续使用其真实一次性运行和历史桥接；未核实常驻协议或交互终端接口前，不虚构支持。Command Code 的结构化接口同样仍按原生单次进程运行。
- **TRAE 企业版 CLI**：已用官方企业分发包 Windows `0.216.0-tob` 验证 `acp serve`、`--acp`、命名配置档与未登录提示。Rust 后端的离线验收覆盖启动回退、代理变量、模型和推理选项、允许与拒绝的选项映射、取消待审批请求、同一原生会话续聊和回复持久化。
- **企业环境验收**：先在公司终端使用实际二进制运行 `traecli login status`，从同一用户环境启动 Nautilo。将 Trae Harness 的可执行文件设为公司安装的 CLI，全局参数按需填写公司使用的 `--profile` 等选项，新对话选「原生配置」。用公司允许的测试仓库验证首轮模型回复、同一会话续聊、审批、取消后续聊和已配置的企业 MCP。模型列表、企业 SSO、专属域及网络策略最终由实机验收。当前适配仍按轮启动 ACP 并通过原生会话 ID 恢复。常驻后台任务、ACP 表单提问及原生终端和历史同步尚待接入。参见 [TRAE CLI 2.0 登录](https://docs.trae.cn/cli_get-started-with-trae-cli-2)、[ACP 参数](https://docs.trae.cn/cli_agent-client-protocol) 和 [代理环境变量](https://docs.trae.cn/cli_environment-variables)。
- **Kimi API /自定义包装器**：当前安装版本下仍使用可用的单次结构化路径；ACP 常驻结论只适用于支持该登录/配置方式的路径。
- **逐 CLI 真实往返**：七个原生终端方案还需逐个在当前选定账号下验证进入、原生操作、退出、继续聊天。当前没有使用用户模型 API 批量发测试请求。
- **源码管理剩余项**：stash、原生 rebase/cherry-pick 等操作的继续/中止、未跟踪文件的可恢复清理、PR 工作流及真实远程认证验收仍待补齐；子模块与目录/文件类型冲突使用原生终端。源码管理主流程的本地检查不能替代这些工作，也不代表所有 Git 配置和版本已完整兼容。
- **T3 的其他产品功能**：跨设备访问与设备配对、移动通知、便携交接/导出导入/会话迁移、分享与访客访问、语音输入，以及其余 Provider（ACP、Muse、Kiro、FX、Antigravity）的接入仍需逐项建设和验收。它们没有因为上述改动就自动完成，不能宣称已全面对齐或超越 T3 Code。

用户明确排除 **DeepSeek 原生 Web 界面交接**；继续保留其结构化聊天、动态模式、原生配置和会话能力。这项排除不影响其他已授权工作的范围。

## 验收原则

2026-11-12 修复 DeepSeek Harness 恢复会话后的回复归属：原生 `attemptId` 仅在单个 Agent 生命周期内唯一，恢复同一原生会话时计数可重置。传输现在为每个 Agent 实例分配独立命名空间，同实例的流式、完成和迟到事件保持一致身份，避免新回复被 daemon 识别为已停止运行的后台消息。历史展示仅恢复同时满足“旧原生进程已关闭、新 DeepSeek 前台轮正在运行、旧版临时消息编号、非子 Agent”的错误记录，不改写追加式事件日志。已验证连续三轮、停止后恢复及旧后台/子 Agent 不串轮；用实际受影响会话的只读记录确认三条回复能回到对应轮次，未将此检查扩大为全部 Harness 的原生验收。

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

## Magpie 参考改造：第一阶段（2026-11-12）

参考 `yetone/magpie` 提交 `873b4987e97328071d4aeabd21996a3a8fcfab24` 的连接管理、MCP 检测及分组界面思路，独立实现了以下内容：

- `connection.diagnose` 绑定所选连接和配置版本，只读取实际服务返回的模型目录，不把手动配置的模型数当作远端返回，不发送推理请求。目录接口缺失、认证失败、空目录分别报告；不自动切换账号。
- `capability.diagnose` 复用运行时 MCP 配置映射，实际完成 STDIO 或 HTTP 初始化、工具列表分页和本次诊断会话清理。HTTP 支持 JSON/SSE，设置单步及总体超时、响应大小和分页上限；错误和工具描述中的凭据脱敏。
- 供应商与账号、MCP 列表显示配置归属与独立检测结果。结果按配置版本暂存，切换页面不触发后台探测；重新检测由用户点击。选中项采用弹性过渡，详情在原位展开，检测期间提供呼吸反馈，保留应用和系统的减少动态效果设置。

检测通过仅表示本次目录或 MCP 握手通过，不能代替每个 Harness 的原生工具注入、OAuth 和真实交互验收。原生配置事务化合并、同步冲突与回滚、完整延迟跟踪、按用途分配工具连接等后续工作尚未在这一阶段完成。

定向验证覆盖 Rust 的 4 项握手/SSE/分页/清理测试、TS daemon 的 6 项协议及错误测试、前端的 2 项缓存/重试测试，并完成 TS 构建及桌面类型检查。没有使用真实账号运行模型推理，也未自动操作应用做视觉验收。

## 本机安装

当前开发预览通过 `pnpm dev:desktop` 使用同次构建的 Electron + Rust，运行文件放在配置的 Cargo target 下 `nautilo-preview/<启动时间>/`。插件启停仍由用户数据目录管理，开发可执行文件从同次预览的 `plugins/` 加载；不覆盖正在加载的 exe 或用户配置。修改后台后需重新启动开发预览，已有窗口继续使用它启动时的独立运行目录。

2026-11-07 这台 Windows 电脑的项目位于 `D:/Nautilo/`，Node、Git、pnpm、Rust、MinGW、OpenCode 1.19.5、构建缓存及应用数据位于 `D:/NautiloEnv/`。`Start-Nautilo.cmd` 使用 `NAUTILO_USER_DATA_DIR=D:/NautiloEnv/data`，Electron 的会话缓存、崩溃文件和日志也显式使用该 D 盘目录；原有数据继续使用同一物理目录。本机 `.nautilo-dev.local.json` 只记录本机路径，仍由 Git 忽略。原电脑交接中的 `D:/CodexBuildCache/Nautilo/backups/native-experience-20261106-201444` 属于原电脑，不能据此假设新电脑存在该备份。

本机额外安装官方 `@openai/codex` 0.167.0 至 `D:/NautiloEnv/codex/`，保留 Windows 原生二进制、搜索/沙箱辅助工具和相邻资源目录，稳定入口为 `D:/NautiloEnv/codex/native/bin/codex.exe`。D 盘 Codex、OpenCode 和 Node 目录已加入 Windows 用户级 PATH，并通知环境变量更新；原用户 PATH 保存在 `D:/NautiloEnv/setup/user-path-before-codex.json`。运行中的 Nautilo 实例通过 `agent.upsert` 将 Codex 可执行文件改为该绝对路径，原连接、账号目录、模型和原生会话 ID 沿用原值。验证版本与实际恢复命令参数的 `resume --help`，未发起模型生成；尚未将此检查称为真实账号的完整 TUI 往返。

2026-11-06 阶段完成过 Rust workspace 构建、TS 构建、桌面类型检查、Electron/Tauri renderer 构建及对应测试。2026-11-07 的常驻 SSE 和终端对账分别执行适合其改动范围的检查；终端对账包含实际 DOM 流程，未把跳过当通过，也未自动打开界面做视觉检查。

本机 8 GiB 内存下并行运行 Rust workspace 与 Electron 生产构建触发过 Windows 提交内存不足。改为串行构建、`CARGO_BUILD_JOBS=1`，本机通过 `NAUTILO_BUILD_SOURCEMAP=0` 关闭构建 source map 后，Rust core/六个插件、TS 构建、桌面类型检查和 Electron 前端生产构建均通过。环境开关只影响构建产物，未调整界面样式；默认构建仍保留 source map。后续构建继续使用 D 盘环境脚本，避免重复触发高并发内存峰值。

## T3 Code 参考文件（固定提交）

- [ProviderAdapterV2 会话及操作契约](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/packages/provider-core/src/server/ProviderAdapter.ts)
- [分层能力与身份协议](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/packages/contracts/src/orchestrationV2.ts)
- [Claude 原生 SDK 适配](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts)
- [Pi 交互与常驻 RPC 适配](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/packages/provider-pi/src/server/adapter.ts)
- [Pi 能力及限制说明](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/docs/user/providers-pi.md)
- [Codex 启动参数](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/apps/server/src/provider/codexLaunchArgs.ts)
- [消息发送](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/apps/web/src/components/chat/useComposerSend.ts)
- [滚动跟随与位置管理](https://github.com/pingdotgg/t3code/blob/86d8838e91b81d328fd8ced042860c7c60160dcd/apps/web/src/components/chat/useTimelineFollow.ts)
