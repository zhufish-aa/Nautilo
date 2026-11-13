package app.nautilo.mobile.data

import org.json.JSONObject
import java.time.Instant

/** Applies the desktop journal in order without replacing the visible conversation. */
class SessionProjection {
    private val messages = linkedMapOf<String, ChatMessage>()
    private val activities = linkedMapOf<String, ActivityItem>()
    private val seen = linkedSetOf<String>()
    var sequence: Long = 0
        private set
    var epoch: String = ""
        private set
    var before: JSONObject? = null
        private set
    var runId: String = ""
    var runStatus = ""
    var startedAt = ""
    var endedAt = ""
    var runError = ""

    fun history(page: JSONObject, initialize: Boolean = false, older: Boolean = false) {
        for (item in page.objects("items")) {
            val value = item.getJSONObject("value")
            val message = ChatMessage(value.getString("id"), value.text("sender"), value.text("text"), value.text("createdAt"), runId = value.text("runId"))
            val current = messages[message.id]
            if (current == null || current.delivery != "sent" || message.text.length >= current.text.length) messages[message.id] = message
        }
        if (initialize) {
            sequence = 0
            seen.clear()
            activities.clear()
            page.objects("activity").forEach { apply(it) }
            epoch = page.getString("epoch")
            sequence = page.getLong("sequence")
        }
        if (initialize || older) before = page.optJSONObject("before")
    }
    fun optimistic(message: ChatMessage) { messages.putIfAbsent(message.id, message) }
    fun delivery(id: String, state: String) { messages[id]?.let { messages[id] = it.copy(delivery = state) } }
    fun apply(event: JSONObject, includeMessages: Boolean = true) {
        val cursor = event.optLong("sequence")
        if (cursor <= sequence || !seen.add(event.getString("eventId"))) return
        val p = event.optJSONObject("payload") ?: JSONObject()
        val type = event.text("type")
        val time = event.text("timestamp")
        val id = p.text("messageId", event.text("runId", "assistant"))
        val streamId = "stream:${event.text("runId")}:$id"
        when (type) {
            "agent.message_delta", "agent.message" -> {
                if (!includeMessages) { sequence = cursor; return }
                if (p.text("subagentDispatchId").isNotEmpty()) {
                    val key = "subagent:${p.text("subagentDispatchId")}:$streamId"
                    activities[key] = ActivityItem(key, "team", "子 Agent", p.text("text"), type.endsWith("_delta"), activities[key]?.time ?: time, event.text("runId"), activities[key]?.sequence ?: cursor)
                } else if (type.endsWith("_delta")) {
                    // The Rust journal coalesces chunks into cumulative snapshots.
                    val old = messages[streamId]
                    messages[streamId] = ChatMessage(streamId, "agent", p.text("text"), old?.time ?: time, runId = event.text("runId"), sequence = old?.sequence ?: cursor)
                } else {
                    val providerId = p.text("providerMessageId", id)
                    val old = messages.remove("stream:${event.text("runId")}:$providerId") ?: messages[id]
                    messages[id] = ChatMessage(id, "agent", p.text("text"), old?.time ?: time, runId = event.text("runId"), sequence = old?.sequence?.takeIf { it > 0 } ?: cursor)
                }
            }
            "agent.thinking_delta", "agent.thinking_summary" -> {
                val key = "thought:${event.text("runId")}:$id"
                val old = activities[key]
                val text = p.text("text")
                activities[key] = ActivityItem(key, "thought", "思考", text, type.endsWith("_delta"), old?.time ?: time, event.text("runId"), old?.sequence ?: cursor)
            }
            "tool.started", "tool.updated", "tool.finished", "command.started", "command.updated", "command.finished" -> {
                val key = p.text("callId", event.getString("eventId"))
                val name = p.text("toolName", p.text("command", "运行命令"))
                val detail = listOf(p.text("inputSummary"), p.text("outputSummary")).filter(String::isNotEmpty).joinToString("\n")
                activities[key] = ActivityItem(key, if (type.startsWith("command")) "terminal" else "tool", name, detail.ifEmpty { activities[key]?.detail.orEmpty() }, !type.endsWith("finished"), activities[key]?.time ?: time, event.text("runId"), activities[key]?.sequence ?: cursor)
            }
            "run.started" -> {
                runId = event.text("runId", p.text("runId")); runStatus = "running"; startedAt = time; endedAt = ""; runError = ""
            }
            "run.waiting" -> runStatus = "waiting"
            "run.completed", "run.cancelled", "run.failed" -> {
                runStatus = type.substringAfter('.')
                endedAt = time
                runError = p.text("message", p.optJSONObject("error")?.text("message").orEmpty())
                val finishedRun = event.text("runId", runId)
                activities.replaceAll { _, activity -> if (activity.runId == finishedRun) activity.copy(running = false) else activity }
            }
        }
        sequence = cursor
        if (seen.size > 1000) seen.remove(seen.first())
    }
    fun messageList(): List<ChatMessage> = messages.values.sortedBy {
        runCatching { Instant.parse(it.time).toEpochMilli() }.getOrDefault(0)
    }
    fun activityList(): List<ActivityItem> = activities.values.toList().takeLast(200)
}
