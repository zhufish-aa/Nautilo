package app.nautilo.mobile

import app.nautilo.mobile.data.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ConversationTimelineTest {
    private fun block(seq: Int, kind: String, run: String, text: String, sealed: Boolean = true) =
        json("seq" to seq, "blockId" to "b$seq", "kind" to kind, "runId" to run, "sealed" to sealed,
            "content" to json("text" to text), "status" to JSONObject.NULL, "result" to JSONObject.NULL)

    private fun turn(run: String, status: String, final: String? = null) =
        json("runId" to run, "status" to status, "finalBlockId" to (final ?: JSONObject.NULL), "durationMs" to 3400)

    private fun created(block: JSONObject) = json("type" to "block_created", "block" to block)

    private fun page(revision: Int, operations: List<JSONObject>, turn: JSONObject? = null) =
        json("revision" to revision, "changes" to JSONArray(listOf(
            json("operations" to JSONArray(operations), "turn" to (turn ?: JSONObject.NULL)))))

    private fun snapshot(revision: Int, blocks: List<JSONObject>, turns: List<JSONObject>) =
        MobileTimeline.open(json("revision" to revision, "blocks" to JSONArray(blocks), "turns" to JSONArray(turns)))

    private fun visible(timeline: MobileTimeline) = conversationTimeline(timeline).map {
        when (it) {
            is ConversationItem.Block -> it.block.id
            is ConversationItem.Process -> it.turn.text("status") + ":" + it.blocks.joinToString(",") { block -> block.id }
            is ConversationItem.Summary -> it.key
        }
    }

    @Test fun steeringAndLateResultsKeepTheirSlotsWhileRunningAndAfterReopen() {
        val blocks = listOf(
            block(1, "user_prompt", "r1", "First"), block(2, "thinking", "r1", "Thought"),
            block(3, "tool_call", "r1", "Edit"), block(4, "user_append", "r1", "Steer"),
            block(5, "thinking", "r1", "New thought"), block(6, "assistant_text", "r1", "Interim"),
            block(7, "assistant_text", "r1", "Final"), block(8, "user_prompt", "r2", "Next"),
            block(9, "late_result", "r1", "Late edit"), block(10, "thinking", "r2", "Next thought", false),
        )
        val start = snapshot(0, emptyList(), emptyList()).apply(
            page(1, listOf(created(blocks[0]), created(block(2, "thinking", "r1", "Th", false))), turn("r1", "running"))
        )
        val running = start.apply(page(2, listOf(
            json("type" to "block_delta", "blockId" to "b2", "text" to "ought"),
            json("type" to "block_updated", "blockId" to "b2", "sealed" to true),
        ) + blocks.subList(2, 7).map(::created)))
        assertEquals(listOf("b1", "running:b2,b3,b4,b5,b6", "b7"), visible(running))
        assertThrows(IllegalArgumentException::class.java) {
            running.apply(page(3, listOf(json("type" to "block_delta", "blockId" to "b2", "text" to "again"))))
        }
        val done = turn("r1", "completed", "b7")
        val next = turn("r2", "running")
        val live = running.apply(page(3, emptyList(), done)).apply(page(4, blocks.drop(7).map(::created), next))
        val reopened = snapshot(4, blocks, listOf(done, next))
        assertEquals(reopened.blocks.map { it.value.toString() }, live.blocks.map { it.value.toString() })
        assertEquals(visible(reopened), visible(live))
        assertEquals(listOf("b1", "summary:r1", "completed:b2,b3,b4,b5,b6", "b7", "b8", "b9", "running:b10"), visible(live))
    }

    @Test fun answeredInteractionUpdatesInPlaceAndKeepsItsResult() {
        val initial = snapshot(1, listOf(
            block(1, "thinking", "r", "Before"), block(2, "interaction", "r", "Question"),
            block(3, "tool_call", "r", "After")
        ), listOf(turn("r", "completed")))
        val resolved = initial.apply(page(2, listOf(
            json("type" to "block_updated", "blockId" to "b2", "status" to "resolved", "result" to json("text" to "Answer"))
        )))
        assertEquals(listOf("completed:b1", "b2", "summary:r", "completed:b3"), visible(resolved))
        assertEquals("Answer", resolved.blocks[1].result?.text("text"))
    }

    @Test fun directReplyHasNoProcessSummaryLiveOrAfterReopen() {
        val blocks = listOf(block(1, "user_prompt", "r", "Hello"), block(2, "assistant_text", "r", "Hello!"))
        val done = turn("r", "completed", "b2")
        val live = snapshot(1, blocks, listOf(turn("r", "running"))).apply(page(2, emptyList(), done))
        val reopened = snapshot(2, blocks, listOf(done))
        assertEquals(listOf("b1", "b2"), visible(live))
        assertEquals(visible(reopened), visible(live))
    }

    @Test fun toolClustersKeepCommentaryAndSeparateApprovalsInOrder() {
        val blocks = listOf(
            block(1, "tool_call", "r", "first"),
            block(2, "tool_call", "r", "second"),
            block(3, "assistant_note", "r", "commentary"),
            block(4, "tool_call", "r", "third"),
            block(5, "approval", "r", "approve"),
            block(6, "tool_call", "r", "fourth"),
            block(7, "assistant_text", "r", "answer"),
        )
        val initial = snapshot(1, blocks, listOf(turn("r", "running")))
        val process = conversationTimeline(initial).filterIsInstance<ConversationItem.Process>()
        assertEquals(listOf("b1,b2", "b3", "b4"), toolClusters(process.first().blocks).map { group -> group.joinToString(",") { it.id } })
        assertEquals(listOf("running:b1,b2,b3,b4", "b5", "running:b6", "b7"), visible(initial))
        val cancelled = snapshot(2, blocks, listOf(turn("r", "cancelled", "b7")))
        assertEquals(listOf("cancelled:b1,b2,b3,b4", "b5", "summary:r", "cancelled:b6", "b7"), visible(cancelled))
    }

    @Test fun summariesCountActualFilesCommandsAndMcpServices() {
        fun step(seq: Int, name: String, input: JSONObject = JSONObject(), status: String = "done") =
            MobileTimelineBlock(block(seq, "tool_call", "r", "")
                .put("status", status)
                .put("content", json("type" to "tool.finished", "payload" to json("toolName" to name, "inputSummary" to input.toString()))))
        val read = step(1, "read", json("filePath" to "src/a.kt"))
        val edit = step(2, "edit_file", json("path" to "src/b.kt"))
        val create = step(3, "create_file", json("path" to "src/c.kt"))
        val command = step(4, "Bash", json("command" to "test"), "failed")
        assertEquals("读取 1 个文件 · 编辑 1 个文件 · 创建 1 个文件", formatToolClusterSummary(listOf(edit, read, read, create)).label)
        val mixed = formatToolClusterSummary(listOf(read, edit, create, command, step(5, "web_search")))
        assertEquals("读取 1 个文件 · 编辑 1 个文件 · 等 3 项操作", mixed.label)
        assertEquals(1, mixed.failed)
        val playwright = step(6, "Playwright/browser_snapshot")
        val github = step(7, "mcp__GitHub__list_issues")
        assertTrue(formatToolClusterSummary(listOf(playwright)).standalone)
        assertEquals("调用了 Playwright · 2 次", formatToolClusterSummary(listOf(playwright, playwright)).label)
        assertEquals("调用了 Playwright (2) · GitHub (1)", formatToolClusterSummary(listOf(playwright, playwright, github)).label)
        assertEquals("调用了 3 个 MCP 服务 · 3 次", formatToolClusterSummary(listOf(playwright, github, step(8, "Notes/list"))).label)
        assertEquals("搜索网页 · Nautilo", toolActivityLabel("web_search", "done", "Nautilo"))
    }
}
