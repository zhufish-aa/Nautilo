package app.nautilo.mobile.transport

import kotlinx.coroutines.delay

/** Bound long-poll starts, not text rendering. Fast streams otherwise exhaust the desktop RPC budget. */
internal class EventPoller(
    private val intervalMs: Long = 250,
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
    private val pause: suspend (Long) -> Unit = { delay(it) },
) {
    private var previousStart: Long? = null

    suspend fun <T> next(read: suspend () -> T): T {
        previousStart?.let { start ->
            val remaining = intervalMs - (nowMs() - start)
            if (remaining > 0) pause(remaining)
        }
        previousStart = nowMs()
        return read()
    }
}
