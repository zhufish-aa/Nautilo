package app.nautilo.mobile

import androidx.activity.OnBackPressedDispatcher
import androidx.activity.OnBackPressedDispatcherOwner
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.app.ActivityOptionsCompat
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import app.cash.paparazzi.Snapshot
import app.cash.paparazzi.SnapshotHandler
import app.nautilo.mobile.data.*
import app.nautilo.mobile.ui.NautiloApp
import app.nautilo.mobile.ui.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Rule
import org.junit.Test
import org.mockito.Mockito
import java.io.File
import java.lang.reflect.Proxy

/** Renders the shipping screen and text widgets, not an HTML approximation. */
class MobileDesignSnapshotTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_5, theme = "NautiloTheme", snapshotHandler = FinalFrameCapture())

    private fun state(answer: String) = MobileState(screen = Screen.Chat, connected = true,
        session = Conversation("session", "project", "回归测试", "idle", "", "gpt-6.1-sol", "max", agentId = "codex"),
        projects = listOf(Project("project", "Nautilo")),
        runs = listOf(RunInfo("run", "completed", "2026-11-14T01:00:00Z", "2026-11-14T01:13:14Z")),
        messages = listOf(ChatMessage("question", "user", "这轮回归结果怎么样？", ""), ChatMessage("answer", "agent", answer, "", runId = "run")))

    private fun render(state: MobileState, name: String) {
        val model = Mockito.mock(MobileViewModel::class.java)
        Mockito.`when`(model.state).thenReturn(MutableStateFlow(state))
        val owner = PreviewOwner()
        val view = ComposeView(paparazzi.context).apply { setContent {
            CompositionLocalProvider(LocalOnBackPressedDispatcherOwner provides owner,
                LocalActivityResultRegistryOwner provides owner, LocalLifecycleOwner provides owner) {
                NautiloApp(model, null, {})
            }
        } }
        paparazzi.gif(view, name = name, start = 0, end = 1000, fps = 10)
    }

    @Test fun desktopConversationLanguageOnPhone() = render(state("""
        这轮没有 10 条全部通过：**9 通过 / 0 部分 / 0 失败 / 1 受阻**。

        ### 本轮结果

        - 两项 P0 保持稳定，没有回归。
        - 页面读取、批量操作和输入均已通过。
        - 登录场景需要扫码后继续验证。

        | 验收项 | 结果 |
        | :--- | :--- |
        | 懒加载评论 | 已通过 |
        | 批量失败报告 | 已通过 |
        | 登录后同步 | 待验证 |

        可以继续验证剩余场景，完成后再更新结论。
    """.trimIndent()), "conversation")

    @Test fun markdownWithCodeAndComfortableType() = render(state("""
        ### 读取页面内容

        先等待页面加载，再读取评论区域。`#comment` 用于定位页面中的评论容器。

        ```typescript
        const result = await browser.read({
          selector: "#comment",
          format: "text",
        });

        console.log(result.text);
        ```

        > 已完成的步骤会保留，失败后会停止后续操作。

        **下一步**：验证多标签切换和长列表分页。
    """.trimIndent()), "markdown")

    @Test fun quietNewConversation() = render(state("").copy(screen = Screen.NewConversation,
        setup = json("agents" to org.json.JSONArray().put(json("id" to "codex", "name" to "Codex"))),
        newModels = listOf(json("id" to "gpt-6.1-sol", "displayName" to "GPT-6.1"))), "new-conversation")

    @Test fun questionMatchesDesktopCard() = render(state("").copy(messages = emptyList(), runs = emptyList(),
        interactions = listOf(json("id" to "question", "kind" to "question", "title" to "界面偏好", "status" to "pending",
            "questions" to org.json.JSONArray().put(json("id" to "style", "question" to "你更喜欢哪种界面风格？", "isOther" to true,
                "options" to org.json.JSONArray().put(json("id" to "a", "label" to "简洁高级（推荐）")).put(json("id" to "b", "label" to "清新柔和")).put(json("id" to "c", "label" to "深色沉浸"))))))), "question")

    @Test fun focusedComposerExpandsWithinItsOwnSurface() {
        val owner = PreviewOwner()
        val view = ComposeView(paparazzi.context).apply { setContent {
            CompositionLocalProvider(LocalOnBackPressedDispatcherOwner provides owner, LocalLifecycleOwner provides owner) {
                NautiloTheme {
                    val requester = remember { FocusRequester() }
                    Column(Modifier.fillMaxSize().background(Color.White), verticalArrangement = Arrangement.Bottom) {
                        ChatComposer("", {}, "发送消息", true, false, onAttach = {}, onRemoveAttachment = {}, onVoice = {}, onSend = {},
                            configurationEnabled = true, onConfiguration = {}, inputFocusRequester = requester, onModes = {})
                    }
                    LaunchedEffect(Unit) { kotlinx.coroutines.delay(100); requester.requestFocus() }
                }
            }
        } }
        paparazzi.gif(view, name = "composer-expanded", start = 0, end = 1000, fps = 10)
    }

    @Test fun connectionConfirmationUsesAppTypography() {
        val view = ComposeView(paparazzi.context).apply { setContent {
            NautiloTheme {
                Box(Modifier.fillMaxSize().background(Color(0xFFEDEDED)), contentAlignment = Alignment.Center) {
                    NAlertContent(title = { androidx.compose.material3.Text("切换连接？") },
                        text = { androidx.compose.material3.Text("聊天记录会保留。更换连接后将重新建立原生会话，旧连接的推理、缓存和图片上下文不会迁移。") },
                        confirmButton = { NButton({}) { androidx.compose.material3.Text("切换连接") } },
                        dismissButton = { NTextButton({}) { androidx.compose.material3.Text("取消") } })
                }
            }
        } }
        paparazzi.gif(view, name = "confirmation", start = 0, end = 1000, fps = 10)
    }

    @Test fun composerExpansionAndCollapseMotionFrames() {
        val owner = PreviewOwner()
        val view = ComposeView(paparazzi.context).apply { setContent {
            CompositionLocalProvider(LocalOnBackPressedDispatcherOwner provides owner, LocalLifecycleOwner provides owner) {
                NautiloTheme {
                    val requester = remember { FocusRequester() }
                    val focus = LocalFocusManager.current
                    Column(Modifier.fillMaxSize().background(Color.White), verticalArrangement = Arrangement.Bottom) {
                        ChatComposer("", {}, "发送消息", true, false, onAttach = {}, onRemoveAttachment = {}, onVoice = {}, onSend = {},
                            configurationEnabled = true, onConfiguration = {}, inputFocusRequester = requester, onModes = {})
                    }
                    LaunchedEffect(Unit) {
                        kotlinx.coroutines.delay(200); requester.requestFocus()
                        kotlinx.coroutines.delay(500); focus.clearFocus()
                    }
                }
            }
        } }
        paparazzi.gif(view, name = "composer-motion", start = 0, end = 1200, fps = 30)
    }

    @Test fun projectListSeparatesProjectCreationFromSessionAndFiles() {
        val model = Mockito.mock(MobileViewModel::class.java)
        val base = MobileState(connected = true, host = Host("desktop", "我的电脑", json()),
            projects = listOf(Project("nautilo", "Nautilo", "D:/Nautilo"), Project("notes", "研究笔记", "D:/Notes")),
            sessions = listOf(Conversation("chat", "nautilo", "检查远程连接与文件预览", "idle", "")))
        render(base, "project-create-and-files")
    }

    @Test fun phoneFilePreviewShowsReadableHighlightedSource() {
        val model = Mockito.mock(MobileViewModel::class.java)
        val code = """
            // 保留项目边界，按块读取文件。
            pub fn preview(path: &str) -> Result<Value> {
                let offset = 0;
                let limit = 524_288;
                read_workspace_range(path, offset, limit)
            }
        """.trimIndent()
        val base = MobileState(screen = Screen.FilePreview, filePreview = RemoteFilePreview(path="rust/nautilo-core/src/application/preview.rs", mimeType="text/plain", size=code.toByteArray().size.toLong(), bytes=code.toByteArray(), line=2))
        render(base, "file-preview-highlight")
    }

    @Test fun phonePhotosAppearInMessageAndComposer() {
        val photo = File(System.getenv("NAUTILO_ANDROID_BUILD_DIR") ?: "build", "app/design-previews/attachment-fixture.png")
        photo.parentFile.mkdirs()
        val bitmap = android.graphics.Bitmap.createBitmap(720, 480, android.graphics.Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(bitmap)
        canvas.drawColor(android.graphics.Color.rgb(235, 241, 231))
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
        paint.color = android.graphics.Color.rgb(143, 172, 133)
        canvas.drawCircle(190f, 240f, 165f, paint)
        paint.color = android.graphics.Color.rgb(216, 177, 112)
        canvas.drawCircle(470f, 270f, 135f, paint)
        photo.outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        val attachment = DraftAttachment("picked", "照片.png", "image/png", photo.length(), photo.path)
        val current = state("").copy(messages = listOf(ChatMessage("photo-message", "user", "看看这张图片", "",
            attachments = listOf(ChatAttachment.draft(attachment)))), draftAttachments = listOf(attachment), runs = emptyList())
        val model = Mockito.mock(MobileViewModel::class.java)
        val owner = PreviewOwner()
        val view = ComposeView(paparazzi.context).apply { setContent {
            CompositionLocalProvider(LocalOnBackPressedDispatcherOwner provides owner,
                LocalActivityResultRegistryOwner provides owner, LocalLifecycleOwner provides owner) {
                NautiloTheme { ChatScreen(current, model) }
            }
        } }
        paparazzi.gif(view, name = "chat-photo-preview", start = 0, end = 1000, fps = 10)
    }

    private fun configurationPanel(name: String, height: Int, fontScale: Float) {
        val model = Mockito.mock(MobileViewModel::class.java)
        val values = listOf("GPT-6.1-Sol", "GPT-6-Astra", "GPT-6.1 Terra", "GPT-6-Sol", "GPT-6-Luna", "GPT-5.6-Sol", "GPT-6.1-Sol Mini", "GPT-6-Sol Fast")
        val state = state("").copy(session = state("").session!!.copy(model = "model-4", connectionId = "account"),
            setup = json("connections" to org.json.JSONArray().put(json("id" to "account", "name" to "Codex 账号 2", "kind" to "login"))),
            models = values.mapIndexed { index, value -> json("id" to "model-$index", "displayName" to value,
                "reasoningEfforts" to org.json.JSONArray(listOf("low", "medium", "high", "xhigh", "max"))) })
        val view = ComposeView(paparazzi.context).apply { setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale)) {
                NautiloTheme {
                    Box(Modifier.fillMaxSize().background(Color(0xFFEDEDED)).padding(top = 36.dp, bottom = 28.dp), contentAlignment = Alignment.BottomCenter) {
                        SessionConfigurationEditor(state, model, {}) { content ->
                            Column(Modifier.fillMaxWidth().height(height.dp).background(Color.White, RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)).padding(top = 14.dp)) { content() }
                        }
                    }
                }
            }
        } }
        paparazzi.gif(view, name = name, start = 0, end = 1000, fps = 10)
    }
    @Test fun modelActionsRemainVisibleInNormalSheet() = configurationPanel("model-settings-safe", 640, 1f)
    @Test fun modelActionsRemainVisibleWithKeyboardAndLargeText() = configurationPanel("model-settings-short-large", 380, 1.4f)

    @Test fun activeConversationKeepsCommentaryBeforeLaterTools() {
        val input = json("description" to "检查工作区", "code" to "const r = await tools.read({ path: 'main.rs' });\nconsole.log(r);").toString()
        val execution = json("description" to "检查工作区", "calls" to org.json.JSONArray()
            .put(json("callId" to "read", "name" to "read", "status" to "done", "input" to json("path" to "src/main.rs"), "output" to "fn main() {}"))
            .put(json("callId" to "shell", "name" to "pwsh", "status" to "running", "input" to json("description" to "检查项目状态", "command" to "git status --short"))))
        render(state("").copy(runId = "run", runStatus = "running", runs = listOf(RunInfo("run", "running", "2026-11-14T01:00:00Z", "")),
            messages = listOf(ChatMessage("u", "user", "帮我检查一下项目。", "2026-11-14T01:00:00Z"),
                ChatMessage("comment", "agent", "我先查看工作区和当前改动，再根据结果继续处理。", "2026-11-14T01:00:01Z", runId = "run", sequence = 1)),
            activities = listOf(ActivityItem("code", "tool", "run_code", running = true, time = "2026-11-14T01:00:02Z", runId = "run", sequence = 2,
                payload = json("inputSummary" to input, "codeExecution" to execution)))), "pc-ordered-active-conversation")
    }

    @Test fun newOverviewAndHarnessPickerUseBoundedFooters() {
        val owner = PreviewOwner()
        val view = ComposeView(paparazzi.context).apply { setContent {
            CompositionLocalProvider(LocalOnBackPressedDispatcherOwner provides owner, LocalLifecycleOwner provides owner) {
                NautiloTheme {
                    Box(Modifier.fillMaxSize().background(Color(0xFFEDEDED)).padding(bottom = 28.dp), contentAlignment = Alignment.BottomCenter) {
                        Column(Modifier.fillMaxWidth().heightIn(max = 520.dp).background(Color.White, RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)).padding(top = 14.dp)) {
                            NewConversationSettingsContent("DeepSeek Harness", "DeepSeek API", "DeepSeek V4", "最高", true, {}, {}, {})
                        }
                    }
                }
            }
        } }
        paparazzi.gif(view, name = "new-settings-footer", start = 0, end = 1000, fps = 10)
    }

    @Test fun allHarnessChoicesCanScrollAboveCancel() {
        val owner = PreviewOwner()
        val harnesses = listOf("DeepSeek Harness", "Codex", "OpenCode", "Claude Code", "Kimi Code", "Pi", "Trae", "自定义 Harness")
        val state = state("").copy(setup = json("agents" to org.json.JSONArray(harnesses.mapIndexed { index, name -> json("id" to "$index", "name" to name) })))
        val view = ComposeView(paparazzi.context).apply { setContent {
            CompositionLocalProvider(LocalOnBackPressedDispatcherOwner provides owner, LocalLifecycleOwner provides owner) {
                NautiloTheme {
                    Box(Modifier.fillMaxSize().background(Color(0xFFEDEDED)).padding(bottom = 28.dp), contentAlignment = Alignment.BottomCenter) {
                        Column(Modifier.fillMaxWidth().height(560.dp).background(Color.White, RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)).padding(top = 14.dp)) {
                            CreationChoiceContent(CreationPicker.Harness, state, "", "0", "", "", "", {}, {}, {}, {})
                        }
                    }
                }
            }
        } }
        paparazzi.gif(view, name = "harness-picker-footer", start = 0, end = 1000, fps = 10)
    }
}

