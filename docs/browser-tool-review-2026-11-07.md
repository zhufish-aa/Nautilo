# 浏览器操作工具（`browser_*`）使用评测与改进建议

> **2026-11-08 更新**：插件已修复并完成三轮回归。首轮 T1–T10 中 7 通过 / 1 部分 / 2 受阻（9.5）；第二轮 7 通过 / 1 部分 / 1 失败 / 1 受阻，发现 `Runtime.evaluate` 死锁（8.8）；第三轮（9.7 节）9 通过 / 1 受阻，死锁已修复、跨文档 ref 已归一为 `stale_ref`，总分回升至 **9.6 / 10**。唯一受阻项 T7（已登录态无「立即登录」元素）。详见第 9 节。

- 评测日期：2026-11-07
- 评测环境：Nautilo / DSH 内嵌浏览器 MCP（`nautilo_0`），Windows，会话未登录 → 扫码登录后保持
- 涉及工具：`browser_tabs`、`browser_run`（steps: open / read / click / fill / wait / scroll / hover / drag / press / select / back / forward / reload）、`browser_read`（scope: viewport / document，含 `nextOffset`）、`browser_screenshot`
- 评测方式：真实完成任务（百度搜索 → B 站搜索 → 纪录片页 → 扫码登录 → 读评论区 → 查 LMArena / Artificial Analysis / SWE-bench 榜单），记录每一次失败与 workaround

---

## 0. TL;DR（一页版）

**总评 8.5 / 10。** 这是"陪人上网"体验最好的一类浏览器 Agent 工具：文本优先、支持多标签、尊重用户接管、`scope=document` + `nextOffset` 能稳定拿到全文。但在**懒加载页面**和**批量步骤事务性**上存在明显短板，且部分能力（`scroll`、`press`）可发现性差。

最重要的 6 条改进（按优先级）：

1. **P0** 增加 `scroll_to_text` / `scroll_into_view(ref)`，并让 `wait` 在超时时提示"内容可能是懒加载，试试滚动"。
2. **P0** 批量步骤返回结构化执行报告（哪几步执行了），默认"遇错即停"，避免半执行状态。
3. **P1** JSON/大文本页面支持分页续读或结构化树视图，不要退化成单个被截断的 `StaticText`。
4. **P1** 截图失败自动重试 + 回退（区域截图/整页），失败时给出明确原因。
5. **P1** 用户接管时提供 `wait_for_control(timeout)`，而不是直接让整个批次失败。
6. **P1** 工具描述里显式列出全部 action 和 3 个典型流程（扫码登录、懒加载评论、表单搜索），并让 `click` 支持按可见文本匹配兜底。

---

## 1. 总评与分项评分

| 维度 | 分数 | 说明 |
|---|---|---|
| 易用性（自然语言式操作） | 9.0 | `ref`、`role+name`、`fill`、`wait for text` 都很直观 |
| 内容读取能力 | 8.5 | `scope=document` + `nextOffset` 是核心优势；JSON 页面是短板 |
| 动态 / 懒加载页面 | 6.5 | 不滚动就看不到评论、榜单；失败时无引导 |
| 稳定性 | 7.5 | 截图偶发失败、ref 易失效、批量半执行 |
| 人机协作与安全 | 9.0 | 用户接管保护、多标签隔离做得很好 |
| 可发现性 | 7.0 | `scroll` / `press` 藏在 schema 里，容易漏 |
| 可调试性 | 6.0 | 没有 console / network / 选择器能力 |

---

## 2. 做得好的地方（附本次证据）

1. **文本优先的交互设计**：`ref`（如 `@2.58`）配合 `fill` / `click` / `wait`，不用写选择器就能完成"搜索、登录、翻页"。
2. **`browser_read scope=document` + `nextOffset` 非常好用**：B 站 2,122 条评论的当前页、Artificial Analysis 20,678 字符的榜单，都是一次读取拿到；超出部分用 `nextOffset` 续读。
3. **截图能力是刚需且工作正常**：登录二维码、登录弹窗、评论区排版，全靠截图确认；没有截图就只能靠猜。
4. **多标签 + 用户优先**：可以在保留用户视频页的前提下另开标签查榜单；用户接管页面时工具会拒绝操作（"The user has control of this page"），不与真人抢控制权。
5. **会话保持**：扫码登录后的 cookie 在整个会话内持续有效，后续跨页访问评论区、榜单都正常。
6. **能处理重定向与 SPA**：`lmarena.ai → arena.ai` 自动跟随；`wait for text` 能等出 React 渲染完成。
7. **错误信息可操作**：`Stale or unknown ref. Read a new snapshot.` 直接告诉你怎么恢复。

---

## 3. 问题清单

> 格式：现象 / 复现 / 期望 / 推测根因 / 建议。优先级 P0（阻断主流程）> P1（明显降低效率）> P2（体验优化）。

### BR-01 懒加载内容不可见，且没有"滚动到指定元素"能力（P0）

