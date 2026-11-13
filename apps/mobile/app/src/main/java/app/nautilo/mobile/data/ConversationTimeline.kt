package app.nautilo.mobile.data

import java.time.Instant

sealed interface ConversationItem {
    val key: String
    val time: String
    data class Message(val value: ChatMessage) : ConversationItem {
        override val key = "message:${value.id}"
        override val time = value.time
    }
    data class Turn(val id: String, override val time: String, val parts: List<TurnPart>, val run: RunInfo?) : ConversationItem {
        override val key = "turn:$id"
        // A final response stays outside the disclosure. No text is discarded.
        val answer: ChatMessage? get() = parts.lastOrNull { it.message != null }?.message
        val process: List<TurnPart> get() = parts.filterNot { it.message?.id == answer?.id && it.message != null }
    }
}

data class TurnPart(val message: ChatMessage? = null, val activity: ActivityItem? = null) {
    val key get() = message?.let { "message:${it.id}" } ?: "activity:${activity!!.id}"
    val time get() = message?.time ?: activity!!.time
    val sequence get() = message?.sequence ?: activity!!.sequence
}

private fun milliseconds(time: String) = runCatching { Instant.parse(time).toEpochMilli() }.getOrDefault(0)

/** One native run is one assistant reply, even when it emits several messages and tool calls. */
fun conversationTimeline(messages: List<ChatMessage>, activities: List<ActivityItem>, runs: List<RunInfo>): List<ConversationItem> {
    val turns = linkedMapOf<String, MutableList<TurnPart>>()
    val items = mutableListOf<ConversationItem>()
    val knownRuns = runs.associateBy { it.id }
    fun nativeRun(id: String, time: String): String {
        if (id.isNotBlank()) return id
        val moment = milliseconds(time)
        return runs.filter { milliseconds(it.startedAt) in 1..moment && (it.endedAt.isBlank() || moment <= milliseconds(it.endedAt)) }
            .maxByOrNull { it.startedAt }?.id.orEmpty()
    }
    messages.forEach { message ->
        if (message.sender != "agent") items += ConversationItem.Message(message)
        else turns.getOrPut(nativeRun(message.runId, message.time).ifBlank { "reply:${message.id}" }) { mutableListOf() } += TurnPart(message = message)
    }
    activities.forEach { activity ->
        val id = nativeRun(activity.runId, activity.time).ifBlank { "activity:${activity.id}" }
        turns.getOrPut(id) { mutableListOf() } += TurnPart(activity = activity)
    }
    runs.filter { running(it.status) }.forEach { turns.getOrPut(it.id) { mutableListOf() } }
    turns.forEach { (id, parts) ->
        val ordered = parts.sortedWith(compareBy<TurnPart> { milliseconds(it.time) }.thenBy { if (it.sequence > 0) it.sequence else Long.MAX_VALUE })
        val run = knownRuns[id]
        val time = listOfNotNull(run?.startedAt?.takeIf { it.isNotBlank() }, ordered.firstOrNull()?.time).minOrNull().orEmpty()
        items += ConversationItem.Turn(id, time, ordered, run)
    }
    return items.sortedBy { milliseconds(it.time) }
}
