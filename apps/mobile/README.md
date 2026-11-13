# Nautilo Mobile

原生 Android 客户端：Kotlin、Jetpack Compose、Android Keystore，以及与桌面 Rust 后端相同的 Iroh 1.4.1 加密 P2P 协议。界面包含项目列表、新建会话、聊天、工作区、独立文件 Diff 和电脑连接页面。

## 使用

1. 安装 APK（Android 8.0 或更新版本）。
2. 在电脑 Nautilo 的「设置 → 远程连接」启用连接，点击「配对新设备」。
3. 手机选择「连接我的电脑 → 扫描二维码」，或粘贴配对链接。
4. 核对两端的六位数字，在电脑上确认。配对后即可操作全部项目，后来新建的项目也自动出现。

手机首页的「+」打开新会话首页：顶部切换项目，底部直接输入第一条消息，发送时创建会话。Harness、已配置账号 / API、模型和推理强度在输入框上方选择，沿用当前会话配置；模型列表缓存，手动刷新才重新获取。输入框旁「+」可以选择电脑目录添加项目，或在电脑指定目录下创建新文件夹作为项目。

消息立即进入会话，正文、思考和工具事件持续同步；每轮回复在 Nautilo 名称旁显示该轮真实状态和耗时。支持审批和问题回应、运行中引导 / 排队、主动停止、切换模型与推理强度、查看当前会话的文件变更和团队成员。语音输入调用设备可用的系统语音识别服务。

同一轮的中间说明、工具调用和思考归入一个可折叠执行过程，最终回复保留在折叠区外。Markdown 使用 CommonMark 解析，表格按原生单元格渲染，宽表独立横向滚动。模型面板只滚动模型列表，推理强度固定显示。

工作区点击文件进入独立 Diff 页面，提供真实新旧行号、增删底色、语法高亮、改动定位、换行和当前文件视图。差异和高亮在后台计算；没有原始快照时不把整个文件伪算成新增，未提供的内容明确显示不可用。界面字体统一，代码使用随 APK 内置的 JetBrains Mono，许可证见 `FONT-LICENSE.txt`。

已有会话点击输入框上方的模型，打开「模型与连接」，点击当前连接可切换账号或 API，选择对应模型后应用。运行中的请求结束后才能更改连接；有历史的连接切换会说明原生上下文影响，文字记录保留。手机不复制账号凭据，仍由电脑保存和使用；所选 Codex / Claude 账号的跨 Harness 转发沿用电脑端的账号网关。

新会话页采用浅色底、底部蓝色柔光和原生呼吸标识；键盘、选择面板、页面切换及新消息衔接均用 Compose 动效，遵循系统动画时长设置。历史消息同步和回执更新不会重复播放入场动画。

电脑需保持开机、在线且 Nautilo 后端运行。自动连接优先尝试直连，必要时使用 Iroh 加密中继，无需给电脑开放公网端口。在后台断网时手机保留草稿和待发送消息；重新打开后重新连接和同步。关闭手机页面不会停止电脑上已经接受的任务。停止任务需要主动点击「停止」。

## 构建安装包

需要 JDK 21、Android SDK platform 35 / build-tools 35.0.0。Gradle Wrapper 固定为 8.14.4，校验官方发行文件 SHA-256。

在仓库根目录运行：

```powershell
$env:JAVA_HOME = 'C:/Program Files/Eclipse Adoptium/jdk-21.0.10.7-hotspot'
$env:ANDROID_HOME = 'C:/Users/admin/AppData/Local/Android/Sdk'
pnpm mobile:apk
```

Windows 上有 D 盘时，脚本默认把缓存、临时文件、构建输出和签名文件放在 `D:/CodexBuildCache/Nautilo/mobile`，复用已有的 `D:/GradleHome`。可以通过 `NAUTILO_MOBILE_CACHE`、`GRADLE_USER_HOME`、`NAUTILO_ANDROID_BUILD_DIR` 覆盖。

输出：`<缓存目录>/artifacts/Nautilo-Mobile-0.1.1.apk`，附 SHA-256 文件。APK 包含 arm64-v8a、armeabi-v7a、x86_64。

首次构建会在缓存目录的 `signing` 子目录生成发布签名；此目录必须私下备份，后续更新沿用同一签名。**不要提交 keystore 或密码文件。** 也可以用 `NAUTILO_ANDROID_SIGNING` 指向自己的签名 properties 文件（`storeFile`、`storePassword`、`keyAlias`、`keyPassword`）。

## 结构

- `data/`：加密身份、配对电脑、草稿、待发送指令和增量会话投影。
- `transport/`：JNI Iroh endpoint、连接复用、独立双向请求流、身份校验。
- `MobileViewModel.kt`：生命周期、重连、历史与事件同步、会话操作。
- `ui/`：Compose 页面、原生底部抽屉、提问 / 审批、消息动效。
- `src/test/`：消息去重、累计增量、历史合并、配对数据校验。
- `src/androidTest/`：真实 Android endpoint 配对 / 重连，以及可选的真实 Harness 流式收发验证。

普通单元测试：

```sh
apps/mobile/gradlew -p apps/mobile :app:testDebugUnitTest
```

`ConnectionTest` 需要 instrumentation 参数 `invitation` 和电脑侧确认。`ConversationTest` 是显式运行的联调测试，需要已配对设备、可丢弃的电脑目录 `projectRoot`、可用 `agentId` / `connectionId` / `model`，会创建测试项目和会话并实际请求模型。它只处理此测试目录的首次授权提示，不自动批准其他原生请求。

手机端配对身份、电脑地址、草稿及待发送记录使用 Android Keystore 的 AES-GCM 加密，原子写入应用私有且不参与备份的目录。电脑账号凭据留在电脑端；手机不需要录入 API 密钥。