- **现象**：打开 B 站视频页后，`read`（默认快照）与 `read scope=document` 都只显示 `评论 / 正在玩命加载…`；`wait text="回复"` 10 秒超时。手动 `scroll deltaY≈1400` 后，同一页面 document 读取立刻出现 26 条评论与全部回复数。
- **复现**：任意带懒加载评论区的页面（B 站视频页、部分电商详情页）→ 不滚动 → 读取 → 评论缺失。
- **期望**：提供 `scroll_to_text("评论")` / `scroll_into_view(ref)`；或在检测到 "loading/正在加载/加载中" 占位文案时，在响应里返回明确提示。
- **推测根因**：评论区用 IntersectionObserver 懒加载；工具只能按像素 `scroll(deltaX,deltaY,x,y)` 滚动，无法定位到目标元素。
- **建议**：
  - 新增 step：`{ "action": "scroll", "text": "评论" }`、`{ "action": "scroll", "ref": "@2.3.189" }`；
  - `wait` 超时响应中附带 `hint`："目标文本可能由懒加载渲染，尝试 scroll 到该区域"；
  - 返回 `scrollY` / `pageHeight` 便于判断是否滚动到位。

### BR-02 批量步骤失败不回滚、ref 易失效（P0）

- **现象**：同一批次 `[click 刷新类按钮, read]`，第一步触发页面重载，第二步报 `Stale or unknown ref. Read a new snapshot.`；但第一步的点击已经生效。
- **复现**：任意 SPA 页面，批量里包含"会触发重渲染的点击 + 后续读取"。
- **期望**：返回结构化执行报告：`{ ok:false, failedStep:2, executed:[1], reason:"stale_ref", recover:"re-read" }`；默认"遇错即停"，不要继续执行后续步骤。
- **建议**：错误对象统一附带 `executedSteps`、`remainingSteps`；可选的 `continueOnError` 参数。

### BR-03 JSON / 大文本节点被截断且无续读（P1）

- **现象**：打开 `api.bilibili.com/x/v2/reply?...` 时，页面渲染为**一个** `StaticText` 巨块，读取结果在 `…` 处截断（约 2k 字符），后续内容不可见。本次只能靠"美观输出"扩展（页面上的 checkbox）曲线救国。
- **期望**：`Content-Type: application/json` 时，解析为结构化树或分页纯文本；至少支持 `offset` 续读。
- **建议**：在 `read` 结果里为 JSON 页面返回 `nextOffset`；或提供内置 JSON 查看器，不要依赖用户安装扩展。

### BR-04 截图偶发失败且提示模糊（P1）

- **现象**：出现过两次失败：`Current display surface not available for capture`、`Internal error`；重新调用后恢复正常。
- **期望**：自动重试 2–3 次（退避）；失败时区分原因（标签页被切换 / 表面不可用 / 渲染未完成），并回退到"按 ref 区域截图"或"整页截图"。
- **建议**：返回截图元数据：尺寸、DPR、`scrollY`、当前 `tabId`、URL。

### BR-05 用户接管时操作直接失败，无等待/队列（P1）

- **现象**：用户在查看 Arena 榜单时触发 `The user is controlling this tab`；此前还出现过 `The user has control of this page. Wait for them to return control.`。批次直接失败，没有恢复机制。
- **期望**：支持 `wait_for_control(timeoutMs)`；或在返回里标记 `retryable:true` 并提供建议等待时长。
- **建议**：新增 `{ "action": "wait", "for": "user_release", "timeoutMs": 15000 }`。

### BR-06 动作可发现性差（P1）

- **现象**：本次会话前期，我误以为没有 `scroll` 动作，改用 URL 直达和"凑合读"绕过，多绕了 3–4 轮；`press`（Enter 提交）同样被忽略。
- **期望**：工具描述中显式列出所有 action，并给出典型流程示例；对常用动作加粗强调。
- **建议**：在 `browser_run` 描述中加入：
  - 动作清单：`open/read/click/fill/press/wait/scroll/hover/drag/select/back/forward/reload`
  - 示例 1（扫码登录）：`open 登录页 → screenshot 给用户扫码 → wait "创作中心"`
  - 示例 2（懒加载评论）：`open 视频页 → scroll(text:"评论") → read scope=document`
  - 示例 3（表单搜索）：`fill(搜索框) → press Enter → wait 结果页关键词`

### BR-07 可点击控件在无障碍树里是 `StaticText`（P1）

- **现象**：B 站首页「立即登录」在快照中是 `StaticText`，不是 button/link；按 role 点击无法命中。
- **期望**：`click` 支持可见文本匹配兜底：`{ "action": "click", "text": "立即登录" }`。
- **建议**：解析顺序 `ref` → `role+name` → `text`；返回实际命中的元素信息，便于排错。

### BR-08 表单填写后提交链路不明确（P1）

- **现象**：百度首页 `fill("bilibili") + click("百度一下")` 后 URL 未变化、未导航（最终改用 `/s?wd=bilibili` 直达）。（注：本次未尝试 `press Enter`，属使用模式问题，但工具缺乏引导。）
- **期望**：文档化"fill 后 press Enter"模式；或提供 `submit(ref)`。
- **建议**：文档 + 在 `fill` 的返回里提示"提交表单请配合 press Enter / 点击提交按钮"。

