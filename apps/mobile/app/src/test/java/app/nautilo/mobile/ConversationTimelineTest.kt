package app.nautilo.mobile

import app.nautilo.mobile.data.*
import org.junit.Assert.*
import org.junit.Test

class ConversationTimelineTest {
    private fun time(second: Int) = "2026-11-14T00:00:${second.toString().padStart(2, '0')}Z"
    @Test fun commentaryToolsAndFinalAnswerShareOneCollapsibleTurn() {
        val messages = listOf(ChatMessage("user", "user", "查看目录", time(0)),
            ChatMessage("comment", "agent", "我查看一下目录", time(2), runId = "r"),
            ChatMessage("final", "agent", "共有 45 个文件夹", time(19), runId = "r"))
        val parts = listOf(ActivityItem("cmd", "terminal", "pwsh", time = time(3), runId = "r"), ActivityItem("thought", "thought", "思考", "整理目录", time = time(18), runId = "r"))
        val timeline = conversationTimeline(messages, parts, listOf(RunInfo("r", "completed", time(1), time(20))))
        assertEquals(2, timeline.size)
        val turn = timeline.last() as ConversationItem.Turn
        assertEquals("final", turn.answer!!.id)
        assertEquals(listOf("message:comment", "activity:cmd", "activity:thought"), turn.process.map { it.key })
        assertEquals(19, turn.run!!.elapsedSeconds().toInt())
    }
    @Test fun streamingFinalReceiptsKeepTheSameTurnAndOtherRunsStaySeparate() {
        val run = RunInfo("r", "running", time(2), "")
        val first = conversationTimeline(listOf(ChatMessage("u", "user", "你好", time(1))), emptyList(), listOf(run))
        val stream = conversationTimeline(listOf(ChatMessage("u", "user", "你好", time(1)), ChatMessage("stream:r:native", "agent", "你好", time(3), runId = "r")), emptyList(), listOf(run))
        assertEquals(first.last().key, stream.last().key)
        val done = conversationTimeline(listOf(ChatMessage("u", "user", "你好", time(1)), ChatMessage("persisted", "agent", "你好！", time(3), runId = "r"), ChatMessage("u2", "user", "继续", time(8)), ChatMessage("a2", "agent", "好的", time(10), runId = "r2")), emptyList(), listOf(run.copy(status = "completed", endedAt = time(5)), RunInfo("r2", "completed", time(9), time(11))))
        assertEquals(listOf("message:u", "turn:r", "message:u2", "turn:r2"), done.map { it.key })
        assertEquals(stream.last().key, done[1].key)
    }
    @Test fun equalTimestampEventsKeepJournalOrderAndDoNotLoseReasoning() {
        val messages = listOf(ChatMessage("comment", "agent", "检查一下", time(1), runId = "r", sequence = 1), ChatMessage("final", "agent", "完成", time(1), runId = "r", sequence = 4))
        val activities = listOf(ActivityItem("t", "thought", "思考", "看看目录", time = time(1), runId = "r", sequence = 2), ActivityItem("c", "terminal", "pwsh", time = time(1), runId = "r", sequence = 3))
        val turn = conversationTimeline(messages, activities, emptyList()).single() as ConversationItem.Turn
        assertEquals(listOf("message:comment", "activity:t", "activity:c"), turn.process.map { it.key })
    }

    @Test fun activeCommentaryThenToolStaysInItsChronologicalSlot() {
        val turn = conversationTimeline(listOf(ChatMessage("comment", "agent", "先查看目录", time(2), runId = "r", sequence = 1)),
            listOf(ActivityItem("cmd", "tool", "读取目录", running = true, time = time(3), runId = "r", sequence = 2)),
            listOf(RunInfo("r", "running", time(1), ""))).single() as ConversationItem.Turn
        assertFalse(turn.completed)
        assertNull(turn.answer)
        assertEquals(listOf("message:comment", "activity:cmd"), turn.parts.filter { it.visible(true, turn.answer) }.map { it.key })
    }

    @Test fun noticesAndFinalReplyAreCollapsedInPlaceLikeDesktop() {
        val messages = listOf(ChatMessage("comment", "agent", "先检查", time(2), runId = "r", sequence = 1),
            ChatMessage("final", "agent", "检查结果", time(4), runId = "r", sequence = 3))
        val activities = listOf(ActivityItem("approval", "approval", "批准", time = time(3), runId = "r", sequence = 2),
            ActivityItem("later-tool", "tool", "后台工具", time = time(5), runId = "r", sequence = 4),
            ActivityItem("error", "error", "错误", time = time(6), runId = "r", sequence = 5))
        val turn = conversationTimeline(messages, activities, listOf(RunInfo("r", "completed", time(1), time(7)))).single() as ConversationItem.Turn
        assertEquals("final", turn.answer?.id)
        assertEquals(listOf("activity:approval", "message:final", "activity:error"), turn.parts.filter { it.visible(false, turn.answer) }.map { it.key })
        assertEquals(listOf("message:comment", "activity:approval", "message:final", "activity:later-tool", "activity:error"), turn.parts.filter { it.visible(true, turn.answer) }.map { it.key })
    }

    @Test fun protocolStatusAndUsageNeverCreateConversationCardsOrEmptyTurns() {
        val hidden = listOf("provider.runtime_ready", "provider.runtime_capabilities", "provider.runtime_closed", "provider.commands_updated", "agent.status", "session.native_history_synced", "unknown.event").mapIndexed { index, type ->
            ActivityItem("internal-$index", "status", type, time = time(1), eventType = type)
        } + ActivityItem("usage", "usage", "用量", time = time(1), eventType = "usage.updated") +
            ActivityItem("diff", "artifact", "diff", time = time(1), eventType = "artifact.created", payload = json("kind" to "diff"))
        assertTrue(conversationTimeline(emptyList(), hidden, emptyList()).isEmpty())
    }

    @Test fun journalOrderWinsOverProviderClockDifferences() {
        val turn = conversationTimeline(listOf(ChatMessage("comment", "agent", "先读文件", time(10), runId = "r", sequence = 1)),
            listOf(ActivityItem("cmd", "tool", "read", time = time(3), runId = "r", sequence = 2)), emptyList()).single() as ConversationItem.Turn
        assertEquals(listOf("message:comment", "activity:cmd"), turn.parts.map { it.key })
    }

    @Test fun onlyDesktopVisibleExtensionMethodsBecomeRows() {
        fun extension(method: String, raw: org.json.JSONObject = json()) = ActivityItem(method, "provider_ui", method, time = time(1), payload = json("method" to method, "raw" to raw))
        val timeline = conversationTimeline(emptyList(), listOf(extension("set_status"), extension("notify"), extension("open_url", json("url" to "https://example.com/auth")), extension("open_url", json("url" to "file:///private"))), emptyList())
        assertEquals(listOf("activity:notify", "activity:open_url"), timeline.flatMap { (it as ConversationItem.Turn).parts }.map { it.key })
    }
}
