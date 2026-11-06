# 第 7 章 LLM 抽象：一套接口，接所有模型

> 第 5、6 章我们看到了循环和工具，但"模型请求到底是怎么发出去的"，一直是个黑盒。这一章把它点亮：DSH 怎么做到"写一套代码，就能接 DeepSeek、国产模型、……任何厂商"？它又怎么把每家厂商不同的"计费/缓存"数据翻译成统一的东西？
> 读完你会彻底明白 DSH 那句骄傲的话：**换模型厂商 = 换一个 Provider 插件，调用方代码一行不改。**

---

## 7.1 还记得"能力缝三件套"吗？LLM 就是它的模范案例

第 2 章我们学过能力缝：**Service Definition（接口）+ Provider（实现）+ Consumer（使用者）**。

LLM 这块是它的完美落地：

| 角色 | 包 | 干什么 |
|---|---|---|
| **Service Definition** | `packages/llm/llm` | 定义"一次模型调用"长什么样：消息格式、内容块、用量、错误……**不绑任何厂商** |
| **Provider** | `packages/llm/llm-deepseek`、`llm-pi-ai`… | 把通用接口**翻译**成某家厂商的 HTTP 请求 / 解析响应 |
| **Consumer** | `packages/core/agent-loop` | 只管用 `llm.stream(...)` 发请求，**根本不关心背后是谁** |

打个比方：`llm` 定义了“插座规格”，`llm-deepseek` 是一颗“专用插头”，`agent-loop` 是“插上就能用的电器”。

---

## 7.2 统一的"消息"长什么样：内容块（Content Blocks）

不同厂商的消息格式千差万别，DSH 怎么统一？答案在 `packages/llm/llm/src/types.ts`：它定义了一套**厂商无关的消息和内容块（content block）**。

消息里可以带各种 **content block**，我们列几个常见的：

| 内容块类型 | 是什么 |
|---|---|
| `text` | 普通文本 |
| `reasoning` | 思考过程（DeepSeek 的 `reasoning_content`） |
| `image` | 图片 |
| `tool-call` | 要调用工具（包含 callId、工具名、参数） |
| `tool-result` | 工具返回结果 |

看到没？**连"思考过程"都被定义成统一的内容块类型**——因为现在很多模型（包括 DeepSeek）有 reasoning，DSH 直接把它抽象成标准成员。这样上层代码处理"思考"和"文本"就有统一的套路，不用每换一家厂商就改一套判断。

---

## 7.3 Provider 的活儿：翻译（Translate & Serialize）

Provider 包（比如 `llm-deepseek`）做两件翻译工作：

### ① Serialize（序列化，出去时翻译）
把 DSH 的统一消息 **翻译成** DeepSeek API 认识的格式再发出去。

举两个真实细节：

- **工具结果**在 DSH 里是"一条消息里的 tool-result 内容块"，但 Translate 成 DeepSeek 格式时，会被拆成独立的 `role: 'tool'` 消息（这是 DeepSeek 的要求）。
- **reasoning_content（思考过程）**：DSH 只在**某一轮**带着它（用于上下文里有思考的模型），别的轮次不带——这是为了兼顾"模型需要思考"和"请求别太臃肿"。

### ② Translate（反序列化，回来时翻译）
把 DeepSeek 返回的响应，重新**翻译回 DSH 的统一格式**，包括把流式 chunk 处理成统一的内容块。

这一进一出，就是 Provider 的全部工作。**它是"国境口岸"**：在里面走的是 DSH 本国语言，过口岸到外面就换成厂商语言。

---

## 7.4 用量统计里的"神仙角落"：缓存命中怎么被挖出来

这是本章（甚至全书）特别值钱的一段——**DSH 怎么从厂商返回里精确算出"缓存省了多少 token"**。

DeepSeek API 的响应里带着 raw 的 usage，类似：

```json
{
  "prompt_tokens": 1000,
  "prompt_cache_hit_tokens": 600,
  "prompt_cache_miss_tokens": 400,
  ...
}
```

（你注意：`prompt_tokens` 里面**包含了**缓存命中的 600。也就是说这 1000 个输入 token 里，600 个是命中缓存、不要重新算的。）

**DSH 在 `mapUsage` 里做了一件精明的账目操作**：

```
inputTokens = prompt_tokens − cacheRead   ← 把真正"新算"的输入 token 算出来
```

它把"总输入 token"和"缓存读取 token"（来自 `prompt_cache_hit_tokens` 或 `prompt_tokens_details.cached_tokens`）分开记。

**为什么这么重要？**
- 计费：很多厂商对"缓存命中的 token"收更少的钱。把 cacheRead 单独记下来，你才能算真实成本。
- 优化：这本书后面第 8 章就是讲"怎么让 cacheRead 最大化"。没有这个统计，你连缓存好不好都不知道。

这把"省了多少"变成**一个可统计、可优化的数字**——这是 DSH 一切缓存打磨的观测基础。

---

