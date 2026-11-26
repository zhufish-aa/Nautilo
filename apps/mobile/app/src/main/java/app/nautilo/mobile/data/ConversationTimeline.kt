package app.nautilo.mobile.data

import org.json.JSONObject

data class MobileTimelineBlock(val value: JSONObject) {
    val id get() = value.getString("blockId")
    val seq get() = value.getLong("seq")
    val kind get() = value.getString("kind")
    val runId get() = value.text("runId")
    val content get() = value.getJSONObject("content")
    val result get() = value.optJSONObject("result")
    val sealed get() = value.getBoolean("sealed")
    val status get() = value.text("status")
    val type get() = (result ?: content).text("type")
    val payload get() = content.optJSONObject("payload") ?: JSONObject()
    val toolPayload get(): JSONObject {
        val resultPayload = result?.optJSONObject("payload") ?: return payload
        return JSONObject(payload.toString()).apply {
            resultPayload.keys().forEach { put(it, resultPayload.opt(it)) }
        }
    }
    val isToolStep get() = kind == "tool_call" || type == "file.changed"
}

data class MobileTimeline(
    val revision: Long,
    val blocks: List<MobileTimelineBlock>,
    val turns: Map<String, JSONObject>,
) {
    companion object {
        fun open(snapshot: JSONObject): MobileTimeline {
            val blocks = snapshot.objects("blocks").map(::MobileTimelineBlock)
            require(blocks.zipWithNext().all { (first, next) -> first.seq < next.seq })
            require(blocks.map { it.id }.toSet().size == blocks.size)
            return MobileTimeline(snapshot.getLong("revision"), blocks, snapshot.objects("turns").associateBy { it.getString("runId") })
        }
    }

    fun apply(page: JSONObject): MobileTimeline {
        require(!page.optBoolean("reset"))
        val nextRevision = page.getLong("revision")
        if (nextRevision <= revision) return this
        val next = blocks.toMutableList()
        val positions = blocks.mapIndexed { index, block -> block.id to index }.toMap().toMutableMap()
        val metadata = turns.toMutableMap()
        for (batch in page.objects("changes")) {
            for (op in batch.objects("operations")) {
                if (op.getString("type") == "block_created") {
                    val block = MobileTimelineBlock(op.getJSONObject("block"))
                    require(block.id !in positions && block.seq > (next.lastOrNull()?.seq ?: 0))
                    positions[block.id] = next.size
                    next.add(block)
                } else {
                    val index = positions.getValue(op.getString("blockId"))
                    val block = next[index]
                    val updated = JSONObject(block.value.toString())
                    when (op.getString("type")) {
                        "block_delta" -> {
                            require(!block.sealed && index == next.lastIndex)
                            val content = updated.getJSONObject("content")
                            content.put("text", content.getString("text") + op.getString("text"))
                        }
                        "block_updated" -> for (key in listOf("sealed", "status", "result")) {
                            if (op.has(key)) updated.put(key, op.get(key))
                        }
                        else -> error("Unknown timeline operation")
                    }
                    next[index] = MobileTimelineBlock(updated)
                }
            }
            batch.optJSONObject("turn")?.let { metadata[it.getString("runId")] = it }
        }
        return MobileTimeline(nextRevision, next, metadata)
    }
}

sealed interface ConversationItem {
    val key: String
    data class Block(val block: MobileTimelineBlock) : ConversationItem { override val key get() = block.id }
    data class Process(val turn: JSONObject, val blocks: MutableList<MobileTimelineBlock>) : ConversationItem {
        override val key get() = "process:" + blocks.first().id
    }
    data class Summary(val turn: JSONObject) : ConversationItem {
        override val key get() = "summary:" + turn.getString("runId")
    }
}

fun conversationTimeline(timeline: MobileTimeline): List<ConversationItem> {
    val out = mutableListOf<ConversationItem>()
    val lastProcess = mutableMapOf<String, ConversationItem.Process>()
    val runningTails = mutableMapOf<String, String>()
    for (block in timeline.blocks) {
        if (timeline.turns[block.runId]?.text("status") == "running" && block.kind in replyTailKinds) {
            runningTails[block.runId] = block.id
        }
    }
    var group: ConversationItem.Process? = null
    for (block in timeline.blocks) {
        if (block.type == "handoff.created") continue
        val turn = timeline.turns[block.runId]
        val reply = block.kind == "assistant_text" && runningTails[block.runId] == block.id
        val foldable = turn != null && block.id != turn.text("finalBlockId")
            && !reply && block.kind in processKinds && block.type !in visibleNotices
        if (!foldable) {
            group = null
            out += ConversationItem.Block(block)
        } else {
            val adjacent = group?.takeIf { it.turn === turn }
                ?: ConversationItem.Process(turn, mutableListOf()).also {
                    group = it
                    out += it
                    lastProcess[block.runId] = it
                }
            adjacent.blocks += block
        }
    }
    return buildList {
        for ((index, entry) in out.withIndex()) {
            when (entry) {
                is ConversationItem.Process -> {
                    val turn = entry.turn
                    val finalId = turn.text("finalBlockId")
                    val next = out.getOrNull(index + 1) as? ConversationItem.Block
                    if (turn.text("status") != "running" && lastProcess[turn.text("runId")] === entry &&
                        (finalId.isEmpty() || next?.block?.id == finalId)) add(ConversationItem.Summary(turn))
                }
                is ConversationItem.Block -> {
                    val turn = timeline.turns[entry.block.runId]
                    val process = lastProcess[entry.block.runId]
                    if (turn != null && turn.text("finalBlockId") == entry.block.id &&
                        process != null && process !== out.getOrNull(index - 1)) add(ConversationItem.Summary(turn))
                }
                is ConversationItem.Summary -> error("Summary is added after projecting timeline blocks")
            }
            add(entry)
        }
    }
}

private val replyTailKinds = setOf("assistant_text", "thinking", "tool_call", "user_append")
private val processKinds = replyTailKinds + setOf("assistant_note", "notice")
private val visibleNotices = setOf("workflow.plan", "task.updated", "run.failed")

/** A tool run ends at every non-tool block. Never collect across a commentary or interaction. */
internal fun toolClusters(blocks: List<MobileTimelineBlock>): List<List<MobileTimelineBlock>> = buildList {
    var index = 0
    while (index < blocks.size) {
        val start = index++
        if (blocks[start].isToolStep) {
            while (index < blocks.size && blocks[index].isToolStep) index++
        }
        add(blocks.subList(start, index))
    }
}
