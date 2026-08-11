# 任务书：Electron 壳切换到 Rust daemon 的对齐度评估

> 交接说明：本文件由一次人工+模型排查后写成，第 2 节是**已核实的结论**，可直接信任，不要重复探索；
> 第 3 节是需要你完成的探索任务；第 4 节是输出格式要求。**本阶段只探索、出清单，不修改任何代码。**

## 1. 背景与目标

Nautilo 目前有两条 daemon 实现：

- TS 版：`packages/core-daemon/`（Node.js，Electron 壳当前使用）
- Rust 版：`rust/nautilo-core/`（TS 版的移植，Tauri 壳当前使用）

目标：让 **Electron 壳**（`apps/desktop/src/main/`）也改用 Rust daemon，从而：

- 打包体积去掉内置 `node.exe`（~88MB）+ `core-daemon` node_modules（裁剪后 ~40MB），换为单个 `nautilo-core.exe`（~11MB）
- 为"收敛到 Electron 单壳、退役 Tauri 线"铺路（renderer 不变，两条壳共用同一 daemon 后，Tauri 壳可安全归档）

**前置问题：Rust daemon 与 TS daemon 的功能对齐度是否足够支撑这次切换？** 这就是本探索任务要回答的。

## 2. 已核实的事实（不要重复探索）

### 2.1 启动契约完全一致，切换点极小

Electron 壳与 daemon 之间的契约只有四个要素（`apps/desktop/src/main/core-daemon-client.ts:14-51`）：

- spawn 参数：`--serve`
- 环境变量：`AGENTHUB_DATA_DIR` / `AGENTHUB_SOCKET` / `AGENTHUB_TOKEN_PATH`
- stdout ready 行：`{"service":"core-daemon","status":"ok","socketPath":...}`
- 之后走 JSON Lines over Windows 命名管道（`\\.\pipe\agenthub-core-<pid>`），首行 token 认证

Rust daemon 入口（`rust/nautilo-core/src/main.rs`）**逐字实现了同一契约**：同样的 env 变量、同样的 `--serve`、同样的 ready 行格式。

参考实现：Tauri 壳已经在用 Rust daemon，spawn/握手代码在 `apps/desktop/src-tauri/src/core_daemon.rs`（`wait_for_ready` 等）——Electron 壳改造时可以直接对照它。

结论：**切换本身只需改 `core-daemon-client.ts` 的 `resolveDaemonEntry()`（改为定位 `nautilo-core.exe`）+ 打包脚本替换资源**。难点不在启动，在 IPC 覆盖面（见 2.2 与第 3 节）。

### 2.2 IPC 方法覆盖面：字符串级初查结果良好

粗粒度对比（方法名字符串提取，非严格 diff）：

- TS 侧 `packages/core-daemon/src/application/ipc-handlers.ts`：提取到 71 个方法名形态字符串
- Rust 侧 `rust/nautilo-core/src/application/`：105 个
- TS 有而 Rust 没有的：仅 1 个（`"source.kind"`，大概率是字段名误匹配，不是方法）

注意：Rust 侧字符串含事件类型等非方法名，数字不代表"Rust 更多功能"。**这只说明覆盖面大概率接近全量，不等于行为一致**——第 3 节任务 A 要做严格核对。

### 2.3 数据库 schema 迁移数量一致

- `rust/nautilo-core/src/database/migrations.rs` 与 `packages/core-daemon/src/database/migrations.ts` 均含 20 个 `CREATE TABLE`/`ALTER TABLE` 语句
- migrations.rs 自述为 `migrateDatabase` 的移植

**未核实**（任务 B 要查）：迁移版本号机制是否兼容——用户现有 `agenthub.sqlite`（在 `%APPDATA%/@agenthub/desktop/`）如果被 TS daemon 迁移到了版本 N，Rust daemon 打开时能否识别、会不会重复执行或报错。这是切换后用户数据能否无损的关键。

### 2.4 打包侧涉及的文件

