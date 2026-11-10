# DeepSeek Harness 设计详解（全面版）

> 研究版本：v0.1.0-rc.7（commit `99f6f02fe`，pnpm@11.7.0，MIT）
> 面向读者：从"会用"过渡到"想懂设计"的 Agent 工程师。全程用大白话 + 代码事实，由浅入深。
> 本文覆盖 DSH 的全部核心设计：插件体系、会话事件日志、Surface 层、Agent Loop、工具系统、上下文、LLM 抽象、Token 计量、压缩、Prompt Cache、子代理、持久化、装配与测试。**压缩和缓存只是其中两个环节，放在整个系统里讲**。

---

## 0. 一句话记住 DSH

**一切皆插件的 Agent 运行底座**：把"Agent 干活的全过程"记录成一条只增不改的事件日志，日志是唯一事实来源；模型每次请求要看的"对话"是从日志上实时折算出来的一个视图（Surface）；谁超过上下文就基于视图做"压缩"——把一段历史用一个模型总结替换掉，同时保证 API 的 Prompt Cache 尽量不被破坏。

三个词反复出现，记住它们就懂一半：
- **事件日志（Event Log）**：只追加、从不修改。真实是它，备份是它，回放是它。
- **Surface（视图层）**：模型每次实际看到的节点序列，是日志的派生视图。
- **压缩（Compaction）**：在 Surface 上把一段旧历史折叠成一个总结节点，让对话变短又不失上下文。

---

## 1. 插件体系：DSH 的骨架（一切皆插件）

### 1.1 什么是"一切皆插件"

DSH 基于 vendored 的 **Cordis**（一个 TypeScript 插件容器，被固定在 `vendor/` 目录里，按版本锁定）。Cordis 提供：
- **插件生命周期**：`ctx.effect()` / `ctx.on()` 注册副作用，插件卸载时自动清理。
- **服务（Service）**：通过 `ctx` 注入和访问的具名对象。
- **作用域（Scope）**：插件的依赖/所有权关系，作用域销毁时其插件一并销毁。
- **Waterfall 事件**：监听器串成链，**必须调用 `next()` 才会把控制权传给下一个**（不调用就短路）。

DSH 里"插件"既是组织单元也是复用单元：每个能力拆成一个 `@deepseek-ai/dsh-<name>` 包，放进 `packages/<group>/<pkg>/`。

### 1.2 能力缝（Capability Seam）三件套

任何"能力"（LLM、工具、文件系统、shell、子代理、压缩……）都以**三件套**形式出现，且三者总是一起出现：

1. **Service Definition（服务定义）**：声明这个能力的接口契约（有哪些方法、参数、返回）。比如 `ctx.compaction` 是一个 `CompactionEngine` 抽象类。
2. **Service Provider（服务提供者）**：具体实现。比如 `BasicCompactionEngine extends CompactionEngine`，核心分包只载接口，实现放独立包。
3. **Consumer（消费者）**：使用该能力的插件/工具。

> 设计原则：**能力裂缝 = 三件套完整，缺一不可**。想新增能力，就照着三件套搭，而不是把逻辑塞进 Agent 循环。

### 1.3 注册即副作用

DSH 约定：**所有贡献必须走 `ctx.effect()` / `ctx.on()` 注册**，`register()` 返回"注销函数"，保证热更新/卸载时能干净清理。没有"埋在构造函数里的隐式全局注册"。

### 1.4 两条黄金纪律

- **Model-visible ⟺ logged**：任何会进入模型请求的内容，都必须能从会话日志里重建；新增模型可见输入必须对应一条会话事件。日志永远不撒谎。
- **插件，不是改循环**：新行为走文档化的扩展点（waterfall 事件、Service 三件套）；改 `agent-loop` 本身必须同步更新架构文档。

---

## 2. 会话：只增不改的事件日志（Source of Truth）

### 2.1 事件日志思维

DSH 的会话（Session）不做"存一份当前对话"这种事，而是把**每一次状态变化记成一条事件**，无限追加：

```
turn/start       turn/end
step/start       step/end
user/message     assistant/chunk  assistant/message
tool/call        tool/result
request/header   request/context
compaction/start compaction/summary compaction/end
session/end-seed ...
```

