package app.nautilo.mobile.data

import kotlin.math.floor
import kotlin.math.max

/** Paces presentation only. The persisted timeline always keeps the original text. */
internal class StreamPacer(private val segmentEnds: (String) -> List<Int>) {
    private val ends = mutableListOf<Int>()
    private var raw = ""
    private var shown = 0
    private var previousFrame: Long? = null
    private var fractional = 0.0
    private var backlogMs = 0.0
    private var finishingMs = 0.0
    private var streaming = false
    val pending get() = shown < ends.size
    val text get() = raw.substring(0, if (shown == 0) 0 else ends[shown - 1])

    fun update(value: String, live: Boolean, animate: Boolean) {
        val next = if (live && value.lastOrNull()?.isHighSurrogate() == true) value.dropLast(1) else value
        val append = next.startsWith(raw)
        val waiting = pending
        if (next != raw) {
            // The first new code point may extend the previous grapheme, for
            // example a combining mark, emoji modifier or ZWJ sequence.
            val restart = if (append) ends.getOrNull(ends.size - 2) ?: 0 else 0
            if (!append) ends.clear() else if (ends.isNotEmpty()) ends.removeAt(ends.lastIndex)
            ends.addAll(segmentEnds(next.substring(restart)).map { it + restart })
            raw = next
            shown = shown.coerceAtMost(ends.size)
        }
        if (!animate || !append) shown = ends.size
        if (!waiting || !pending) {
            previousFrame = null
            fractional = 0.0
            backlogMs = 0.0
        }
        if (streaming != live) finishingMs = 0.0
        streaming = live
    }

    fun frame(nanos: Long): String {
        val dt = previousFrame?.let { ((nanos - it) / 1_000_000.0).coerceIn(0.0, 50.0) } ?: 0.0
        previousFrame = nanos
        val backlog = ends.size - shown
        if (backlog == 0 || dt == 0.0) return text
        val rate = if (streaming) {
            val adaptive = if (backlog <= 20) 48.0 else 48.0 + backlog * 5.5
            val catchUp = if (backlog > 20 || backlogMs >= 180.0) backlog * 1000.0 / (300.0 - backlogMs).coerceAtLeast(dt) else 0.0
            backlogMs += dt
            max(adaptive, catchUp)
        } else {
            val remaining = (180.0 - finishingMs).coerceAtLeast(dt)
            finishingMs += dt
            backlog * 1000.0 / remaining
        }
        fractional += rate * dt / 1000.0
        val advance = floor(fractional + 1e-6).toInt().coerceAtMost(backlog)
        shown += advance
        fractional -= advance
        if (!streaming && finishingMs >= 180.0) shown = ends.size
        return text
    }
}
