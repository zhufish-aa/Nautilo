# Browser MCP 与空间窗口实现状态

更新：2026-11-10。依据用户提供的 `nautilo-ego-lite-design/DESIGN.md`、`schemas/` 与 `ISSUES.md`。

当前入口仍是 Electron + React + 独立 Rust 后端。WebContents、浏览器输入和 CDP 属于 Electron 桌面层；Rust 提供会话运行与按会话认证的 MCP 注入。没有切换 Tauri，没有关闭 Harness 的 Apps、插件、Skills、MCP 或原生持久化。

## 本轮问题清单

| 原问题 | 实现与验证 |
|---|---|
| `timeoutMs` / `timeout_ms` 不一致 | 顶层和步骤递归接受两种写法；同一参数两种写法冲突时明确 `INVALID_FIELD`，不静默选择。其他已发布的 tab/space/view/控制等待别名一并归一化。 |
| expect 命中后返回第一次采样 | 顶层与批量 eval 都返回命中时的实际值，包含 `attempts`、`elapsed_ms`；首次命中为 1。 |
| `target.nth` 被忽略 | CSS、XPath、role/name、文本定位使用零基索引，支持负数从后取；越界报未找到。文件输入可显式定位隐藏 input。 |
| MCP 内联 favicon | 模型侧所有结果剔除 favicon，桌面标签栏的图标不受影响。 |
| 阻塞 eval 只返回 `Internal error` | 实测原始 6 秒忙等脚本、500 ms 超时，修正 Chromium 在 V8 中止时返回的泛化错误；携带操作、超时分类、时限、耗时和 renderer_alive。严格 v2 为 `OPERATION_TIMEOUT`。 |
| 登录态 | 保留 Nautilo 的持久化浏览器 profile；增加登录交接与按用户选择站点的本地 CDP Cookie 导入。导入不读取源 profile 文件，不返回 Cookie 值，也不宣称导入等于服务端验证通过。 |
| A5 控制权 | 按 11-10 用户新要求，普通鼠标移动、点击、滚动和键盘输入均不自动接管；只有接管按钮才返回 paused、takeover_button 和剩余步骤。用户控制时读取继续，写入等待交还。 |

## 单窗口与空间

- 浏览器只有一个系统主窗口，窗口总览和各空间网页在此窗口切换。每个空间保留自己的标签列表、选中页、导航、缩放与控制状态。
- 点总览卡片从卡片位置放大进入；返回时沿原路径缩回。240 ms、transform/opacity，过渡期间使用真实网页预览，完成时交接原生 WebContentsView。键盘切换即时执行，尊重减少动态效果设置。
- 切换空间、打开总览、聚焦窗口不接管、不停止后台批次。过期的旧空间布局回调不能把网页重新盖到当前空间上。
- 第一次浏览器工具调用会自动打开浏览器，已有窗口复用。关闭浏览器主窗口停止当时正在执行的请求与 Agent 下载；下一次工具调用会重新自动打开，不要求用户先开窗或交还控制。关闭单个标签不停止其他空间。停靠工作台是明确交接，不等于取消任务。
- 再打开总览保留空间、标签和登录态。总览也算打开的浏览器窗口。关窗暂停可由下一次工具调用或用户打开动作解除；关闭时的旧请求独立取消，即使马上打开也不能复活旧批次。单独点击“接管”或“停止”产生的状态保留。
- 名称、选中标签、历史网页、缩略图与停止状态可跨进程恢复。Agent 可创建具名子空间；名字冲突明确返回 SESSION_CONFLICT，MCP 不能跨会话访问其他空间。
- 右上角四宫格打开总览，Alt+S 在访问过的空间间切换。顶部保留浏览器标签与窗口控件、地址栏、导航、接管和停靠菜单。
- 接管条、蓝边与指针跟随浏览器任务，不跟随每次工具调用：第一次浏览器操作绑定本轮 run，调用间隔保持控制；journal 的 run.completed / failed / cancelled、显式 finish / handoff / 接管 / 停止结束任务指示。Rust 和 TS daemon 都通过同一紧凑生命周期包通知 Electron，不传输模型文本。没有浏览器操作的普通 Harness 运行不会点亮指示。

## 工具与事件