- 每条事件有全局自增 **seq**。
- 日志是**唯一事实来源**（append-only，只追加不修改）。
- 模型要的历史、UI 要的对话、崩溃后的恢复，全都是**从这个日志派生/回放**出来的。

> 为什么要这样？「唯一事实来源 + 任意前缀都自洽」是缓存友好和可恢复的根基，后面压缩和缓存两章会反复用到。

### 2.2 派生历史：deriveMessages

`Session.deriveMessages()` 把日志折算成发给模型的 `Message[]`。折算规则（`surface.ts` 的 `deriveEventMessage`）极简：

- `user/message` → 直接给 `event.data`（原样透传，不带额外包装）。
- `assistant/message` → 给 `data.message`；**content 为空的一律跳过**（那种事件只是用来挂 usage 的）。
- `tool/result` → 给 `data.message`。
- 其它类型（chunk、boundary、usage 等）→ 不产生消息。

### 2.3 为什么请求前缀稳定（回顾）

```
[system prompt] [tools] user assistant tool/result user assistant ...
```

每一轮消息都是**只追加**：系统提示、工具 schema、历史消息都保持字节不变，只往尾部新增。这让 provider 的 **KV Cache / Prompt Cache**（下文第 8 章）能整段复用。

### 2.4 Request Header：请求的"固定头部"单独记

`session.requestHeader()` 从 `request/header` 事件折叠出最近一次请求的**固定部分**（Epoch Header）：`config`（provider/model 等）、`system`、`tools`，以及可选的 `adapterDefaults`。

- `canonicalHeader()` 归一化：空 system / 空 tools 折叠成缺省字段。
- `headerEquals()` 做**逐字段深比较**——只有 header 真的变了（比如切了模型、改了个工具 schema）才追加新 `request/header` 事件，否则不浪费日志。
- 任何持有一份日志的人都能用 `foldRequestHeader()` 离线重建当时的 header。**压缩摘要能复用缓存，靠的就是读它取 system+tools**（见第 7.5 节）。

### 2.5 事件契约与校验引擎（可选读）

`surface.ts` 面向事件做严格校验（设计上这些校验保证日志永远可回放）：

- `assertProvenance`：`sourceEventSeqs` 必须引用**更早**的事件、无重复、且必须覆盖被遮蔽的每个 surface 节点。
- `assertToolResultRewrite`：`tool/result` 替换只允许改 `content`，其它字段必须深相等（防止改写工具结果造假）。
- `planSurfaceEvent` / `applySurfacePlan`：先校验后原子落地；替换会让 `replaceGeneration` 递增。

这些是"日志自证清白"的机制：任何非法替换（拆对话、引用了不存在的 seq、改了工具结果）都会在回放时直接抛错，而不是悄悄污染。

---

## 3. Surface：模型可见视图层

### 3.1 为什么需要视图层

日志里有很多模型不该看到的东西（chunk、压缩临时事件、usage 记录）。所以 DSH 在日志之上维护一个**Surface**——真正会进入 `deriveMessages` 的节点序列。

**Surface 只认三类事件**（`SURFACE_EVENT_TYPES`）：`user/message`、`assistant/message`、`tool/result`。且必须带 `surfaceOp` 标记：

- `surfaceOp: 'append'` → 追加到 Surface 尾部。
- `surfaceOp: { op: 'replace', start, end }` → 用它自己替换掉 `[start, end]` 那一段 Surface 节点（旧节点被 shadow，从模型视野里消失）。

### 3.2 折叠与增量

- `foldSurface(events)`：完整重放日志得到 `{ nodes, replacements }`（离线/恢复用）。
- `SurfaceManager`：增量维护 `nodes` + 单调的 `replaceGeneration`（在线用）。
- 同一个 `foldSurface` 既服务在线 `deriveMessages`，也服务离线重建——**投影规则唯一**：`deriveEventMessage` 是唯一投影函数，谁都要用它。

### 3.3 替换（replace）与人类转录的分野

- **Model-visible ≠ human-transcript**。替代是给模型看的：替换后旧节点从模型视野消失，对话"变短"。
- 用户**已经看过**的原始内容不能因为压缩而消失。所以人类转录用 `isAppendSurfaceEvent`（只在日志里原始追加位置取），**替代副本只对模型可见**。
- 一句话：Surface 回答"模型现在看到什么"；append 原始事件回答"用户真实聊过什么"。

