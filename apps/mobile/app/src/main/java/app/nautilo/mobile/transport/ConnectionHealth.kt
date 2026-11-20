package app.nautilo.mobile.transport

import app.nautilo.mobile.data.RemoteFailure
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.selects.select

/** Detect a half-open transport even when QUIC has not reported it closed. */
internal class ConnectionHealth(
    private val intervalMs: Long = 20_000,
    private val retryMs: Long = 2_000,
    private val timeoutMs: Long = 8_000,
) {
    suspend fun watch(
        wake: ReceiveChannel<Unit>,
        closed: suspend () -> Unit,
        probe: suspend () -> Unit,
        recoverPath: suspend () -> Unit = {},
    ): Unit = supervisorScope {
        val closure = async { closed() }
        val heartbeat = async {
            var failures = 0
            while (isActive) {
                withTimeoutOrNull(if (failures == 0) intervalMs else retryMs) { wake.receive() }
                try {
                    if (withTimeoutOrNull(timeoutMs) { probe(); true } != true)
                        throw RemoteFailure("CONNECTION_HEALTH_TIMEOUT", "电脑连接未响应，正在重新连接。")
                    failures = 0
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (error is RemoteFailure && error.code in setOf("DEVICE_NOT_AUTHORIZED", "REMOTE_DISABLED"))
                        throw error
                    // A single delayed reply during a cellular handoff is not a lost connection.
                    if (++failures >= 2) throw RemoteFailure("CONNECTION_HEALTH_TIMEOUT", "电脑连接未响应，正在重新连接。")
                    try { withTimeoutOrNull(timeoutMs) { recoverPath() } }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* Keep the second health probe even if discovery is offline. */ }
                }
            }
        }
        try {
            select { closure.onAwait { }; heartbeat.onAwait { } }
        } finally {
            closure.cancel()
            heartbeat.cancel()
            withContext(NonCancellable) { closure.join(); heartbeat.join() }
        }
    }
}