- 保留既有工具，提供 browser_eval、browser_assert、browser_wait、browser_session、browser_files、browser_dialog、browser_cdp、browser_fetch、browser_paste、browser_events。initialize、browser_state、browser_session list 发布当前版本及能力清单，用法见 [浏览器工具补充用法](usage.md)。
- popup 回执包含 tab_id/label/url；expect.popup、follow 跟随新页；原标签上的等待若发现新页，返回 NAVIGATED_TO_NEW_TAB，说明原点击已成功，不能重放。
- 上传通过真实文件输入/文件选择器；下载按来源标签归属记录，可保存到显式绝对路径，保存不覆盖现有文件。
- alert/confirm/prompt/beforeunload 支持查看、一次性规则和用户回应。没有规则时不自动接受。Electron 33 覆盖了 window.prompt，因此通过受限本地协议恢复同步 prompt 的原生返回语义；不向网页开放桌面 preload。
- CDP 仅作用于选定页面；Browser/Target/全局 profile 操作不能绕过会话归属。
- 等待支持 load_state、network_idle_ms、指定事件和文件选择器；事件环有边界、游标可增量读取。
- 快照支持结构化 refs、节点分页、root、view_id。短 ref 可省略 @。完整导航使旧 ref 失效；同 URL 下节点替换只有在稳定定位、可访问身份及 root 一致时才重绑定，并返回 ref_rebound。
- 分级超时：探测 3 秒、读取 10 秒、动作 15 秒、导航 30 秒，可显式覆盖。两次探测失败后，仅对未被用户编辑的 Agent 页面中止卡住脚本并重载一次；不重放原动作，也不重载等待用户对话框/文件选择的页面。
- finish({keep}) 保护用户创建/编辑、恢复历史及指定保留标签。handoff 后必须由用户交还控制。

## 回执与兼容

默认 contract_version=1 保留已发布的 camelCase / snake_case 返回字段，不破坏旧客户端。显式 contract_version=2 使用 `receipt-v2.schema.json`：严格顶层结构、统一大写错误码、业务扩展集中到 data。initialize 元数据公开支持版本。测试验证实际成功和失败回执均符合 v2 schema。

动作回执与验证仍分开：没有断言时 verified=false；失败带步骤 ID、完成/失败/跳过状态、executed_steps、remaining_steps、错误和恢复建议。已派发动作不会在超时、协议重连或断言失败后自动重放。

聊天中的 browser_* 调用使用专门的浏览器与指针图标，折叠行显示实际动作和对象；展开显示逐步结果及验证状态，原始数据可按需查看。通过统一工具名识别适配各 Harness 的命名空间，不要求每个适配器重复实现 UI。

## 验证证据与范围

- 桌面主进程、preload 与 renderer 类型检查。
- `test/browser-runtime.test.mjs`：真实 Electron 的参数/断言/nth/ref 契约，上传、下载保存、prompt、事件、登录态导入、控制权、全部关闭停止、单系统窗口的独立空间及跨进程恢复。
- 同一回归制造真实 `while(true)` 渲染线程卡死，确认 RENDERER_UNRESPONSIVE、recovered=true、仅重载一次，后续读取恢复；不只模拟一个函数失败。
- 原浏览器回归 30 次批次全部完成，Cookie 重启持久化/退出登录、已删除会话不复活继续覆盖。
- `test/browser-display.test.mjs`：实际 React 渲染浏览器活动组件，覆盖常见 Harness 名称前缀，避免 isBrowserTool 缺失导致整页崩溃。
- 可选 `NAUTILO_BROWSER_LIVE=1` 运行 `test/browser-live.test.mjs`。2026-11-09/10 实测使用 Nautilo MCP 完成百度搜索 bilibili、结果新标签、B站热门 21 条视频链接、打开视频；断言 paused=false、currentTime 0.009445 → 0.454702，含收尾共 10 次 MCP 调用。这是单轮样本，不是全部网站稳定性承诺。第一次测试的链接文本过滤遗漏图片链接，修正测试定位后复跑通过。
- Rust 与 TS Git 回归：原生 Git 的 `? doop/` 嵌套仓库记录不能误报越界；目录预览可读，真正的 ../、绝对路径、.git 和重复斜杠仍被拒绝。没有删除或改写嵌套仓库。

## 已知边界

- 登录导入需要用户提供已开启本地调试端口的浏览器并选择站点；没有静默复用任意普通 Chrome profile，也没有承诺所有登录票据仅凭 Cookie 都可迁移。
- 任意原生事件仅覆盖订阅/启用的页面范围 CDP 域；不把当前实现称为所有 Chrome 扩展与全局调试命令均兼容。
- 真实网站只有上述一次修正后的完整验收样本。各 Harness 经由共用 MCP 暴露能力，不等于本轮逐个运行全部 Harness/网站组合。
- 界面视觉效果由用户验收，本轮不反复截图调整其余页面样式。

## 2026-11-10 探针补齐

