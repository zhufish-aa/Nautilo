package app.nautilo.mobile.transport

import app.nautilo.mobile.data.Host
import kotlinx.coroutines.*

/** One transport owner per computer, independent of the visible Activity. */
internal class ConnectionKeeper(private val scope: CoroutineScope,
    private val maintain: suspend (Host) -> Unit, private val failed: (Throwable) -> Unit = {}) {
    private var computer: String? = null
    private var job: Job? = null
    fun keep(host: Host) {
        if (computer == host.id && job?.isActive == true) return
        val previous = job
        previous?.cancel()
        computer = host.id
        job = scope.launch {
            previous?.join()
            var failures = 0
            while (isActive) {
                try { maintain(host); failures = 0 }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) { failed(error); failures++ }
                delay((500L shl failures.coerceAtMost(5)).coerceAtMost(15_000))
            }
        }
    }
    fun stop() { computer = null; job?.cancel(); job = null }
}