/** Advances actual frames and writes the unmodified final Android-rendered bitmap. */
private class FinalFrameCapture : SnapshotHandler {
    override fun newFrameHandler(snapshot: Snapshot, frameCount: Int, fps: Int): SnapshotHandler.FrameHandler {
        var frames = 0
        // Android's compile bootclasspath omits java.desktop. The renderer runs
        // on the full host JDK; reflection keeps desktop-only types out of it.
        return Proxy.newProxyInstance(SnapshotHandler.FrameHandler::class.java.classLoader, arrayOf(SnapshotHandler.FrameHandler::class.java)) { _, method, args ->
            when (method.name) {
                "handle" -> {
                    frames++
                    if (frames == frameCount || snapshot.name == "composer-motion") {
                        val name = if (snapshot.name == "composer-motion") "composer-motion/frame-${(frames - 1).toString().padStart(3, '0')}" else snapshot.name
                        val output = File(requireNotNull(System.getenv("NAUTILO_ANDROID_BUILD_DIR")), "app/design-previews/$name.png")
                        output.parentFile!!.mkdirs()
                        val writer = Class.forName("javax.imageio.ImageIO").methods.first { it.name == "write" && it.parameterTypes.size == 3 && it.parameterTypes[2] == File::class.java }
                        check(writer.invoke(null, args!![0], "png", output) == true)
                    }
                }
                "close" -> check(frames == frameCount)
            }
            null
        } as SnapshotHandler.FrameHandler
    }
    override fun close() = Unit
}

private class PreviewOwner : LifecycleOwner, OnBackPressedDispatcherOwner, ActivityResultRegistryOwner {
    override val lifecycle = LifecycleRegistry.createUnsafe(this).apply { currentState = Lifecycle.State.RESUMED }
    override val onBackPressedDispatcher = OnBackPressedDispatcher()
    override val activityResultRegistry = object : ActivityResultRegistry() {
        override fun <I, O> onLaunch(requestCode: Int, contract: ActivityResultContract<I, O>, input: I, options: ActivityOptionsCompat?) = Unit
    }
}