- 本地 `file:///` 页面可导航和恢复；网页依旧 sandbox、contextIsolation、无 Node/preload。网络共享 file URL 不作为本地文件入口。
- iframe 定位先查询主文档，无匹配时进入子框架；可显式 `target.frame` 使用 iframe 元素 CSS 或零基索引。自动附加仅限当前页的后代框架；跨进程 OOPIF 使用各自的 CDP 会话、虚拟节点 ID 与坐标换算，不扫描或接管其他浏览窗口。探针实际由 file 主页面嵌入 HTTP 子框架，验证点击、输入和 role/name。
- 拖拽支持 `{action:"drag",target:{css:"#src"},to:{css:"#dst"}}`，保留 x/y/toX/toY。HTML5 拖放转发浏览器原生 drag 数据和 drop，失败或取消也释放鼠标及拦截器。
- blob 下载通过原生 will-download 记录来源、文件名、URL、状态与进度，触发 download/download_done 事件，可 list 后 save，保存不覆盖现有文件。请求层不再把 blob 文档/下载请求取消。
- 用户探针原始下载按钮的内联代码 `URL.createObjectURL` 会被内联处理器的 `document.URL` 字符串遮蔽，未真正发起下载。早先只改了仓库副本；收到“复测 3”后同步修正 D 盘原始 probe.html，明确使用 `window.URL`。页面脚本错误记录为 page_error，browser_files list 返回近期 page_errors，帮助区分“脚本没发起下载”和“下载未登记”。
- `browser_fetch` 在页面环境使用 Cookie、相对 URL 与正常 CORS，返回有界文本/JSON。
- `browser_paste` 使用原生 paste 发送可信粘贴事件与 text/plain + text/html；保存原剪贴板格式，仅在用户没有另行复制内容时恢复，不清空原编辑内容。
- `browser_events watch/unwatch/list` 提供页面日志/事件游标；Runtime.consoleAPICalled、exceptionThrown、Log、Page、Network 等开启对应域。unwatch 停止记录指定事件，不关闭其他功能正在使用的域。分页返回已交付事件的 cursor，避免跳过尚未读取的事件。
- `browser_session open` 可在新建的具名空间指定 profile_id，选择独立持久化登录 profile；isolated:true 使用内存 context。已有空间不会静默更换 profile。跨空间读取仍受会话归属约束。默认 profile 与当前用户账号不变。浏览器 Cookie 导入与 live attach 是不同能力，当前仍不提供直接控制用户任意外部 Chrome 的 live attach。
- AI 指针没有固定 950 ms 自动隐藏；控制期间保留上次位置，明确交接、停止或本轮结束后收起。

新增 `test/browser-probe.test.mjs` 保留可复跑探针，验证 file、OOPIF iframe、HTML5 drop、blob 下载真实文件内容、原生可信 HTML 粘贴、console、带 Cookie 的相对 fetch、profile 隔离、调用间隔指针与显式接管。与原有浏览器回归共 7 项通过；旧 30 次批次仍全部成功。Rust 专项测试验证只有 run 生命周期产生浏览器控制状态，tool.finished 不结束控制。

关窗状态补充用例：总览仍打开时关闭其他浏览器面板不能触发全局停止；首次 MCP 调用自动开窗；全部关闭取消旧批次，新调用重新打开；保留其他标签的手动接管状态；进程重启后旧的 suspended 标记也不再阻止新调用。回执按真实窗口是否存在区分“当前全关”和“上次关窗留下的暂停”。本次窗口自动打开的整组回归在预览图断言处中断，未宣称整组通过；按用户要求停止继续测试，由用户验收运行效果。

复测 3 后将关窗中断单独编码为 BROWSER_CLOSED，在旧回执与严格 v2 中均为 paused；CONTROL_TAKEN 仅表示用户交接。自动开窗规则保持不变。页面导出与指定 URL 下载的两种入口已分别记录于工具描述与 usage.md。本次未重跑浏览器探针、测试套件或真实站点，不把代码更新写成新的验收结论。

## 复测 6 后的可靠性调整（1.2.1，待用户验收）

- 像素滚动选择中性位置，记录文档和命中区域滚动容器的前后位置。滚轮命令独立限时最多 1 秒；页面探测、恢复与位置读取另有限时。滚轮通道异常后不在同一文档连续重发，改走受控 DOM 滚动，主文档导航后恢复。降级以起始位置加距离计算绝对目标，未实际位移返回 SCROLL_NO_EFFECT，附边界、目标与原始通道错误；不因命令回包就报 completed。
- 点击观察从 document 外层移到目标节点和同一个 shadow root 内，记录真实 pointerdown / mousedown / click。closed shadow 不再仅因外层 composedPath 看不到内部节点就报 input_not_delivered。派发后证据缺失返回 delivery:unknown、inputDelivered:null、retrySafe:false，仍需 expect 验证业务状态。
- 鼠标移动产生 hover 层后、按下前再次检查遮挡。命中元素的 tag、selector、短 text 放在 hit 中；已派发但确实落在别处的点击标为不可盲目重试。
- 本次仅编译检查通过，没有运行浏览器探针、测试套件或真实站点。用户的“复测 6”通过项和问题记录保持原样。