### BR-09 正文提取噪声大（P2）

- **现象**：Artificial Analysis 榜单页 `document` 读取 20,678 字符，其中包含大量 FAQ、页脚、全站导航；需要人工筛选。
- **期望**：提供主内容提取（readability 思路）或页面大纲（main / nav / footer 分区）。
- **建议**：`read` 增加 `region:"main"` 参数；或返回 `outline` 结构。

### BR-10 缺少选择器 / JS / 网络 / 控制台能力（P2）

- **现象**：无法按 CSS 精准定位"评论区容器"；无法查看 console 报错或失败请求（排查"评论加载失败"时很有用）。
- **建议**：只读 console 摘要 + 失败请求列表（脱敏），可选受限 `eval`（需权限确认）。

### BR-11 错误信息不够可操作（P2）

- **现象**：`Timed out waiting for text` 不区分"文本不存在 / 存在但不可见 / 尚未懒加载"；`Browser operation interrupted` 含义模糊。
- **建议**：错误统一带 `hint`，包含 URL、`scrollY`、候选文本是否存在、建议动作。

### BR-12 多标签语义易混淆（P2）

- **现象**：返回里同时有 `tabId` / `viewedTabId` / `agentTabId`；只读批次默认用户可见标签，动作默认 agent 标签，容易误操作。
- **建议**：文档明确三者语义；动作默认使用显式指定或 agent 标签，并提供 `--user-tab` 显式覆盖。

### BR-13 视口尺寸 / 缩放不可控（P2）

- **现象**：`browser_screenshot` 输出 1375×950，而 `document` 读取的 `width` 在不同页面为 583 / 1026 / 1536，尺寸关系不直观；无法缩放（扫码时二维码偏小）。
- **建议**：提供 `set_viewport(width,height,scale)`；截图返回值标注与 DOM 视口的对应关系。

### BR-14 无方式直接查看登录态（P2）

- **现象**：只能通过页面文本（是否有「创作中心」）推断是否登录。
- **建议**：提供 `state` 动作返回 URL / 标题 / 登录态布尔值（不暴露敏感 cookie）。

---

## 4. API 设计建议（示例）

```jsonc
// 1) 滚动到文本 / 元素
{ "action": "scroll", "text": "评论", "timeoutMs": 5000 }
{ "action": "scroll", "ref": "@2.3.189" }

// 2) 等待，允许懒加载兜底
{ "action": "wait", "text": "回复", "alsoTryScroll": true, "timeoutMs": 8000 }

// 3) 读取全文并分页
{ "action": "read", "scope": "document", "offset": 16000 }

// 4) 文本点击兜底
{ "action": "click", "text": "立即登录" }

// 5) 用户接管等待
{ "action": "wait", "for": "user_release", "timeoutMs": 15000 }

// 6) 结构化执行报告
{
  "ok": false,
  "failedStep": 2,
  "executedSteps": [1],
  "remainingSteps": [3, 4],
  "reason": "stale_ref",
  "recover": "re-read snapshot, then retry",
  "hint": "step 1 triggered navigation; snapshots are invalidated from step 2"
}
```

---

## 5. 验收清单（建议维护者自测）

| # | 用例 | 期望 |
|---|---|---|
| T1 | 打开 B 站视频页，不手动滚动，调用 `scroll(text:"评论")` 后 `read document` | 5 秒内出现评论正文 |
| T2 | 打开任意 JSON API 页面，`read document` | 支持 `offset/nextOffset` 续读，或返回结构化树 |
| T3 | 批量 `[click(触发重载), read]` | 返回 `executedSteps`，不执行后续步骤 |
| T4 | 模拟截图 surface 不可用 | 自动重试成功，或返回明确原因 + 回退截图 |
| T5 | 用户接管期间发起动作 | `wait_for_control` 后继续，或返回 `retryable:true` |
| T6 | `fill(搜索框)` + `press Enter` | 页面导航到结果页 |
| T7 | `click(text:"立即登录")` | 命中 StaticText 按钮并打开登录弹窗 |
| T8 | 100KB JSON 页面 | 分页读取连续、无 `…` 截断 |
| T9 | `wait` 超时 | 返回 `hint` 指明可能是懒加载，并建议 `scroll` |
| T10 | 登录后跨标签导航 | 登录态保持，评论区可读 |

---

## 6. 给 Agent 的使用最佳实践（本次踩坑总结）

1. **先截图看清状态**，再决定用文本快照还是 document 读取。
2. **见到 `正在加载 / loading` 占位**：先 `scroll`，再 `read`；不要直接断言"内容不存在"。
3. **看到 `[Snapshot shortened]`**：立刻用 `browser_read scope=document` + `nextOffset` 拿全文。
4. **批量操作拆小**：会触发导航/重渲染的点击，单独成批，避免 ref 失效导致半执行。
5. **表单提交**：`fill` 之后补一个 `press Enter`，比只点按钮可靠。
6. **用户接管时不要硬重试**：等待用户交还控制权，或切到其他标签操作。

