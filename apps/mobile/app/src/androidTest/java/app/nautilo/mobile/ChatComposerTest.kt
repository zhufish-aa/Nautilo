package app.nautilo.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.nautilo.mobile.data.*
import app.nautilo.mobile.ui.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import android.graphics.Bitmap
import java.io.File

@RunWith(AndroidJUnit4::class)
class ChatComposerTest {
    @get:Rule val compose = createComposeRule()
    private fun screenshot(name: String) {
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    @Test fun configurationOnlyAppearsWhileEditingAndSendReplacesVoice() {
        val sent = mutableListOf<String>()
        var attached = false
        var settings = false
        compose.setContent { NautiloTheme {
            var text by remember { mutableStateOf("") }
            val focus = LocalFocusManager.current
            Column(Modifier.fillMaxSize().background(ChatBackground).imePadding()) {
                Text("想聊点什么？", Modifier.weight(1f).fillMaxWidth().testTag("outside").clickable { focus.clearFocus() })
                ChatComposer(text, { text = it }, "发送消息", true, text.isNotBlank(), onAttach = { attached = true }, onRemoveAttachment = {}, onVoice = {}, onSend = { sent += text; text = "" }, configurationEnabled = true, onConfiguration = { settings = true })
            }
        } }
        compose.onNodeWithTag("composer-configuration").assertDoesNotExist()
        compose.onNodeWithTag("composer-voice").assertIsDisplayed()
        compose.onNodeWithTag("composer-send").assertDoesNotExist()
        compose.onNodeWithTag("composer-attach").performClick()
        compose.runOnIdle { assertTrue(attached) }
        compose.onNodeWithTag("composer-input").performClick()
        compose.onNodeWithTag("composer-configuration").assertIsDisplayed()
        compose.onNodeWithTag("composer-configuration").performClick()
        compose.runOnIdle { assertTrue(settings) }
        compose.waitForIdle()
        compose.onNodeWithTag("composer-configuration").assertDoesNotExist()
        compose.onNodeWithTag("composer-input").performClick().performTextInput("帮我看看这个项目")
        compose.onNodeWithTag("composer-send").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(listOf("帮我看看这个项目"), sent) }
        compose.onNodeWithTag("composer-voice").assertIsDisplayed()
        compose.onNodeWithTag("composer-configuration").assertDoesNotExist()
        compose.onNodeWithTag("composer-input").performClick()
        compose.onNodeWithTag("outside").performClick()
        compose.onNodeWithTag("composer-configuration").assertDoesNotExist()
    }
    @Test fun attachmentsCanBeRemovedAndSentWithoutText() {
        val attachment = DraftAttachment("fixture", "设计说明.pdf", "application/pdf", 120, "fixture")
        var sent = false
        compose.setContent { NautiloTheme {
            var files by remember { mutableStateOf(listOf(attachment)) }
            Box(Modifier.width(320.dp).background(ChatBackground)) {
                ChatComposer("", {}, "发送消息", true, files.isNotEmpty(), attachments = files, onAttach = {}, onRemoveAttachment = { files = files - it }, onVoice = {}, onSend = { sent = true }, configurationEnabled = true, onConfiguration = {})
            }
        } }
        compose.onNodeWithText("设计说明.pdf").assertIsDisplayed()
        compose.onNodeWithTag("composer-send").performClick()
        compose.runOnIdle { assertTrue(sent) }
        compose.onNodeWithContentDescription("移除 设计说明.pdf").performClick()
        compose.onNodeWithText("设计说明.pdf").assertDoesNotExist()
        compose.onNodeWithTag("composer-voice").assertIsDisplayed()
    }
    @Test fun readonlyComposerCannotOpenInputOrAttachments() {
        compose.setContent { NautiloTheme {
            ChatComposer("", {}, "此设备仅有查看权限", false, false, onAttach = {}, onRemoveAttachment = {}, onVoice = {}, onSend = {}, configurationEnabled = false, onConfiguration = {})
        } }
        compose.onNodeWithTag("composer-input").assertIsNotEnabled()
        compose.onNodeWithTag("composer-attach").assertIsNotEnabled()
        compose.onNodeWithTag("composer-voice").assertIsNotEnabled()
        compose.onNodeWithTag("composer-configuration").assertDoesNotExist()
    }
    @Test fun shippingNewConversationHasQuietIdleAndFocusedLayouts() {
        val model = MobileViewModel(ApplicationProvider.getApplicationContext())
        val state = MobileState(screen = Screen.NewConversation, connected = true,
            session = Conversation("previous", "project", "项目讨论", "idle", "", "gpt-6.1-sol", "max", agentId = "codex"),
            projects = listOf(Project("project", "Nautilo")),
            setup = json("agents" to org.json.JSONArray().put(json("id" to "codex", "name" to "Codex"))),
            newModels = listOf(json("id" to "gpt-6.1-sol", "displayName" to "GPT-6.1", "reasoningEfforts" to org.json.JSONArray().put("max"))))
        compose.setContent { NautiloTheme { Box(Modifier.fillMaxSize().background(ChatBackground).statusBarsPadding().navigationBarsPadding()) { NewConversationScreen(state, model) } } }
        compose.onNodeWithText("GPT-6.1").assertDoesNotExist()
        compose.onNodeWithText("推理 最高").assertDoesNotExist()
        screenshot("composer-new-idle")
        compose.onNodeWithTag("composer-input").performClick()
        compose.onNodeWithTag("composer-configuration").assertIsDisplayed()
        screenshot("composer-new-focused")
        compose.onNodeWithTag("composer-configuration").performClick()
        compose.onNodeWithText("Harness").assertIsDisplayed()
        screenshot("composer-new-settings")
    }
    @Test fun shippingChatUsesTheSameCompactComposer() {
        val model = MobileViewModel(ApplicationProvider.getApplicationContext())
        val state = MobileState(screen = Screen.Chat, connected = true,
            session = Conversation("session", "project", "项目讨论", "idle", "", "gpt-6.1-sol", "max"),
            timeline = MobileTimeline(1, listOf(
                MobileTimelineBlock(json("blockId" to "user", "seq" to 1, "kind" to "user_prompt",
                    "content" to json("sender" to "user", "text" to "帮我梳理一下项目。"))),
                MobileTimelineBlock(json("blockId" to "reply", "seq" to 2, "kind" to "assistant_text",
                    "content" to json("text" to "当然。我们可以先从项目结构开始，再看你想改进的部分。")))
            ), emptyMap()))
        compose.setContent { NautiloTheme { Box(Modifier.fillMaxSize().background(ChatBackground).statusBarsPadding().navigationBarsPadding()) { ChatScreen(state, model) } } }
        compose.onNodeWithTag("composer-configuration").assertDoesNotExist()
        compose.onNodeWithText("gpt-6.1-sol", substring = true).assertDoesNotExist()
        screenshot("composer-chat-idle")
    }
}
