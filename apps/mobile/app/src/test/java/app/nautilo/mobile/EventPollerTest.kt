package app.nautilo.mobile

import app.nautilo.mobile.data.*
import app.nautilo.mobile.transport.EventPoller
import app.nautilo.mobile.transport.ReadRecovery
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class EventPollerTest {
    @Test fun fastStreamingStaysWithinTheRequestBudgetWithoutDroppingTextOrCursor() = runBlocking {
        var time = 0L
        val starts = mutableListOf<Long>()
        val poller = EventPoller(nowMs = { time }, pause = { time += it })
        val projection = SessionProjection()
        val received = mutableListOf<Long>()
        val expected = "流".repeat(500)
        while (projection.sequence < 500) {
            poller.next {
                starts += time
                val available = (time / 10 + 1).coerceAtMost(500)
                for (sequence in (projection.sequence + 1)..available) {
                    received += sequence
                    projection.apply(json("eventId" to "event-$sequence", "sequence" to sequence,
                        "type" to "agent.message_delta", "runId" to "run", "timestamp" to "2026-11-16T07:00:00Z",
                        "payload" to json("messageId" to "reply", "text" to expected.take(sequence.toInt()))))
                }
            }
        }
        assertEquals((1L..500L).toList(), received)
        assertEquals(expected, projection.messageList().single().text)
        assertTrue(starts.zipWithNext().all { (previous, next) -> next - previous >= 250 })
        assertTrue("500 updates should be batched, not become 500 RPCs", starts.size <= 22)
    }

    @Test fun aStreamResetRetriesTheSameCursorInsteadOfReplayingTheConversation() = runBlocking {
        var time = 0L
        var cursor = 37L
        val requested = mutableListOf<Long>()
        val notices = mutableListOf<Throwable?>()
        val poller = EventPoller(nowMs = { time }, pause = { time += it })
        val recovery = ReadRecovery(notices::add, noticeDelayMs = 40, retryDelayMs = 1)
        val page = recovery.read { poller.next {
            requested += cursor
            if (requested.size == 1) throw IOException("reset")
            listOf(38L, 39L, 40L)
        } }
        page.forEach { cursor = it }
        assertEquals(listOf(37L, 37L), requested)
        assertEquals(40L, cursor)
        assertTrue(notices.isEmpty())
    }

    @Test fun idleLongPollsAndTheFirstReadDoNotGainAnExtraDelay() = runBlocking {
        var time = 0L
        var pauses = 0
        val poller = EventPoller(nowMs = { time }, pause = { pauses++; time += it })
        poller.next { assertEquals(0L, time); time += 20_000 }
        poller.next { assertEquals(20_000L, time) }
        assertEquals(0, pauses)
    }
}