- `scripts/prepare-packaged-resources.mjs`：目前负责 deploy TS daemon + 拷贝 `node.exe`（切换后整个 script 的目标变为只产出 `nautilo-core.exe`，或干脆删除该 script 改由 cargo 构建产出）
- `scripts/electron-builder-after-pack.cjs`：afterPack 把 `build/packaged/core-daemon` 拷进 resources（切换后改为拷 `nautilo-core.exe`）
- `electron-builder.yml`：`extraResources` 里的 `build/packaged/node` 整个可删
- `scripts/package-win-portable.mjs`：portable zip 线，同样内嵌了 pnpm deploy + node.exe 拷贝
- `apps/desktop/src/main/core-daemon-client.ts` 的 `resolveDaemonEntry()` 有两个候选路径（dev 布局 + packaged 布局），都要换

## 3. 探索任务

### 任务 A：IPC 方法的严格对齐核对（核心）

以 `packages/schemas/src/ipc.ts` 的方法定义为准绳（它是协议源头），产出三方对照：

1. schemas 定义的完整方法清单
2. TS daemon 每个方法的实现位置（`packages/core-daemon/src/application/ipc-handlers.ts` 为主）
3. Rust daemon 每个方法的实现位置（`rust/nautilo-core/src/application/*.rs`，入口分发在 `ipc_gateway.rs` 的 handler 注册处）

对**每个方法**判定三档：

- ✅ Rust 已实现且语义一致（参数校验、返回结构、错误码一致——抽查即可，不必逐行）
- ⚠️ Rust 有同名实现但行为有差异（写清差异点）
- ❌ Rust 缺失

特别注意长链路方法：`runs.*` / `sessions.*` / `orchestration.*`（任务 DAG 派发）/事件订阅相关（renderer 靠它增量刷新，见 `apps/desktop/src/renderer/src/lib/orchestration-runtime.ts`）。

### 任务 B：运行时行为兼容性

1. **DB 迁移兼容**：对比两侧 migrations 的版本表设计与执行逻辑；判断"TS 迁移过的库给 Rust 打开"和反向场景是否安全。用户数据目录：`%APPDATA%/@agenthub/desktop/agenthub.sqlite`
2. **事件协议**：`packages/event-protocol/` 是 TS 包，Rust daemon 的事件追加/投影是否产出同构的 RuntimeEvent（renderer 的 `appendRuntimeEvents` 直接消费）
3. **适配器能力对齐**：TS `packages/core-daemon/src/adapters/{claude,codex,kimi}/` vs Rust `rust/nautilo-core/src/adapters/{claude,codex,kimi}/`；重点核可选项：PTY、原生 resume、结构化输出、usage 上报（ADR-0001 第 5 条要求显式声明 + 安全降级）
4. **PTY**：TS 版依赖 `node-pty`（native 模块），Rust 版用什么实现？是否完整覆盖 `pty-runtime.ts` 的能力
5. **provider 插件加载**：Rust 插件（`rust/plugins/*` 编译的 exe）与 TS 插件（`packages/provider-plugin-*`）在两种 daemon 下的加载路径是否都通

### 任务 C：dev 与 packaged 两种布局的启动路径盘点

列出 `resolveDaemonEntry()` / `resolveNodeCommand()` 目前覆盖的所有布局（dev、`release/win-unpacked`、NSIS 安装版、portable zip），以及切换成 `nautilo-core.exe` 后每种布局下 exe 应该放哪、由哪个脚本放。注意 `AGENTHUB_NODE_PATH` 这个 escape hatch 的去留。

## 4. 输出要求

产出一份差距清单（Markdown），格式：

| # | 方法/能力 | 档位(✅/⚠️/❌) | TS 位置 | Rust 位置 | 差异说明 | 切换阻塞? |

并按严重度给出总结论，三选一：

- **可直接切换**：无 ❌ 且无阻塞性 ⚠️ → 附切换实施步骤清单
- **补齐后可切换**：列出必须先补的 ❌/⚠️ 最小集合（按工作量排序）
- **暂不可切换**：说明根本性障碍

## 5. 明确不做的事

- 不修改任何代码（包括"顺手修"发现的差异）
- 不评估 Tauri 壳的退役（那是下一步，本任务只管 daemon 对齐）
- 不动 renderer、schemas、event-protocol
