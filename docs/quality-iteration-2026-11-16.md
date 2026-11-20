# Nautilo 质量迭代：实施与交接

日期：2026-11-16。桌面版本 0.2.16，Android 版本 0.1.23（versionCode 24）。

本记录对应 `next-iteration-quality-plan.md` 中 O01—O08 与 N01。当前主线仍为 Electron / React + Rust daemon，保留 Node 对照实现和原生 Harness 的账号、配置、Apps、插件、MCP、Skills 与会话身份。

**用户最新范围修正：删除项目名下面“全部 / 运行中 / 待处理”筛选行及其状态、无用过滤函数。** 侧栏直接展示项目和会话，驾驶舱继续提供跨项目状态筛选。不要在下一次调整时恢复这排按钮。

## 1. 实施结果

| 项目 | 本轮实际改变 | 实现位置 |
| --- | --- | --- |
| O01 长会话 | 将长轮次拆成稳定事件行，纳入单一虚拟列表；折叠过程时最终回复、必要交互和委派仍有独立位置；恢复阅读行 ID、偏移及跟随状态 | `SessionWorkbench.tsx`、`Timeline.tsx`、`timeline-position.ts` |
| N01 桌面草稿 | 独立加密 Repository、版本比较写入与删除墓碑；关闭握手、附件检查、恢复冲突、未知发送结果按消息 ID 核对；回执不清新输入 | `composer-persistence.ts`、`draft-journal.ts`、`window-drafts.ts`、Rust / Node 的 `composer_drafts` 服务与 Repository |
| O02 项目导航 | 项目折叠、最近会话与列表位置；侧栏共用活动状态，点击只更新阅读；驾驶舱待处理项定位具体交互、完成项定位结果，右侧去重 | `SessionListPanel.tsx`、`project-navigation.ts`、`runs-dashboard.ts`、`RunsPage.tsx` |
| O03 热路径 | 沿用常驻协议与 MCP 池，补充实际复用 / 重建原因、PID 与初始化次数；DeepSeek 常驻键补原生会话身份；同身份复用、变化时隔离 | Rust `mcp_pool`、原生适配器及插件、`RequestRuntimeDetails.tsx` |
| O04 手机恢复 | 独立同步控制器；连接 / 会话所有权令牌；历史请求和事件消费分开；旧响应不得回写新页面；只读失败不改发送和电脑任务状态 | `SessionSyncController.kt`、`MobileViewModel.kt`、`SessionRefresh.kt` |
| O05 文件与 Git | 待选文件与当前预览分开；新文件就绪后标题与内容原子切换；Monaco 实例复用及有界模型缓存；仓库变更串行、状态合并、按文件版本失效 | `SourceControlDrawer.tsx`、`SourceControlPreview.tsx`、`DiffCodeEditor.tsx`、`editor-model-cache.ts`、`source-control-client.ts`、Rust / Node `source_control` |
| O06 团队与 PTC | 任务卡补最近活动 / 结果；选定失败或已停止任务单独重试；保留成功兄弟任务；主轮结束后继续更新成员；PTC 展示目的、真实子工具数量、活动及调用关系 | `DelegationCard.tsx`、`CodeExecutionCard.tsx`、`delegation-activity.ts`、Rust `task_retry.rs`、Node 编排服务、Android `MobileTeamController.kt` |
| O07 诊断与资源 | 用请求 / 运行 / 连接版本关联工具证据；同步按来源、目标分组；预览实际变更和冲突，冲突后重预览；沿用版本检查、备份与安全撤销 | `SessionToolsInventory.tsx`、`RequestRuntimeDetails.tsx`、`ResourceSyncDialog.tsx`、`resource-sync/useResourceSync.ts` |
| O08 呈现与动效 | 沿用黑白主题、Logo、Noto Sans SC / JetBrains Mono；列表与预览反馈统一；新发送约 200 ms 入场，流式和历史补读不重播；运行标记随实际状态结束 | 共享 motion、侧栏 / 驾驶舱 / 时间线 / 工具 / 资源样式及 Android 现有 Compose 动效 |

上述“已实现”指源码执行链路及下述定向检查，不代表所有真机、模型、协议组合与设计稿像素验收均通过。

## 2. 关键行为与边界

### 聊天与阅读位置

- 消息、事件、交互保留稳定身份与接受顺序，不按整轮结束时间搬动整轮内容。
- 整轮的内部活动也参与虚拟化；不是只把整轮当一行，再在一行内挂载所有工具。
- 用户主动读历史即停止跟随；切回、折叠及补读以阅读行与偏移找回位置，原行被折叠时找最近仍存在的前置锚点。
- 历史加载、流式补丁和乐观消息确认不触发新消息入场效果。
- 桌面阅读锚点为本次进程内按会话有界保留；侧栏导航位置、书签与草稿另行持久化，不把这几种存储混为一个保证。

