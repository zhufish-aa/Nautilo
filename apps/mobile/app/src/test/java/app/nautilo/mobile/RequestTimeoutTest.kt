package app.nautilo.mobile

import app.nautilo.mobile.data.isConnectionFailure
import app.nautilo.mobile.data.isTransportFailure
import app.nautilo.mobile.transport.requestTimeout
import org.junit.Assert.*
import org.junit.Test

class RequestTimeoutTest {
    @Test fun backgroundReadsNeverClaimThatAMessageIsWaitingToSend() {
        for (method in listOf("hello", "events.wait", "session.history", "session.snapshot", "session.models", "projects.list")) {
            val timeout = requestTimeout(method)
            assertEquals("REMOTE_SYNC_TIMEOUT", timeout.code)
            assertFalse(timeout.message.orEmpty().contains("消息"))
            assertFalse(timeout.isConnectionFailure())
        }
    }
    @Test fun unconfirmedSendsRemainRetryableWithoutClaimingTheyDefinitelyFailed() {
        val timeout = requestTimeout("session.send")
        assertEquals("REMOTE_RESPONSE_TIMEOUT", timeout.code)
        assertTrue(timeout.isTransportFailure())
        assertTrue(timeout.message.orEmpty().contains("尚未确认"))
        assertEquals("COMMAND_OUTCOME_PENDING", requestTimeout("session.compact").code)
    }
}
