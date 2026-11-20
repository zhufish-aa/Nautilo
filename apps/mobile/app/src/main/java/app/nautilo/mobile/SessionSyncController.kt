package app.nautilo.mobile

import kotlinx.coroutines.*

/** Connection/session ownership lives outside Compose. Cancellation alone is
 * insufficient for a transport completing an already-dispatched read. */
internal class SessionSyncController(private val scope: CoroutineScope) {
    private var owner: Ticket? = null
    var job: Job? = null
        private set
    inner class Ticket(val hostId: String, val sessionId: String) {
        fun isCurrent(): Boolean = owner === this && job?.isActive == true
    }
    fun cancel() { owner = null; job?.cancel(); job = null }
    fun launch(hostId: String, sessionId: String, block: suspend CoroutineScope.(Ticket) -> Unit) {
        cancel()
        val ticket = Ticket(hostId, sessionId)
        owner = ticket
        val next = scope.launch(start = CoroutineStart.LAZY) { block(ticket) }
        job = next
        next.start()
    }
}
