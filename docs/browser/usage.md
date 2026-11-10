# 浏览器工具补充用法

`browser_state` 和 `browser_session {"action":"list"}` 的 `capabilities` 返回当前服务版本、工具名称与能力入口。MCP 初始化也提供同一份清单。客户端若只显示旧工具，应刷新该 MCP 的工具列表；不能仅依据旧会话里的清单断言能力缺失。

## 页面导出与指定 URL 下载

这两个入口共用下载登记、来源标签归属与保存逻辑，但必须分别验收。

**页面导出**：点击网页的导出按钮或带 `download` 的链接，由浏览器产生下载事件。包括通过有效 `Blob` / `window.URL.createObjectURL` 生成的文件。

```json
{"steps":[{"action":"click","target":{"css":"#export"},"expect":{"event":{"type":"download"}}}],"snapshot":false}
```

随后调用 `browser_files`：

```json
{"action":"list","tabId":"来源标签 ID"}
```

用返回的 `download_id` 保存：

```json
{"action":"save","tabId":"来源标签 ID","download_id":"下载 ID","path":"D:\\Exports\\result.csv"}
```

**指定 URL 下载**：已知 HTTP(S) 文件地址时直接发起，不需要点击网页。这个入口成功不代表页面导出按钮也成功。

```json
{"action":"download","url":"https://example.com/result.csv","tabId":"来源标签 ID"}
```

当列表没有新增下载时，先查看 `page_errors`。这是该标签最近 30 秒内最多 5 条页面脚本错误。页面在创建 Blob URL 前抛错，就不会产生下载事件；不能通过修改系统 `URL` 对象来掩盖网页错误。

探针的内联事件应写 `window.URL.createObjectURL(blob)`。内联处理器中的裸 `URL` 可能解析为 `document.URL` 字符串。

## 页面请求、粘贴、日志与隔离登录环境

工具名称与参数如下，均接受 `tabId` / `tab_id`、`spaceId` / `space_id`。

| 能力 | 工具 | 参数示例 |
|---|---|---|
| 使用页面 Cookie 的相对请求 | `browser_fetch` | `{"url":"/api/me","response":"json"}` |
| 原生文本与 HTML 粘贴 | `browser_paste` | `{"target":{"css":"#editor"},"text":"hello","html":"<b>hello</b>"}` |
| 开启 console / 异常事件收集 | `browser_events` | `{"action":"watch","methods":["Runtime.consoleAPICalled","Runtime.exceptionThrown"]}` |
| 读取增量事件 | `browser_events` | `{"action":"list","since":0,"limit":20}` |
| 停止收集指定事件 | `browser_events` | `{"action":"unwatch","methods":["Runtime.consoleAPICalled"]}` |
| 独立持久化登录环境 | `browser_session` | `{"action":"open","name":"工作账号","profile_id":"work"}` |
| 不持久化 Cookie 的隔离环境 | `browser_session` | `{"action":"open","name":"临时环境","profile_id":"temporary","isolated":true}` |

`fetch` 保留页面的 CORS 约束。粘贴触发原生 paste 事件，并在用户没有另行复制内容时恢复原剪贴板。日志取消订阅只停止记录指定事件，不关闭其他浏览器能力依赖的 CDP 域。创建环境不会替换已有空间的账号；独立 profile 不等于接管外部 Chrome。

## 关窗与用户接管

- 首次调用自动开窗；关闭全部浏览器窗口只中断当时正在执行的请求。
- 中断回执为 `BROWSER_CLOSED`，批次状态为 `paused`。下一次调用自动重新打开；仅处理未完成步骤，已派发动作不能盲目重放。
- `CONTROL_TAKEN` 表示明确的用户交接，需要等待用户交还。普通鼠标移动、点击和滚动不自动接管。
- `finish`、`handoff`、取消下载等收尾操作不会为了结束任务额外打开窗口。

## 滚动与点击回执（1.2.1）

像素滚动会比较实际滚动位置，包含嵌套滚动容器。无坐标时优先选择中性区域，避开播放器、输入框等；显式 x/y 保留调用方的目标点。滚轮派发最多等待 1 秒；出现超时的页面后续使用 DOM 滚动降级，主文档导航后恢复滚轮通道。页面探测与协议恢复有各自的限时，不表示整个调用固定 1 秒返回。

滚动成功返回 `moved:true`、`scroll_before`、`scroll_after`、`scroll_target` 和 `method`（wheel 或 dom-scroll）。容器滚动时文档的 scrollY 可能不变，应看目标容器的位置。降级使用起始位置加目标距离的绝对位置，不再次发送同一滚轮事件。没有位移或已到边界返回 `SCROLL_NO_EFFECT`，附 `at_boundary` 与可能的 `wheel_error`，不报告 completed。

目标点击在节点和同一 shadow root 内观察 pointerdown / mousedown / click，避免从 document 外观察 closed shadow 得到假阴性。移动鼠标后、按下前重新检查遮挡；错误中的 `hit` 给出命中元素的标签、选择器及短文本。

若已派发原生事件但无法确认送达，回执为 `dispatched:true,inputDelivered:null,delivery:"unknown",retrySafe:false`。这只表示动作派发，不是业务验证通过；应读取状态或使用 expect，不自动重复点击。确认落在别的元素时返回 `input_not_delivered`，附 hit 与 `retryable:false`；它可能已触发另一个元素。