---

## 7. 附录：本次真实使用时间线（问题证据）

| 时间点 | 操作 | 结果 |
|---|---|---|
| 开场 | 百度 `fill("bilibili") + click("百度一下")` | 未导航，改用 `/s?wd=bilibili` |
| 中段 | B 站登录前读纪录片页评论区 | 显示「登录后查看 5000+ 条评论」 |
| 中段 | 扫码登录（passport.bilibili.com） | 成功；二维码截图正常 |
| 中段 | 登录后读选集页评论区 | 停留在「正在玩命加载…」，`wait "回复"` 超时 |
| 中段 | `scroll deltaY=1400` 后再 `read document` | 26 条评论 + 回复数全部出现 |
| 中段 | 同一标签被用户接管 | 操作返回 `The user is controlling this tab` |
| 后段 | 打开 Arena 榜单 | 出现 "Loading leaderboard"，`wait` 后正常 |
| 后段 | 打开 Artificial Analysis | `document` 读取 20,678 字符，`nextOffset` 续读 |
| 后段 | 打开 SWE-bench | 默认快照表格截断于第 9 行，document 读取完整 47 行 |
| 后段 | 打开评论 API 的 JSON 页面 | 单节点截断，只能看到前 ~2k 字符 |

---

## 8. 结论

这版工具的核心设计（文本优先 + document 读取 + 截图 + 多标签 + 用户优先）是对的，**完成"看网页、点网页、读内容"的日常任务没有问题**，本次评测的 6 个真实任务全部完成（含扫码登录与 5,000+ 评论页的读取）。

若要继续提升，建议把精力集中在两件事上：**①动态/懒加载页面的可操作性（滚动定位 + 等待提示）；②批量执行的可观测性（结构化执行报告 + 事务语义）**。这两项修好，评分可以从 8.5 提到 9.5。

> 上述两项已于 2026-11-08 的回归中验证通过，详见第 9 节。当前评分 **9.5 / 10**（受 T7、T10 两条无法复现的用例限制）。

---

## 9. 回归测试记录（2026-11-08）

- 环境：同一 Nautilo 会话，Windows，浏览器会话在轮次间可恢复（`restoring:true`），但未登录 B 站
- 结论：**T1/T2/T3/T5/T6/T8/T9 通过；T4 部分通过；T7/T10 受阻（环境/登录限制，无法复现）**
- 总评：**9.5 / 10**，两条 P0 均通过

### 9.1 验收用例逐条结果

| # | 用例 | 结果 | 证据 |
|---|---|---|---|
| T1 | 懒加载评论：不手动滚动，`scroll(text:"评论")` 后 `read document` | ✅ 通过 | `scroll_to_text` → `scrollY=641.6`；`wait selector:"#comment"` 命中；`read` 返回 3,275 条评论及正文，无超时 |
| T2 | JSON API 页面 `read document` 支持 `offset/nextOffset` 或结构化树 | ✅ 通过 | 返回 `format:"json"`、`totalCharacters:220641`、`nextOffset:16000`、`continueWith` |
| T3 | 批量 `[click(触发重载), read]` 返回 `executedSteps`，不执行后续步骤 | ✅ 通过 | 3 步批次：步骤 1 点击跳转（URL 变更）；步骤 2 失败；`executedSteps:[1]`、`failedStep:2`、`remainingSteps:[3]`，步骤 3 **未执行** |
| T4 | 截图 surface 不可用 → 自动重试或明确原因 + 回退 | ⚠️ 部分通过 | 正常截图 `attempts:1` 成功；`unknown_tab` 错误码清晰；**surface 不可用场景无法强制复现**，重试逻辑未验证 |
| T5 | 用户接管期间动作 → `wait_for_control` 或 `retryable:true` | ✅ 通过 | 实测两次 `control_taken`（`retryable:true` + recovery）；`browser_wait_for_control(timeout=5000)` 返回 `ready:true`，可继续操作 |
| T6 | `fill(搜索框)` + `press Enter` → 导航 | ✅ 通过 | `fill` 8 字符 → `press Enter` → `wait urlIncludes "wd=bilibili"` 命中，URL 变为 `/s?...wd=bilibili` |
| T7 | `click(text:"立即登录")` 命中 StaticText 并打开登录弹窗 | ⛔ 受阻 | B 站首页/视频页均无「立即登录」元素（`foundInDocument:false`），无法复现；文本点击机制此前用「最新」验证可用 |
| T8 | 100KB JSON 页面分页连续、无 `…` 截断 | ✅ 通过 | `offset=16000` 结尾 `...bfs`，`offset=16256` 开头 `/face/3ed51...`，拼接连续；`offset=999999` 返回 `outOfRange:true` + `rangeHint:"offset exceeds document length"` |
| T9 | `wait` 超时返回 hint 指明懒加载并建议 scroll | ✅ 通过 | `wait_timeout` 带 `foundInDocument/visible/loading/hasMoreBelow/scrollAttempts`，recovery 明确写「滚动到相关区域触发懒加载后再等待」 |
| T10 | 登录后跨标签导航，登录态保持、评论区可读 | ⛔ 受阻 | 本会话未登录（无法扫码），无法验证登录态跨标签保持；跨标签导航本身正常 |