### 草稿

- 文本及附件引用不进入 localStorage、请求日志或审计正文；后端加密保存。侧栏 localStorage 只存导航标识 / 偏移。
- 保存采用版本比较，迟到写入、迟到回执、删除后旧保存不得覆盖新输入或复活已清草稿。
- 退出前请求各窗口刷新保存，失败仍有反馈；突然断电只能恢复最近一次成功持久化版本。
- 恢复后不自动发送；附件已经移动 / 删除会明确标示。发送结果未知时先查稳定提交消息 ID，不能未经对账重新提交。

### 生命周期、MCP 与请求日志

- 保留常驻原生进程、后台任务、待回应交互及子 Agent 的生命周期；一轮完成不等于进程退出。
- Pi / Oh My Pi 的常驻重建原因包括首次使用、进程退出、配置或会话身份变化；DeepSeek / OpenCode 也按真实缓存键记录复用情况。
- MCP 进程按工作目录、配置、环境 / 认证身份隔离；每个客户端仍执行原生 MCP 握手，不伪造 `initialize`。
- 请求日志的复用原因、原生 PID、MCP 命中 / 新建 / 客户端连接 / 握手耗时均为可选证据。有数据才展示；没有首段内容或没有阶段时间保持未知。
- MCP 累计计数标明为进程生命周期计数；单个请求关联实际使用的进程，不把另一次检测当本轮证据。
- 日志不记录 API Key、认证令牌、提示词或工具正文。

### Git 与编辑器

- B 正在读取时仍完整显示 A 的身份与内容；B 成功后一起切换。过期 B 响应不能覆盖后来选择的 C。
- 每个编辑器的模型缓存最多 20 个文件 / 约 16 MiB，优先淘汰脱离编辑器的模型；超限的当前大文件仍可使用。
- 文件预览请求缓存有独立数量 / 字节上限；按根路径规范化仓库身份，避免 Windows 大小写与路径分隔符产生两条写队列。
- 暂存、保存、提交等仓库写操作串行；状态读取等待已有写入完成。单文件变化只失效对应内容，旧请求不能重新填回已失效的缓存。
- 外部变动、保存成功但后续暂存失败等情况保留实际结果及编辑草稿。
- 继续保留完整文件、行号、高亮、正确文件图标、真实基线及可调尺寸；未知基线不能冒充“新增整个文件”。

### 团队

- 重试 API 只接受已失败 / 已停止且依赖完成的选定任务；增加该任务 attempt，重新核对当前成员配置，不重启成功兄弟任务或整个主轮。
- 主轮已经结束时单独重试成员，也会刷新父会话任务和活动状态，继续同步并保留停止操作。
- 取消先记录非终态任务为取消，再等待原生取消；迟到的初始化 / 完成不得复活取消任务。
- 桌面、Android 通过能力声明显示重试入口；旧端仍可聊天和查看任务，不假定所有旧后端都支持新操作。
- PTC 的展示来源于实际事件关系，未观测到的子工具不会按代码猜造出来。结构化委派已有主卡片时去掉重复内部派发记录，保留真实用户可读说明。

### Android 恢复与资源同步

- 同步所有权先失效再取消协程，传输层即使迟到返回也不能更新当前连接 / 会话。
- 已有消息、增量事件、待发送内容和草稿先保留；恢复输入 / 停止不依赖整份历史读取完成。
- 只读超时不是“消息未发送”；短暂网络波动延迟呈现，连接恢复只清理自身提示。
- 资源预览归属、原生配置位置、同名不同来源分开显示。应用前检查版本；发生外部修改进入冲突流程。
- 原生资源服务已有备份及应用版本检查，本轮继续使用；撤销不能覆盖用户之后的外部编辑。没有新增后台无限轮询所有原生配置文件。

## 3. 已运行的验证

构建、测试及临时文件位于 `D:/CodexBuildCache/Nautilo/`。源码在 C 盘的现有 checkout，不迁移账号和会话目录。

