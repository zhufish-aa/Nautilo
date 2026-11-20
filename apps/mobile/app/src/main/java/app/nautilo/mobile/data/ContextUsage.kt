package app.nautilo.mobile.data

import org.json.JSONArray
import org.json.JSONObject

/** Same observations and accounting rules as desktop context-usage.ts/session-usage.ts. */
data class ContextUsage(val used: Long? = null, val window: Long? = null, val totalTokens: Long? = null) {
    val percentage: Float? get() = if (used != null && window != null && window > 0)
        (used.toDouble() / window * 100).coerceIn(0.0, 100.0).toFloat() else null
    val available: Long? get() = if (used != null && window != null) (window - used).coerceAtLeast(0) else null
    fun withModelWindow(model: JSONObject?) = if (window != null) this
        else copy(window = model?.knownTokenCount("contextWindow")?.takeIf { it > 0 })
}

internal fun JSONObject.knownTokenCount(field: String): Long? = (opt(field) as? Number)?.let {
    val number = it.toDouble()
    number.takeIf { value -> value.isFinite() && value >= 0 && value <= 9_007_199_254_740_991 && value % 1.0 == 0.0 }?.toLong()
}

/** Snapshots replace their own counters; context-only reports never count as consumption. */
internal class ContextUsageProjection {
    private var used: Long? = null
    private var window: Long? = null
    private var usedAt = -1L
    private var windowAt = -1L
    private data class Snapshot(val sequence: Long, val total: Long?)
    private val accounting = linkedMapOf<String, Snapshot>()

    fun ingest(event: JSONObject) {
        if (event.text("type") != "usage.updated") return
        val payload = event.optJSONObject("payload") ?: return
        if (payload.text("subagentDispatchId").isNotBlank()) return
        val sequence = event.optLong("sequence")
        payload.knownTokenCount("contextUsed")?.let { if (sequence > usedAt) { used = it; usedAt = sequence } }
        payload.knownTokenCount("contextWindow")?.takeIf { it > 0 }?.let { if (sequence > windowAt) { window = it; windowAt = sequence } }
        val scope = payload.text("usageScope")
        if (scope !in setOf("turn", "session")) return
        val nativeKey = if (payload.isNull("usageKey")) if (scope == "turn") event.text("runId") else "" else payload.text("usageKey")
        if (nativeKey.isBlank()) return
        val key = JSONArray(listOf(payload.opt("connectionId"), payload.opt("connectionRevision"), payload.opt("agentInstanceId"), scope, nativeKey)).toString()
        if (sequence <= (accounting[key]?.sequence ?: -1)) return
        val input = payload.knownTokenCount("inputTokens")
        val output = payload.knownTokenCount("outputTokens")
        val total = if (input == null || output == null) null else when (payload.opt("inputTokensIncludesCache")) {
            true -> input + output
            false -> {
                val read = payload.knownTokenCount("cachedInputTokens")
                val write = payload.knownTokenCount("cacheCreationInputTokens")
                if (read == null || write == null) null else input + output + read + write
            }
            else -> null
        }
        accounting[key] = Snapshot(sequence, total)
    }

    fun value(): ContextUsage {
        val totals = accounting.values.mapNotNull { it.total }
        return ContextUsage(used, window, totals.takeIf { it.isNotEmpty() }?.sum())
    }
}