### 9.2 两条 P0 专项

**P0-1 懒加载内容：✅ 通过**
- `scroll_to_text("评论")` 精准定位评论区 → 评论组件自动加载 → `read` 一次拿到 3,275 条评论与正文。
- `wait selector:"#comment"` 可直接等待评论容器；`read` 结果带 `hasMoreBelow`、`nextOffset`。
- 未再出现"等 10 秒超时、评论一条读不到"。

**P0-2 批量失败：✅ 通过（语义为"停止 + 报告"，非回滚）**
- 步骤 1 点击跳转（`urlBefore → urlAfter` 记录完整），步骤 2 因元素已脱离文档失败，步骤 3 未执行。
- 返回 `executedSteps:[1]`、`failedStep:2`、`remainingSteps:[3]`、`retryable:true`、`recovery`，并附新快照。
- **注意**：已执行步骤不会回滚（符合"Completed steps remain applied"的文档表述），验收标准里的"回滚"应理解为"停止执行后续步骤 + 报告已完成步骤"。
- 小问题：元素脱离文档时错误码是 `browser_error`（"Could not find object with given id"），建议归一为 `stale_ref`，便于 Agent 判断。

### 9.3 三项历史问题复查

| 问题 | 状态 | 说明 |
|---|---|---|
| 快照过长截断 | 🟡 部分改善 | 默认快照仍以 `[Snapshot shortened ...]` 收尾，但 `browser_run` 同时返回 `content`（含 `text`、`nextOffset`、`continueWith`），可无缝切换 `browser_read` 续读 |
| JSON 页面 2000 字截断 | ✅ 已修复 | 支持 `format:"json"`、`jsonPath`、`offset/nextOffset`、`outOfRange`/`rangeHint`；分页边界连续，无 `…` 截断 |
| document 全文噪声大 | 🟡 部分改善 | `scope=main`、`selector`、`fields`、`visibleRegions` 可降噪（评论页用 `selector:"#comment"` 只取评论正文）；但 `scope=main` 仍会带推荐位/侧栏，B 站视频页主内容约 7k 字符中含大量相关推荐 |

### 9.4 本轮新发现 / 仍未修复

1. **`wait` 的可见性语义**：页面刚加载时 `wait text:"评论"` 超时（`foundInDocument:true`、`visible:false`），因为标题在首屏下方。建议提供 `visible:false` 选项，默认按"存在"判断。
2. **`open` 不等待加载完成**：`open` 后立即 `scroll_to_text` 会失败（页面尚白屏）；必须显式 `wait urlIncludes`。建议 `open` 增加 `waitUntil:"domcontentloaded"` 或内置短暂等待。
3. **错误码归一化**：元素脱离文档返回 `browser_error` 而非 `stale_ref`（见 9.2）。
4. **T7 受阻**：当前 B 站首页/视频页不渲染「立即登录」；建议提供固定测试用例页（fixture），或确保未登录态该按钮可见，以便回归。
5. **T10 受阻**：需要登录态（扫码）才能验证跨标签登录保持；建议补一个"登录态持久化"的自动化检查（例如 `browser_state.session` 的 cookie 数量/登录标记）。
6. **T4 重试逻辑未验证**：无法强制 surface 不可用，建议提供故障注入开关或 mock。

### 9.5 本轮确认的其他改进

- `read` 结果新增 `fields`，**输入框 value 可读**（如百度搜索框 `value:"bilibili"`），修复了此前"填了什么读不到"的问题。
- `wait` 结果带 `visible` 标记；超时信息区分 "document content" 与 "visible content"。
- 会话间标签页可恢复（`restoring:true`），但登录态未随之恢复（需重新扫码）。

### 9.6 第二轮真实站点回归（2026-11-08 11:00，修复合入后）

**结论：7 通过 / 1 部分通过 / 1 失败 / 1 受阻。两条 P0 无回归，但发现新的阻断性回归（`Runtime.evaluate` 死锁）。**