| 层次 | 本轮证据 | 能证明什么 / 不能证明什么 |
| --- | --- | --- |
| TS / Electron | 共享包构建、全仓类型检查、Electron 生产构建通过 | 当前源码可编译，不等于实际安装 / 视觉验收 |
| 桌面 / Node | 会话顺序与委派去重、草稿 journal、后端加密草稿、编辑器 500 文件缓存、Git 写队列与过期 Diff、单任务重试的定向测试通过 | 覆盖这些状态路径，不代表整套软件零缺陷 |
| 真实 React 虚拟列表 | 600 行合成几何测试通过：视口挂载有界、屏幕外跳转、二次对齐、预览、书签、键盘和返回锚点 | 使用真实组件 / 虚拟器及合成 DOM；不是 600 次真实工具调用或 P50/P95 |
| Rust | workspace Release 编译；草稿 / 加密 4 项、Git 同行数内容变更版本 1 项、远程团队 5 项通过 | 后端和插件可构建，所列执行路径通过 |
| MCP 原生协议 fixture | 连续三客户端 PID 相同；初始化次数 1；命中 0 / 1 / 2；连接 1 / 2 / 3；轮次约 53 / 14 / 15 ms，首次原生握手约 40 ms | 实际启动 Node fixture 进程并走 MCP；这是 fixture 测量，不是用户真实 MCP / 模型延迟 |
| Pi / Oh My Pi 协议 fixture | 各自连续三轮 PID 相同；恢复、取消、后台工具及扩展交互租约的定向检查通过 | 实际进程和 wire fixture；不是安装的官方 CLI 对真实模型的全流程 |
| Android | 独立同步控制器、会话刷新、投影、团队图的定向单元测试通过；Kotlin 编译及签名 Release APK 通过 | Android 源码与包可构建；后台 / Wi-Fi / 蜂窝仍需手机真机确认 |

Git 版本测试特别覆盖：porcelain 状态及增删行数不变，但文件内容已经变化时，文件版本与仓库版本必须改变，旧版本保存被拒绝。

最后的安装包独立启动结果及 SHA-256 以本节后的交付记录为准；不能用开发目录里的预览进程替代安装包启动检查。

## 4. 构建与启动

本机 `.nautilo-dev.local.json` 指向 D 盘的 Cargo / Rustup / GNU target、临时目录与缓存。跨机器使用各自已有工具链或 CI 配置；不要复制本机账号凭据。

```powershell
# 开发主线（Electron + Rust）
pnpm dev:desktop

# 桌面生产构建与匹配的本平台原生后端 / 插件打包
pnpm build:desktop
node scripts/package-desktop.mjs

# 仅 Windows 免安装 EXE 与 ZIP（同样先 build:desktop）
node scripts/package-win-portable.mjs

# Android 签名 Release，沿用本机现有签名与 D 盘构建目录
node scripts/build-mobile.mjs
```

Electron 本机构建若遇到已知 esbuild 管道限制，使用现有 D 盘 `tools/esbuild-pipe-input.cjs` 的 `NODE_OPTIONS=--require ...`；这只是构建辅助，不随产品启动。

本机验证采用可工作的 Electron 33.4.11 副本，可通过 `NAUTILO_ELECTRON_DIST` 指定。打包脚本会校验其可执行文件。

打包时把 `out/` 的实际内容复制到 D 盘 staging：本机输出目录是 junction，直接让 builder 收集 junction 会漏掉 `out/main/index.js`。staging 的 package metadata 不再声明已经被 Vite 打入 bundle 的开发依赖，原始 workspace package.json 不变。完整配置只保留一份 native resources，避免重复复制与签名的占用冲突。安装包内继续包含 Rust 后端和全部 8 个插件。

## 5. 交付与剩余验收

预期交付目录：`D:/CodexBuildCache/Nautilo/releases/0.2.16/`，移动包：`D:/CodexBuildCache/Nautilo/mobile/artifacts/Nautilo-Mobile-0.1.23.apk`。最终文件及校验值见同目录交付清单。

以下内容**尚未作为已通过验收**：

1. 用户手机后台 30 秒 / 5 分钟、短时断网、Wi-Fi / 蜂窝互切、VPN 分应用排除后的真实网络过程。源码隔离旧响应与单元测试不能替代它。
2. 所有已安装 Harness × API / Responses / Anthropic / 原生账号组合的真实 CLI、真实模型、真实 MCP / Skills 完整往返；本轮复用测试只明确验证上表 fixture。
3. 同设备、同会话数据的 P50/P95 前后对照。≤100 ms 本地反馈、≤150 ms 缓存切换为目标，尚无完整实测报告，不冒充已达标。
4. 在另一台机器实际安装升级，验证既有数据库、原账号、原配对和全部历史保留；打包不主动迁移或删除这些数据，但仍需覆盖真实升级场景。
5. 所有浅深主题页面按统一分辨率逐页像素对照，以及手机触控 / 输入法体验；未做用户设备视觉验收。

N02 正文搜索、N03 手机统一产物下载、N04 配置方案完整页面、N05 独立工具服务仍属后续扩展，不计入本轮交付完成项。

工作区包含本轮之前已经存在的未提交修改及实验文件。本次不清理、重置或全量暂存它们。需要提交时先按交接内容核对范围，避免把无关文件一起加入。
