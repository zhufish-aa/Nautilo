package app.nautilo.mobile

import app.nautilo.mobile.data.RemoteFailure
import app.nautilo.mobile.transport.ConnectionHealth
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.junit.Assert.*
import org.junit.Test

class ConnectionHealthTest {
    @Test fun anIdleConnectionIsProbedWithoutAnActivity() = runBlocking {
        val wake = Channel<Unit>(Channel.CONFLATED)
        val replies = Channel<Unit>(Channel.UNLIMITED)
        val job = launch {
            ConnectionHealth(intervalMs = 5).watch(wake, closed = { awaitCancellation() }, probe = { replies.send(Unit) })
        }
        try { withTimeout(2000) { repeat(2) { replies.receive() } } }
        finally { job.cancelAndJoin() }
    }

    @Test fun returningToTheAppWakesTheProbeImmediately() = runBlocking {
        val wake = Channel<Unit>(Channel.CONFLATED)
        val reply = CompletableDeferred<Unit>()
        val job = launch {
            ConnectionHealth(intervalMs = 60_000).watch(wake, closed = { awaitCancellation() }, probe = { reply.complete(Unit) })
        }
        try {
            wake.send(Unit)
            withTimeout(2000) { reply.await() }
        } finally { job.cancelAndJoin() }
    }

    @Test fun aTransientFailureRecoversWithoutDroppingTheConnection() = runBlocking {
        val wake = Channel<Unit>(Channel.CONFLATED)
        val recovered = CompletableDeferred<Unit>()
        var probes = 0
        var pathRefreshes = 0
        val job = launch {
            ConnectionHealth(intervalMs = 60_000, retryMs = 1).watch(wake,
                closed = { awaitCancellation() },
                probe = { if (++probes == 1) error("temporary handoff") else recovered.complete(Unit) },
                recoverPath = { pathRefreshes++; error("network discovery is temporarily unavailable") })
        }
        try {
            wake.send(Unit)
            withTimeout(2000) { recovered.await() }
            assertTrue(job.isActive)
            assertEquals(2, probes)
            assertEquals(1, pathRefreshes)
        } finally { job.cancelAndJoin() }
    }

    @Test fun aHalfOpenConnectionTimesOutAndReturnsToTheReconnectOwner() = runBlocking {
        val wake = Channel<Unit>(Channel.CONFLATED)
        var attempts = 0
        var cancelledProbes = 0
        var closedWaitCancelled = false
        wake.send(Unit)
        val error = try {
            withTimeout(2000) {
                ConnectionHealth(intervalMs = 60_000, retryMs = 1, timeoutMs = 20).watch(wake,
                    closed = { try { awaitCancellation() } finally { closedWaitCancelled = true } },
                    probe = { attempts++; try { awaitCancellation() } finally { cancelledProbes++ } })
            }
            null
        } catch (failure: RemoteFailure) { failure }
        assertEquals("CONNECTION_HEALTH_TIMEOUT", error?.code)
        assertEquals(2, attempts)
        assertEquals(2, cancelledProbes)
        assertTrue(closedWaitCancelled)
    }

    @Test fun cancellingMaintenanceCancelsBothNativeWaits() = runBlocking {
        val wake = Channel<Unit>(Channel.CONFLATED)
        val probeEntered = CompletableDeferred<Unit>()
        var cleaned = 0
        val job = launch {
            ConnectionHealth(intervalMs = 60_000).watch(wake,
                closed = { try { awaitCancellation() } finally { cleaned++ } },
                probe = { probeEntered.complete(Unit); try { awaitCancellation() } finally { cleaned++ } })
        }
        wake.send(Unit)
        withTimeout(2000) { probeEntered.await() }
        job.cancelAndJoin()
        assertEquals(2, cleaned)
    }

    @Test fun nativeClosureCancelsTheIdleHeartbeat() = runBlocking {
        var probes = 0
        withTimeout(2000) {
            ConnectionHealth(intervalMs = 60_000).watch(Channel(Channel.CONFLATED), closed = {}, probe = { probes++ })
        }
        assertEquals(0, probes)
    }

    @Test fun revokedAuthorizationIsNotMisdiagnosedAsAStalledPath() = runBlocking {
        val wake = Channel<Unit>(Channel.CONFLATED)
        var recoveries = 0
        wake.send(Unit)
        val error = try {
            withTimeout(2000) {
                ConnectionHealth(intervalMs = 60_000).watch(wake, closed = { awaitCancellation() },
                    probe = { throw RemoteFailure("DEVICE_NOT_AUTHORIZED", "revoked") },
                    recoverPath = { recoveries++ })
            }
            null
        } catch (failure: RemoteFailure) { failure }
        assertEquals("DEVICE_NOT_AUTHORIZED", error?.code)
        assertEquals(0, recoveries)
    }
}