| # | 用例 | 结果 | 证据 |
|---|---|---|---|
| T1 | 懒加载评论 | ✅ 通过 | 视频页 `scroll_to_text("评论")` + `wait selector:"#comment"` + `read` → 3,275 条评论；纪录片页同流程 → 5,306 条评论 |
| T2 | JSON 分页/结构化 | ✅ 通过 | `format:"json"`、`totalCharacters:218764`、`nextOffset`、`continueWith` |
| T3 | 批量失败停止并报告 | ✅ 通过 | `[open bing, click 旧 ref, click "登录"]` → `executedSteps:[1]`、`failedStep:2`、`remainingSteps:[3]`，步骤 3 未执行；错误码为 `browser_operation_timeout`（见 9.6.3） |
| T4 | 截图 surface 不可用 | ⚠️ 部分通过 | 实测 `screenshot_surface_unavailable`，`attempts:3`，`causes:["Current display surface not available for capture","Capture surface did not respond",...]`；成功路径因 surface 卡死未复现 |
| T5 | 用户接管 → wait_for_control | ✅ 通过 | `browser_wait_for_control` 返回 `ready:true`；本轮未再触发 `control_taken` |
| T6 | fill + press Enter | ❌ 失败 | `fill` 全部 `browser_operation_timeout`（`Runtime.evaluate`，15s），连 `example.com`、全新标签页也失败（见 9.6.3） |
| T7 | click 文本「立即登录」 | ⛔ 受阻 | 账号已登录（nav API `isLogin:true`），页面无「立即登录」元素，无法复现 |
| T8 | 100KB JSON 分页连续 | ✅ 通过 | `offset=16000` 结尾 `...bfs` + `offset=16256` 开头 `/face/3ed51...` 连续；`offset=999999` → `outOfRange:true` + `rangeHint:"offset exceeds document length"` |
| T9 | wait 超时 hint | ✅ 通过 | `wait_timeout` 返回 `foundInDocument/visible/loading/hasMoreBelow/scrollAttempts` 与懒加载 recovery 文案 |
| T10 | 登录后跨标签登录态 | ✅ 通过 | nav API `isLogin:true`（uname 栋龙涛、mid 8679205）；纪录片页 5,306 条评论可读；两个标签共享登录态 |

#### 9.6.1 四个遗留项复核

| 遗留项 | 状态 | 证据 |
|---|---|---|
| `wait` 可见性语义 | ✅ 已修复 | 视频页 `wait text:"评论"` 返回 `matched:true`、`visible:false`，不再因首屏下方超时 |
| `open` 后不等待加载 | ✅ 已修复 | `open` 返回 `waitUntil:"domcontentloaded"`、`readyState:"interactive"/"complete"`；同一批次 `[open 视频页, scroll_to_text("评论")]` 直接成功（`scrollY=665.6`），无需手动 `wait urlIncludes` |
| 错误码归一化 | 🟡 部分修复 | DOM 脱离场景已返回 `stale_ref`（带 `documentVersion`、recovery）；但跨文档旧 ref 仍返回 `browser_operation_timeout`（15s），并触发 9.6.2 的死锁 |
| T7 / T10 | T10 ✅ / T7 ⛔ | T10 因 Cookie 持久化（`session.persistent:true`，SESSDATA/bili_jct/DedeUserID 均在）已可跑通；T7 因已登录无该元素仍受阻 |

#### 9.6.2 新发现：`Runtime.evaluate` 死锁（阻断级）

- **现象**：一次 `Runtime.evaluate` 超时后，**后续所有依赖 evaluate 的动作**（`click`/`fill`/`press`/`scroll`）均以 15s 超时失败，页面本身正常（`open`/`read`/`wait`/`wait_for_control` 仍可用），截图返回 `screenshot_surface_unavailable`（3 次尝试）。
- **复现步骤**：
  1. `open https://www.baidu.com`，`read` 拿到快照；
  2. 同批次执行 `[open https://www.bing.com, click <百度页旧 ref>, click text:"登录"]`；
  3. 第 2 步返回 `browser_operation_timeout`（`Runtime.evaluate`，15000ms）；
  4. 此后任意标签页执行 `click`/`fill`/`scroll` 均超时；`reload`、新建标签、关闭多余标签页均无法恢复。
- **影响**：本轮 T6 直接失败，T4 成功路径无法验证；实际使用中会导致工具"半瘫"，只能重启浏览器/插件会话。
- **推测原因**：失败的 evaluate 请求未被释放，占住扩展侧的串行队列/互斥锁，后续调用全部排队超时。
- **建议**：为 evaluate 增加独立超时与队列熔断；失败后重建 CDP session 或释放挂起请求；将"跨文档旧 ref"直接判定为 `stale_ref` 而不进入 evaluate。

#### 9.6.3 与第 10 节固定页结论的差异

| 项目 | 固定页结论（第 10 节） | 本轮真实站点观察 |
|---|---|---|
| `open` 等待 | 已等待 DOM 就绪 + 新增 `waitUntil:"load"` | 一致：真实站点 `[open, scroll_to_text]` 同批次通过 |
| `stale_ref` 归一 | 已统一为 `stale_ref`，步骤 3 不执行 | 部分一致：DOM 脱离为 `stale_ref`；跨文档旧 ref 为 `browser_operation_timeout`，并触发死锁 |
| T7 | fixture 页可点 | 真实 B 站因已登录无该元素，仍受阻 |
| T10 | Cookie fixture 通过 | 真实 B 站扫码登录已持久化，跨标签通过 |

---

### 9.7 第三轮真实站点回归（2026-11-08 11:44–11:58）

