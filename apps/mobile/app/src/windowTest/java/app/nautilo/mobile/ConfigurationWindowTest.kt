@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package app.nautilo.mobile

import android.app.Application
import android.graphics.Insets
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.clickable
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import app.nautilo.mobile.data.*
import app.nautilo.mobile.ui.*
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog

/** The shipping dialog, including its Android window, not a body-only preview. */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [35], qualifiers = "w393dp-h851dp-xhdpi")
class ConfigurationWindowTest {
    @get:Rule val compose = createComposeRule()
    private val model = Mockito.mock(MobileViewModel::class.java)
    private fun state() = MobileState(connected = true,
        session = Conversation("fixture", "project", "设置", "idle", "", "model-0", "low"),
        setup = json("agents" to JSONArray((0..15).map { json("id" to "agent-$it", "name" to "Harness $it") })),
        models = (0..20).map { json("id" to "model-$it", "displayName" to "模型 $it", "reasoningEfforts" to JSONArray(listOf("low", "medium", "high", "xhigh", "max"))) })

    private fun assertButtonWithinActualWindow(tag: String) {
        compose.onNodeWithTag(tag).assertIsDisplayed()
        val node = compose.onNodeWithTag(tag).fetchSemanticsNode()
        val coordinates = node.layoutInfo.coordinates
        val origin = coordinates.localToWindow(Offset.Zero)
        val decor = ShadowDialog.getLatestDialog().window!!.decorView
        println("$tag bounds=${node.boundsInRoot} origin=$origin size=${coordinates.size} decor=${decor.width}x${decor.height}")
        assertTrue("$tag above window: $origin", origin.y >= 0)
        assertTrue("$tag clipped: ${origin.y + coordinates.size.height} > ${decor.height}", origin.y + coordinates.size.height <= decor.height)
        assertTrue("$tag outside horizontal bounds", origin.x >= 0 && origin.x + coordinates.size.width <= decor.width)
        assertTrue("$tag lost its touch height", coordinates.size.height >= 44 * decor.resources.displayMetrics.density)
    }
    private fun tapInWindow(node: SemanticsNodeInteraction) {
        compose.mainClock.advanceTimeBy(150)
        compose.waitForIdle()
        val coordinates = node.fetchSemanticsNode().layoutInfo.coordinates
        val center = coordinates.localToWindow(Offset(coordinates.size.width / 2f, coordinates.size.height / 2f))
        val window = ShadowDialog.getLatestDialog()
        val origin = IntArray(2)
        var downTime = 0L
        compose.runOnUiThread {
            window.window!!.decorView.getLocationOnScreen(origin)
            println("window-screen-origin=${origin.toList()} decor-top=${window.window!!.decorView.top}")
            downTime = SystemClock.uptimeMillis()
            val down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, center.x + origin[0], center.y + origin[1], 0).apply { offsetLocation(-origin[0].toFloat(), -origin[1].toFloat()) }
            try { println("tap $center down=${window.dispatchTouchEvent(down)}") } finally { down.recycle() }
        }
        compose.mainClock.advanceTimeBy(80)
        compose.waitForIdle()
        compose.runOnUiThread {
            val up = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, center.x + origin[0], center.y + origin[1], 0).apply { offsetLocation(-origin[0].toFloat(), -origin[1].toFloat()) }
            try { println("tap $center up=${window.dispatchTouchEvent(up)}") } finally { up.recycle() }
        }
        compose.mainClock.advanceTimeBy(100)
        compose.waitForIdle()
    }

    @Test fun buttonTouchWorksInTheActivityControl() {
        var clicked = false
        compose.setContent { NautiloTheme { NButton({ clicked = true }, modifier = Modifier.testTag("control")) { androidx.compose.material3.Text("测试按钮") } } }
        compose.onNodeWithTag("control").performTouchInput { click() }
        compose.mainClock.advanceTimeBy(150)
        compose.runOnIdle { assertTrue("Activity control did not receive a touch", clicked) }
    }

    @Test fun projectPlusOpensProjectCreationAndProjectSessionKeepsItsWorkspace() {
        val base = state().copy(host = Host("desktop", "Computer", json()), projects = listOf(Project("project", "Nautilo", "D:/Nautilo")))
        compose.setContent { NautiloTheme { ProjectsScreen(base, model, false, {}, {}) } }
        compose.onNodeWithTag("projects-create-project").performClick()
        compose.onNode(hasText("新建项目") and hasAnyAncestor(hasTestTag("app-sheet"))).assertIsDisplayed()
        compose.onNodeWithText("已有目录").assertIsDisplayed()
        compose.onNodeWithText("新建文件夹").assertIsDisplayed()
        Mockito.verify(model).browse("", 0)
        tapInWindow(compose.onNodeWithContentDescription("关闭"))
        compose.onNodeWithTag("project-new-session:project").performClick()
        Mockito.verify(model).beginConversation("project")
        compose.onNodeWithTag("project-files:project").performClick()
        Mockito.verify(model).openProjectFiles("project")
    }

    @Test fun projectFileRowsOpenTheSelectedFileRatherThanTheDiffList() {
        val base = state().copy(fileProject = Project("project", "Nautilo", "D:/Nautilo"),
            projectFiles = json("path" to "src", "parent" to "", "entries" to JSONArray().put(json("name" to "demo.rs", "path" to "src/demo.rs", "size" to 30, "directory" to false))))
        compose.setContent { NautiloTheme { ProjectFilesScreen(base, model) } }
        compose.onNodeWithText("demo.rs").performClick()
        Mockito.verify(model).previewFile(FileReference("src/demo.rs"), false)
    }

    @Test @Config(qualifiers = "w393dp-h480dp-xhdpi")
    fun projectCreationKeepsItsActionVisibleOnAShortWindowWithLargeType() {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 1.4f)) {
                NautiloTheme { NewProjectSheet(state(), model, {}, {}) }
            }
        }
        assertButtonWithinActualWindow("project-create-submit")
    }

    @Test fun selectedProjectWinsOverThePreviousChatWhenStartingANewSession() {
        val base = state().copy(screen = Screen.NewConversation, newConversationProjectId = "chosen", projects = listOf(Project("project","旧项目"), Project("chosen","目标项目")))
        compose.setContent { NautiloTheme { NewConversationScreen(base, model) } }
        compose.onNodeWithText("目标项目").assertIsDisplayed()
        compose.onNodeWithText("旧项目").assertDoesNotExist()
    }

    @Test fun markdownFileLinksAndTableCellsUseTheSameInAppPreviewCallback() {
        val opened = mutableListOf<FileReference>()
        var root: View? = null
        compose.setContent {
            val view = LocalView.current
            SideEffect { root = view.rootView }
            NautiloTheme { CompositionLocalProvider(LocalFileOpener provides { opened.add(it); Unit }) {
                Markdown("[代码](/D:/Nautilo/src/main.rs#L12)\n\n| 文件 |\n| --- |\n| [配置](package.json) |")
            } }
        }
        fun collect(view: View): List<android.widget.TextView> = when (view) {
            is android.widget.TextView -> listOf(view)
            is ViewGroup -> (0 until view.childCount).flatMap { collect(view.getChildAt(it)) }
            else -> emptyList()
        }
        compose.runOnIdle {
            collect(requireNotNull(root)).forEach { view ->
                (view.text as? android.text.Spanned)?.getSpans(0, view.text.length, android.text.style.ClickableSpan::class.java)?.forEach { it.onClick(view) }
            }
        }
        assertEquals(listOf(FileReference("D:/Nautilo/src/main.rs",12), FileReference("package.json")), opened)
    }

    @Test fun codePreviewKeepsHighlightingWhenAnotherChunkArrives() {
        val current = mutableStateOf(state().copy(filePreview = RemoteFilePreview(path="src/demo.rs", mimeType="text/plain", size=100,
            bytes="fn main() {}".toByteArray(), nextOffset=12)))
        compose.setContent { NautiloTheme { FilePreviewScreen(current.value, model) } }
        compose.onNodeWithText("fn main() {}").assertIsDisplayed()
        compose.runOnUiThread { current.value = current.value.copy(filePreview = current.value.filePreview.copy(bytes="fn main() {}\nlet value = 42;".toByteArray(), nextOffset=null)) }
        compose.onNodeWithText("let value = 42;").assertIsDisplayed()
        compose.waitUntil(3000) {
            compose.onNodeWithText("let value = 42;").fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.Text].first().spanStyles.isNotEmpty()
        }
    }

    @Test fun reasoningKeepsTheOriginalStreamingAndCompletedPreviewRules() {
        val current = mutableStateOf(ActivityItem("thinking", "thought", "思考", "最初的思考\n\n最新的思考", true))
        var root: View? = null
        compose.setContent {
            val view = LocalView.current
            SideEffect { root = view.rootView }
            NautiloTheme { ProcessActivity(current.value) }
        }
        compose.onNodeWithText("最新的思考").assertIsDisplayed()
        compose.onNodeWithText("最初的思考").assertDoesNotExist()
        compose.runOnUiThread { current.value = current.value.copy(detail = "最初的思考\n\n最新的思考\n\n刚刚补充的内容") }
        compose.onNodeWithText("刚刚补充的内容").assertIsDisplayed()
        compose.runOnUiThread { current.value = current.value.copy(running = false) }
        compose.onNodeWithText("刚刚补充的内容").assertIsDisplayed()
        compose.onNodeWithText("思考").performClick()
        fun collect(view: View): List<android.widget.TextView> = when (view) {
            is android.widget.TextView -> listOf(view)
            is ViewGroup -> (0 until view.childCount).flatMap { collect(view.getChildAt(it)) }
            else -> emptyList()
        }
        compose.runOnIdle {
            val full = collect(requireNotNull(root)).map { it.text.toString() }.first { it.contains("最初的思考") }
            assertTrue(full.indexOf("最初的思考") < full.indexOf("刚刚补充的内容"))
        }
        compose.onNodeWithText("思考").performClick()
        compose.onNodeWithText("刚刚补充的内容").assertIsDisplayed()
    }

    @Test fun pickedPhotoShowsThumbnailAndCanBeRemovedWithoutSending() {
        val file = java.io.File.createTempFile("nautilo-photo-", ".png")
        try {
            android.graphics.Bitmap.createBitmap(640, 400, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.GREEN) }
                .let { bitmap -> file.outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } }
            var attachments by mutableStateOf(listOf(DraftAttachment("photo", "照片.png", "image/png", file.length(), file.path)))
            compose.setContent { NautiloTheme {
                ChatComposer("", {}, "发送消息", true, true, attachments = attachments, onAttach = {},
                    onRemoveAttachment = { attachments = attachments - it }, onVoice = {}, onSend = {}, configurationEnabled = true, onConfiguration = {})
            } }
            compose.waitUntil(5000) { compose.onAllNodesWithContentDescription("照片.png").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithContentDescription("照片.png").assertIsDisplayed()
            compose.onNodeWithContentDescription("移除 照片.png").performClick()
            compose.onNodeWithTag("attachment-image-photo").assertDoesNotExist()
        } finally { file.delete() }
    }

    @Test fun messagePhotoShowsInlineAndOpensAnInAppViewer() {
        val file = java.io.File.createTempFile("nautilo-photo-", ".png")
        try {
            android.graphics.Bitmap.createBitmap(640, 400, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.GREEN) }
                .let { bitmap -> file.outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } }
            val attachment = ChatAttachment("photo", "消息照片.png", "image/png", file.length(), "image", localPath = file.path)
            compose.setContent { NautiloTheme { MessageRow(ChatMessage("message", "user", "请查看附件。", "", attachments = listOf(attachment)), "session") {} } }
            compose.waitUntil(5000) { compose.onAllNodesWithContentDescription("消息照片.png").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("请查看附件。").assertDoesNotExist()
            compose.onNodeWithTag("attachment-image-photo").performClick()
            compose.onNodeWithContentDescription("关闭图片").assertIsDisplayed().performClick()
            compose.onNodeWithTag("attachment-image-photo").assertIsDisplayed()
        } finally { file.delete() }
    }

    @Test @Config(qualifiers = "w393dp-h480dp-xhdpi")
    fun duplicateFilenameChoicesScrollWithoutShowingAnEmptyCodeEditor() {
        val base = state().copy(filePreview = RemoteFilePreview(path="index.ts", candidates=(0..19).map { "folder$it/index.ts" }, error="找到多个同名文件，请选择完整路径"))
        compose.setContent { NautiloTheme { FilePreviewScreen(base, model) } }
        compose.onNodeWithText("folder19/index.ts").performScrollTo().assertIsDisplayed().performClick()
        Mockito.verify(model).previewFile(FileReference("folder19/index.ts"), false)
        compose.onNodeWithTag("file-preview-code").assertDoesNotExist()
    }

    @Test fun buttonTouchWorksInAPlainDialogControl() {
        var clicked = false
        compose.setContent { NautiloTheme {
            androidx.compose.ui.window.Dialog({}) { NButton({ clicked = true }, modifier = Modifier.testTag("dialog-control")) { androidx.compose.material3.Text("测试按钮") } }
        } }
        compose.onNodeWithTag("dialog-control").performTouchInput { click() }
        compose.mainClock.advanceTimeBy(150)
        compose.runOnIdle { assertTrue("Plain Dialog control did not receive a touch", clicked) }
    }

    @Test fun repeatedFocusAndOutsideTapsKeepTheSameDraftAndResponsiveToolbar() {
        compose.setContent { NautiloTheme {
            var text by remember { mutableStateOf("保留的草稿") }
            val focus = LocalFocusManager.current
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f).fillMaxWidth().testTag("outside").clickable { focus.clearFocus() })
                ChatComposer(text, { text = it }, "发送消息", true, true, onAttach = {}, onRemoveAttachment = {}, onVoice = {}, onSend = {}, configurationEnabled = true, onConfiguration = {}, onModes = {})
            }
        } }
        repeat(8) {
            compose.onNodeWithTag("composer-input").performTouchInput { click() }
            compose.onNodeWithTag("composer-input").assertIsFocused()
            compose.onNodeWithTag("composer-configuration").assertIsDisplayed()
            compose.onNodeWithTag("outside").performTouchInput { click() }
            compose.onNodeWithTag("composer-input").assertIsNotFocused()
            compose.onNodeWithTag("composer-configuration").assertDoesNotExist()
            compose.onNodeWithTag("composer-input").assertTextEquals("保留的草稿")
        }
    }

    @Test fun composerHeightInterpolatesAndCanReverseBeforeExpansionFinishes() {
        compose.mainClock.autoAdvance = false
        compose.setContent { NautiloTheme {
            val focus = LocalFocusManager.current
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f).fillMaxWidth().testTag("outside").clickable { focus.clearFocus() })
                ChatComposer("草稿不丢失", {}, "发送消息", true, true, onAttach = {}, onRemoveAttachment = {}, onVoice = {}, onSend = {},
                    configurationEnabled = true, onConfiguration = {}, onModes = {})
            }
        } }
        fun height() = compose.onNodeWithTag("chat-composer").fetchSemanticsNode().layoutInfo.coordinates.size.height
        compose.waitForIdle()
        val collapsed = height()
        val attachment = compose.onNodeWithTag("composer-attach").fetchSemanticsNode()
        compose.onNodeWithTag("composer-input").performClick()
        compose.mainClock.advanceTimeBy(16)
        compose.onNodeWithTag("composer-attach").assertIsDisplayed()
        assertEquals(attachment.id, compose.onNodeWithTag("composer-attach").fetchSemanticsNode().id)
        assertEquals(attachment.boundsInRoot.center.y, compose.onNodeWithTag("composer-attach").fetchSemanticsNode().boundsInRoot.center.y, .5f)
        compose.mainClock.advanceTimeBy(64)
        val midway = height()
        compose.onNodeWithTag("composer-input").assertIsFocused()
        compose.mainClock.advanceTimeBy(240)
        val expanded = height()
        assertTrue("No upward expansion: $collapsed -> $midway -> $expanded", midway > collapsed && midway < expanded)
        compose.onNodeWithTag("outside").performClick()
        compose.mainClock.advanceTimeBy(48)
        assertTrue(height() in (collapsed + 1) until expanded)
        // Reverse the animation; callbacks do not wait for the previous tween.
        compose.onNodeWithTag("composer-input").performClick()
        compose.mainClock.advanceTimeBy(48)
        compose.onNodeWithTag("composer-input").assertIsFocused().assertTextEquals("草稿不丢失")
        compose.mainClock.advanceTimeBy(300)
        assertTrue("Expanded height changed after reversal", kotlin.math.abs(expanded - height()) <= 1)
        assertEquals(attachment.id, compose.onNodeWithTag("composer-attach").fetchSemanticsNode().id)
        compose.onNodeWithTag("composer-configuration").assertIsDisplayed()
    }

    @Test fun sheetEntranceHasNoHorizontalDriftAndKeepsFooterInsideWindow() {
        compose.mainClock.autoAdvance = false
        compose.setContent { NautiloTheme { SessionConfigurationSheet(state(), model) {} } }
        listOf(16L, 48L, 160L).forEach { elapsed ->
            compose.mainClock.advanceTimeBy(elapsed)
            compose.waitForIdle()
            val window = ShadowDialog.getLatestDialog().window!!
            assertEquals("Device window animation must be disabled before entrance", 0, window.attributes.windowAnimations)
            val coordinates = compose.onNodeWithTag("app-sheet").fetchSemanticsNode().layoutInfo.coordinates
            assertEquals("Sheet slid horizontally", 0f, coordinates.localToWindow(Offset.Zero).x, .1f)
            assertEquals(window.decorView.width, coordinates.size.width)
            assertButtonWithinActualWindow("session-config-apply")
            assertButtonWithinActualWindow("session-config-cancel")
        }
    }

    @Test fun disabledMotionAppliesFocusedLayoutWithoutWaitingForAnimation() {
        compose.mainClock.autoAdvance = false
        var entrance: androidx.compose.animation.core.Animatable<Float, androidx.compose.animation.core.AnimationVector1D>? = null
        compose.setContent { NautiloTheme { CompositionLocalProvider(LocalNautiloMotion provides false) {
            entrance = rememberEntranceProgress("reduced-motion")
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Bottom) {
                ChatComposer("", {}, "发送消息", true, false, onAttach = {}, onRemoveAttachment = {}, onVoice = {}, onSend = {},
                    configurationEnabled = true, onConfiguration = {}, onModes = {})
            }
        } } }
        assertEquals(1f, entrance!!.value, 0f)
        compose.onNodeWithTag("composer-input").performClick()
        // Commit the focus change and its resulting layout, without advancing
        // through the 180 ms motion used when animations are enabled.
        compose.mainClock.advanceTimeBy(32)
        compose.onNodeWithTag("composer-configuration").assertIsDisplayed()
        assertFalse(entrance!!.isRunning)
    }

    @Test fun sheetRejectsAnIntermediatePlatformWidthBeforeDrawing() {
        compose.setContent { NautiloTheme { SessionConfigurationSheet(state(), model) {} } }
        compose.waitForIdle()
        compose.runOnUiThread {
            val window = ShadowDialog.getLatestDialog().window!!
            val decor = window.decorView
            val fullWidth = decor.width
            val fullHeight = decor.height
            window.setLayout(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            decor.layout(0, 0, fullWidth - 100, fullHeight)
            assertTrue("Narrow first frame was allowed to draw", decor.viewTreeObserver.dispatchOnPreDraw())
            assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, window.attributes.width)
            decor.layout(0, 0, fullWidth, fullHeight)
            assertFalse("Correctly sized frame remained blocked", decor.viewTreeObserver.dispatchOnPreDraw())
        }
        assertButtonWithinActualWindow("session-config-apply")
    }

    @Test fun finalAnswerStaysVisibleWithTheProcessCollapsed() {
        val thought = MobileTimelineBlock(json("seq" to 1, "blockId" to "thought", "kind" to "thinking",
            "runId" to "r", "sealed" to true, "content" to json("text" to "核对文件")))
        val answer = MobileTimelineBlock(json("seq" to 2, "blockId" to "answer", "kind" to "assistant_text",
            "runId" to "r", "sealed" to true, "content" to json("text" to "你好，已完成。")))
        val timeline = MobileTimeline(2, listOf(thought, answer),
            mapOf("r" to json("runId" to "r", "status" to "completed", "finalBlockId" to "answer", "durationMs" to 2000)))
        compose.setContent { NautiloTheme { ChatScreen(state().copy(timeline = timeline), model) } }
        compose.onNodeWithTag("timeline:answer").assertIsDisplayed()
        compose.onNodeWithText("已完成，用时 2秒").assertIsDisplayed().performClick()
        compose.onNodeWithTag("timeline:answer").assertIsDisplayed()
    }

    @Test fun existingSessionActionsAreInsideTheRealDialogWindow() {
        var closed = false
        compose.setContent { NautiloTheme { SessionConfigurationSheet(state(), model) { closed = true } } }
        assertButtonWithinActualWindow("session-config-cancel")
        assertButtonWithinActualWindow("session-config-apply")
        tapInWindow(compose.onNodeWithTag("session-config-cancel"))
        compose.runOnIdle { assertTrue(closed) }
    }

    @Test fun keyboardInsetsKeepTheFooterAboveTheKeyboard() {
        compose.setContent { NautiloTheme { SessionConfigurationSheet(state(), model) {} } }
        val keyboardHeight = 640
        compose.runOnUiThread {
            ShadowDialog.getLatestDialog().window!!.decorView.dispatchApplyWindowInsets(WindowInsets.Builder()
                .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, keyboardHeight)).setVisible(WindowInsets.Type.ime(), true).build())
        }
        compose.mainClock.advanceTimeBy(200)
        compose.waitForIdle()
        assertButtonWithinActualWindow("session-config-apply")
        val coordinates = compose.onNodeWithTag("session-config-apply").fetchSemanticsNode().layoutInfo.coordinates
        val bottom = coordinates.localToWindow(Offset.Zero).y + coordinates.size.height
        assertTrue("Footer under keyboard: $bottom", bottom <= ShadowDialog.getLatestDialog().window!!.decorView.height - keyboardHeight)
    }

    @Test fun newSessionPickersReuseOneWindowAndReturnWithoutLosingTheDraft() {
        val base = state().copy(screen = Screen.NewConversation, projects = listOf(Project("project", "Nautilo")),
            session = state().session!!.copy(agentId = "agent-0"), newDraft = "保留的草稿", newModels = state().models)
        compose.setContent { NautiloTheme { NewConversationScreen(base, model) } }
        compose.onNodeWithTag("composer-input").performTouchInput { click() }
        compose.onNodeWithTag("composer-configuration").performClick()
        assertButtonWithinActualWindow("new-config-apply")
        val originalWindow = ShadowDialog.getLatestDialog()
        tapInWindow(compose.onNodeWithText("Harness", substring = false))
        assertSame(originalWindow, ShadowDialog.getLatestDialog())
        compose.onNodeWithTag("creation-choice-list").performScrollToNode(hasText("Harness 15"))
        tapInWindow(compose.onNodeWithText("Harness 15"))
        assertSame(originalWindow, ShadowDialog.getLatestDialog())
        compose.onNodeWithText("Harness 15").assertIsDisplayed()
        assertButtonWithinActualWindow("new-config-cancel")
        tapInWindow(compose.onNodeWithTag("new-config-cancel"))
        compose.onNodeWithTag("composer-input").assertTextEquals("保留的草稿")
    }

    @Test @Config(qualifiers = "w393dp-h480dp-xhdpi")
    fun shortWindowAndLargeTypeKeepActionsVisibleWhileModelsScroll() {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 1.4f)) {
                NautiloTheme { SessionConfigurationSheet(state(), model) {} }
            }
        }
        assertButtonWithinActualWindow("session-config-apply")
        val original = ShadowDialog.getLatestDialog()
        compose.onNodeWithTag("config-model-picker").performClick()
        compose.onNodeWithTag("creation-choice-list").performScrollToNode(hasText("模型 20"))
        assertSame(original, ShadowDialog.getLatestDialog())
        compose.onNodeWithContentDescription("返回设置").performClick()
        compose.onNodeWithText("推理强度").performScrollTo()
        assertButtonWithinActualWindow("session-config-cancel")
        assertButtonWithinActualWindow("session-config-apply")
    }

    @Test fun newSessionOverviewHasWorkingFooterInTheRealWindow() {
        var done = false
        compose.setContent { NautiloTheme { NSheet({}) {
            SessionSettingsContent("DeepSeek Harness", "原生配置", "DeepSeek V4", "max", true,
                efforts = listOf("low", "high", "max"), onEffortChange = {}, cancel = {}, done = { done = true }, choose = {})
        } } }
        assertButtonWithinActualWindow("new-config-cancel")
        assertButtonWithinActualWindow("new-config-apply")
        tapInWindow(compose.onNodeWithTag("new-config-apply"))
        compose.runOnIdle { assertTrue(done) }
    }

    @Test fun engineOpensOneSheetAndEffortChangesInlineBeforeDraggingItClosed() {
        val base = state().copy(screen = Screen.NewConversation, projects = listOf(Project("project", "Nautilo")),
            session = state().session!!.copy(agentId = "agent-0"), newModels = state().models, connected = true)
        compose.setContent { NautiloTheme { NewConversationScreen(base, model) } }
        compose.onNodeWithTag("starter-engine").performClick()
        compose.waitForIdle()
        val original = ShadowDialog.getLatestDialog()
        assertNotNull(original)
        compose.onNodeWithText("高", substring = false).performClick().assertIsSelected()
        assertSame(original, ShadowDialog.getLatestDialog())
        compose.onNodeWithTag("sheet-grab-handle").performTouchInput {
            swipe(center, center + Offset(0f, height * 6f), durationMillis = 220)
        }
        compose.onNodeWithTag("app-sheet").assertDoesNotExist()
        compose.onNodeWithTag("starter-engine").assertIsDisplayed()
    }

    @Test fun harnessPickerScrollsToLastOptionWithoutLosingCancel() {
        var selected = ""
        compose.setContent { NautiloTheme {
            CreationChoiceSheet(CreationPicker.Harness, state(), "agent-0", {}, {}, {}) { selected = it }
        } }
        assertButtonWithinActualWindow("creation-choice-cancel")
        compose.onNodeWithTag("creation-choice-list").performScrollToNode(hasText("Harness 15"))
        tapInWindow(compose.onNodeWithText("Harness 15"))
        compose.runOnIdle { assertEquals("agent-15", selected) }
        assertButtonWithinActualWindow("creation-choice-cancel")
    }

    @Test fun permissionsAndModesHaveAVisibleWorkingFooter() {
        var chosen = ""
        val catalog = json("permissionModes" to JSONArray((0..10).map { json("value" to "permission-$it", "name" to "权限 $it", "description" to "在所选工作区执行操作") }))
        compose.setContent { NautiloTheme {
            ModeConfigurationSheet(catalog, false, "permission-0", "", false, false, "", {}, {}) { permission, _ -> chosen = permission }
        } }
        assertButtonWithinActualWindow("mode-config-apply")
        compose.onNodeWithTag("mode-config-options").performScrollToNode(hasText("权限 10"))
        tapInWindow(compose.onNodeWithText("权限 10"))
        tapInWindow(compose.onNodeWithTag("mode-config-apply"))
        compose.runOnIdle { assertEquals("permission-10", chosen) }
    }
}
