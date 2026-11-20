package app.nautilo.mobile

import app.nautilo.mobile.data.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class InteractionTimelineTest {
    private fun time(second: Int) = "2026-11-16T01:00:${second.toString().padStart(2, '0')}Z"
    private fun question(status: String = "pending", runId: String = "r") = json(
        "id" to "q", "kind" to "question", "title" to "选择周末活动", "status" to status,
        "runId" to runId, "createdAt" to time(3),
        "questions" to JSONArray().put(json("id" to "weekend", "question" to "周末想做什么？")),
    ).apply {
        if (status == "resolved") {
            put("resolvedAt", time(20))
            put("response", json("answers" to json("weekend" to JSONArray().put("见朋友家人"))))
        }
    }
    private fun cards(items: List<ConversationItem>) = items.filterIsInstance<ConversationItem.Turn>()
        .flatMap { it.parts }.filter { it.activity?.kind == "interaction" }

    @Test fun answeredQuestionStaysBeforeItsReplyAndTheNextRound() {
        val messages = listOf(
            ChatMessage("u1", "user", "问我一个问题", time(1)),
            ChatMessage("a1", "agent", "你选了见朋友家人", time(5), runId = "r"),
            ChatMessage("u2", "user", "再派一个子代理", time(7)),
            ChatMessage("a2", "agent", "子代理已完成", time(10), runId = "r2"),
        )
        val timeline = conversationTimeline(messages, emptyList(), listOf(
            RunInfo("r", "completed", time(2), time(6)), RunInfo("r2", "completed", time(8), time(11)),
        ), listOf(question("resolved")))
        assertEquals(listOf("message:u1", "turn:r:after:u1", "message:u2", "turn:r2:after:u2"), timeline.map { it.key })
        val first = timeline[1] as ConversationItem.Turn
        assertEquals(listOf("activity:interaction:q", "message:a1"), first.parts.filter { it.visible(false, first.answer) }.map { it.key })
        assertTrue((timeline.last() as ConversationItem.Turn).parts.none { it.activity?.kind == "interaction" })
        assertEquals("见朋友家人", cards(timeline).single().activity!!.payload.getJSONObject("interaction")
            .getJSONObject("response").getJSONObject("answers").getJSONArray("weekend").getString(0))
    }

    @Test fun liveResolutionKeepsTheOriginalJournalSlotAndCannotDuplicateOrResurrectTheCard() {
        val projection = SessionProjection()
        fun event(sequence: Int, type: String, payload: JSONObject, second: Int = 3) = json(
            "sequence" to sequence, "eventId" to "e$sequence", "type" to type, "runId" to "r", "timestamp" to time(second), "payload" to payload,
        )
        projection.apply(event(1, "tool.started", json("callId" to "ask", "toolName" to "request_user_input")))
        projection.apply(event(2, "interaction.requested", json("interaction" to question())))
        val run = RunInfo("r", "running", time(2), "")
        val pending = conversationTimeline(emptyList(), projection.activityList(), listOf(run), listOf(question()))
        val originalKey = cards(pending).single().key
        projection.apply(event(3, "interaction.resolved", json("interaction" to question("resolved")), 20))
        projection.apply(event(4, "agent.message", json("messageId" to "final", "text" to "收到你的回答")))
        // A stale list response must not overwrite the resolved journal value.
        val resolved = conversationTimeline(projection.messageList(), projection.activityList(), listOf(run.copy(status = "completed", endedAt = time(21))), listOf(question()))
        val turn = resolved.single() as ConversationItem.Turn
        assertEquals(listOf("activity:tool:r:ask", originalKey, "message:final"), turn.parts.map { it.key })
        assertEquals(2L, cards(resolved).single().sequence)
        assertEquals("resolved", cards(resolved).single().activity!!.payload.getJSONObject("interaction").text("status"))
        assertEquals(pending.single().key, turn.key)
    }

    @Test fun snapshotOnlyQuestionsStillUseCreationTimeAndRetainTheirKeysOnRefresh() {
        val runs = listOf(RunInfo("r", "completed", time(2), time(6)))
        val messages = listOf(ChatMessage("u", "user", "开始", time(1)), ChatMessage("a", "agent", "收到", time(5), runId = "r"))
        val live = conversationTimeline(messages.take(1), emptyList(), runs, listOf(question(runId = "")))
        val refreshed = conversationTimeline(messages, emptyList(), runs, listOf(question("resolved", runId = "")))
        assertEquals(live.map { it.key }, refreshed.map { it.key })
        assertEquals(cards(live).single().key, cards(refreshed).single().key)
        assertEquals(listOf("activity:interaction:q", "message:a"), (refreshed.last() as ConversationItem.Turn).parts.map { it.key })
    }

    @Test fun journalOnlyRequestFallsBackToItsFirstEventWhenCreationTimeIsMissing() {
        val request = question("resolved").apply { remove("createdAt") }
        val activity = ActivityItem("interaction:q", "interaction", "提问", time = time(3), runId = "r", sequence = 2,
            eventType = "interaction.resolved", payload = json("interaction" to request))
        val timeline = conversationTimeline(listOf(ChatMessage("a", "agent", "已回答", time(5), runId = "r")), listOf(activity), emptyList())
        val turn = timeline.single() as ConversationItem.Turn
        assertEquals(listOf("activity:interaction:q", "message:a"), turn.parts.map { it.key })
        assertEquals(time(3), cards(timeline).single().time)
    }

    @Test fun pendingInteractionsStayVisibleAndResolvedNonQuestionsStayHidden() {
        val pendingApproval = question().apply { put("id", "permission"); put("kind", "approval") }
        val resolvedApproval = question("resolved").apply { put("id", "done"); put("kind", "approval") }
        val timeline = conversationTimeline(emptyList(), emptyList(), emptyList(), listOf(question(), pendingApproval, resolvedApproval))
        assertEquals(2, cards(timeline).size)
        timeline.filterIsInstance<ConversationItem.Turn>().forEach { turn ->
            assertFalse(turn.completed)
            assertTrue(turn.parts.all { it.visible(false, turn.answer) })
        }
    }
}
