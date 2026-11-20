package app.nautilo.mobile

import app.nautilo.mobile.data.*
import org.junit.Assert.*
import org.junit.Test

class ConversationTimelineTest {
    private fun time(second: Int) = "2026-11-14T00:00:${second.toString().padStart(2, '0')}Z"
    @Test fun routingRecordsAndSuccessfulToolReceiptsReuseTheExistingTaskCard() {
        val run = RunInfo("r", "completed", time(1), time(9))
        val messages = listOf(ChatMessage("u", "user", "使用探索者", time(0)),
            ChatMessage("route", "system", "Delegated task t: 查看项目", time(4), kind = "delegation", taskId = "t"),
            ChatMessage("final", "agent", "已派发探索者", time(8), runId = "r"))
        val receipt = json("success" to true, "outputSummary" to "[{\"text\":\"{\\\"accepted\\\":true,\\\"tasks\\\":[{\\\"taskId\\\":\\\"t\\\"}]}\"}]")
        val activities = listOf(ActivityItem("task", "task", "任务进度", time = time(3), eventType = "task.updated", payload = json("taskId" to "t")),
            ActivityItem("dispatch", "tool", "mcp__nautilo__agenthub_delegate", time = time(5), runId = "r", payload = receipt))
        val timeline = conversationTimeline(messages, activities, listOf(run))
        assertEquals(2, timeline.size)
        val turn = timeline.last() as ConversationItem.Turn
        assertEquals(listOf("activity:task", "message:final"), turn.parts.map { it.key })
        assertTrue(turn.isLatestSegment)
        assertEquals("completed", turn.run!!.status)
        assertEquals(3, messages.size) // Projection does not delete journal/history data.
    }
    @Test fun normalRepliesAndUnrepresentedOrFailedDispatchesStayVisible() {
        val messages = listOf(ChatMessage("u", "user", "Delegated task t: 用户文字", time(0)),
            ChatMessage("route", "system", "内部消息", time(2), kind = "delegation", taskId = "unmatched"),
            ChatMessage("reply", "agent", "Delegated task t: 模型回复", time(8), runId = "r"))
        val activities = listOf(ActivityItem("task", "task", "任务进度", time = time(3), eventType = "task.updated", payload = json("taskId" to "t")),
            ActivityItem("dispatch", "tool", "agenthub_delegate", time = time(4), runId = "r", payload = json("success" to false, "outputSummary" to "{\"taskId\":\"t\"}")))
        val timeline = conversationTimeline(messages, activities, listOf(RunInfo("r", "completed", time(1), time(9))))
        assertTrue(timeline.filterIsInstance<ConversationItem.Message>().any { it.value.id == "route" })
        assertTrue(timeline.filterIsInstance<ConversationItem.Turn>().flatMap { it.parts }.any { it.activity?.id == "dispatch" })
        assertEquals("reply", (timeline.last() as ConversationItem.Turn).answer!!.id)
    }
    @Test fun failedChildResultsKeepTheirCardWhenTheTurnIsCollapsed() {
        val result = ChatMessage("result", "system", "PROVIDER_ERROR", time(4), kind = "result", taskId = "t")
        val handoff = ActivityItem("result-card", "handoff", "任务交接", "余额不足", time = time(4), eventType = "handoff.created", payload = json("taskId" to "t"))
        val timeline = conversationTimeline(listOf(result, ChatMessage("reply", "agent", "成员运行失败", time(5), runId = "r")), listOf(handoff), listOf(RunInfo("r", "completed", time(1), time(6))))
        val turn = timeline.single() as ConversationItem.Turn
        assertEquals(listOf("activity:result-card", "message:reply"), turn.parts.filter { it.visible(false, turn.answer) }.map { it.key })
    }
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
        assertEquals(listOf("message:u", "turn:r:after:u", "message:u2", "turn:r2:after:u2"), done.map { it.key })
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
    @Test fun steeringSplitsTheReplyEvenWhenTheNativeRunIsUnchanged() {
        val messages = listOf(
            ChatMessage("u", "user", "看看 C 盘", time(1)),
            ChatMessage("a", "agent", "先检查缓存", time(3), runId = "r"),
            ChatMessage("steer", "user", "能不能移动到 D 盘", time(6)),
            ChatMessage("b", "agent", "可以，先确认迁移范围", time(8), runId = "r"),
        )
        val activity = ActivityItem("cmd", "terminal", "检查迁移目录", time = time(7), runId = "r")
        val timeline = conversationTimeline(messages, listOf(activity), listOf(RunInfo("r", "running", time(2), "")))
        assertEquals(4, timeline.size)
        assertEquals("a", (timeline[1] as ConversationItem.Turn).answer!!.id)
        assertEquals("steer", (timeline[2] as ConversationItem.Message).value.id)
        val reply = timeline[3] as ConversationItem.Turn
        assertEquals("b", reply.answer!!.id)
        assertEquals(listOf("activity:cmd"), reply.process.map { it.key })
        assertEquals("r", reply.run!!.id)
        assertFalse((timeline[1] as ConversationItem.Turn).isLatestSegment)
        assertTrue(reply.isLatestSegment)
    }
    @Test fun repeatedSteeringKeepsEveryReplyAfterItsUserMessage() {
        val messages = listOf(
            ChatMessage("a2", "agent", "第二条引导的回复", time(9), runId = "r"),
            ChatMessage("u", "user", "开始", time(1)),
            ChatMessage("s2", "user", "第二条引导", time(8)),
            ChatMessage("a0", "agent", "开始检查", time(3), runId = "r"),
            ChatMessage("s1", "user", "第一条引导", time(4)),
            ChatMessage("a1", "agent", "第一条引导的回复", time(5), runId = "r"),
        )
        val timeline = conversationTimeline(messages, emptyList(), listOf(RunInfo("r", "completed", time(2), time(10))))
        assertEquals(listOf("u", "a0", "s1", "a1", "s2", "a2"), timeline.map {
            when (it) { is ConversationItem.Message -> it.value.id; is ConversationItem.Turn -> it.answer!!.id }
        })
    }
    @Test fun subMillisecondTimestampsAreNotRoundedIntoTheWrongOrder() {
        val timeline = conversationTimeline(listOf(
            ChatMessage("reply", "agent", "收到引导", "2026-11-14T00:00:01.000900Z", runId = "r", sequence = 7),
            ChatMessage("steer", "user", "补充指令", "2026-11-14T00:00:01.000500Z"),
        ), emptyList(), listOf(RunInfo("r", "running", time(0), "")))
        assertEquals("message:steer", timeline.first().key)
        assertEquals("reply", (timeline.last() as ConversationItem.Turn).answer!!.id)
    }
    @Test fun anEarlyRunStartCannotMoveTheFirstReplyBeforeSteering() {
        val timeline = conversationTimeline(listOf(
            ChatMessage("u", "user", "开始", time(1)),
            ChatMessage("s", "user", "补充", time(4)),
            ChatMessage("a", "agent", "收到补充", time(5), runId = "r"),
        ), emptyList(), listOf(RunInfo("r", "running", time(2), "")))
        assertEquals(3, timeline.size)
        assertEquals(listOf("message:u", "message:s"), timeline.take(2).map { it.key })
    }
    @Test fun streamedSteeringReplyKeepsItsSlotWhenTheFinalReceiptArrives() {
        val user = ChatMessage("u", "user", "开始", time(1))
        val comment = ChatMessage("a", "agent", "检查中", time(3), runId = "r")
        val steer = ChatMessage("s", "user", "补充指令", time(5))
        val run = RunInfo("r", "running", time(2), "")
        val thought = ActivityItem("thought", "thought", "思考", time = time(6), runId = "r")
        val thinking = conversationTimeline(listOf(user, comment, steer), listOf(thought), listOf(run))
        val streamed = conversationTimeline(listOf(user, comment, steer, ChatMessage("stream:r:native", "agent", "收到", time(7), runId = "r")), listOf(thought), listOf(run))
        val final = conversationTimeline(listOf(user, comment, steer, ChatMessage("saved", "agent", "收到指令", time(7), runId = "r")), listOf(thought), listOf(run.copy(status = "completed", endedAt = time(9))))
        assertEquals(thinking.map { it.key }, streamed.map { it.key })
        assertEquals(streamed.map { it.key }, final.map { it.key })
        assertEquals("s", (final[2] as ConversationItem.Message).value.id)
        assertEquals("saved", (final.last() as ConversationItem.Turn).answer!!.id)
    }
    @Test fun interleavedRunsDoNotDuplicateDisplayKeysOrReorderTheirContent() {
        val timeline = conversationTimeline(listOf(
            ChatMessage("u", "user", "开始", time(1)),
            ChatMessage("a", "agent", "主任务", time(2), runId = "r"),
            ChatMessage("b", "agent", "另一任务", time(3), runId = "r2"),
            ChatMessage("c", "agent", "主任务继续", time(4), runId = "r"),
        ), emptyList(), emptyList())
        assertEquals(timeline.size, timeline.map { it.key }.toSet().size)
        assertEquals(listOf("a", "b", "c"), timeline.filterIsInstance<ConversationItem.Turn>().map { it.answer!!.id })
    }
}
