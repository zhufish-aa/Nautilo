package app.nautilo.mobile

import android.app.Application
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
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

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [35], qualifiers = "w393dp-h851dp-xhdpi")
class InteractionTimelineWindowTest {
    @get:Rule val compose = createComposeRule()
    private val model = Mockito.mock(MobileViewModel::class.java)
    private fun time(second: Int) = "2026-11-16T01:00:${second.toString().padStart(2, '0')}Z"
    private fun question(status: String) = json("id" to "q", "runId" to "r", "kind" to "question", "status" to status,
        "createdAt" to time(3), "questions" to JSONArray().put(json("id" to "weekend", "question" to "周末想做什么？",
            "options" to JSONArray().put(json("label" to "见朋友家人"))))).apply {
        if (status == "resolved") put("response", json("answers" to json("weekend" to JSONArray().put("见朋友家人"))))
    }
    private fun state(status: String) = MobileState(connected = true,
        session = Conversation("session", "project", "测试提问", "idle", ""),
        messages = listOf(ChatMessage("u", "user", "问我一个问题", time(1))),
        interactions = listOf(question(status)), runs = listOf(RunInfo("r", "completed", time(2), time(6))))

    @Test fun chatScreenKeepsAnsweredCardAboveTheFirstReplyAndNextUserMessage() {
        val initial = state("resolved")
        val current = mutableStateOf(initial)
        compose.setContent { NautiloTheme { ChatScreen(current.value, model) } }
        compose.onNodeWithText("你的回答：见朋友家人").assertIsDisplayed()
        compose.runOnUiThread {
            current.value = initial.copy(messages = initial.messages + listOf(
                ChatMessage("a1", "agent", "收到你的回答", time(5), runId = "r"),
                ChatMessage("u2", "user", "继续", time(7)),
                ChatMessage("a2", "agent", "下一轮已完成", time(10), runId = "r2")),
                runs = initial.runs + RunInfo("r2", "completed", time(8), time(11)))
        }
        compose.waitForIdle()
        compose.onAllNodesWithTag("turn-part:activity:interaction:q").assertCountEquals(1)
        val question = compose.onNodeWithTag("turn-part:activity:interaction:q").fetchSemanticsNode().boundsInRoot
        val firstReply = compose.onNodeWithTag("turn-part:message:a1").fetchSemanticsNode().boundsInRoot
        val nextUser = compose.onNodeWithText("继续").fetchSemanticsNode().boundsInRoot
        assertTrue("Question moved below its reply", question.bottom <= firstReply.top)
        assertTrue("Old question moved below the next user message", question.bottom <= nextUser.top)
        // The completed turn starts collapsed, but the answered card remains visible.
        compose.onNodeWithText("你的回答：见朋友家人").assertIsDisplayed()
    }

    @Test fun pendingCardUpdatesToReadOnlyAtTheSamePositionWhenAnswered() {
        val current = mutableStateOf(state("pending"))
        compose.setContent { NautiloTheme { ChatScreen(current.value, model) } }
        compose.onNodeWithContentDescription("提交回答").assertExists()
        compose.onNodeWithText("见朋友家人").performClick()
        compose.onNodeWithContentDescription("提交回答").assertIsEnabled()
        val before = compose.onNodeWithTag("turn-part:activity:interaction:q").fetchSemanticsNode().boundsInRoot.top
        compose.runOnUiThread { current.value = state("resolved") }
        compose.waitForIdle()
        compose.onNodeWithContentDescription("提交回答").assertDoesNotExist()
        compose.onNodeWithText("你的回答：见朋友家人").assertIsDisplayed()
        compose.onAllNodesWithTag("turn-part:activity:interaction:q").assertCountEquals(1)
        val after = compose.onNodeWithTag("turn-part:activity:interaction:q").fetchSemanticsNode().boundsInRoot.top
        assertEquals(before, after, 1f)
    }
}
