# 内嵌浏览器自动化

浏览器由 Electron 提供，Rust 后台将同一套 MCP 工具交给各 Harness 插件。一个鹦鹉螺会话对应一个浏览器工作区，各次运行沿用该工作区。

## 等待与读取

- `open` 默认等待 `domcontentloaded`；`waitUntil:"load"` 还会等待图片等子资源，默认导航超时 20 秒，可用 `timeoutMs` 调整。DOM 或 load 就绪不代表 SPA 已完成渲染。
- 带文字、选择器或 ref 的滚动操作会先定位目标。文字和选择器在尚未出现时最多等待 5 秒（可用 `timeoutMs` 调整），适用于 `[open, scroll_to_text]`。已失效的 ref 直接返回 `stale_ref`，需要重新读取快照。
- `wait` 默认检查已加载文档中的内容，可以匹配首屏下方的文字。`visible:true` 要求目标位于当前视口。
- `alsoTryScroll:true` 允许等待过程中滚动目标。需要让屏幕显示该目标时，同时设置 `visible:true`。
- `browser_read` 和 `read` 支持 `selector`、`scope`、`offset`。输入框、文本域及下拉框的当前值位于 `fields`，密码等敏感输入返回 `redacted:true`。
- 返回 `nextOffset`、`continueWith` 时，按返回的参数继续读取。超过总长度的 offset 返回 `outOfRange:true` 和 `rangeHint`。offset 等于总长度表示已经读到末尾。
- 每步先检查 ref 是否属于当前文档。动作就绪和滚动后的短暂等待由宿主计时，不依赖网页的动画帧；窗口暂停绘制时不会因此无限等待。
- CDP 请求超时会尝试重置该标签的调试连接，错误中返回 `cdpReset`。重置会使旧 ref 失效，需要读取新快照；已经执行的输入不会自动重放。文字/选择器滚动在目标被 SPA 替换时重新查找一次，显式 ref 则直接报失效。

## 标签与登录状态

同一鹦鹉螺会话内的多轮对话复用标签。正常退出时保存标签、网址、缩放和滚动位置，在重新进入该会话时恢复。恢复会重新加载网页，需要重新获取 DOM ref。新建的鹦鹉螺会话有独立的标签工作区。

标签元数据保存在用户数据目录的 `browser-workspaces.json`。本机开发环境的用户数据目录是 `D:\NautiloEnv\data`。Cookie 使用 `persist:nautilo-browser` 分区，按站点设置的生命周期保存，并在变更和正常退出时写盘。Cookie 的存在和到期时间不能确认服务器是否仍接受登录，状态查询保留 `serverAuthentication:unverified`。

## 点击与测试网址

工具中的 Ctrl/Meta 加左键点击会将 HTTP(S) 超链接打开到后台标签，返回 `openedTabId`。同时按 Shift 会选择新标签。只有脚本事件而没有超链接地址的元素继续接收原生鼠标事件。

导航入口支持 HTTP 和 HTTPS，包括本地 HTTP 测试服务。`data:`、`file:` 等地址会返回 `invalid_url`。空白标签使用内部的 `about:blank`。

`browser_state.regions` 提供 selector、`matches` 和 `unique`。能生成唯一结构选择器时返回该选择器，无法区分的重复候选合并为一条并标注 `unique:false`。

## 固定回归测试

在项目环境中运行 `node --test apps/desktop/test/browser-runtime.test.mjs`。测试使用本地 HTTP 服务和隔离的临时用户数据目录，包含延迟渲染、屏外文字等待、元素移除后的批次中止、StaticText「立即登录」、截图 surface 失败及 CDP 回退、服务端确认跨标签 Cookie，以及多进程重启恢复与退出登录。

截图故障只在测试里替换 Electron 捕获方法和 CDP 返回值，不向正常运行的 MCP 暴露故障注入开关。真实网站扫码登录仍需用户完成；Cookie 数和名称存在性不能代替服务器对登录的确认。
