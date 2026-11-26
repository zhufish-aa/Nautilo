package app.nautilo.mobile

import android.app.Application
import android.text.Selection as TextSelection
import android.widget.TextView
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import app.nautilo.mobile.data.*
import app.nautilo.mobile.ui.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [35], qualifiers = "w393dp-h851dp-xhdpi")
class ConversationProcessWindowTest {
    @get:Rule val compose = createComposeRule()

    private fun block(seq: Int, kind: String, content: JSONObject, status: String = "", sealed: Boolean = true) =
        MobileTimelineBlock(json("seq" to seq, "blockId" to "b$seq", "kind" to kind, "runId" to "r",
            "content" to content, "sealed" to sealed, "status" to status))

    private fun command(seq: Int, line: String, active: Boolean = false) =
        block(seq, "tool_call", json("type" to if (active) "command.started" else "command.finished",
            "payload" to json("command" to line, "exitCode" to 0)), if (active) "running" else "done")

    @Test fun realChatGroupsLiveCommandsAndReopensCompletedProcessCollapsed() {
        val model = Mockito.mock(MobileViewModel::class.java)
        fun state(blocks: List<MobileTimelineBlock>, done: Boolean = false) = MobileState(connected = true,
            session = Conversation("session", "project", "执行分组", "idle", ""),
            timeline = MobileTimeline(blocks.size.toLong(), blocks, mapOf("r" to json("runId" to "r",
                "status" to if (done) "completed" else "running", "durationMs" to 35000, "finalBlockId" to if (done) "b6" else ""))))
        val prompt = block(1, "user_prompt", json("sender" to "user", "text" to "测试命令分组"))
        val commands = listOf(prompt, command(2, "check one"), command(3, "check two", active = true))
        val current = mutableStateOf(state(commands))
        val reopened = mutableStateOf(false)
        compose.setContent {
            NautiloTheme(dark = reopened.value) {
                CompositionLocalProvider(LocalNautiloMotion provides false) {
                    key(reopened.value) { ChatScreen(current.value, model) }
                }
            }
        }
        compose.onNodeWithText("正在运行命令 · 2").assertIsDisplayed()
        compose.onNodeWithText("check one", useUnmergedTree = true).assertIsDisplayed()
        compose.onAllNodesWithTag("timeline-frontier").assertCountEquals(1)
        compose.onNodeWithText("执行中").assertDoesNotExist()
        val intermediate = commands.take(2) + command(3, "check two") +
            block(4, "assistant_note", json("text" to "继续检查")) + command(5, "check three")
        compose.runOnUiThread { current.value = state(intermediate) }
        compose.onNodeWithText("运行了 2 条命令").assertIsDisplayed()
        compose.onNodeWithText("check one", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("check three", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("运行了 2 条命令").performClick()
        compose.onNodeWithText("check one", useUnmergedTree = true).assertIsDisplayed()
        compose.runOnUiThread { current.value = state(intermediate + block(6, "assistant_text", json("text" to "最终回复")), true) }
        compose.onNodeWithContentDescription("复制回复").assertIsDisplayed()
        compose.onAllNodesWithTag("timeline-frontier").assertCountEquals(0)
        compose.onNodeWithText("运行了 2 条命令").assertDoesNotExist()
        compose.onNodeWithText("已完成，用时 35秒").performClick()
        compose.onNodeWithText("check one", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("check three", useUnmergedTree = true).assertDoesNotExist()
        compose.runOnUiThread { reopened.value = true }
        compose.onNodeWithText("已完成，用时 35秒").assertIsDisplayed()
        compose.onNodeWithText("运行了 2 条命令").assertDoesNotExist()
    }

    @Test fun nativeMarkdownKeepsCompletedViewsAndRetainsSelectionUntilItClears() {
        val view = MarkdownView(RuntimeEnvironment.getApplication())
        val first = "第一段 **已完成**。\n\n后一段开头\n"
        view.render(first, streaming = true, fade = true)
        val stable = view.getChildAt(0) as TextView
        val tail = view.getChildAt(1) as TextView
        assertEquals("第一段 已完成。", stable.text.toString().trim())
        TextSelection.setSelection(tail.editableText, 0, 3)
        val selection = tail.text.substring(0, 3)
        val final = first + "新增 👩🏽‍💻"
        view.render(final, streaming = true, fade = true)
        assertSame(stable, view.getChildAt(0))
        assertSame(tail, view.getChildAt(1))
        view.render(final)
        assertEquals(selection, tail.text.substring(tail.selectionStart, tail.selectionEnd))
        TextSelection.removeSelection(tail.editableText)
        view.viewTreeObserver.dispatchOnPreDraw()
        assertTrue((view.getChildAt(0) as TextView).text.toString().contains("新增 👩🏽‍💻"))
        assertEquals(1, view.childCount)
    }

    @Test fun draggingUpStopsTheTimelineFromFollowingNewText() {
        val model = Mockito.mock(MobileViewModel::class.java)
        fun state(revision: Long, extra: String = "") = MobileState(connected = true,
            session = Conversation("session", "project", "流式滚动", "running", ""),
            timeline = MobileTimeline(revision, listOf(
                block(1, "user_prompt", json("sender" to "user", "text" to "请输出长文")),
                block(2, "assistant_text", json("text" to "这一行用于检查滚动位置。\n\n".repeat(65) + extra), sealed = false)),
                mapOf("r" to json("runId" to "r", "status" to "running"))))
        val current = mutableStateOf(state(1))
        compose.setContent { NautiloTheme {
            CompositionLocalProvider(LocalNautiloMotion provides false) { ChatScreen(current.value, model) }
        } }
        val timeline = compose.onNodeWithTag("chat-timeline")
        compose.onNodeWithContentDescription("回到最新消息").assertDoesNotExist()
        timeline.performTouchInput {
            swipe(Offset(width / 2f, height / 4f), Offset(width / 2f, height * .78f), durationMillis = 450)
        }
        compose.onNodeWithContentDescription("回到最新消息").assertIsDisplayed()
        compose.runOnUiThread { current.value = state(2, "继续追加的内容。\n\n".repeat(24)) }
        compose.onNodeWithContentDescription("回到最新消息").assertIsDisplayed().performClick()
        compose.onNodeWithContentDescription("回到最新消息").assertDoesNotExist()
    }
}
