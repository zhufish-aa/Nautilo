# DeepSeek Harness 新手详细介绍

> 本文面向第一次接触 Agent Harness、Agent Loop、Prompt Cache 和事件溯源的开发者。
>
> 目标不是让你马上看懂 DeepSeek Harness 的所有源码，而是先建立一张完整的地图：它解决什么问题、每个模块为什么存在、一次对话到底发生了什么，以及 Nautilo 可以怎样借鉴它。

本文研究的源码位于：

```text
work/deepseek-harness/
```

研究版本：

```text
v0.1.0-rc.7
commit 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
```

官方项目：

- [DeepSeek Harness GitHub](https://github.com/deepseek-ai/deepseek-harness)
- [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md?plain=1)
- [Core subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md)
- [Session package](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/session)

---

## 1. 先用一句话理解 DeepSeek Harness

DeepSeek Harness 可以理解为：

> 一个负责驱动大模型、管理工具、保存会话、恢复运行、压缩上下文、处理权限，并尽可能提高 Prompt Cache 命中率的 Agent 运行框架。

它不只是一个“调用 API 的函数”，也不只是一个“工具调用循环”。

一个简单的 Agent 可能只有下面几步：

```text
发送用户问题
  ↓
调用大模型
  ↓
如果模型要求工具，就执行工具
  ↓
把工具结果发回模型
  ↓
得到最终答案
```

这能工作，但很快会遇到很多实际问题：

- 大模型输出了一半，程序崩溃了，怎么恢复？
- 后端明明已经产生输出，前端为什么没有及时显示？
- 工具执行到一半，用户点击停止，应该怎么处理？
- 工具结果太长，下一次请求超出上下文窗口怎么办？
- 每次请求都重新发送很长的 system prompt，Prompt Cache 还能命中吗？
- 用户切换权限后，之前的上下文还能不能重放？
- 一个子 Agent 应该继承父 Agent 的哪些内容？
- 怎样知道一次请求到底用了多少缓存 Token？

Harness 解决的就是这些“真实运行时问题”。

---

## 2. 先认识几个容易混淆的词

### 2.1 LLM

LLM 是 Large Language Model，也就是大语言模型。

例如：

- DeepSeek
- GPT
- Claude
- Gemini
- Qwen

它们通常提供一个接口：你发送消息，它返回文本、推理内容或工具调用。

### 2.2 Agent

Agent 是一个能围绕目标持续工作的模型程序。

它通常不只回答一次，而是会：

```text
理解任务
  ↓
决定是否需要工具
  ↓
调用工具
  ↓
读取工具结果
  ↓
继续思考
  ↓
再次调用工具或给出答案
```

例如用户说：

```text
帮我找到项目里所有登录相关的代码，并总结问题。
```

Agent 可能会：

```text
调用 glob
  ↓
调用 grep
  ↓
读取几个文件
  ↓
分析结果
  ↓
生成总结
```

### 2.3 Agent Loop

Agent Loop 就是 Agent 的循环控制器。

最简单的伪代码是：

```ts
while (任务还没有结束) {
  const response = await model.generate(messages, tools)

  if (response 没有工具调用) {
    return response
  }

  const results = await executeTools(response.toolCalls)
  messages.push(response)
  messages.push(...results)
}
```

DeepSeek Harness 的 `ReactLoopAgent` 做的就是这个事情，但它还额外处理：

- turn 和 step
- 流式 chunk
- 取消和恢复
- 工具并行执行
- 错误和重试
- 会话日志
- 动态上下文
- 请求重建
- 压缩

源码位置：

```text
work/deepseek-harness/packages/core/agent-loop/src/agent.ts
```

### 2.4 Tool

Tool 是模型可以请求程序执行的工具。

例如：

```text
read_file
write_file
grep
shell
web_search
ask_user_question
```

模型不是直接执行这些工具，而是返回一个结构化请求：

```json
{
  "name": "read_file",
  "arguments": {
    "path": "src/main.ts"
  }
}
```

程序收到后，才真正执行工具。

### 2.5 Session

Session 是一次持续的会话。

它不仅是“消息数组”，还包括：

- 用户消息
- 模型消息
- 工具调用
- 工具结果
- 流式输出片段
- 请求使用的模型
- Token 使用量
- 权限变化
- 压缩记录
- 错误
- turn 和 step 边界

DeepSeek Harness 把 Session 设计成一个可以恢复和重放的事件日志。

### 2.6 Prompt Cache

Prompt Cache 是模型服务商对“之前已经处理过的输入前缀”进行复用。

如果两次请求的开头完全相同，服务商可能不需要重新计算这一部分。

例如第一次请求：

```text
[SYSTEM][TOOLS][用户问题 1]
```

第二次请求：

```text
[SYSTEM][TOOLS][用户问题 1][模型回答 1][工具结果 1]
```

第二次请求的开头和第一次一样，所以有机会复用缓存。

注意：Prompt Cache 不是程序本地缓存，也不是简单地把响应存起来。它是模型服务商在处理请求时复用 KV Cache 的机制。

---

## 3. 一次 Agent 请求到底发生了什么

下面用一个例子说明。

用户输入：

```text
请读取 package.json，然后告诉我项目使用什么包管理器。
```

Agent 可能经历以下步骤。

### 第一步：用户消息进入 Inbox

用户消息不会直接跳进模型 API，而是先进入 Agent 的输入队列：

```text
Agent Inbox
```

这样做的好处是：

- 可以排队
- 可以区分下一轮输入和当前步骤的 steering 输入
- 可以在取消时清理未处理消息
- 可以记录消息什么时候被接收和认领

### 第二步：开始一个 Turn

Turn 可以理解为一次完整的用户任务处理过程。

例如：

```text
turn/start { turn: 1 }
```

一个 Turn 里面可能有多个 Step。

### 第三步：开始一个 Step

Step 是一次模型请求及其工具处理过程。

例如：

```text
step/start { turn: 1, step: 1 }
```

### 第四步：组装上下文

Harness 会准备：

```text
稳定的 system prompt
当前可用的工具 schema
动态运行时上下文
Session 中当前可见的消息
```

### 第五步：发送模型请求

请求大致是：

```text
system prompt
+ tools
+ user message
```

模型可能返回一个工具调用：

```json
{
  "tool": "read_file",
  "arguments": {
    "path": "package.json"
  }
}
```

### 第六步：流式接收模型输出

模型的输出可能是一个个 chunk：

```text
assistant/chunk: "我先"
assistant/chunk: "读取"
assistant/chunk: " package.json"
assistant/chunk: tool-call delta
```

这些 chunk 会及时写入 Session Log。

### 第七步：提交完整的 Assistant Message

流结束后，Harness 会把 chunk 组装成一个完整消息：

```text
assistant/message
```

这个消息还会记录它由哪些 chunk 组成：

```json
{
  "type": "assistant/message",
  "sourceEventSeqs": [12, 13, 14, 15]
}
```

这样既可以实时显示，也可以在以后恢复出最终消息。

### 第八步：执行工具

Harness 检查：

- 工具是否存在
- 参数是否合法
- 是否允许执行
- 是否需要用户审批
- 是否超时
- 当前任务是否已经取消

然后执行 `read_file`。

### 第九步：记录工具结果

工具结果会被写入：

```text
tool/result
```

例如：

```text
文件内容：
{
  "packageManager": "pnpm@11.7.0"
}
```

### 第十步：开始下一个 Step

工具结果进入模型上下文：

```text
[SYSTEM][TOOLS][USER][ASSISTANT_TOOL_CALL][TOOL_RESULT]
```

然后模型再次请求：

```text
package.json 使用 pnpm 作为包管理器。
```

### 第十一步：结束 Turn

最后记录：

```text
step/end { turn: 1, step: 2 }
turn/end { turn: 1, reason: "completed" }
```

完整流程可以画成：

```text
用户输入
  ↓
Inbox
  ↓
turn/start
  ↓
step/start
  ↓
组装 system + tools + history
  ↓
模型流式输出
  ↓
assistant/chunk
  ↓
assistant/message
  ↓
执行工具
  ↓
tool/result
  ↓
再次请求模型
  ↓
最终回答
  ↓
step/end
  ↓
turn/end
```

---

## 4. 为什么 DeepSeek Harness 不直接保存一个 messages 数组

初学者通常会想：

```ts
const messages: Message[] = []
```

每次把消息 push 进去不就行了吗？

简单 Demo 可以这样做，但生产环境会有问题。

### 问题一：消息数组不能很好地记录过程

如果模型输出了一半就崩溃：

```text
已经收到 300 个字符
还没有收到最终响应
程序崩溃
```

普通 messages 数组通常不知道这 300 个字符来自哪里，也不知道它是否应该算作最终消息。

### 问题二：工具调用和结果容易失配

可能出现：

```text
模型产生了 tool call
程序还没有写入结果就崩溃
```

恢复时必须知道这个调用到底有没有开始执行、执行结果是否未知、是否可以安全重试。

### 问题三：压缩无法解释历史变化

如果你把旧消息直接删掉，之后无法知道：

- 哪些内容被压缩了
- 摘要替代了什么
- 摘要请求是否成功
- 是否需要重新压缩

### 问题四：无法审计模型真正看到了什么

生产环境经常需要回答：

```text
这次请求到底发送了什么 system prompt？
当时有哪些工具？
权限是什么？
模型为什么看到这段内容？
```

单纯的 messages 数组不容易回答这些问题。

因此 Harness 使用：

```text
Event Log 作为事实源
  ↓
Surface 作为模型可见消息投影
  ↓
Messages 作为请求时派生结果
```

---

## 5. 三层 Session 结构：Log、Surface、Messages

这是理解 DeepSeek Harness 最重要的部分。

### 5.1 第一层：Raw Event Log

Raw Event Log 是完整的事件流水账。

例如：

```text
seq 0  request/header
seq 1  turn/start
seq 2  step/start
seq 3  user/message
seq 4  assistant/chunk
seq 5  assistant/chunk
seq 6  assistant/message
seq 7  tool/call
seq 8  tool/result
seq 9  step/end
seq 10 turn/end
```

事件日志记录了过程中的事实。

它不一定全部直接发送给模型。

### 5.2 第二层：Surface

Surface 是“当前模型能看到的消息节点”。

通常包括：

```text
user/message
assistant/message
tool/result
```

通常不直接进入模型消息历史的包括：

```text
assistant/chunk
turn/start
step/start
usage
request/header
permission audit
```

Surface 还支持替换。

例如原来是：

```text
[很长的旧对话][最近问题][工具结果]
```

压缩后变成：

```text
[旧对话摘要][最近问题][工具结果]
```

Raw Log 仍然保留原来的旧对话，但 Surface 不再让模型看到它们。

### 5.3 第三层：Derived Messages

真正发给模型的消息，是从 Surface 派生出来的：

```ts
const messages = session.deriveMessages()
```

这有一个非常重要的好处：

> 不允许 UI、Provider、Compaction 各自维护一份不同的消息历史。

所有地方都从同一个事件源派生。

源码位置：

```text
work/deepseek-harness/packages/core/session/src/index.ts
work/deepseek-harness/packages/core/session/src/surface.ts
```

---

## 6. Prompt Cache 到底是怎么命中的

### 6.1 先理解“前缀”

把一次请求想象成一串 Token：

```text
T1 T2 T3 T4 T5 T6 T7 T8 T9 T10 ...
```

如果下一次请求开始的 Token 仍然是：

```text
T1 T2 T3 T4 T5 T6 T7 T8 T9 T10 ...
```

那么服务商就可能复用之前已经计算过的部分。

请求变化通常从第一个不同的 Token 开始失去复用。

### 6.2 一个容易命中缓存的请求序列

第一次：

```text
[SYSTEM][TOOLS][USER_1]
```

第二次：

```text
[SYSTEM][TOOLS][USER_1][ASSISTANT_1][TOOL_RESULT_1]
```

第三次：

```text
[SYSTEM][TOOLS][USER_1][ASSISTANT_1][TOOL_RESULT_1][ASSISTANT_2]
```

前面的部分一直没有变化，所以比较容易获得缓存命中。

### 6.3 一个容易破坏缓存的设计

假设 system prompt 每次都包含当前时间：

```text
You are Nautilo.
Current time: 2026-08-17 19:03:17
```

下一次请求变成：

```text
You are Nautilo.
Current time: 2026-08-17 19:03:20
```

从当前时间所在位置开始，后面的 Token 都可能无法复用。

如果动态内容出现在 system prompt 很靠前的位置，损失会更大。

### 6.4 DeepSeek Harness 的做法

它把内容分成两类。

#### 稳定内容

放在 system prompt 或稳定工具 schema 中：

```text
你是谁
固定的行为规则
固定的工具使用规则
稳定的工具描述
```

#### 动态内容

作为追加的上下文消息：

```text
当前工作目录
当前权限
当前任务状态
当前 todo
当前环境观察
```

这样动态信息变化时，只会增加新的后缀，而不会从 system prompt 开头破坏缓存。

源码位置：

```text
work/deepseek-harness/packages/core/agent-loop/src/runtime-context.ts
```

### 6.5 工具 Schema 也会影响缓存

工具定义本身也会进入模型请求：

```json
[
  {
    "name": "read_file",
    "description": "读取文件",
    "parameters": { ... }
  }
]
```

如果每一轮都改变：

- 工具顺序
- description
- JSON key 顺序
- 参数 schema
- 工具数量

就可能破坏工具部分之后的缓存。

因此应该做到：

```text
工具名称稳定
工具顺序稳定
工具描述稳定
Schema 序列化稳定
动态权限在执行阶段判断
```

### 6.6 缓存不等于总是命中

即使程序写得很好，也不保证每次都命中。原因可能包括：

- Provider 的缓存策略不同
- 缓存有过期时间
- 请求路由不同
- model 不同
- system prompt 不同
- tools 不同
- 序列化方式不同
- 服务器缓存容量有限
- 请求之间间隔太久

所以 Harness 不只是“努力保持前缀稳定”，还要记录实际使用量。

---

## 7. Token 使用量应该怎么看

DeepSeek API 可能返回：

```text
prompt_tokens
prompt_cache_hit_tokens
prompt_cache_miss_tokens
completion_tokens
```

其中：

```text
prompt_tokens = cache_hit + cache_miss
```

例如：

```text
prompt_tokens = 10000
cache_hit = 8000
cache_miss = 2000
output = 500
```

那么内部应该记录：

```ts
{
  inputTokens: 2000,
  cacheReadTokens: 8000,
  outputTokens: 500
}
```

不能这样记录：

```ts
{
  inputTokens: 10000,
  cacheReadTokens: 8000,
  outputTokens: 500
}
```

因为那会把缓存部分重复计算。

### 推荐的 UI 展示

```text
上下文占用：32,000 / 128,000
未缓存输入：2,000
缓存输入：8,000
缓存命中率：80%
输出：500
```

### 为什么要记录 cacheReadTokens

因为只看总 Prompt Token，无法判断：

- 是真的重新计算了 10000 Token
- 还是其中 8000 Token 来自缓存

对于你关心的 Token Cache，`cacheReadTokens` 是非常重要的可观测指标。

源码位置：

```text
work/deepseek-harness/packages/llm/llm-deepseek/src/translate.ts
work/deepseek-harness/packages/llm/token-meter/src/index.ts
```

---

## 8. Compaction：为什么需要压缩上下文

模型有上下文窗口限制。

例如一个模型支持 128K Token，但对话不断增长：

```text
第 1 轮：5K
第 2 轮：15K
第 5 轮：50K
第 10 轮：120K
```

如果继续追加，很快就会超过限制。

### 8.1 最简单的压缩方式

把旧消息总结成一段摘要：

```text
旧消息 1
旧消息 2
旧消息 3
旧工具结果
  ↓
摘要
```

模型以后看到：

```text
[摘要][最近历史]
```

### 8.2 DeepSeek Harness 不直接删除旧日志

它的做法是：

```text
Raw Log 保留原始历史
Surface 用摘要替换旧消息
Derived Messages 只使用新的 Surface
```

也就是说，压缩不是销毁历史，而是改变模型未来看到的投影。

### 8.3 压缩流程

大致是：

```text
测量当前上下文压力
  ↓
选择旧的完整消息范围
  ↓
不能拆开 tool call 和 tool result
  ↓
记录 compaction/start
  ↓
调用摘要模型
  ↓
确认历史在摘要期间没有改变
  ↓
确认摘要确实比原内容短
  ↓
写入 replacement message
  ↓
记录 compaction/end
  ↓
等待持久化完成
```

源码位置：

```text
work/deepseek-harness/packages/compaction/compaction-basic/src/region.ts
work/deepseek-harness/packages/compaction/compaction-basic/src/summarizer.ts
```

### 8.4 为什么摘要请求也要复用缓存

一个错误做法是：

```text
使用一套全新的摘要 system prompt
把所有历史重新拼进去
```

这样摘要请求和普通请求的前缀不同，之前的缓存很难复用。

DeepSeek Harness 的做法是：

```text
[原来的 system prompt]
[原来的 tools]
[原来的历史]
[最后追加 compaction 指令]
```

也就是把摘要指令放在最后，尽量保留之前的请求前缀。

### 8.5 Tool Result Pruning

有些工具结果不需要调用模型总结，可以直接裁剪。

例如一个文件搜索工具返回 100000 个字符：

```text
保留开头 2000 字符
插入“中间内容已省略”
保留结尾 2000 字符
```

这样做的优点：

- 不需要额外模型调用
- 结果确定
- 速度快
- 适合 shell 输出、日志、搜索结果
- 原始日志仍然可以保留完整内容

源码位置：

```text
work/deepseek-harness/packages/compaction/compaction-tool-result-pruner/src/index.ts
```

### 8.6 压缩会影响缓存

压缩会替换旧历史，因此从被替换的第一条消息开始，后面的原缓存可能失效。

这是正常的。

所以正确目标不是“永远不压缩”，而是：

```text
尽可能晚压缩
保留最近的重要内容
一次压缩出足够大的收益
不要频繁小范围改写历史
```

---

## 9. Tool 执行与权限

### 9.1 模型不能直接执行程序

模型只能请求：

```text
请调用 shell
```

真正执行的是程序里的 Tool Runtime。

Tool Runtime 需要负责：

```text
验证工具名
验证参数
检查权限
检查沙箱
处理审批
设置超时
执行工具
规范化结果
写入日志
```

### 9.2 权限不要只靠隐藏工具

一种简单但不理想的实现是：

```text
有权限：发送 shell 工具
没权限：不发送 shell 工具
```

这会导致每次权限变化都改变工具列表，可能影响 Prompt Cache。

更稳定的方式是：

```text
工具 schema 保持稳定
执行时检查当前权限
无权限时返回稳定的拒绝结果
```

例如：

```text
shell 工具仍然存在
  ↓
模型请求 shell
  ↓
执行器检查权限
  ↓
拒绝，并返回：当前会话权限不允许执行该操作
```

### 9.3 审批结果应该有明确分类

不要把所有情况都当成普通错误。

至少区分：

```text
allowed-once  用户允许这一次
rejected      用户拒绝
cancelled     请求被取消
unavailable   没有可用的审批 UI 或 answerer
```

DeepSeek Harness 还会把审批请求和审批结果写入日志，保证以后可以审计。

源码位置：

```text
work/deepseek-harness/packages/interaction/user-approval/src/index.ts
```

### 9.4 工具并行执行

并不是所有工具都能并行。

可以并行的例子：

```text
grep 文件 A
grep 文件 B
grep 文件 C
```

应该串行的例子：

```text
写文件 A
再次读取文件 A
```

DeepSeek Harness 用两种分类：

```text
parallel   可以和同组工具重叠执行
exclusive  必须形成顺序屏障
```

但即使工具并行执行，最终结果仍然按模型的调用顺序写入历史。

源码位置：

```text
work/deepseek-harness/packages/core/agent-loop/src/tool-calls.ts
```

---

## 10. Sub-Agent：子 Agent 到底继承什么

### 10.1 Spawn

Spawn 可以理解为新建一个 Agent：

```text
父 Agent
  ↓
创建一个新的子 Agent
  ↓
子 Agent 从新的任务开始
```

它通常不继承父 Agent 的完整对话。

### 10.2 Fork

Fork 是复制父 Agent 的一部分历史，然后创建子 Agent。

但不能随便复制当前日志。

假设父 Agent 当前正在执行：

```text
turn 3 开始
assistant 发出了 tool call
工具还没有返回
```

此时复制会得到一个不完整的对话。

DeepSeek Harness 只复制到最后一个完整的：

```text
turn/end
```

也就是：

```text
父 Agent:
  完整 turn 1
  完整 turn 2
  正在执行 turn 3

子 Agent:
  继承 turn 1
  继承 turn 2
  不继承 turn 3
```

源码位置：

```text
work/deepseek-harness/packages/subagent/subagent-fork-in-process/src/index.ts
```

### 10.3 上下文继承不等于权限继承

这是一个非常重要的安全原则。

子 Agent 可以继承：

```text
父 Agent 已完成的对话
```

但不一定继承：

```text
父 Agent 的权限
父 Agent 的工具限制
父 Agent 的审批状态
父 Agent 的 live scope
```

必须分别决定。

### 10.4 Fork 对缓存的影响

如果子 Agent 使用：

```text
相同 provider
相同 model
相同 system prompt
相同 tools
相同序列化方式
```

那么继承的前缀有机会复用缓存。

但如果子 Agent 额外增加：

```text
子 Agent 专用工具
子 Agent 专用 system prompt
report 工具
不同权限说明
```

这些内容如果放在继承历史之前，就会破坏父级缓存前缀。

---

## 11. Cordis Plugin 是什么

DeepSeek Harness 使用 Cordis 作为插件系统。

可以先把它理解成一个“可以装卸的功能模块系统”。

例如：

```text
Session 插件
LLM 插件
Tool 插件
Agent Loop 插件
Compaction 插件
Permission 插件
Persistence 插件
```

每个插件可以：

- 提供一个服务
- 注册事件监听器
- 注册工具
- 注册请求处理逻辑
- 在卸载时清理自己的资源

### 为什么要插件化

如果所有逻辑都写在一个巨大 Agent 类里，会变成：

```text
Agent 类知道模型
Agent 类知道权限
Agent 类知道压缩
Agent 类知道子 Agent
Agent 类知道 UI
Agent 类知道数据库
```

最后任何改动都会影响整个系统。

插件化后：

```text
Agent Loop 负责循环
LLM Plugin 负责模型连接
Tool Plugin 负责工具
Permission Plugin 负责权限
Compaction Plugin 负责压缩
Persistence Plugin 负责保存
```

Agent Loop 通过事件和服务调用它们。

### 重要原则

DeepSeek Harness 的 README 里有一句很重要的话：

> `agent-loop` 是唯一包含具体循环逻辑的包；其他功能应该通过插件和扩展点加入，而不是不断修改循环本身。

这意味着：

```text
新功能优先加插件
不要每次都修改核心 while 循环
```

架构文档：

```text
work/deepseek-harness/docs/architecture.md
```

---

## 12. DeepSeek Harness 的包怎么理解

不需要一开始看完整个 monorepo，可以先看下面这些包。

| 包 | 新手理解 | 主要职责 |
|---|---|---|
| `core/session` | 会话账本 | 保存所有事件，派生模型消息 |
| `core/agent` | Agent 类型和注册表 | 管理 Agent 身份和生命周期 |
| `core/agent-loop` | 循环引擎 | 驱动 turn、step、模型请求和工具 |
| `core/system-prompt` | Prompt 组装器 | 组装 system、动态上下文和工具 |
| `core/tools` | 工具运行时 | 注册、校验、执行和保护工具 |
| `llm/llm` | 模型抽象层 | 定义请求、消息、chunk、usage 类型 |
| `llm/llm-deepseek` | DeepSeek 适配器 | 调用 DeepSeek API 并翻译流式响应 |
| `llm/token-meter` | Token 统计 | 估算压力、记录缓存和输出 |
| `compaction/compaction-basic` | 基础压缩 | 选择旧历史并调用模型摘要 |
| `compaction/compaction-tool-result-pruner` | 工具结果裁剪 | 确定性裁剪超长工具输出 |
| `session/session-persistence-jsonl` | JSONL 持久化 | 把会话保存到文件 |
| `interaction/user-approval` | 审批服务 | 处理工具审批和审计 |
| `subagent/*` | 子 Agent | spawn、fork、ACP 等子 Agent 后端 |

建议阅读顺序：

```text
1. core/session/README.md
2. core/agent-loop/README.md
3. core/tools/README.md
4. llm/llm-deepseek
5. llm/token-meter/README.md
6. compaction/compaction-basic/README.md
7. subagent/subagent-fork-in-process/README.md
```

---

## 13. DeepSeek Harness 和 Nautilo 的关系

Nautilo 当前已经有一些与 Harness 相似的基础设施：

```text
Provider Plugin
Provider SDK
RunService
Session Service
Event Journal
Event Subscription
Recovery Service
Permission Prompt
MCP Runtime Bridge
Model Catalog
```

相关源码位置：

```text
packages/provider-sdk/
packages/core-daemon/src/runtime/run-service.ts
packages/core-daemon/src/runtime/recovery-service.ts
packages/core-daemon/src/runtime/event-subscription-service.ts
packages/core-daemon/src/runtime-mcp-bridge.ts
packages/core-daemon/src/adapters/model-config.ts
```

但 Nautilo 当前的 Provider 仍然承担了比较多的运行逻辑。

不同 Provider 可能分别处理：

- ACP 事件
- CLI 输出
- 子 Agent
- 权限
- resume
- provider-specific tool 事件
- provider-specific usage

如果要做 Nautilo Native Harness，推荐逐步把通用逻辑收回 Nautilo：

```text
Nautilo Native Harness
  ├── 统一 Agent Loop
  ├── 统一 Session Event Log
  ├── 统一 Tool Runtime
  ├── 统一 Permission
  ├── 统一 Token Usage
  ├── 统一 Compaction
  └── Provider 只保留模型通信和协议翻译
```

Provider 最终更适合只负责：

```text
发送请求
接收流
翻译 provider-specific 事件
发现模型
恢复 provider 原生会话
```

而不负责：

```text
通用 turn 生命周期
通用工具调度
通用权限逻辑
通用上下文压缩
通用前端事件语义
```

---

## 14. 当前 Nautilo 前端“暂停后突然全部输出”的问题，和 Harness 有什么关系

这个问题可以分成两个层次。

### 第一层：事件传输可靠性

后端已经产出事件，但前端没有及时收到，通常涉及：

```text
广播通知丢失
订阅游标不一致
前端 hydration 竞态
事件等待没有重新读取 journal
```

Nautilo 已经针对这部分做了修复：

- `event.wait()` 周期性重放持久化 journal
- 广播 receiver lag 后重新 replay
- 前端按 projectRun 串行 hydration
- 读取失败后 reset subscription 并从 cursor 恢复

相关文件：

```text
packages/core-daemon/src/runtime/event-subscription-service.ts
rust/nautilo-core/src/runtime/event_subscription_service.rs
apps/desktop/src/renderer/src/lib/orchestration-runtime.ts
```

### 第二层：Native Harness 的输出模型

如果未来 Nautilo 使用自己的 Harness，建议把输出分为：

```text
assistant/chunk       实时增量
assistant/message     最终提交消息
turn/end             当前任务结束
```

前端应该：

```text
实时显示 chunk
最终以 assistant/message 校正状态
断线后从 event cursor 继续
没有收到 chunk 时，也可以从最终 message 恢复
```

所以，事件订阅修复解决“事件有没有送到前端”，而 Harness 的 Session 设计解决“这些事件如何成为可靠的模型运行记录”。两者都需要。

---

## 15. Nautilo Native Harness 建议的最小版本

不要一开始实现 DeepSeek Harness 的全部功能。

可以先做一个最小但方向正确的版本。

### 第一步：统一请求类型

定义一个不依赖具体 Provider 的请求：

```ts
interface CanonicalModelRequest {
  provider: string
  model: string
  system?: string
  tools: ToolSchema[]
  messages: Message[]
  temperature?: number
  maxTokens?: number
  signal: AbortSignal
}
```

### 第二步：统一流式 chunk

```ts
interface ModelChunk {
  type:
    | "text-delta"
    | "reasoning-delta"
    | "tool-call-delta"
    | "usage"
    | "finish"

  text?: string
  toolCall?: ToolCallDelta
  usage?: ModelUsage
}
```

### 第三步：建立 Session Event Log

至少记录：

```text
turn/start
step/start
user/message
assistant/chunk
assistant/message
tool/call
tool/result
request/header
usage
step/end
turn/end
```

### 第四步：实现一个统一 Loop

先支持：

```text
用户消息
→ 模型流
→ 一个或多个工具调用
→ 工具结果
→ 下一次模型流
→ 最终回答
```

先不要做复杂子 Agent 和复杂压缩。

### 第五步：实现 Token Cache Telemetry

先把 provider 返回的 usage 统一显示出来：

```text
inputTokens
cacheReadTokens
cacheWriteTokens
outputTokens
```

### 第六步：实现稳定前缀策略

固定：

```text
system prompt
工具顺序
工具 schema 序列化
```

动态信息追加到消息历史，而不是修改 system prompt。

### 第七步：实现工具结果裁剪

先处理：

```text
shell 输出
read_file 输出
grep 输出
git diff 输出
```

之后再实现模型摘要压缩。

---

## 16. 一张完整的目标架构图

```text
┌──────────────────────────────────────────────┐
│                 Nautilo Web / Desktop UI     │
│                                              │
│  从 session/event 投影消息、工具、状态、usage │
└───────────────────────┬──────────────────────┘
                        │
                        │ Event Subscription
                        ▼
┌──────────────────────────────────────────────┐
│             Native Harness Runtime           │
│                                              │
│  Agent Loop                                  │
│   ├── Turn / Step                            │
│   ├── Cancellation                            │
│   ├── Retry                                   │
│   └── Stream Assembly                         │
│                                              │
│  Context Assembly                             │
│   ├── Stable System Prompt                   │
│   ├── Stable Tool Schemas                    │
│   └── Append-only Runtime Context            │
│                                              │
│  Tool Runtime                                 │
│   ├── Permission                              │
│   ├── Sandbox                                 │
│   ├── Timeout                                 │
│   ├── Parallel / Exclusive                   │
│   └── Result Normalization                   │
│                                              │
│  Token Meter / Cache Telemetry                │
│  Compaction / Tool Result Pruner              │
└───────────────────────┬──────────────────────┘
                        │
                        │ Canonical Model Request
                        ▼
┌──────────────────────────────────────────────┐
│                 Provider Adapter              │
│                                              │
│  DeepSeek / OpenAI / Claude / ACP / CLI       │
│  只负责协议翻译、stream、usage、resume        │
└───────────────────────┬──────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────┐
│              Append-only Session Log          │
│                                              │
│  Raw Events → Surface Projection → Messages   │
│                                              │
│  JSONL / SQLite / 其他持久化后端              │
└──────────────────────────────────────────────┘
```

---

## 17. 新手最容易犯的几个错误

### 错误一：把 Harness 理解成一个 while 循环

while 循环只是 Agent Loop 的一部分。

完整 Harness 还需要：

```text
事件
持久化
恢复
权限
工具
压缩
usage
缓存
```

### 错误二：把前端显示文本当成模型历史

前端展示可以是一个投影，不应该成为模型请求的唯一事实源。

模型请求应从 Session Log 派生。

### 错误三：为了动态权限每次重建工具 schema

这会导致请求前缀变化，降低缓存命中率。

更好的方式是：

```text
稳定 schema
执行时检查权限
```

### 错误四：把所有运行状态都塞进 system prompt

当前时间、cwd、权限、todo 等动态内容如果直接写进 system prompt，会频繁破坏缓存。

### 错误五：压缩时直接删除旧消息

直接删除会失去：

- 审计信息
- 恢复能力
- 压缩关系
- 原始 transcript

正确做法是：

```text
保留原始事件
替换模型可见的 Surface
```

### 错误六：工具结果只保存在内存里

如果工具结果没有进入 Session Log，恢复后的模型就无法知道之前发生了什么。

### 错误七：把取消理解成“立刻杀死所有 Promise”

JavaScript 通常无法强制杀死一个已经运行的同进程函数。

正确的取消设计是：

```text
发出 AbortSignal
停止启动新的工作
等待已启动工作达到 quiescence
记录取消结果
再完成资源释放
```

---

## 18. 最终用一个比喻总结

可以把 DeepSeek Harness 想象成一个有完整账本的项目经理。

### Agent Loop 是项目经理

它决定：

```text
下一步做什么
什么时候问模型
什么时候调用工具
什么时候结束任务
```

### Session Log 是项目账本

它记录：

```text
发生过什么
什么时候发生
谁产生了什么
工具有没有执行
模型看到了什么
```

### Surface 是给模型看的当前工作摘要

账本可以很长，但模型不一定需要每一页原始记录。

### Provider 是电话线路

Provider 负责把请求发送给具体模型，并把返回内容翻译回来。

它不应该决定整个项目流程。

### Tool Runtime 是执行团队

模型只能提出请求，真正的执行由 Tool Runtime 完成。

### Compaction 是整理旧档案

旧档案不一定销毁，而是整理成摘要，让模型继续工作。

### Prompt Cache 是复用已经读过的资料

只要资料的开头没有变化，模型服务商就可能不必从头再读一遍。

---

## 19. 你现在最应该记住的 8 句话

1. **Agent Loop 是循环控制器，不是完整 Harness。**
2. **Session Log 应该是唯一事实源。**
3. **模型看到的 Messages 应该从 Session Log 派生。**
4. **流式 chunk 负责实时显示，最终 message 负责提交和恢复。**
5. **稳定的 system prompt 和 tool schema 是 Prompt Cache 的基础。**
6. **动态上下文应该追加，不要频繁重写固定前缀。**
7. **压缩应该替换模型可见历史，不要删除原始日志。**
8. **Provider 负责连接模型，Native Harness 负责统一运行逻辑。**

---

## 20. 推荐阅读顺序

如果你要继续深入源码，建议按照这个顺序：

### 第一阶段：理解整体

1. [`work/deepseek-harness/docs/architecture.md`](../work/deepseek-harness/docs/architecture.md)
2. [`work/deepseek-harness/packages/core/session/README.md`](../work/deepseek-harness/packages/core/session/README.md)
3. [`work/deepseek-harness/packages/core/agent-loop/README.md`](../work/deepseek-harness/packages/core/agent-loop/README.md)

### 第二阶段：理解一次请求

1. [`work/deepseek-harness/packages/core/agent-loop/src/agent.ts`](../work/deepseek-harness/packages/core/agent-loop/src/agent.ts)
2. [`work/deepseek-harness/packages/core/agent-loop/src/tool-calls.ts`](../work/deepseek-harness/packages/core/agent-loop/src/tool-calls.ts)
3. [`work/deepseek-harness/packages/core/session/src/surface.ts`](../work/deepseek-harness/packages/core/session/src/surface.ts)

### 第三阶段：理解缓存和 Token

1. [`work/deepseek-harness/packages/core/agent-loop/tests/request-cache.e2e.ts`](../work/deepseek-harness/packages/core/agent-loop/tests/request-cache.e2e.ts)
2. [`work/deepseek-harness/packages/llm/llm-deepseek/src/translate.ts`](../work/deepseek-harness/packages/llm/llm-deepseek/src/translate.ts)
3. [`work/deepseek-harness/packages/llm/token-meter/README.md`](../work/deepseek-harness/packages/llm/token-meter/README.md)
4. [`work/deepseek-harness/packages/core/agent-loop/src/runtime-context.ts`](../work/deepseek-harness/packages/core/agent-loop/src/runtime-context.ts)

### 第四阶段：理解压缩和子 Agent

1. [`work/deepseek-harness/packages/compaction/compaction-basic/README.md`](../work/deepseek-harness/packages/compaction/compaction-basic/README.md)
2. [`work/deepseek-harness/packages/compaction/compaction-basic/src/region.ts`](../work/deepseek-harness/packages/compaction/compaction-basic/src/region.ts)
3. [`work/deepseek-harness/packages/compaction/compaction-tool-result-pruner/src/index.ts`](../work/deepseek-harness/packages/compaction/compaction-tool-result-pruner/src/index.ts)
4. [`work/deepseek-harness/packages/subagent/subagent-fork-in-process/src/index.ts`](../work/deepseek-harness/packages/subagent/subagent-fork-in-process/src/index.ts)

---

## 结论

DeepSeek Harness 最值得学习的不是某一段循环代码，而是它对整个 Agent 运行过程的拆分方式：

```text
稳定请求前缀
  +
事件溯源会话
  +
可重建模型请求
  +
可审计工具和权限
  +
可恢复流式输出
  +
缓存感知的 Token 统计
  +
不破坏历史的上下文压缩
```

对于 Nautilo，最现实的方向不是马上复制 DeepSeek Harness 的全部插件，而是先建立这条主线：

```text
统一 Session Event Log
  ↓
统一 Canonical Model Request
  ↓
统一 Native Agent Loop
  ↓
统一 Tool Runtime
  ↓
统一 Token / Cache Telemetry
  ↓
统一 Compaction
```

只要这条主线建立起来，Nautilo 才能从“多个 Provider 的运行壳”逐步变成“拥有自己 Agent Runtime 的 Harness”。