### 3.4 为什么 replace 会破坏缓存（关键点）

从**第一个被遮蔽的 token 起**，前缀就不连续了，provider 的 KV Cache 从那里开始失效。Design 的核心矛盾就此浮现：

> 要省 token → 必须替换 → 替换破坏缓存前缀 → 又要省 cache→ 只能**尽量把摘要做成"前缀内可复用"**（第 8 章）以及在同一个前缀尾部追加 Summary 后原地替换。

---

## 4. Agent Loop：ReactLoopAgent 循环驱动器

`@deepseek-ai/dsh-agent-loop` 是**唯一包含真实循环逻辑**的包。核心是 `agent.ts`（~496 行）的 `ReactLoopAgent`，它的任务：把"请求模型 → 拿工具调用 → 执行 → 再请求"转起来。

### 4.1 状态机：phase

```
idle        { lastTurn }
maintenance { abort, lastTurn, wakeRequested }
running     { abort, turn, step, wakeRequested }
```

- 空闲可接受消息；消息唤醒进入 running 跑 turn；压缩这类后台杂活走 maintenance。
- `status` getter：idle|maintenance → `'idle'`；running → `'running'`。

### 4.2 Inbox 与唤醒语义

- `Inbox`（来自 dsh-agent）：`splice/reserve/claim`。
- `send(input, target, wakeup)`：wake up 若发生在非 idle/已 abort 状态，则把目标改成 `'next-turn'`（消息排队稍后开新 turn）。
- `send` 带 wake / `followup` → `'next-turn'`；`steer` → `'next-step'`；`inject` → `'next-step'` 且不唤醒。
- `cancel(cause)`：默认 `inbox.clear()` + 置 `wakeRequested=false`，随后 abort；`keepInbox` 则保留队列。

### 4.3 主循环 turn()

```
phase.turn += 1
append('turn/start', {turn})
while (true):
    step = phase.step + 1
    decision = await preStep(...)            # 收最新消息、组装 context
    if rejected → turnEnds={kind:'blocked'}; return false
    if 空消息且 step==0 → completed; return false
    append('step/start')
    for msg in decision.messages → append('user/message', msg, {surfaceOp:'append'})
    stepEnd = await this.step(assembly)      # 真正发请求、串流、执行工具
    append('step/end')
    ...
append('turn/end', {turn, reason})
```

边界守卫：

- **max-tokens 粘滞**：一旦某一步遇到 max-tokens，后续正常步不再降级为 turn 结束——避免模型输出被截断就误判会话结束。
- **错误处理**：abort → `{kind:'aborted'}`；LlmError → `error.failure`；其它 → `errorChain` 摊平 `'UNKNOWN'` code。
- turn 结束若有 pending 消息则开新 controller、`step=0`、返回 `true`（继续跑下一个 turn）。

### 4.4 preStep：步前决策 + 组装上下文

```
inbox.claim()
await systemPrompt.assemble(...)
renderContextSections(...)
runtimeContext.project(...)          # 动态上下文快照（见 4.6）
waterfall 'agent/pre-step' → 默认 {kind:'enter', messages}
```

waterfall 是 DSH 的扩展点：其他插件可在这里修改/拦截本步要发的消息（比如 `compaction-basic` 就在这里做**压力检查**，见第 7 章）。

### 4.5 step：发请求 + 流式收 + 执行工具

```
while (true):
    buildRequest(turn, step, tools, system, session.deriveMessages(), signal)
    → {request, preparedCall?}
    stream = preparedCall?.stream(request) ?? ctx.llm.stream(request)
    BlockAssembler 逐 chunk：
        append('assistant/chunk', {turn, step, chunk})   # 记 chunkSeqs
        assembler.push(chunk)
    finish:
        出错/abort → waterfall 'agent/request-error'（可 retry）
        成功    → createAssistantMessage(...)
                   append('assistant/message',{...,usage},
                          {surfaceOp:'append', sourceEventSeqs: chunkSeqs})
        有 tool-call → executeToolCalls(...)（见第 5 章）
```

