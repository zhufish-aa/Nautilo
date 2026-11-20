package app.nautilo.mobile

import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class SessionSyncControllerTest {
    @Test fun changingSessionRejectsAnAlreadyDispatchedOldRead() = runBlocking {
        val scope = CoroutineScope(coroutineContext + SupervisorJob())
        val controller = SessionSyncController(scope)
        val pending = CompletableDeferred<Unit>()
        var old: SessionSyncController.Ticket? = null
        var current: SessionSyncController.Ticket? = null
        val applied = mutableListOf<String>()
        controller.launch("computer-a", "session-a") { ticket ->
            old = ticket
            withContext(NonCancellable) { pending.await(); if (ticket.isCurrent()) applied += "old" }
        }
        yield()
        controller.launch("computer-a", "session-b") { ticket -> current = ticket; awaitCancellation() }
        yield()
        assertFalse(old!!.isCurrent())
        assertTrue(current!!.isCurrent())
        pending.complete(Unit)
        yield()
        assertTrue(applied.isEmpty())
        controller.cancel()
        assertFalse(current!!.isCurrent())
        scope.cancel()
    }

    @Test fun reconnectingTheSameSessionInvalidatesTheOldTransportOwner() = runBlocking {
        val scope = CoroutineScope(coroutineContext + SupervisorJob())
        val controller = SessionSyncController(scope)
        var first: SessionSyncController.Ticket? = null
        controller.launch("computer", "same-session") { first = it; awaitCancellation() }
        yield()
        val previousJob = controller.job!!
        var latest: SessionSyncController.Ticket? = null
        controller.launch("computer", "same-session") { latest = it; awaitCancellation() }
        yield()
        assertTrue(previousJob.isCancelled)
        assertFalse(first!!.isCurrent())
        assertTrue(latest!!.isCurrent())
        controller.cancel()
        assertNull(controller.job)
        scope.cancel()
    }
}
