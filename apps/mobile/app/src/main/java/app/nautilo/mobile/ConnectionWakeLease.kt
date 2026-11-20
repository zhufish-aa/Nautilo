package app.nautilo.mobile

import android.content.Context
import android.os.PowerManager

/** Only the visible connection service owns this CPU lease; it never keeps the screen on. */
internal class ConnectionWakeLease(context: Context) {
    private var active = false
    private val lock = context.getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Nautilo:PeerConnection")
        .apply { setReferenceCounted(false) }

    @Synchronized fun start() { active = true; renew() }

    @Synchronized fun renew() {
        // Renewed after real peer replies. Offline retries cannot hold the CPU indefinitely.
        if (active) lock.acquire(90_000L)
    }

    @Synchronized fun release() {
        active = false
        if (lock.isHeld) lock.release()
    }
}