**流式如何保证可重放**：每个 assistant 消息的 `sourceEventSeqs` 指向产生它的所有 `assistant/chunk` 的 seq。UI 可以做流式重放"打字机"效果，回放也据此完成。

### 4.6 动态上下文（runtime-context.ts）

`cwd`、权限、当前目录等**运行时动态信息**怎么进上下文？DSH 的做法很聪明：

- 动态信息作为一条 **user 消息快照**追加（`RuntimeContextProjection`），每次渲染出来只**在内容变化时**才追加新快照，没变就不写。
- `project()` 只有当 `retained.text !== snapshot` 时才生成候选消息；若没变化，直接返回 `undefined`（不追加）。
- `CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'` 用于清空旧快照影响。
- 被压缩遮蔽 / 被替换时，`RuntimeContextProjection` 通过 `sourceEventSeqs` 感知并失效 `retained`。

**为什么这么做**：这保证**system prompt 前缀永远不被重写**（system 保持字节稳定 → 前缀缓存稳定），动态部分只作为追加的 user 消息。这和"请求前缀稳定"哲学完全一致。

---

## 5. 工具系统：执行调度（tool-calls.ts）

模型要调用工具时，DSH 把同一 assistant step 里的多个工具调用**调度执行**：

### 5.1 独占 / 并行 / 滚动池

- `executionMode` 判定每个调用是 `exclusive`（独占，形成 barrier）还是 `parallel`。
- **独占调用是屏障**：等前面都执行完才能开始，且其之后能并行。
- **并行调用有界滚动池**：同时最多 `maxParallelToolCalls` 个在飞；一个结束立刻补充下一个。
- 调度前会**重新分类**（re-read executionMode），因为工具注册表可能在执行中变化。

### 5.2 结果按模型顺序提交

- dispatch 可以并发，但**策略、结果、结果上下文全部按模型原始顺序提交**（`commitReady()` 只推进连续的前缀槽位）。
- 每个 `tool/result` 用 `sourceEventSeqs: [callSeq]` 指向它的 `tool/call`，保证配对可回放。

### 5.3 中止的合成结果

- 用户中止时：已开始的调用**排水后提交真实结果**；没开始的调用**补一条合成错误结果**（`tool call aborted before dispatch`，code `TOOL_ABORTED_BEFORE_DISPATCH`）。
- 目的：**日志永远成对、可重放**，不能出现只记 `tool/call` 没 `tool/result` 的情况。

### 5.4 参数解析

`parseArguments`：合法 JSON → 解析成对象；非法 JSON → **保留原始字符串**（不让一个坏参数炸掉整个调度），空字符串 → `{}`。

---

## 6. LLM 抽象与 DeepSeek 适配器

### 6.1 Provider 无关的消息模型（llm/types.ts）

DSH 定义了一组**Provider 无关**的结构：

- 消息 Content 块：`text`、`reasoning`、`image`、`tool-call`、`tool-result`。
- 统一的 `usage` / `failure` / `model` 契约。
- `createUserMessage` / `createToolResultMessage` 等工厂。

任何 provider（deepseek、pi-ai、openai…）都实现这套接口，上层代码永远不碰厂商私有字段。

### 6.2 llm-deepseek 适配器的关键动作

- **usage 映射**（`mapUsage`）：
  - `inputTokens = prompt_tokens − cacheRead`（模型真正"新算"的输入）。
  - `cacheReadTokens` 取自 `prompt_cache_hit_tokens` 或 `prompt_tokens_details.cached_tokens`。
  - 目标：让上层能精确看到"缓存命中多少、实付多少"——这正是 Prompt Cache 分析的数据来源。
- **消息序列化**：工具结果拆成独立 `role:'tool'` 消息；`reasoning_content` 只在工具调用轮回传（避免无谓浪费）。
- **`purpose: 'compaction'`** 时发请求头 `x-deepseek-harness-compact: 1`，标识这是一次压缩专用调用。

### 6.3 缓存实证（request-cache.e2e.ts）

agent-loop 的 e2e 测试对真实 DeepSeek API 断言：**首个请求之后，每个后续请求 `cacheReadTokens > 0`**。说明"前缀 append-only 只扩张、永不改写"的策略真的能在生产拿到缓存命中。

---

