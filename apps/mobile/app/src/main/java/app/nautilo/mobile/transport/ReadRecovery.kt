package app.nautilo.mobile.transport

import app.azula.iroh.IrohException
import app.nautilo.mobile.data.RemoteFailure
import kotlinx.coroutines.*
import java.io.IOException

/** Retry only idempotent reads. User commands keep their existing durable receipt/ID flow. */
internal class ReadRecovery(
    private val report: (Throwable?) -> Unit,
    private val checkConnection: () -> Unit = {},
    private val noticeDelayMs: Long = 4_000,
    private val retryDelayMs: Long = 350,
) {
    suspend fun <T> read(request: suspend () -> T): T = coroutineScope {
        var notice: Job? = null
        var reported = false
        var failures = 0
        try {
            while (true) {
                try {
                    val value = request()
                    return@coroutineScope value
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (!error.isRetryableReadFailure()) throw error
                    if (notice == null) {
                        checkConnection()
                        notice = launch {
                            delay(noticeDelayMs)
                            reported = true
                            report(error)
                        }
                    }
                    delay((retryDelayMs shl failures.coerceAtMost(3)).coerceAtMost(3_000))
                    failures++
                }
            }
            @Suppress("UNREACHABLE_CODE") error("Read recovery stopped")
        } finally {
            withContext(NonCancellable) {
                notice?.cancelAndJoin()
                if (reported) report(null)
            }
        }
    }
}

internal fun Throwable.isRetryableReadFailure(): Boolean = when (this) {
    is IrohException, is IOException -> true
    is RemoteFailure -> code in setOf(
        "REMOTE_SYNC_TIMEOUT", "REMOTE_RESPONSE_TIMEOUT", "CONNECTION_HEALTH_TIMEOUT",
        "PEER_CONNECTION_TIMEOUT", "TRANSPORT_POLICY_TIMEOUT", "TRANSPORT_START_TIMEOUT",
        "DIRECT_NETWORK_UNAVAILABLE", "DIRECT_CONNECTION_UNAVAILABLE", "DIRECT_PATH_LOST", "VPN_ROUTE_RESTRICTED",
    )
    else -> false
}