**结论：9 通过 / 0 部分通过 / 0 失败 / 1 受阻；两条 P0 无回归；上轮阻断性的 `Runtime.evaluate` 死锁已修复，跨文档旧 ref 已归一为 `stale_ref`。**

| # | 用例 | 结果 | 关键证据（工具 + 字段/坐标/条数） |
|---|---|---|---|
| T1 | 懒加载评论 | ✅ 通过 | `scroll_to_text("评论")` → `scrollY=482.4`；`wait text:"回复" alsoTryScroll:true` → `matched:true`、`scrollAttempts:1`；`browser_read` 返回纪录片页 **5,306 条评论**及正文 |
| T2 | JSON 分页/结构化 | ✅ 通过 | `format:"json"`、`totalCharacters:231003`、`nextOffset:4000`、`continueWith` |
| T3 | 批量失败停止并报告 | ✅ 通过 | 3 步批次：`open example.com` 成功 → 第 2 步旧 ref 失败（`stale_ref`，`documentVersion:7`）→ `executedSteps:[1]`、`failedStep:2`、`remainingSteps:[3]`，步骤 3 未执行 |
| T4 | 截图 surface 故障 | ✅ 通过 | 正常路径：`browser_screenshot` 返回 `attempts:1`（纪录片页）与 `attempts:2`（example.com，自动重试一次后成功）；故障路径上轮已验证 `attempts:3 + causes`，本轮未复现 |
| T5 | 用户接管 / wait_for_control | ✅ 通过 | `browser_wait_for_control` → `ready:true`；本轮未触发 `control_taken` |
| T6 | fill + press Enter | ✅ 通过 | 最小化验证：httpbin 表单 `fill` → `inputDelivered:true, characters:5`，`press Enter` 无超时；百度 `fill(8 字符)` + Enter → 落到 `baidu.com/s?...wd=bilibili`（标题 `bilibili_百度搜索`） |
| T7 | click 文本「立即登录」 | ⛔ 受阻 | 账号已登录（`nav` API `isLogin:true`，uname 栋龙涛、mid 8679205）；首页 `wait text:"立即登录"` → `foundInDocument:false`，无该元素 |
| T8 | 100KB JSON 分页连续 | ✅ 通过 | `offset=16000` 结尾 `...https://i0.hdslb.com/bfs` + `offset=16256` 开头 `/face/3ed51...` 连续无重复；`offset=999999` → `outOfRange:true` + `rangeHint:"offset exceeds document length"` |
| T9 | wait 超时 hint | ✅ 通过 | `wait text:"不存在的文本XYZ-2026"` → `wait_timeout`，带 `foundInDocument:false/loading:false/hasMoreBelow/scrollAttempts` 与懒加载滚动 recovery |
| T10 | 登录后跨标签 | ✅ 通过 | `nav` API `isLogin:true`；另一标签的纪录片页 5,306 条评论可读；多标签共享登录态 |

#### 9.7.1 上轮遗留项复核

| 遗留项 | 状态 | 证据 |
|---|---|---|
| 【阻断】`Runtime.evaluate` 死锁 | ✅ 已修复 | httpbin 表单 `fill`（5 字符）+ `press Enter` 正常；example.com 上 `click`/`scroll` 即时返回；跨文档旧 ref 立即失败而非 15s 超时 |
| T4 截图成功路径 | ✅ 已恢复 | 两次截图 `attempts:1` / `attempts:2` 均成功；失败路径仍按预期返回 `screenshot_surface_unavailable`（上轮） |
| 跨文档旧 ref 错误码 | ✅ 已归一 | 返回 `stale_ref` + `message:"Stale or unknown ref. Read a new snapshot."` + `documentVersion:7` + recovery，可据此重读快照 |
| T7 受阻 | ⛔ 仍受阻 | 需登出账号或使用独立无 Cookie profile 才能出现「立即登录」；当前账号已登录，页面无该元素 |

#### 9.7.2 本轮残留（非阻断）

1. **B 站视频页 `open` 偶发 `navigation_timeout`（20s）**：页面实际已加载，但 `domcontentloaded` 未在 20s 内上报；需 `wait urlIncludes` 兜底。复现：`open https://www.bilibili.com/video/BV1Zp4q6KEWa`。
2. **个别 UGC 视频页评论区长期「正在玩命加载…」**：同一流程在 bangumi 页正常（5,306 条），该页视频显示「正在缓冲… 0.00KB/s」，判断为站点/网络侧而非工具问题；建议回归时优先用纪录片页。
3. **`click` 命中检测边缘**：example.com 底部链接（y≈736，贴近视口底边）返回 `input_not_delivered`，`scroll_into_view` 未改变 `scrollY`（页面高度约等于视口）；属边缘场景。
4. **百度 `fill + Enter` 后 `wait urlIncludes` 可能竞态超时**：最终 URL 正确（`/s?...wd=bilibili`），但等待瞬间读到的仍是旧 URL；建议等待改为轮询/带延迟。

---

## 10. 开发侧核对与修复（2026-11-08）