## 7. 压缩（Compaction）：设计详解核心之一

### 7.1 四个包的分工

| 包 | 作用 |
|---|---|
| `@deepseek-ai/dsh-compaction` | **接口层**：`CompactionEngine` 抽象类、`compaction/*` 事件类型、`ManualCompactionError` 错误码、`toolPairingBalancedBefore/After` 工具、`compactCheckpointSource` |
| `@deepseek-ai/dsh-compaction-basic` | **实现层**：默认配置、压力/溢出触发、选段、事务、基于 LLM 的摘要 |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` | **无模型裁剪**：不等模型，先裁剪超长工具结果 |
| `@deepseek-ai/dsh-command-compact` | **命令层**：`/compact` 手动命令 |

### 7.2 默认配置（config.ts）

```
thresholdRatio      0.8    # 上下文用到窗口 80% 触发压力压缩
retainRatio         0.16   # 保留最近 16% 原样不动
maxTokens           8192   # 单次摘要输出上限
compactionRetries   1      # 压力压缩最多额外重试次数
maxOverflowRetries  1      # 溢出压缩最多重试次数
auto                true   # 自动压缩开关
```

- `thresholdTokens = floor(contextWindow × 0.8)`。
- `retainTokens = floor(contextWindow × 0.16)` 或绝对 `retainTokens`。
- 校验 **`retain < threshold`**（保留至少比阈值低），`retainRatio` 与 `retainTokens` 互斥。
- `modelPolicies[]` 可按 `provider/model` 覆盖以上任意默认值。所有"可调参数"都是可配置字段，**不硬编码**。

### 7.3 三个触发入口

1. **压力触发（auto，每步）**：监听 `agent/pre-step`，调 `compactIfNeeded(agent, 'pressure')`。测 `totalTokens ≥ thresholdTokens` 才动手。
2. **溢出触发（auto，遇到错误时）**：监听 `agent/request-error`，当错误 code 是 `CONTEXT_WINDOW_EXCEEDED_CODE` 时强制压缩（`retain=0`，只保最后一条消息）。
3. **手动触发**：`compactNow(agent)`（`/compact` 命令）。要求 agent 空闲走 `runMaintenance`，`retain=0`。

### 7.4 选段：selectCompactableRange（region.ts）

要压缩哪一段？原则：**从尾部向前数出要保留的尾巴，其余全压**，并避开会拆散工具问答对的位置。

```
1. 用 token-meter 测全 Surface，校验与 session.surface 逐 seq 一致
   （否则抛 'compaction: token-meter surface does not match the current session surface'）
2. 从最后一个节点往头累计 token，直到累计 ≥ retainTokens，得到 keepFromIdx
3. while keepFromIdx > 0 且 toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx]) 不成立：
   keepFromIdx 前移   # 切点必须平衡，否则往更早走
4. keepFromIdx == 0 → 无可压，返回 null
5. 返回 {start: 第一个节点, end: surfaceNodes[keepFromIdx-1]}
```

**工具配对平衡**（tool-pairing.ts `toolPairingBalancedBefore/After`）：

- 沿 Surface 数一个"进行中工具调用计数"：`assistant/message` 中每个 `tool-call` 块 **+1**；`tool/result` **−1**。
- 某个位置累计值 **= 0** 才算平衡切点（没有悬挂的未配对调用跨过切点）。
- `cutBalanced[]` 数组缓存在 `balanceCacheBySession`（WeakMap）里，按 `replaceGeneration` 重建，避免每次重扫。
- 为什么不能拆工具问答对：拆了之后模型看到的 `tool/result` 没有对应的 `tool-call`，会破坏历史和缓存对齐。

### 7.5 摘要并复用缓存（summarizer.ts）：设计精华

压缩真正牛的地方在这——**用模型总结时几乎不破坏 KV 缓存**：

```
输入 = 最近一次 request/header 里的 system（原封不动）
     + 最近一次 request/header 里的 tools（原封不动）
     + 被压区域的派生消息（surface 顺序）
     + 末尾追加一条 COMPACTION_INSTRUCTION（唯一的"新"内容）
