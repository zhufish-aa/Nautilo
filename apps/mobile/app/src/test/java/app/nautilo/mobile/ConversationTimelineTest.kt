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
}
