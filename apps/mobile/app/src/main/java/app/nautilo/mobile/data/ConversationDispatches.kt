package app.nautilo.mobile.data

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/** Match persisted routing records to their actual task cards, not to prose. */
internal fun routedTaskIds(activities: List<ActivityItem>): Set<String> = activities
    .filter { it.eventType in setOf("task.updated", "handoff.created") }
    .map { it.payload.text("taskId") }.filter(String::isNotBlank).toSet()

internal fun ChatMessage.isTaskRoutingRecord(tasks: Set<String>): Boolean =
    sender == "system" && kind in setOf("delegation", "result") && taskId.isNotBlank() && taskId in tasks

/** Same explicit receipt matching as desktop conversationTimeline. Failed or
 * unmatched calls remain visible; source events are never removed. */
internal fun dispatchReceiptIsRepresented(item: ActivityItem, tasks: Set<String>): Boolean {
    if (item.kind != "tool" || item.running || item.payload.opt("success") != true ||
        item.payload.optJSONObject("subagent") != null ||
        !Regex("(?:^|[.:/]|__)agenthub_(?:delegate|plan)$").containsMatchIn(item.title)) return false
    val ids = mutableSetOf<String>()
    fun read(value: Any?, depth: Int = 0) {
        if (depth > 12) return
        when (value) {
            is String -> runCatching { JSONTokener(value).nextValue() }.getOrNull()
                ?.takeUnless { it is String }?.let { read(it, depth + 1) }
            is JSONArray -> for (index in 0 until value.length()) read(value.opt(index), depth + 1)
            is JSONObject -> {
                if (value.opt("success") == false || value.opt("isError") == true ||
                    value.opt("accepted") == false && value.opt("approvalRequired") != true) return
                value.text("taskId").takeIf(String::isNotBlank)?.let(ids::add)
                listOf("tasks", "content", "contentItems", "text", "structuredContent", "result").forEach { read(value.opt(it), depth + 1) }
            }
        }
    }
    read(item.payload.text("outputSummary"))
    return ids.isNotEmpty() && ids.all(tasks::contains)
}