```

- 前面那一大段 = **上一次真实请求的字节前缀**，直接复用 provider 热缓存；**只有末尾那一条压缩指令是新 token**。
- `COMPACTION_INSTRUCTION` 是最后一条 user 消息，要求模型按固定 Markdown 结构输出 checkpoint（Primary Request / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context），且规则强调：
  - 保留精确路径、命令、字符串、标识符、数值、签名。
  - 保留用户反馈和纠正。
  - **如果对话里已有旧 checkpoint，不要原样复制——合并成单一新版**。
- 只保留 `text` 块（丢弃 reasoning / tool-call；图片直接抛 `UNSUPPORTED_CONTENT`）。
- `frameSummary()` 用 `CHECKPOINT_PREAMBLE` + `<compacted-summary>...</compacted-summary>` 包裹，落地为替换节点。
- **强制收敛**：`framedSummaryTokenCount < shadowedTokenCount`，否则抛 "summary is not smaller than the shadowed content (...)"。总结必须比原文小，不然白压。

### 7.6 压缩事务：compactSurfaceRegion（region.ts）

这是整个压缩正确性的核心，分阶段落地，任何一步失败都有明确的日志痕迹：

```
1  durable 锁：append('compaction/start')  # 未闭合的 compaction/start 就是锁
   - assertCompactionInactive：已有未闭合 start 且无更新的 session/end-seed → 抛 busy（拒绝并发）
2. prepareCompaction：measure 计 shadowedTokenCount，构建摘要输入
3. summarizeCompaction：调模型总结 + frame + 收敛校验（必须更小）
4. 稳定性检查：
   - whole-surface（自动路径）：重新 measure，深比较整个 nodes 列表
   - selected-span（手动路径）：只要求选中区间仍在、等值、平衡；区间外新节点不算违反
   - 不一致 → SurfaceChangedError
5. commitCompactionBody：
   - append('compaction/summary', {summary, shadowedRange, shadowedSeqs,
     shadowedTokenCount, provider, model, maxTokens, usage})
   - append('user/message', checkpointMessage,
       {surfaceOp:{op:'replace',start,end}, sourceEventSeqs:[startSeq, summarySeq, ...shadowedSeqs]})
6. append('compaction/end')   # 成功闭合
   - 失败也 append('compaction/end', {error}) 闭合 —— 锁永不悬挂
7. 手动路径：options.flush → await sessions.flush 持久化
```

要点：

- **锁永不悬挂**：即便摘要失败，也会写一条带 error 的 `compaction/end`；失败留下的 unmatched `compaction/start` 可被检测（`inspectCompactionEntryState`）。
- **绝不提交基于过期展板的摘要**：稳定性检查失败就不会落地（见 7.8）。
- `assertToolResultRewrite` 在回放层进一步保证替换只是 content 级改动。

### 7.7 "重新来"（重试/继续）的真实语义

用户最容易误解的一点：**稳定性检查失败 ≠ 立即原地重试**。分三条路径：

- **自动压力路径**（pre-step）：本次作废，锁已闭合，记失败日志；**等下一个 step 边界重新测量再触发全新压缩**——此时新消息已经进展到新的展板，不是拿旧摘要硬塞。
- **溢出路径**（request-error）：**仅当有实质进展才重试**。判定标准是 `session.surface.replaceGeneration` 变化（比如无模型裁剪 `toolResultPruner` 已落地、日志确实变小了）。若 replaceGeneration 没变，说明压缩没成功（或没必要），**保留原始请求错误**，不回退、不伪造。超 `maxOverflowRetries` 也不再重试。
- **手动**：提示"历史在使用过程中变了"，记录在案，用户可再发 `/compact`。

### 7.8 保留量

- 平时：压 84% 留 16%。对 128K 窗口 ≈ **保留 20,972 token 原样不动**；由于不拆工具问答对，实际会略多留。
- 溢出 / 手动：`retain=0`，**只留最后一条消息**（用户最新输入）。

### 7.9 无模型裁剪：tool-result-pruner（可选但重要）

在动用模型总结之前，**先用这个不花钱的裁剪**把超长工具结果砍短：

- 默认：`thresholdChars 8192` / `headChars 4096` / `tailChars 1024`。
- `PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'`。
- 只替换 `content`，保留其余字段；按 Unicode code point 切（不拆 surrogate pair）；head+marker+tail ≤ threshold 校验。
- **先裁剪后重测**：裁完总 token 低于阈值就直接跳过摘要 —— 省一次模型调用。
- 压缩流程里它作为可选步骤（`ctx.get('toolResultPruner')`），使 compaction-basic 可独立组装。

