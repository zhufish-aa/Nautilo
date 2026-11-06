# 第 4 章 Surface 视图层：给模型看的那扇窗

> 第 3 章我们有了"账本"（事件日志），但模型不能直接读账本——太碎了。
> 这一章讲 DSH 怎么"从账本里实时算出一排节点"，让模型看到干干净净的对话。
> **本章是全书最难、也最重要的概念之一**：Surface 上的一个动作（append / replace）直接决定缓存好不好、压缩对不对。请务必跟上。

---

## 4.1 问题再具象一点：模型到底该看到什么？

第 3 章那本"账本"长这样：

```
seq 1   user/message        用户说…
seq 2   turn/start          轮次边界（模型不该看这个）
seq 3   step/start          步边界（也不该看）
seq 4   assistant/chunk     "我" （碎片，不该单独看）
seq 5   assistant/chunk     "来看"
seq 6   assistant/message   完整回复 + tool/call
seq 7   tool/call           工具调用
seq 8   tool/result         工具结果
...
```

如果**直接把整本账本发给模型**，模型会看到一堆 `turn/start`、`step/start`、`chunk`…… 乱七八糟。模型会困惑，"这些是什么？" 而且请求里塞满垃圾也浪费缓存。

**所以 DSH 定义了一个"投影层"：Surface（表面）**——它实时维护"模型应该看到的那一排节点"。

**再打一次比方：**
- 账本 = 后台记账的全部明细（什么都记）。
- Surface = 前台给旅客看的那张"已出行程单"（只列用户消息、助手消息、工具结果这几样，工整好看）。

---

## 4.2 Surface 上只有三类节点

DSH 规定，Surface（也就是"模型能看到的对话"）只包含**三种**事件：

| Surface 节点类型 | 是什么 |
|---|---|
| `user/message` | 用户说的话 |
| `assistant/message` | 模型说的完整回复 |
| `tool/result` | 工具返回的结果 |

注意：`tool/call`（模型发起调用）**不单独占据一个 Surface 节点**——它作为 `assistant/message` 的一部分存在（模型那条回复里带了"我要调工具"的信息），而它的结果 `tool/result` 单独成一个节点。这样模型看到的序列是干净清楚的：

```
user/message  →  assistant/message（含工具调用意图）→  tool/result →  assistant/message（下一步）→ …
```

这就是 DSH 在代码里给 `SURFACE_EVENT_TYPES` 定义的那三个成员。**任何其他事件都不上 Surface。**

---

## 4.3 SurfaceOp：节点怎么"进"Surface

现在问题来了：日志里每条事件怎么知道"我该不该上 Surface、我该以什么方式上"？

靠一个叫 **`surfaceOp`（表面操作）** 的标记。有两种：

### ① `surfaceOp: 'append'`（追加）

意思："把这条消息**接到 Surface 末尾**。"

正常的对话流就是这样：
- 用户发消息 → `user/message` 带 `append` → Surface 末尾多一条
- 模型回复 → `assistant/message` 带 `append` → Surface 末尾多一条
- 工具返回 → `tool/result` 带 `append` → Surface 末尾多一条

**Append = 对话一直在变长，永不回头。** 这正好对上第 3 章"只增不改"的精神，也正好是缓存最喜欢的样子（前缀稳定）。

### ② `surfaceOp: { op: 'replace', start, end }`（替换）

意思："把 Surface 上从 `start` 到 `end` 这一段的旧节点，**整体换成一个新节点**。"

这在什么时候用？——**压缩的时候**（第 9、10 章讲）。对话太长了，DSH 把一段历史用模型总结成一个 `summary`，然后：

- 源 log 里旧的 `user/message`、`assistant/message`、`tool/result` 事件**全都保留在账本里**（一条不删）；
- 但 Surface 上，它们被换成了一条新的 "checkpoint 摘要" 节点。

**关键差别记住：**
> Replace 只是 Surface 上的"视觉替换"，账本里的旧事件一条都没少。

这就是为什么压缩是**可逆、可追溯**的——因为真相（账本）没变，变的只是"给模型看的那扇窗"。

---

## 4.4 Replace 会"遮蔽"历史，读懂这个词

DSH 管被替换掉的旧节点叫"**被遮蔽（shadowed）**"。

来看一个例子。假设 Surface 现在是：

```
节点① 用户："讲讲压缩"      （user/message）
节点② 助手：长篇解释         （assistant/message）
节点③ 工具：返回某个文档     （tool/result）
节点④ 用户："继续"           （user/message）
```

如果 `节点①到③` 太长，压缩触发，DSH 会做一次 replace：把节点①到③换成一条新的 `summary` 摘要节点：

```
节点⑤ 用户：<摘要>（原①~③浓缩）   （user/message, surfaceOp replace）
节点④ 用户："继续"                 （user/message）仍保留
```

- **被遮蔽的** 是 ① ② ③（它们在 Surface 上消失，但在账本里还在）。
- **ShadowedSeqs** 这个词你会反复见到——它就是指"这次 replace 把哪些 seq 遮掉了"：`[seq(①), seq(②), seq(③)]`。