本节补充开发侧的固定回归结果，保留第 9 节真实网站测试原文及受阻状态。固定页测试不替代 B 站登录验证。

| 项目 | 处理与证据 |
|---|---|
| `wait` 可见性 | 当前实现已默认读取 document。固定页把「回复」放在首屏下方，分别省略 `visible`、显式传 `false`，均成功且不滚动；`visible:true` 则超时，显式允许滚动后成功。第 9.4 的 B 站现象尚未独立复现，保留待核实。返回中的 `visible` 表示请求的可见性要求，不能据其为 `false` 推断实际目标不可见。 |
| `open` 与 SPA | 原实现已等待 DOM 就绪；异步渲染仍可能晚于该事件。新增 `waitUntil:"load"` 及导航就绪状态；滚动定位对尚未出现的文字/选择器有限重试，默认 5 秒。固定页在 DOM 就绪后延迟 250ms 插入「评论」，同一 `[open, scroll_to_text]` 批次通过；慢图片页 `waitUntil:"load"` 返回 `readyState:"complete"`。 |
| 元素失效错误 | 将原生协议的对象/节点失效错误统一为 `stale_ref`，携带 `documentVersion`、相关 ref 和恢复建议。固定页先点击删除输入框，再使用原 ref 填写：`executedSteps:[1]`、`failedStep:2`、`remainingSteps:[3]`，保留新快照且不执行步骤 3。 |
| T7 固定页 | 测试中的「立即登录」为带点击处理的 span，按文本点击后等待结果成功。真实 B 站是否渲染该元素仍是原受阻项。 |
| T4 故障注入 | 固定测试让原生 `capturePage` 抛出 surface 错误，验证 CDP 回退成功且 `attempts>=2`；再让所有路径失败，验证 `screenshot_surface_unavailable`、`attempts:3` 和具体 causes。不新增正常 MCP 可调用的故障开关。 |
| T10 Cookie | 新增本地服务端登录 fixture，以 HttpOnly Cookie 在另一个标签请求账号页，服务端确认已认证。已有四进程测试覆盖持久 Cookie 的写入、重启读取、退出登录和再次重启。B 站扫码登录续存仍需实测，状态查询继续标注 `serverAuthentication:unverified`。 |

验证入口：`node --test apps/desktop/test/browser-runtime.test.mjs`。Electron 测试和临时 profile 位于 D 盘项目环境中，不访问用户的测试标签或登录账号。

## 11. 第二轮阻断回归的开发侧修复（2026-11-08）

第 9.6 的失败记录保留。开发侧已复现一条与报告吻合的路径：动作在 ref 检查前，通过 `Runtime.evaluate` 等待两次 `requestAnimationFrame`；动画帧不回调时，每次都会等待 15 秒超时。该等待不会由外层超时主动取消，后续动作仍会重复进入同一等待。

- **修复前验证**：固定页令 `requestAnimationFrame` 不回调，执行 `[open 新文档, click 旧 ref, open 后续页]`，实际返回 `browser_operation_timeout`，而非预期的 `stale_ref`，测试失败。此测试不依赖 B 站账号或外部网络。
- **动作路径修复**：每步先检查 ref；移除所有通过 CDP 等待动画帧的就绪等待，改用有限的宿主计时。失效 ref 不进入输入准备，仍报告已完成/失败/剩余步骤，且不执行后续步骤。
- **连接恢复**：协议调用统一设置期限，超时后尝试断开并重新附加该标签的 CDP 连接，返回 `cdpReset`；使旧 ref 失效，不重放动作。定位、截图回退、JSON 资源读取和清理请求都使用该通道，清理也有期限。
- **T6 恢复测试**：动画帧不回调的页面中填写并 Enter 导航通过；再通过真实 CDP 执行一个永不完成的 Promise，触发 200ms 测试期限及连接重置，之后同标签填写、Enter 和新标签填写均成功，重置前 ref 返回 `stale_ref`。
- **T4 恢复测试**：上述连接重置后截图成功；已有测试仍覆盖原生 surface 故障后的 CDP 回退，以及三次全部失败的明确错误报告。截图成功不代表所有最小化/驱动故障均可强制恢复绘制。
- **SPA 滚动**：文字/选择器定位后、滚动前替换目标，允许重新定位一次，返回 `targetRetries:1`。显式 ref 不自动替换，点击/填写不自动重试，避免重复副作用。

第 9.6 已记录真实 B 站跨标签登录通过；本轮不会退出该账号。T7 继续由固定页验证文本点击，真实站点缺少对应元素时仍列为受阻。

三组浏览器回归及桌面端类型检查通过。正常退出旧桌面进程并启动新版后，在实际运行的应用中另建本地 HTTP 测试工作区：旧 ref 返回 `stale_ref`，`executedSteps:[1]`、`remainingSteps:[3]`；T6 填写加 Enter 导航为 `completed`；T4 返回图像且 `attempts:1`；新标签填写与滚动成功。临时测试标签已关闭。此处是修复后本地页实测，未改写第 9.6 的真实站点历史结果。