---

## 8. Prompt Cache：和压缩咬合的另一半

### 8.1 为什么 DSH 对缓存这么上心

对 DeepSeek 这类有 Prompt Cache 计费的模型，**输入 token 里大量是缓存命中**，成本差异巨大。DSH 把"缓存最大化"当成一等设计目标，不是事后优化：

- **稳定不可变前缀**：system + tools + 历史只追加不重写（第 2.3 节）。
- **header 稳定**：只有真正变化才记 `request/header`（第 2.4 节）。
- **动态上下文不碰前缀**：动态信息以追加 user 消息快照存在（第 4.6 节）。
- **压缩复用前缀**：摘要调用就复用上一次请求的 system+tools+历史做前缀（第 7.5 节）。
- `mapUsage` 精确拆分 `inputTokens`（实付）与 `cacheReadTokens`（命中），**让缓存收益可测量、可验收**（第 6.2 节）。
- e2e 测试把 `cacheReadTokens > 0` 写成断言（第 6.3 节）。

### 8.2 何时必然失效（诚实说明）

- **replace 落地**：从第一个被遮蔽 token 起前缀中断，缓存部分失效。压缩的代价在此。
- **改 system / 换模型 / 加工具**：产生了新的 header → 新前缀。
- DSH 的做法是把"失效"压缩到最小：**能用追加表达的绝不用替换；必须替换时，让替换发生在旧的连续前缀尾部之后**（summary 本身尽量是原前缀的延续），把缓存损失降到最低。

### 8.3 测量驱动

Token 计量（第 9 章）提供 `totalTokens / surfaceTokens / projectedTokens / contextBreakdown`，压缩触发（第 7.3 节）用同一套计量。**压缩策略和缓存策略共用同一数据源**，不会出现"压缩说够了、计费说爆了"的分裂。

---

## 9. Token 计量（token-meter）

- **固定启发式 4 字符/token**：不依赖具体模型词典，快速、稳定、可重复。够准也够快。
- Provider usage 只有在其 canonical envelope 完全一致时才能作锚点校准。
- 对外提供：`totalTokens`（整个请求压力）、`surfaceTokens`、`projectedTokens`（预计要用的）、`contextBreakdown`（分块占用）。
- 它同时服务：压缩压力判断（第 7.2）、摘要收敛校验（第 7.5）、体积报告。

---

## 10. 子代理（Subagent）与所有权

- **所有权链**：每个 Agent 由发起者（initiator）派生；`withInitiator()` 恢复发起者身份，`agent.session` 从属派生。
- 派生子代理 = 新 Agent + 新 Session（独立事件日志、独立 Surface），而不是共享一个会话。
- 子代理有自己的上下文预算和生命周期；超预算时按自身策略处理（错误/降级），不影响父代理日志。
- 设计原则（packages/AGENTS.md）：**让 Agent/Session 在生命周期、会话日志、服务、权威、worker/进程、持久化、线路等接口边界保持显式**，不把叶子 helper 从 `Session` 拓宽成 `Context` 来藏参数。

---

## 11. 权限与交互（interaction 能力）

- `@deepseek-ai/dsh-interaction`：提供 **user-approval**（需要用户批准才执行）、**permission**（权限预设）、命令系统、ask-user。
- **Permission Presets**：预定义的权限集合（如"只读"、"聊天气泡式确认"、"全放行"），按插件/场景装配。
- 审批同样走事件/服务三件套，可被替换（如无人值守场景换成无交互审批器）。
- 只读运行时边界信任 TS 类型（同一进程内），不在运行时重复校验静态保证的字段（校验发生在解析/配置、工具 JSON、持久化、进程、线路边界——"hostile-input"测试仅在边界）。

---

## 12. 持久化（session-persistence）与检查点