DSH 记账时会把这个列表写进事件里（`sourceEventSeqs`），保证"这次替换影响到了哪些历史"是**完全可见、可审计**的。

---

## 4.5 为什么 Replace 会让缓存"失效"？——全书关键

现在我们把第 3 章和第 4 章串起来，回答一个要害问题。

模型的 Prompt Cache（第 8 章详讲）是这样工作的：
> 如果两次请求的**前缀字节完全一样**，云服务可以复用第一次算好的缓存，省时省钱。

append 的情况：每次请求 = 老前缀 + 新尾巴。老前缀没动 → **缓存完整命中**。完美。

replace 的情况：你往 Surface **中间**塞进了一个 summary 节点。这意味着从被替换位置开始，**后面的每一个 token 的"身份"都变了**（模型看到的不再是原来的第 N 个 token）。于是缓存从那个位置开始**全部作废**，要重新计算。

用大白话：
> Append 像往本子最后续页——前面的内容没动，缓存全保住。
> Replace 像把中间几页换成新页——从换页处往后，之前算好的东西全都不作数了。

这就是为什么 DSH 做压缩时**极其小心翼翼**：能 append 就 append，非 replace 不可时，也要考虑"怎么换最省缓存"（摘要复用技巧，第 10 章）。

---

## 4.6 从日志重算 Surface：`foldSurface` 完整重放

DSH 是怎么维护"当前 Surface"的？两个办法：

**办法一：完整重放（foldSurface）。**
从头到尾读一遍账本，遇到 `append` 就往末尾加节点，遇到 `replace` 就把那一段替换成一个节点。这种方式**任何时刻重新跑一遍，结果一定一致**——这就是"真相可重放"的又一次体现。

**办法二：增量维护（SurfaceManager）。**
不用每次从头读。它记住"当前节点列表"和一个计数器 `replaceGeneration`（记录发生过多少次 replace）。每次来新事件，只做一次增量更新。

`replaceGeneration` 这个计数器很重要，它会在压缩"重试"逻辑里出现（第 10 章）：只要发生过 replace，说明"展板变了"，DSH 就知道"有实质进展"了。

---

## 4.7 一切行为都有校验：乱来会抛错

DSH 对 Surface 的正确性有很严的"纪律"，违反就报错。挑两个必须记住的：

- **工具结果改写只能改内容**：如果你给一个 `tool/result` 做 replace，那只能替换**一个**现有节点，而且除了 `content` 以外其他字段必须和原来**完全相等**。为什么？因为工具调用的"身份"（callId、name、arguments）不能变，变了就破坏调用链。只允许修结果文本。
- **来源可达性（provenance）**：凡是 replace，它声称"遮蔽了 seq 1、2、3"，那这些 seq 必须是**真实存在于当前 Surface 上的节点**，不许瞎编。这是把"可追溯"落实成代码约束。

---

## 4.8 一张表总结 Append vs Replace

| | `append` | `replace` |
|---|---|---|
| 作用 | 在末尾加一个节点 | 替换中间一段节点 |
| 什么时候用 | 正常对话流（用户消息/模型回复/工具结果） | 压缩、改写工具结果 |
| 账本里的旧事件 | 保留（当然） | **保留**（只是 Surface 上遮蔽） |
| 缓存影响 | 前缀不动，缓存全保 | 从替换处起缓存作废 |
| 人类看的 transcript | 用 append 型事件 | 人类看的是原版（append-origin） |
| 可追溯性 | 天然 | 靠 sourceEventSeqs / provenance 校验保证 |

最后一行"人类看的 transcript"补一句：**人类（用户界面）看到的聊天记录，用的是 append-origin 事件**——也就是"真正发生过的那版"，而不是被压缩替换后的摘要。所以用户仍能往上翻看完整原文，模型却只看到浓缩版。这很贴心吧。

---

## 4.9 本章自测

1. Surface 上允许出现哪三类节点？为什么不放 `tool/call` 单独节点？
2. `surfaceOp` 两种值分别是什么？replace 长什么样（对象结构）？
3. 用自己的话说：replace 和 append 对模型缓存的影响有什么不同？为什么？
4. "被遮蔽（shadowed）"是什么意思？被遮蔽的事件在账本里还在吗？
5. `replaceGeneration` 计数器是干什么的？它可能在什么时候被用到？
6. 为什么要规定"tool/result 的 replace 只能改 content"？

---

## 4.10 下一章预告

现在你有了"账本"和"窗户（Surface）"，该有"人"来用了——**Agent Loop（循环驱动器）**。第 5 章我们看那台机器是怎么转起来的：状态机怎么管"空闲/运行/维护"，turn 和 step 是什么关系，模型请求怎么被一步步发出去。

> 记住这句话再走：
> **Surface 是从日志投影出的"模型可见对话"；append 保持缓存友好，replace 用于压缩但会让缓存失效——这两者的分寸，是 DSH 所有精密设计的源泉。**
