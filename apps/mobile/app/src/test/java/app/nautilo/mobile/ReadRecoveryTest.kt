package app.nautilo.mobile

import app.nautilo.mobile.data.RemoteFailure
import app.nautilo.mobile.transport.ReadRecovery
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class ReadRecoveryTest {
    @Test fun oneResetRestartsTheReadWithoutShowingAnErrorOrLeavingADelayedBanner() = runBlocking {
        val notices = mutableListOf<Throwable?>()
        var attempts = 0
        var probes = 0
        val reader = ReadRecovery(notices::add, { probes++ }, noticeDelayMs = 40, retryDelayMs = 1)
        assertEquals("next chunk", reader.read {
            if (++attempts == 1) throw IOException("QUIC stream reset")
            "next chunk"
        })
        delay(60)
        assertEquals(2, attempts)
        assertEquals(1, probes)
        assertTrue(notices.isEmpty())
    }

    @Test fun aPersistentReadFailureShowsOneNoticeAndRecoveryClearsIt() = runBlocking {
        val notices = mutableListOf<Throwable?>()
        val shown = CompletableDeferred<Unit>()
        val resume = CompletableDeferred<Unit>()
        val failure = IOException("lost path")
        var attempts = 0
        val reader = ReadRecovery(report = { notices.add(it); if (it != null) shown.complete(Unit) },
            noticeDelayMs = 20, retryDelayMs = 1)
        val read = async { reader.read {
            if (++attempts == 1) throw failure
            resume.await()
            "recovered"
        } }
        withTimeout(2000) { shown.await() }
        assertEquals(listOf(failure), notices)
        resume.complete(Unit)
        assertEquals("recovered", read.await())
        assertEquals(listOf(failure, null), notices)
    }

    @Test fun authorizationAndBusinessFailuresAreImmediatelyReturnedWithoutRetrying() = runBlocking {
        for (code in listOf("DEVICE_NOT_AUTHORIZED", "REMOTE_DISABLED", "DESKTOP_DISK_FULL", "DESKTOP_TRANSPORT_UPDATE_REQUIRED", "CURSOR_RESET_REQUIRED")) {
            var attempts = 0
            val notices = mutableListOf<Throwable?>()
            val failure = RemoteFailure(code, "specific failure")
            val reader = ReadRecovery(notices::add, noticeDelayMs = 20, retryDelayMs = 1)
            try {
                reader.read<Unit> { attempts++; throw failure }
                fail("Expected $code")
            } catch (error: RemoteFailure) { assertSame(failure, error) }
            assertEquals(1, attempts)
            assertTrue(notices.isEmpty())
        }
    }

    @Test fun leavingTheScreenCancelsPendingRecoveryAndItsNotice() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        val notices = mutableListOf<Throwable?>()
        var attempts = 0
        val reader = ReadRecovery(notices::add, noticeDelayMs = 40, retryDelayMs = 1)
        val read = launch { reader.read {
            if (++attempts == 1) throw IOException("temporary reset")
            entered.complete(Unit)
            awaitCancellation()
        } }
        withTimeout(2000) { entered.await() }
        read.cancelAndJoin()
        delay(60)
        assertTrue(notices.isEmpty())
        assertEquals(2, attempts)
    }

    @Test fun cancellingAnAlreadyReportedOutageClearsOnlyItsRecoveryNotice() = runBlocking {
        val notices = mutableListOf<Throwable?>()
        val shown = CompletableDeferred<Unit>()
        val reader = ReadRecovery(report = { notices.add(it); if (it != null) shown.complete(Unit) },
            noticeDelayMs = 10, retryDelayMs = 1)
        val read = launch { reader.read<Unit> { throw IOException("offline") } }
        withTimeout(2000) { shown.await() }
        read.cancelAndJoin()
        assertEquals(2, notices.size)
        assertNull(notices.last())
    }
}