- **persistence 也是插件**：会话日志的落盘由 `session-persistence-jsonl` / `session-persistence-sqlite` 提供（同接口不同后端），`sessions.flush(session)` 把日志刷盘。
- 会话对象是**日志之上的活视图**；持久化的单位是事件日志，不是"当前对话快照"。
- **重启恢复** = 读日志 + 重放 foldSurface，得到与崩溃前一致的 Surface。这就是"唯一事实来源"的复利。
- 手动压缩（compactNow）默认带 `flush`：事务闭合后立即 `await sessions.flush`，保证"用户按了 /compact"这件事本身是持久的。

---

## 13. 装配与测试体系

### 13.1 包布局与装配

- 顶层：`apps/`、`docs/`、`examples/`、`native/`、`packages/`、`patches/`、`python/`、`scripts/`、`vendor/`（Cordis 副本）、`website/`。
- `packages/core/` = 产品 API 主干（session、system-prompt、tools、agent、agent-loop）。
- `packages/bundle/base|web-app|headless` = 可安装的"组装层"：把若干插件 + `dsh.profile`（profile 定义裁切哪些插件）拼成一个完整应用。
- `bundles` 是"装配意图"，不是"又一次实现"——同一批插件按 profile 给 CLI / Web / headless 做出差异。

### 13.2 测试多级

- `pnpm run test`：vitest 单元测试。
- `pnpm run test:coverage`：CI 覆盖门（每文件 100%）。
- `pnpm run test:e2e`：**真实 API 测试**，无 `DEEPSEEK_API_KEY` 自动跳过（request-cache.e2e 在这）。
- `pnpm run test:snapshot`：无需 key 的 ACP/headless 重放 vs 期望输出。
- `pnpm run typecheck / lint / build / hygiene`。
- 原则：**聚焦测试够用就不跑全量**；CI 拥有穷尽覆盖率。

---

## 14. 新手阅读路线（建议顺序）

1. `docs/architecture.md` — 架构全貌（先看总图）。
2. `packages/core/session/README.md` — **事件日志**：一切的地基。
3. `packages/core/session/src/surface.ts` — 视图层 + 投影 + replace 校验。
4. `packages/core/agent-loop/README.md` + `src/agent.ts` — 循环驱动器。
5. `packages/core/agent-loop/src/tool-calls.ts` — 工具调度。
6. `packages/llm/llm/src/types.ts` + `packages/llm/llm-deepseek/src/translate.ts` — 供应商抽象与缓存映射。
7. `packages/llm/token-meter` — 计量。
8. `packages/compaction/`（compaction → compaction-basic → tool-result-pruner → command-compact）— 压缩全链路。
9. `packages/session/session-persistence-*` + `packages/bundle/*` — 落盘与装配。

## 15. 一句话总结

> DSH = 一切皆插件 + 只增不改的事件日志（唯一事实）+ 从日志折算的 Surface 视图 + 一个尊重前缀缓存的 Agent 循环；在这个地基上，用"可复用前缀的模型总结"把超长历史折叠成更短且保真的 checkpoint，压缩与缓存就不再是对立，而是一套互相咬合的机制。

---

## 附：关键源码文件索引（研究时用）

| 主题 | 文件 |
|---|---|
| 循环驱动 | `packages/core/agent-loop/src/agent.ts` |
| 工具调度 | `packages/core/agent-loop/src/tool-calls.ts` |
| 动态上下文 | `packages/core/agent-loop/src/runtime-context.ts` |
| 会话日志/投影/Surface | `packages/core/session/src/index.ts`、`surface.ts` |
| 请求头部重建 | `packages/core/session/src/request-header.ts` |
| 压缩接口 | `packages/compaction/compaction/src/index.ts`、`tool-pairing.ts`、`checkpoint.ts`、`types.ts` |
| 压缩实现 | `packages/compaction/compaction-basic/src/{index,config,region,summarizer,types}.ts` |
| 无模型裁剪 | `packages/compaction/compaction-tool-result-pruner/` |
| LLM 抽象/DeepSeek 适配 | `packages/llm/llm/src/types.ts`、`packages/llm/llm-deepseek/src/{translate,serialize}.ts` |
| Token 计量 | `packages/llm/token-meter/` |
| 缓存实证 | `packages/core/agent-loop/tests/request-cache.e2e.ts` |
| 仓库规范 | `AGENTS.md`、`packages/AGENTS.md`、`docs/architecture.md` |
