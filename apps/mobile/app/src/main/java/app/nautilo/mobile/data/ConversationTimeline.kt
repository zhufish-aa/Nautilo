package app.nautilo.mobile.data

import java.time.Instant
import org.json.JSONObject

sealed interface ConversationItem {
    val key: String
    val time: String
    data class Message(val value: ChatMessage) : ConversationItem {
        override val key = "message:${value.id}"
        override val time = value.time
    }
    data class Turn(
        val id: String, override val time: String, val parts: List<TurnPart>, val run: RunInfo?,
        val runId: String = id, val isLatestSegment: Boolean = true,
    ) : ConversationItem {
        override val key = "turn:$id"
        val completed: Boolean get() = !isLatestSegment || (run?.let { !running(it.status) } ?: parts.none {
            it.message?.id?.startsWith("stream:") == true || it.activity?.running == true
        })
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
        it.kind in setOf("error", "approval", "interaction", "stopped", "task", "team", "handoff") || it.payload.optJSONObject("subagent") != null
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
    if (item.eventType == "run.failed") return true
    if (item.kind == "stopped") return true
    if (item.kind == "provider_ui") {
        val p = item.payload
        val raw = p.optJSONObject("raw")
        return when (p.text("method")) {
            "notify" -> p.text("text").isNotBlank() || raw?.text("instructions")?.isNotBlank() == true
            "open_url" -> raw?.text("url")?.matches(Regex("https?://.+", RegexOption.IGNORE_CASE)) == true
            else -> false
        }
    }
    if (item.kind == "artifact" && item.payload.text("kind") == "diff") return false
    if (item.eventType.isBlank()) return item.kind in setOf("thought", "tool", "terminal", "team", "error", "file", "plan", "recovery", "task", "handoff", "approval", "verification", "git", "artifact", "checkpoint")
    return item.eventType in setOf("provider.background_error", "run.diff_updated", "file.changed", "planner.decision", "recovery.decision", "task.updated", "handoff.created", "approval.requested", "approval.resolved", "verification.started", "verification.finished", "git.merge_started", "git.merge_finished", "git.conflict", "artifact.created", "session.checkpoint_reverted") ||
        item.eventType.startsWith("tool.") || item.eventType.startsWith("command.")
}

private fun instant(time: String) = runCatching { Instant.parse(time) }.getOrDefault(Instant.EPOCH)

private data class TimelineEntry(val time: String, val runId: String, val part: TurnPart? = null) {
    val sequence get() = part?.sequence ?: 0
}

/** Group consecutive assistant events, never across a user message. A steer is
 * a new display boundary inside the same native run, not a new native session. */
fun conversationTimeline(messages: List<ChatMessage>, activities: List<ActivityItem>, runs: List<RunInfo>, interactions: List<JSONObject> = emptyList()): List<ConversationItem> {
    val items = mutableListOf<ConversationItem>()
    val knownRuns = runs.associateBy { it.id }
    fun nativeRun(id: String, time: String): String {
        if (id.isNotBlank()) return id
        val moment = instant(time)
        return runs.filter { it.startedAt.isNotBlank() && instant(it.startedAt) <= moment && (it.endedAt.isBlank() || moment <= instant(it.endedAt)) }
            .maxByOrNull { instant(it.startedAt) }?.id.orEmpty()
    }
    val entries = mutableListOf<TimelineEntry>()
    val routedTasks = routedTaskIds(activities)
    messages.filterNot { it.isTaskRoutingRecord(routedTasks) }.forEach { message ->
        val runId = if (message.sender == "agent") nativeRun(message.runId, message.time).ifBlank { "reply:${message.id}" } else ""
        entries += TimelineEntry(message.time, runId, TurnPart(message = message))
    }
    activities.filter(::conversationActivityVisible).filterNot { dispatchReceiptIsRepresented(it, routedTasks) }.forEach { activity ->
        val id = nativeRun(activity.runId, activity.time).ifBlank { "activity:${activity.id}" }
        entries += TimelineEntry(activity.time, id, TurnPart(activity = activity))
    }
    // The list snapshot supplies current responses; journal activities supply
    // the original sequence. Resolve in place, never append old questions to
    // the bottom or use resolvedAt as their display time.
    val anchors = activities.filter { it.kind == "interaction" }.associateBy { it.payload.optJSONObject("interaction")?.text("id") }
    val requests = mergeInteractions(emptyList(), anchors.values.mapNotNull { it.payload.optJSONObject("interaction") } + interactions)
    requests.forEach { request ->
        val anchor = anchors[request.text("id")]
        val time = request.text("createdAt").ifBlank { anchor?.time.orEmpty() }
        val runId = nativeRun(request.text("runId").ifBlank { anchor?.runId.orEmpty() }, time).ifBlank { "interaction:${request.text("id")}" }
        val activity = ActivityItem("interaction:${request.text("id")}", "interaction", request.text("title"),
            running = request.text("status") == "pending", time = time, runId = runId,
            sequence = anchor?.sequence ?: 0, payload = json("interaction" to request))
        entries += TimelineEntry(time, runId, TurnPart(activity = activity))
    }
    val populatedRuns = entries.map { it.runId }.toSet()
    runs.filter { running(it.status) && it.id !in populatedRuns }.forEach {
        entries += TimelineEntry(it.startedAt, it.id)
    }
    val ordered = entries.sortedWith(compareBy<TimelineEntry> { instant(it.time) }.thenBy { it.sequence })
    var boundary = ""
    var segmentBase = ""
    var segmentId = ""
    var segmentRun = ""
    var segmentTime = ""
    var parts = mutableListOf<TurnPart>()
    val occurrences = mutableMapOf<String, Int>()
    fun flush() {
        if (segmentId.isEmpty()) return
        // Sequence is the append-only journal order; provider clocks can differ.
        // Older history without sequence metadata falls back to first-seen time.
        val orderedParts = if (parts.all { it.sequence > 0 }) parts.sortedBy { it.sequence } else parts.toList()
        items += ConversationItem.Turn(segmentId, segmentTime, orderedParts, knownRuns[segmentRun], runId = segmentRun)
        segmentId = ""
        segmentBase = ""
        parts = mutableListOf()
    }
    for (entry in ordered) {
        val message = entry.part?.message
        if (message != null && message.sender != "agent") {
            flush()
            items += ConversationItem.Message(message)
            boundary = message.id
        } else {
            // The user identity keeps the slot stable across stream receipts.
            val id = entry.runId + if (boundary.isBlank()) "" else ":after:$boundary"
            if (segmentBase != id) {
                flush()
                val occurrence = occurrences.getOrDefault(id, 0)
                occurrences[id] = occurrence + 1
                segmentBase = id
                segmentId = id + if (occurrence == 0) "" else ":segment:$occurrence"
                segmentRun = entry.runId
                segmentTime = entry.time
            }
            entry.part?.let { parts += it }
        }
    }
    flush()
    val lastSegment = mutableMapOf<String, String>()
    items.filterIsInstance<ConversationItem.Turn>().forEach { lastSegment[it.runId] = it.id }
    return items.map { item ->
        if (item is ConversationItem.Turn) item.copy(isLatestSegment = lastSegment[item.runId] == item.id) else item
    }
}
