package app.nautilo.mobile.data

import org.json.JSONObject
import java.time.Instant

/** Applies the desktop journal in order without replacing the visible conversation. */
class SessionProjection(private val subagentBuckets: MutableMap<String, SessionProjection> = linkedMapOf()) {
    private var usage = ContextUsageProjection()
    fun contextUsage(): ContextUsage = usage.value()
    private val messages = linkedMapOf<String, ChatMessage>()
    private val activities = linkedMapOf<String, ActivityItem>()
    private val reasoningGeneration = mutableMapOf<String, Int>()
    private val latestReasoning = mutableMapOf<String, String>()
    private val latestCalls = mutableMapOf<String, String>()
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

    fun history(page: JSONObject, initialize: Boolean = false, older: Boolean = false) {
        for (item in page.objects("items")) {
            val value = item.getJSONObject("value")
            val message = ChatMessage(value.getString("id"), value.text("sender"), value.text("text"), value.text("timelineStartedAt", value.text("createdAt")), runId = value.text("runId"), sequence = value.optLong("sequence"), attachmentNames = value.strings("attachmentNames"), attachments = value.objects("attachments").map(ChatAttachment::decode), kind = value.text("kind", "chat"), taskId = value.text("taskId"))
            val current = messages[message.id]
            if (current == null || current.delivery != "sent" || message.text.length >= current.text.length) messages[message.id] = message.copy(
                time = current?.time?.takeIf(String::isNotBlank) ?: message.time,
                runId = message.runId.ifBlank { current?.runId.orEmpty() },
                viewId = current?.viewId ?: message.viewId,
                sequence = current?.sequence?.takeIf { it > 0 } ?: message.sequence)
        }
        if (initialize) {
            usage = ContextUsageProjection()
            sequence = 0
            seen.clear()
            activities.clear()
            reasoningGeneration.clear()
            latestReasoning.clear()
            latestCalls.clear()
            subagentBuckets.clear()
            page.objects("activity").forEach { apply(it) }
            epoch = page.getString("epoch")
            sequence = page.getLong("sequence")
        }
        // Independent of the bounded activity page, including when reopening.
        page.optJSONObject("usage")?.objects("events")?.forEach(usage::ingest)
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
        val dispatchId = p.text("subagentDispatchId")
        if (dispatchId.isNotEmpty()) {
            // Same as PC collectSubagentActivities: child events belong inside
            // their dispatch, never interleaved into the main assistant reply.
            val nested = JSONObject(event.toString())
            nested.getJSONObject("payload").remove("subagentDispatchId")
            subagentBuckets.getOrPut(dispatchId) { SessionProjection(subagentBuckets) }.apply(nested)
            sequence = cursor
            if (seen.size > 1000) seen.remove(seen.first())
            return
        }
        usage.ingest(event)
        when (type) {
            "agent.message_delta", "agent.message" -> {
                if (!includeMessages) { sequence = cursor; return }
                finishReasoning(event.text("runId"))
                if (type.endsWith("_delta")) {
                    // The Rust journal coalesces chunks into cumulative snapshots.
                    val old = messages[streamId]
                    messages[streamId] = ChatMessage(streamId, "agent", p.text("text"), old?.time ?: time, runId = event.text("runId"), sequence = old?.sequence ?: cursor)
                } else {
                    val providerId = p.text("providerMessageId", id)
                    val old = messages.remove("stream:${event.text("runId")}:$providerId") ?: messages[id]
                    messages[id] = ChatMessage(id, "agent", p.text("text"), old?.time ?: time, runId = event.text("runId"), sequence = old?.sequence?.takeIf { it > 0 } ?: cursor, viewId = old?.viewId ?: id)
                }
            }
            "agent.thinking_delta", "agent.thinking_summary" -> {
                val run = event.text("runId")
                val explicitKey = "thought:$run:$id:${reasoningGeneration[run] ?: 0}"
                val key = if (type.endsWith("summary") && !activities.containsKey(explicitKey)) latestReasoning[run] ?: explicitKey else explicitKey
                latestReasoning[run] = key
                val old = activities[key]
                val text = p.text("text").ifBlank { old?.detail.orEmpty() }
                activities[key] = ActivityItem(key, "thought", "思考", text, type.endsWith("_delta"), old?.time ?: time, event.text("runId"), old?.sequence ?: cursor)
            }
            "tool.started", "tool.updated", "tool.finished", "command.started", "command.updated", "command.finished" -> {
                val run = event.text("runId")
                val family = type.substringBefore('.')
                val fallback = "$family:$run:${p.text("toolName", p.text("command"))}"
                val key = if (p.text("callId").isNotBlank()) "$family:$run:${p.text("callId")}" else
                    if (type.endsWith("finished")) latestCalls[fallback] ?: "$fallback:$cursor" else "$fallback:$cursor"
                if (type.endsWith("started")) {
                    latestCalls[fallback] = key
                    finishReasoning(run)
                    reasoningGeneration[run] = (reasoningGeneration[run] ?: 0) + 1
                }
                val name = p.text("toolName", p.text("command", activities[key]?.title ?: "运行命令"))
                val detail = listOf(p.text("inputSummary"), p.text("outputSummary")).filter(String::isNotEmpty).joinToString("\n")
                val payload = JSONObject(activities[key]?.payload?.toString() ?: "{}")
                val previousCode = payload.optJSONObject("codeExecution")
                p.keys().forEach { field -> payload.put(field, p.get(field)) }
                p.optJSONObject("codeExecution")?.takeIf { it.optBoolean("partial") && previousCode != null }?.let { update ->
                    val calls = previousCode!!.objects("calls").associateBy { it.text("callId") }.toMutableMap()
                    update.objects("calls").forEach { next ->
                        val call = JSONObject(calls[next.text("callId")]?.toString() ?: "{}")
                        next.keys().forEach { field ->
                            val value = next.get(field)
                            if (value != JSONObject.NULL && !(field == "status" && value == "running" && call.text("status").let { it.isNotBlank() && it != "running" })) call.put(field, value)
                        }
                        calls[next.text("callId")] = call
                    }
                    val code = JSONObject(previousCode.toString())
                    update.keys().forEach { field -> code.put(field, update.get(field)) }
                    code.put("calls", org.json.JSONArray(calls.values.toList()))
                    payload.put("codeExecution", code)
                }
                activities[key] = ActivityItem(key, if (type.startsWith("command")) "terminal" else "tool", name, detail.ifEmpty { activities[key]?.detail.orEmpty() }, !type.endsWith("finished") && activities[key]?.running != false, activities[key]?.time ?: time, event.text("runId"), activities[key]?.sequence ?: cursor, type, payload)
            }
            "run.started" -> {
                runId = event.text("runId", p.text("runId")); runStatus = "running"; startedAt = time; endedAt = ""
            }
            "run.waiting" -> runStatus = "waiting"
            "run.completed", "run.cancelled", "run.failed" -> {
                runStatus = type.substringAfter('.')
                endedAt = time
                val finishedRun = event.text("runId", runId)
                activities.replaceAll { _, activity -> if (activity.runId == finishedRun) activity.copy(running = false) else activity }
                if (type == "run.cancelled") {
                    val key = "stopped:$finishedRun"
                    activities[key] = ActivityItem(key, "stopped", "已停止", time = time, runId = finishedRun, sequence = cursor, eventType = type)
                } else if (type == "run.failed") {
                    val key = "failure:${finishedRun.ifBlank { event.getString("eventId") }}"
                    activities[key] = ActivityItem(key, "error", "运行遇到问题", runFailureDetail(p),
                        time = time, runId = finishedRun, sequence = cursor, eventType = type)
                }
            }
            else -> {
                val category = when {
                    type == "provider.extension_ui" -> "provider_ui"
                    type == "provider.background_error" -> "error"
                    type == "run.diff_updated" || type == "file.changed" -> "file"
                    type.startsWith("planner.") -> "plan"
                    type.startsWith("recovery.") -> "recovery"
                    type.startsWith("task.") -> "task"
                    type.startsWith("handoff.") -> "handoff"
                    type.startsWith("approval.") -> "approval"
                    type.startsWith("interaction.") -> "interaction"
                    type.startsWith("verification.") -> "verification"
                    type.startsWith("git.") -> "git"
                    type.startsWith("usage.") -> "usage"
                    type.startsWith("artifact.") -> "artifact"
                    type == "session.checkpoint_reverted" -> "checkpoint"
                    type.startsWith("session.follow_up") -> "followup"
                    else -> ""
                }
                // Desktop has no generic fallback renderer for protocol events.
                // Keep cumulative usage as data, but never turn runtime logs into cards.
                if (category.isEmpty()) { sequence = cursor; return }
                val title = when (category) {
                    "provider_ui" -> "Harness 通知"; "error" -> "后台异常"; "file" -> p.text("path", "文件变更")
                    "plan" -> "计划"; "recovery" -> "恢复决策"; "task" -> "任务进度"; "handoff" -> "任务交接"
                    "approval" -> if (type.endsWith("resolved")) "授权结果" else "等待批准"
                    "interaction" -> p.optJSONObject("interaction")?.text("title", "提问").orEmpty()
                    "verification" -> if (type.endsWith("finished")) if (p.optBoolean("passed")) "验证通过" else "验证失败" else "正在验证"
                    "git" -> when(type) { "git.conflict" -> "合并冲突"; "git.merge_finished" -> "合并完成"; "git.merge_started" -> "正在合并"; else -> "变更已收集" }
                    "usage" -> "用量"; "artifact" -> p.text("name", "产物"); "checkpoint" -> "检查点已恢复"
                    "followup" -> when(type) { "session.follow_up_queued" -> "消息已排队"; "session.follow_up_cancelled" -> "排队已取消"; else -> "消息已引导当前轮" }
                    else -> type
                }
                val key = when(category) {
                    "usage" -> "usage:${event.text("runId")}:${p.text("usageScope")}:${p.text("usageKey")}"
                    "task" -> "task:${p.text("taskId")}"
                    "approval" -> "approval:${p.text("approvalId")}"
                    "interaction" -> "interaction:${p.optJSONObject("interaction")?.text("id")}"
                    "verification" -> "verification:${p.text("verificationId")}"
                    "followup" -> "followup:${p.text("messageId")}"
                    else -> event.getString("eventId")
                }
                val payload = JSONObject(activities[key]?.payload?.toString() ?: "{}")
                p.keys().forEach { field -> if (!p.isNull(field)) payload.put(field, p.get(field)) }
                val detail = listOf("text", "rationale", "summary", "message", "warning").map { payload.text(it) }.firstOrNull(String::isNotBlank).orEmpty()
                activities[key] = ActivityItem(key, category, title, detail, type == "verification.started", activities[key]?.time ?: time, event.text("runId"), activities[key]?.sequence ?: cursor, type, payload)
            }
        }
        sequence = cursor
        if (seen.size > 1000) seen.remove(seen.first())
    }
    fun messageList(): List<ChatMessage> = messages.values.sortedBy {
        runCatching { Instant.parse(it.time) }.getOrDefault(Instant.EPOCH)
    }
    fun activityList(depth: Int = 0, ancestry: Set<String> = emptySet()): List<ActivityItem> = activities.values.toList().takeLast(200).map { item ->
        val bucket = subagentBuckets[item.payload.text("callId")]
        if (depth >= 32 || item.payload.text("callId") in ancestry || bucket == null || item.payload.optJSONObject("subagent") == null) item else {
            val payload = JSONObject(item.payload.toString())
            val parts = bucket.messageList().map { TurnPart(message = it) } + bucket.activityList(depth + 1, ancestry + item.payload.text("callId")).filter(::conversationActivityVisible).map { TurnPart(activity = it) }
            payload.getJSONObject("subagent").put("activities", org.json.JSONArray(parts.sortedBy { it.sequence }.map { part ->
                part.message?.let { json("id" to it.id, "kind" to "message", "text" to it.text) } ?: part.activity!!.let {
                    json("id" to it.id, "kind" to it.kind, "title" to it.title, "detail" to it.detail, "running" to it.running, "payload" to it.payload)
                }
            }))
            item.copy(payload = payload)
        }
    }
    fun interactionList(): List<JSONObject> = activities.values.filter { it.kind == "interaction" }.mapNotNull { it.payload.optJSONObject("interaction") }
    private fun finishReasoning(run: String) {
        latestReasoning[run]?.let { key -> activities[key]?.let { activities[key] = it.copy(running = false) } }
    }
}

private fun runFailureDetail(payload: JSONObject): String {
    val detail = payload.text("message").ifBlank { payload.optJSONObject("error")?.text("message").orEmpty() }
    val status = detail.substringBefore(':').toIntOrNull()
    if (status == 429 && "OpenCode model request returned HTTP 429: Free usage limit reached" in detail) {
        return "OpenCode 拒绝了这次免费模型请求（HTTP 429）。"
    }
    return detail.ifBlank { "这轮请求未完成。" }
}

/** Same visibility as PC InteractionCards: retain answered questions, hide answered approvals. */
internal fun mergeInteractions(previous: List<JSONObject>, observed: List<JSONObject>, pending: List<JSONObject>? = null): List<JSONObject> {
    val retained = if (pending == null) previous else previous.filter { it.text("status") != "pending" }
    val merged = linkedMapOf<String, JSONObject>()
    (retained + observed + pending.orEmpty()).forEach { next ->
        val current = merged[next.text("id")]
        if (!(current != null && current.text("status") != "pending" && next.text("status") == "pending")) merged[next.text("id")] = next
    }
    return merged.values
        .filter { it.text("kind") == "question" || it.text("status") == "pending" }.sortedBy { it.text("createdAt") }
}
