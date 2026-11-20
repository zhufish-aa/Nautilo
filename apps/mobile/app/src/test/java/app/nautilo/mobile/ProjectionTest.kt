package app.nautilo.mobile

import app.nautilo.mobile.data.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class ProjectionTest {
    @Test fun historyPreservesRoutingTypeAndTaskIdentityForPresentation() {
        val projection = SessionProjection()
        projection.history(json("items" to JSONArray().put(json("value" to json("id" to "route", "sender" to "system", "kind" to "delegation", "taskId" to "task", "text" to "Delegated task", "createdAt" to "2026-11-14T00:00:00Z")))))
        val message = projection.messageList().single()
        assertEquals("delegation", message.kind)
        assertEquals("task", message.taskId)
    }
    @Test fun titleUpdatesDoNotBecomeConversationActivityCards() {
        val projection = SessionProjection()
        projection.apply(json("sequence" to 1, "eventId" to "title", "type" to "session.title_changed", "payload" to json("title" to "图片显示修复")))
        assertTrue(projection.activityList().isEmpty())
        assertEquals(1L, projection.sequence)
    }
    private fun event(seq: Long, type: String, text: String, id: String = "answer") = json("sequence" to seq, "eventId" to "e$seq", "type" to type,
        "runId" to "run", "timestamp" to "2026-11-14T01:00:01Z", "payload" to json("messageId" to id, "text" to text))

    @Test fun runsRejectedBeforeAnyOutputStayVisibleInTheLiveChatAndAfterReopen() {
        fun time(second: Int) = "2026-11-18T01:00:0${second}Z"
        val items = JSONArray()
            .put(json("value" to json("id" to "first", "sender" to "user", "text" to "Hello", "createdAt" to time(0))))
            .put(json("value" to json("id" to "second", "sender" to "user", "text" to "Another request", "createdAt" to time(4))))
        val events = listOf(
            event(1, "run.started", "").put("timestamp", time(1)),
            event(2, "run.failed", "").put("timestamp", time(2)).put("payload", json("code" to "PROVIDER_ERROR",
                "message" to """429: {"code":"NATIVE_ACCOUNT_ERROR","message":"OpenCode model request returned HTTP 429: Free usage limit reached."}""")),
            event(3, "run.started", "").put("runId", "next").put("timestamp", time(5)),
            event(4, "run.failed", "").put("runId", "next").put("timestamp", time(6))
                .put("payload", json("error" to json("message" to "Provider temporarily unavailable")))
        )
        val live = SessionProjection().apply {
            history(json("items" to items))
            events.forEach { apply(it) }
            apply(events.last())
        }
        val reopened = SessionProjection().apply {
            history(json("items" to items, "epoch" to "epoch", "sequence" to 4, "activity" to JSONArray(events)), initialize = true)
        }
        val runs = listOf(RunInfo("run", "failed", time(1), time(2)), RunInfo("next", "failed", time(5), time(6)))
        for (projection in listOf(live, reopened)) {
            val timeline = conversationTimeline(projection.messageList(), projection.activityList(), runs)
            assertEquals(listOf("message:first", "turn:run:after:first", "message:second", "turn:next:after:second"), timeline.map { it.key })
            val turns = timeline.filterIsInstance<ConversationItem.Turn>()
            assertTrue(turns.all { it.completed && it.answer == null && it.parts.single().visible(false, null) })
            assertEquals(listOf("OpenCode 拒绝了这次免费模型请求（HTTP 429）。", "Provider temporarily unavailable"),
                turns.map { it.parts.single().activity?.detail })
        }
    }

    @Test fun streamedMessagesReplayOnceAndFinalTextRemainsVisible() {
        val p = SessionProjection()
        p.history(json("items" to JSONArray(), "epoch" to "epoch", "sequence" to 10), initialize = true)
        p.apply(event(11, "agent.message_delta", "你"))
        p.apply(event(11, "agent.message_delta", "你"))
        p.apply(event(12, "agent.message_delta", "你好"))
        p.apply(event(13, "agent.message", "你好！"))
        p.apply(event(14, "run.completed", ""))
        assertEquals("你好！", p.messageList().single().text)
        assertEquals("completed", p.runStatus)
        assertEquals(14L, p.sequence)
    }
    @Test fun pendingDeliveryHydratesWithoutDuplicateBubblesOrTruncatingStream() {
        val p = SessionProjection()
        p.optimistic(ChatMessage("user", "user", "继续", "2026-11-14T01:00:00Z", "waiting"))
        val page = json("items" to JSONArray().put(json("value" to json("id" to "user", "sender" to "user", "text" to "继续", "createdAt" to "2026-11-14T01:00:00Z"))), "epoch" to "epoch", "sequence" to 3)
        p.history(page, initialize = true)
        p.apply(event(4, "agent.message_delta", "完整正文"))
        p.apply(event(5, "agent.message", "完整正文"))
        p.history(json("items" to JSONArray().put(json("value" to json("id" to "answer", "sender" to "agent", "text" to "完整", "createdAt" to "2026-11-14T01:00:01Z")))))
        assertEquals(2, p.messageList().size)
        assertEquals("sent", p.messageList().first().delivery)
        assertEquals("完整正文", p.messageList().last().text)
    }
    @Test fun nativeActivityHydratesBeforeLiveCursor() {
        val p = SessionProjection()
        p.history(json("items" to JSONArray(), "epoch" to "epoch", "sequence" to 4,
            "activity" to JSONArray().put(event(1, "run.started", "")).put(event(2, "agent.thinking_delta", "检查目录")).put(event(3, "run.completed", ""))), initialize = true)
        assertEquals("检查目录", p.activityList().single().detail)
        assertFalse(p.activityList().single().running)
        p.apply(event(2, "agent.thinking_delta", "重复"))
        assertEquals("检查目录", p.activityList().single().detail)
    }
    @Test fun pairingRejectsExpiredLinksAndPinsComputerIdentity() {
        val payload = json("v" to 1, "transport" to "iroh", "alpn" to "nautilo/remote/1", "name" to "我的电脑", "endpoint" to json("id" to "ab".repeat(32)), "token" to "safe-token".repeat(5), "expiresAt" to 2000)
        fun uri() = "nautilo://pair#" + Base64.getUrlEncoder().withoutPadding().encodeToString(payload.toString().toByteArray())
        val invite = PairingInvitation.parse(uri(), 1000)
        assertEquals("ab".repeat(32), invite.host.id)
        assertTrue(invite.verificationCode("cd".repeat(32)).matches(Regex("[0-9]{6}")))
        assertThrows(IllegalArgumentException::class.java) { PairingInvitation.parse(uri(), 3000) }
        payload.put("alpn", "nautilo/remote/2")
        assertEquals("ab".repeat(32), PairingInvitation.parse(uri(), 1000).host.id)
        payload.put("alpn", "other")
        assertThrows(IllegalArgumentException::class.java) { PairingInvitation.parse(uri(), 1000) }
    }
    @Test fun messageIdentityIsStableAndDeviceNamespaced() {
        val first = PendingCommand.stableMessageId("peer-one", "request")
        assertEquals(first, PendingCommand.stableMessageId("peer-one", "request"))
        assertNotEquals(first, PendingCommand.stableMessageId("peer-two", "request"))
        assertEquals("fallback", JSONObject().text("absent", "fallback"))
    }
    @Test fun repliesKeepTheirOwnRunIdentityAcrossHistoryAndFinalReceipts() {
        val p = SessionProjection()
        p.history(json("items" to JSONArray().put(json("value" to json("id" to "old", "sender" to "agent", "text" to "历史回答", "createdAt" to "2026-11-14T00:00:00Z", "runId" to "previous"))), "epoch" to "epoch", "sequence" to 10), initialize = true)
        p.apply(event(11, "agent.message_delta", "新回答", "native"))
        val final = event(12, "agent.message", "新回答完整", "persisted")
        final.getJSONObject("payload").put("providerMessageId", "native")
        p.apply(final)
        assertEquals(2, p.messageList().size)
        assertEquals("previous", p.messageList().first().runId)
        assertEquals("run", p.messageList().last().runId)
        assertEquals(9, RunInfo("run", "completed", "2026-11-14T01:00:00Z", "2026-11-14T01:00:09Z").elapsedSeconds().toInt())
    }

    @Test fun finalReceiptsAndHistoryRefreshRetainFirstAppearanceOrder() {
        val p = SessionProjection()
        p.apply(event(1, "agent.message_delta", "先检查", "native"))
        val originalViewId = p.messageList().single().viewId
        val tool = event(2, "tool.started", "")
        tool.getJSONObject("payload").put("callId", "read").put("toolName", "read_file")
        p.apply(tool)
        val final = event(3, "agent.message", "先检查文件", "saved")
        final.getJSONObject("payload").put("providerMessageId", "native")
        p.apply(final)
        p.history(json("items" to JSONArray().put(json("value" to json("id" to "saved", "sender" to "agent", "text" to "先检查文件", "createdAt" to "2026-11-14T01:00:03Z")))))
        val turn = conversationTimeline(p.messageList(), p.activityList(), emptyList()).single() as ConversationItem.Turn
        assertEquals(listOf("message:$originalViewId", "activity:tool:run:read"), turn.parts.map { it.key })
        assertEquals("saved", turn.parts.first().message!!.id)
        assertEquals(originalViewId, turn.parts.first().message!!.viewId)
        assertEquals(1L, p.messageList().single().sequence)
        assertEquals("run", p.messageList().single().runId)
    }

    @Test fun repeatedNativeCallIdsInSeparateRunsRemainSeparate() {
        val p = SessionProjection()
        val first = event(1, "tool.started", "").apply { getJSONObject("payload").put("callId", "call-0") }
        val second = event(2, "tool.started", "").apply { put("runId", "next"); getJSONObject("payload").put("callId", "call-0") }
        p.apply(first); p.apply(second)
        assertEquals(2, p.activityList().size)
        assertEquals(setOf("run", "next"), p.activityList().map { it.runId }.toSet())
    }

    @Test fun reasoningAfterToolUsesANewChronologicalSegment() {
        val p = SessionProjection()
        p.apply(event(1, "agent.thinking_delta", "先检查"))
        p.apply(event(2, "tool.started", "").apply { getJSONObject("payload").put("callId", "read") })
        p.apply(event(3, "agent.thinking_delta", "读取后整理"))
        val turn = conversationTimeline(emptyList(), p.activityList(), emptyList()).single() as ConversationItem.Turn
        assertEquals(listOf("先检查", "", "读取后整理"), turn.parts.map { it.activity?.detail })
        assertFalse(turn.parts.first().activity!!.running)
    }
    @Test fun historyRefreshKeepsTheFirstChunkBeforeTheNextSteeringMessage() {
        val p = SessionProjection()
        p.apply(event(1, "agent.message_delta", "第一条引导的回答", "native"))
        val receipt = event(2, "agent.message", "第一条引导的回答", "saved")
        receipt.getJSONObject("payload").put("providerMessageId", "native")
        receipt.put("timestamp", "2026-11-14T01:00:03Z")
        p.apply(receipt)
        val page = json("items" to JSONArray()
            .put(json("value" to json("id" to "steer", "sender" to "user", "text" to "第二条引导", "createdAt" to "2026-11-14T01:00:02Z")))
            .put(json("value" to json("id" to "saved", "sender" to "agent", "text" to "第一条引导的回答", "createdAt" to "2026-11-14T01:00:03Z"))))
        p.history(page)
        assertEquals(listOf("saved", "steer"), p.messageList().map { it.id })
        assertEquals("run", p.messageList().first().runId)
        assertEquals(1L, p.messageList().first().sequence)

        // Reopening replays the same first chunk and final receipt. It must
        // produce the same chronological segments as an already-open screen.
        val reopened = SessionProjection()
        reopened.history(page.put("epoch", "epoch").put("sequence", 2)
            .put("activity", JSONArray().put(event(1, "agent.message_delta", "第一条引导的回答", "native")).put(receipt)), initialize = true)
        val live = conversationTimeline(p.messageList(), p.activityList(), emptyList())
        val history = conversationTimeline(reopened.messageList(), reopened.activityList(), emptyList())
        assertEquals(live, history)
    }
}
