package app.nautilo.mobile

import app.nautilo.mobile.data.SessionRefresh
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionRefreshTest {
    @Test fun streamedContentAndFileEventsDoNotReloadTheConversation() {
        val events = List(500) { listOf("agent.message_delta", "agent.thinking_delta", "tool.output", "run.diff_updated")[it % 4] }
        val refresh = SessionRefresh.forEvents(events)
        assertFalse(refresh.history)
        assertFalse(refresh.snapshot)
    }

    @Test fun aTerminalEventReconcilesPersistedMessagesAndTheRunSnapshot() {
        for (type in listOf("run.completed", "run.cancelled", "run.failed")) {
            val refresh = SessionRefresh.forEvents(listOf("agent.message_delta", type))
            assertTrue(refresh.history)
            assertTrue(refresh.snapshot)
        }
    }

    @Test fun questionsAndApprovalsRefreshTheirStateWithoutRereadingAllMessages() {
        for (type in listOf("interaction.requested", "interaction.resolved", "approval.requested", "run.started", "run.waiting")) {
            val refresh = SessionRefresh.forEvents(listOf(type))
            assertFalse(refresh.history)
            assertTrue(refresh.snapshot)
        }
    }

    @Test fun nativeHistoryAndCheckpointChangesKeepTheirExplicitRecoveryPaths() {
        assertTrue(SessionRefresh.forEvents(listOf("session.native_history_synced")).history)
        val checkpoint = SessionRefresh.forEvents(listOf("session.checkpoint_reverted"))
        assertTrue(checkpoint.history)
        assertTrue(checkpoint.snapshot)
    }
}
