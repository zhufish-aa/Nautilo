package app.nautilo.mobile.data

import org.json.JSONObject

/** Run controls and context usage. Conversation rows are read from MobileTimeline. */
class SessionProjection {
    private var usage = ContextUsageProjection()
    fun contextUsage(): ContextUsage = usage.value()
    var sequence: Long = 0
        private set
    var epoch: String = ""
        private set
    var runId: String = ""
    var runStatus = ""
    var startedAt = ""
    var endedAt = ""

    fun history(page: JSONObject, initialize: Boolean = false) {
        if (initialize) {
            usage = ContextUsageProjection()
            sequence = 0
            page.objects("activity").forEach(::apply)
            epoch = page.getString("epoch")
            sequence = page.getLong("sequence")
        }
        page.optJSONObject("usage")?.objects("events")?.forEach(usage::ingest)
    }

    fun apply(event: JSONObject) {
        val cursor = event.optLong("sequence")
        if (cursor <= sequence) return
        sequence = cursor
        if (event.optBoolean("background") || event.optJSONObject("payload")?.text("subagentDispatchId").orEmpty().isNotBlank()) return
        usage.ingest(event)
        val origin = event.text("runId")
        when (val type = event.text("type")) {
            "run.started" -> {
                runId = origin
                runStatus = "running"
                startedAt = event.text("timestamp")
                endedAt = ""
            }
            "run.waiting" -> if (origin == runId) runStatus = "waiting"
            "run.completed", "run.cancelled", "run.failed" -> if (origin == runId) {
                runStatus = type.substringAfter('.')
                endedAt = event.text("timestamp")
            }
        }
    }
}
