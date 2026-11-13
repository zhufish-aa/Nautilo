package app.nautilo.mobile

import app.nautilo.mobile.data.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class ProjectionTest {
    private fun event(seq: Long, type: String, text: String, id: String = "answer") = json("sequence" to seq, "eventId" to "e$seq", "type" to type,
        "runId" to "run", "timestamp" to "2026-11-14T01:00:01Z", "payload" to json("messageId" to id, "text" to text))

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
}
