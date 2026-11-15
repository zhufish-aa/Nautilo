package app.nautilo.mobile

import app.nautilo.mobile.data.Host
import app.nautilo.mobile.data.json
import app.nautilo.mobile.transport.ConnectionKeeper
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.junit.Assert.*
import org.junit.Test

class ConnectionKeeperTest {
    @Test fun returningToTheSameComputerKeepsTheExistingTransport() = runBlocking {
        val joined = Channel<String>(Channel.UNLIMITED)
        var starts = 0
        var stops = 0
        val keeper = ConnectionKeeper(this, maintain = { host ->
            starts++; joined.send(host.id)
            try { awaitCancellation() } finally { stops++ }
        })
        val host = Host("computer", "Computer", json())
        keeper.keep(host)
        assertEquals("computer", withTimeout(2000) { joined.receive() })
        // Activity returns with freshly decoded metadata for the same host.
        keeper.keep(host.copy(endpoint = json("changed" to true)))
        yield()
        assertEquals(1, starts)
        assertEquals(0, stops)
        keeper.stop(); yield()
        assertEquals(1, stops)
    }
    @Test fun switchingComputersReleasesTheOldOwnerBeforeStartingTheNext() = runBlocking {
        val joined = Channel<String>(Channel.UNLIMITED)
        var active = 0
        var peak = 0
        val keeper = ConnectionKeeper(this, maintain = { host ->
            active++; peak = maxOf(peak, active); joined.send(host.id)
            try { awaitCancellation() } finally { active-- }
        })
        keeper.keep(Host("first", "First", json()))
        withTimeout(2000) { joined.receive() }
        keeper.keep(Host("second", "Second", json()))
        assertEquals("second", withTimeout(2000) { joined.receive() })
        assertEquals(1, peak)
        keeper.stop(); yield()
        assertEquals(0, active)
    }
    @Test fun aLostTransportReconnectsWhileThereIsNoActivityOwner() = runBlocking {
        val joined = Channel<Unit>(Channel.UNLIMITED)
        var starts = 0
        val keeper = ConnectionKeeper(this, maintain = {
            starts++
            if (starts == 1) return@ConnectionKeeper
            joined.send(Unit)
            awaitCancellation()
        })
        keeper.keep(Host("computer", "Computer", json()))
        withTimeout(2500) { joined.receive() }
        assertEquals(2, starts)
        keeper.stop()
    }
}
