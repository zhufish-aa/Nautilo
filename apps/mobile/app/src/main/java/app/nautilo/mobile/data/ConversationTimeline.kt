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
    data class Turn(val turn: JSONObject, val blocks: MutableList<MobileTimelineBlock>) : ConversationItem {
        override val key get() = "process:" + (blocks.firstOrNull()?.id ?: turn.getString("finalBlockId"))
    }
}

fun conversationTimeline(timeline: MobileTimeline): List<ConversationItem> {
    val out = mutableListOf<ConversationItem>()
    val turnsWithProcess = mutableSetOf<String>()
    var group: ConversationItem.Turn? = null
    for (block in timeline.blocks) {
        val turn = timeline.turns[block.runId]
        val foldable = turn != null && block.id != turn.text("finalBlockId")
            && block.kind !in setOf("user_prompt", "interaction", "approval", "late_result", "legacy")
        if (!foldable) {
            group = null
            out += ConversationItem.Block(block)
        } else {
            val adjacent = group?.takeIf { it.turn === turn }
                ?: ConversationItem.Turn(turn, mutableListOf()).also {
                    group = it
                    out += it
                    turnsWithProcess += block.runId
                }
            adjacent.blocks += block
        }
    }
    return out.flatMap { entry ->
        val block = (entry as? ConversationItem.Block)?.block
        val turn = block?.let { timeline.turns[it.runId] }
        if (block != null && turn != null && turn.text("finalBlockId") == block.id && block.runId !in turnsWithProcess)
            listOf(ConversationItem.Turn(turn, mutableListOf()), entry)
        else listOf(entry)
    }
}
