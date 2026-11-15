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
        val completed: Boolean get() = run?.let { !running(it.status) } ?: parts.none {
            it.message?.id?.startsWith("stream:") == true || it.activity?.running == true
        }
        // Match desktop conversationRows: an in-progress commentary followed by
        // a tool is process, not a final reply moved below that tool.
        val answer: ChatMessage? get() {
            val lastContent = parts.lastOrNull { it.activity?.kind !in setOf("status", "stopped", "error", "approval") }
            return lastContent?.message ?: if (completed) parts.lastOrNull { it.message != null }?.message else null
        }
        val process: List<TurnPart> get() = parts.filterNot { it.isAnswer(answer) || it.alwaysVisible }
    }
}

data class TurnPart(val message: ChatMessage? = null, val activity: ActivityItem? = null) {
    val key get() = message?.let { "message:${it.viewId}" } ?: "activity:${activity!!.id}"
    val time get() = message?.time ?: activity!!.time
    val sequence get() = message?.sequence ?: activity!!.sequence
    val alwaysVisible get() = activity?.let {
        it.kind in setOf("error", "approval", "stopped", "task", "team") || it.payload.optJSONObject("subagent") != null
    } == true
    fun isAnswer(answer: ChatMessage?) = message != null && message.id == answer?.id
    fun visible(expanded: Boolean, answer: ChatMessage?) = expanded || isAnswer(answer) || alwaysVisible
}

/** Mirrors desktop toTimelinePayload/conversationTimeline; journal events are not UI rows. */
internal fun conversationActivityVisible(item: ActivityItem): Boolean {
    if (item.kind == "usage" || item.kind == "status" || item.kind == "followup") return false
    // The pending managed approval is already interactive at the end of the
    // conversation. Its resolution retains this original chronological slot.
    if (item.eventType == "approval.requested") return false
    if (item.kind == "stopped") return true
    if (item.kind == "provider_ui") {
        val p = item.payload
        return p.text("method") == "notify" || p.text("method") == "open_url" &&
            p.optJSONObject("raw")?.text("url")?.matches(Regex("https?://.+", RegexOption.IGNORE_CASE)) == true
    }
    if (item.kind == "artifact" && item.payload.text("kind") == "diff") return false
    if (item.eventType.isBlank()) return item.kind in setOf("thought", "tool", "terminal", "team", "error", "file", "plan", "recovery", "task", "handoff", "approval", "verification", "git", "artifact", "checkpoint")
    return item.eventType in setOf("provider.background_error", "run.diff_updated", "file.changed", "planner.decision", "recovery.decision", "task.updated", "handoff.created", "approval.requested", "approval.resolved", "verification.started", "verification.finished", "git.merge_started", "git.merge_finished", "git.conflict", "artifact.created", "session.checkpoint_reverted") ||
        item.eventType.startsWith("tool.") || item.eventType.startsWith("command.")
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
    activities.filter(::conversationActivityVisible).forEach { activity ->
        val id = nativeRun(activity.runId, activity.time).ifBlank { "activity:${activity.id}" }
        turns.getOrPut(id) { mutableListOf() } += TurnPart(activity = activity)
    }
    runs.filter { running(it.status) }.forEach { turns.getOrPut(it.id) { mutableListOf() } }
    turns.forEach { (id, parts) ->
        // Sequence is the append-only journal order; provider clocks can differ.
        // Older history without sequence metadata falls back to first-seen time.
        val ordered = if (parts.all { it.sequence > 0 }) parts.sortedBy { it.sequence }
            else parts.sortedWith(compareBy<TurnPart> { milliseconds(it.time) }.thenBy { if (it.sequence > 0) it.sequence else Long.MAX_VALUE })
        val run = knownRuns[id]
        val time = listOfNotNull(run?.startedAt?.takeIf { it.isNotBlank() }, ordered.firstOrNull()?.time).minOrNull().orEmpty()
        items += ConversationItem.Turn(id, time, ordered, run)
    }
    return items.sortedBy { milliseconds(it.time) }
}