## 7.5 有个隐藏的"压缩专属"小开关

还有一个很隐蔽但很酷的细节：当 DSH 发的是**压缩（compaction）**专用请求时，它会带一个自定义头 `x-deepseek-harness-compact: 1`。

为什么？因为压缩请求的用途和普通对话不同（它是在让模型"总结并输出 checkpoint"）。带这个头，DeepSeek 服务端可以**识别出这是压缩请求**——这样服务端能做针对性的处理/统计（比如不把它算进普通对话的某些指标）。这是 DSH 和"自家模型服务"生态配合的体现。别人学不来这么细，但你可以理解这种精神：**给请求打上"用途标签"，让每一类请求都能被统计和优化。**

---

## 7.6 那些厂商之间的最小公倍数

不同厂商最大的差异，除了格式，还有：

- **是否支持 reasoning**：有的模型有思考，有的没有。
- **是否支持某个参数**：比如 `maxTokens`、推理强度。用不了的参数，不能在别的厂商上瞎传。

DSH 用 `adapterDefaults`（适配器默认值）机制来解决：每个 Provider 声明"哪些配置项是我能推导的、哪些是我的默认值"。这样 Consumer 不知道特定厂商的癖好，也能"问适配器"拿答案。这就是"依赖注入 + 接口抽象"给代码带来的从容。

---

## 7.7 别忘了计量器：Token Meter（小尺子）

除了厂商自己报的 usage，DSH 还自带一个独立的计量服务 `packages/llm/token-meter`。

### 它的实诚：穷人的估算

直接说结论：**DSH 的 token-meter 不调任何模型，它用一个固定的启发式估算——4 个字符约等于 1 个 token。** 这不是精确数，但用来"**大概判断对话有没有快满**"足够了，而且**零成本**（不额外花模型调用的钱）。

### 它的机灵：能算"大小"也算"压力"

它提供几个指标（概念上）：

| 指标 | 意思 |
|---|---|
| `totalTokens` | 总共有多长（接近窗口了吗？→ 压力判断用） |
| `surfaceTokens` | Surface 上这些节点大概多少 token |
| `projectedTokens` | 把即将加入的也估计进去 |
| `contextBreakdown` | 各部分（system/tools/messages…）各占多少 |

这个计量器是干嘛用的？——**给压缩当"眼睛"**。第 9 章你会看到：压缩第一步就是"量一量现在多长了"，超了才压。

### 它的一丝不苟：只认面子账

有一句很关键的话：**provider usage 只有当其"canonical envelope"（标准封套）和之前完全一致时，才能作为锚点使用。**

什么意思？你想象：token-meter 想用"厂商报的精确数字"来校准自己。但它只敢在"请求结构（envelope）一模一样"的情况下信厂商数字。如果结构变了（比如 tools 变了、system 变了），厂商的数字和 meter 的量就不是一回事，不能混着比。**还是那句话：只信可对齐的东西。**

---

## 7.8 一张"发送一次模型请求"的完整旅程

把 5、6、7 章连起来，看一次请求的全过程：

```
Agent Loop 要发请求
  ▼ 1. 从日志算 Surface（deriveMessages）
  ▼ 2. 组装 system（固定） + tools + messages
  ▼ 3. 调用 llm 服务接口（Consumer 视角：一个方法）
        ▼ Provider（llm-deepseek）接管：
        ▼ 翻译成 DeepSeek 格式（工具结果拆 role:'tool'、reasoning 按需带）
        ▼ 若是压缩请求 → 加 x-deepseek-harness-compact: 1 头
  ▼ 4. 流式返回 → 翻译回统一格式 → 逐块记 assistant/chunk
  ▼ 5. 响应里挖 usage → 用 mapUsage 把 cacheRead 分开记账
```

---

## 7.9 本章自测

1. LLM 这块，Service Definition / Provider / Consumer 分别是谁？
2. DSH 统一的消息里有哪些 content block？为什么连 reasoning 都要统一？
3. `inputTokens = prompt_tokens − cacheRead` 这个公式在算什么？为什么这么算？
4. `x-deepseek-harness-compact: 1` 头是干什么的？
5. token-meter 用"4 字符 ≈ 1 token"估算，为什么不精确还要用它？
6. "provider usage 只在 canonical envelope 完全一致时才可作锚点"，结合缓存说说为什么。

---

## 7.10 下一章预告

你一定对第 7.4 那个"缓存命中统计"好奇了。下一章我们**彻底讲透 Prompt Cache（缓存经济学）**：缓存的本质、为什么 append 比 replace 香、DSH 为缓存做出了哪些"变态级"的努力。这是全书最"值钱"的一章，而且要解释你在之前所有章节里看到的那些"奇奇怪怪的坚持"——原来全是为了缓存。

> 记住这句话再走：
> **LLM 抽象让 DSH 一套代码接所有厂商；而它从厂商响应里把"缓存命中 token"单独挖出来记账——一切缓存优化的根基，就是能清楚地数出"到底省了多少"。**
