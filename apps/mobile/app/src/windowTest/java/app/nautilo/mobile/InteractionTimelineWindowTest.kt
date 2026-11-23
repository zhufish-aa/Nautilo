package app.nautilo.mobile

import android.app.Application
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import app.nautilo.mobile.data.*
import app.nautilo.mobile.ui.*
import org.json.JSONArray
import org.json.JSONObject
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
    private fun block(seq: Int, id: String, kind: String, run: String, content: JSONObject) =
        MobileTimelineBlock(json("seq" to seq, "blockId" to id, "kind" to kind, "runId" to run,
            "sealed" to true, "content" to content))
    private fun prompt(seq: Int, id: String, run: String, text: String) =
        block(seq, id, "user_prompt", run, json("sender" to "user", "text" to text))
    private fun state(status: String) = MobileState(connected = true,
        session = Conversation("session", "project", "测试提问", "idle", ""),
        timeline = MobileTimeline(1, listOf(prompt(1, "u", "r", "问我一个问题"),
            block(2, "q", "interaction", "r", json("payload" to json("interaction" to question(status))))), emptyMap()))

    @Test fun chatScreenKeepsAnsweredCardAboveTheFirstReplyAndNextUserMessage() {
        val initial = state("resolved")
        val current = mutableStateOf(initial)
        compose.setContent { NautiloTheme { ChatScreen(current.value, model) } }
        compose.onNodeWithText("你的回答：见朋友家人").assertIsDisplayed()
        compose.runOnUiThread {
            val timeline = requireNotNull(initial.timeline)
            current.value = initial.copy(timeline = timeline.copy(revision = 2, blocks = timeline.blocks + listOf(
                block(3, "a1", "assistant_text", "r", json("text" to "收到你的回答")),
                prompt(4, "u2", "r2", "继续"),
                block(5, "a2", "assistant_text", "r2", json("text" to "下一轮已完成")))))
        }
        compose.waitForIdle()
        compose.onAllNodesWithTag("timeline:q").assertCountEquals(1)
        val question = compose.onNodeWithTag("timeline:q").fetchSemanticsNode().boundsInRoot
        val firstReply = compose.onNodeWithTag("timeline:a1").fetchSemanticsNode().boundsInRoot
        val nextUser = compose.onNodeWithTag("timeline:u2").fetchSemanticsNode().boundsInRoot
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
        val before = compose.onNodeWithTag("timeline:q").fetchSemanticsNode().boundsInRoot.top
        compose.runOnUiThread { current.value = state("resolved") }
        compose.waitForIdle()
        compose.onNodeWithContentDescription("提交回答").assertDoesNotExist()
        compose.onNodeWithText("你的回答：见朋友家人").assertIsDisplayed()
        compose.onAllNodesWithTag("timeline:q").assertCountEquals(1)
        val after = compose.onNodeWithTag("timeline:q").fetchSemanticsNode().boundsInRoot.top
        assertEquals(before, after, 1f)
    }

    @Test fun ompApprovalKeepsItsOptionsAndFoldsTheLongPrompt() {
        val prompt = "Allow tool: task Context: ${"Read a directory. ".repeat(30)}"
        val approval = json("id" to "omp-approval", "providerId" to "omp", "kind" to "question", "status" to "pending",
            "questions" to JSONArray().put(json("id" to "request", "question" to prompt,
                "options" to JSONArray().put(json("label" to "Approve")).put(json("label" to "Deny")))))
        val current = mutableStateOf(approval)
        compose.setContent { NautiloTheme { InteractionCard(current.value, false, model) } }
        compose.onNodeWithText("审批 · task").assertIsDisplayed()
        compose.onNodeWithText(prompt).assertDoesNotExist()
        compose.onNodeWithText("Approve").assertIsDisplayed()
        compose.onNodeWithText("Deny").assertIsDisplayed()
        compose.onNodeWithText("查看审批详情").performClick()
        compose.onNodeWithText(prompt).assertIsDisplayed()
        compose.onNodeWithText("查看审批详情").performClick()
        compose.onNodeWithText("Deny").performClick()
        compose.onNodeWithContentDescription("提交回答").assertIsEnabled()

        compose.runOnUiThread {
            current.value = JSONObject(approval.toString()).put("status", "resolved")
                .put("response", json("answers" to json("request" to JSONArray().put("Deny"))))
        }
        compose.onNodeWithText("你的回答：Deny").assertIsDisplayed()
        compose.onNodeWithText(prompt).assertDoesNotExist()
    }

    @Test fun ompCompatibilityNoticeShowsItsTextOnlyWhenExpanded() {
        val text = "[billion-context-pi] Unsupported host: ${"extension diagnostic ".repeat(30)}"
        val item = ActivityItem("omp-notify", "provider_ui", "Harness 通知", payload = json("method" to "notify", "text" to text))
        compose.setContent { NautiloTheme { EventNotice(item) } }
        compose.onNodeWithText(text).assertDoesNotExist()
        compose.onNodeWithText("扩展兼容性提示 · billion-context-pi").performClick()
        compose.onNodeWithText(text).assertIsDisplayed()
    }
}
