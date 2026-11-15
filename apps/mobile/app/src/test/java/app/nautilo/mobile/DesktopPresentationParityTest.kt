package app.nautilo.mobile

import app.nautilo.mobile.data.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Expected values come from running the desktop TypeScript, not this port. */
class DesktopPresentationParityTest {
    private val fixture = JSONObject(javaClass.getResource("/desktop-process-fixtures.json")!!.readText())
    @Test fun toolKindsLabelsAndInferredDiffsMatchPc() = fixture.objects("tools").forEach { case ->
        val input = case.text("input")
        val name = case.text("name")
        assertEquals(name, case.text("kind"), toolActivityKind(name, input))
        assertEquals(name, case.text("label"), toolActivityLabel(name, case.text("status"), input))
        val expected = case.optJSONObject("diff")
        val actual = toolInputFileDiff(name, input)
        assertEquals(name, expected == null, actual == null)
        if (expected != null && actual != null) listOf("operation", "path", "before", "after", "truncated").forEach { assertEquals("$name.$it", expected.text(it), actual.text(it)) }
    }
    @Test fun codeProgramsAndPartialInputsMatchPc() = fixture.objects("programs").forEach { case ->
        val expected = case.getJSONObject("expected")
        val actual = codeExecutionInput(case.text("input"))
        assertEquals(expected.text("code"), actual.code)
        assertEquals(expected.text("description"), actual.description.orEmpty())
        assertEquals(expected.optBoolean("truncated"), actual.truncated)
    }
    @Test fun reasoningPreviewsMatchPc() = fixture.objects("previews").forEach { case ->
        assertEquals(case.text("expected"), reasoningPreview(case.text("text"), case.optBoolean("streaming")))
    }
    @Test fun backgroundReceiptsAndCancellationArePresentedLikePc() = fixture.objects("outputs").forEach { case ->
        val expected = case.getJSONObject("expected")
        val actual = toolOutput(case.text("input"))
        assertEquals(expected.text("status"), actual.status.orEmpty())
        assertEquals(expected.text("text"), actual.text)
        val fields = expected.getJSONArray("fields")
        assertEquals(fields.length(), actual.fields.size)
        actual.fields.forEach { (label, text) -> assertTrue("Missing PC field $label", (0 until fields.length()).any { fields.getJSONArray(it).getString(0) == label && fields.getJSONArray(it).getString(1) == text }) }
    }
    @Test fun nestedAndCyclicCallsStayVisibleInPcOrder() = fixture.objects("trees").forEach { case ->
        fun rows(nodes: List<JSONObject>): List<String> = nodes.flatMap { listOf(it.getJSONObject("call").text("callId")) + rows(it.objects("children")) }
        fun actual(nodes: List<ToolCallBranch>): List<String> = nodes.flatMap { listOf(it.call.text("callId")) + actual(it.children) }
        assertEquals(rows(case.objects("expected")), actual(toolCallTree(case.objects("calls"))))
    }
    @Test fun chronologicalSlotsAndCollapsedRowsMatchPc() = fixture.objects("scenarios").forEach { case ->
        val events = case.objects("events")
        val messages = events.filter { it.getJSONObject("data").text("kind") == "message" }.map { e ->
            ChatMessage(e.text("id"), "agent", e.getJSONObject("data").text("text"), e.text("timestamp"), runId = "r", sequence = e.getLong("sequence"))
        }
        val activities = events.filter { it.getJSONObject("data").text("kind") != "message" }.map { e ->
            val kind = when (e.getJSONObject("data").text("kind")) { "tool_activity" -> "tool"; "activity" -> "status"; else -> e.getJSONObject("data").text("kind") }
            ActivityItem(e.text("id"), kind, e.text("id"), time = e.text("timestamp"), runId = "r", sequence = e.getLong("sequence"))
        }
        val turn = conversationTimeline(messages, activities, listOf(RunInfo("r", if (case.optBoolean("active")) "running" else "completed", "2026-11-14T00:00:00Z", ""))).single() as ConversationItem.Turn
        val expected = case.getJSONObject("expected")
        assertEquals(case.text("name"), expected.strings("order"), turn.parts.map { it.message?.id ?: it.activity!!.id })
        assertEquals(case.text("name"), expected.text("result"), turn.answer?.id.orEmpty())
        assertEquals(expected.optBoolean("completed"), turn.completed)
        assertEquals(case.text("name"), expected.strings("collapsed"), turn.parts.filter { it.visible(false, turn.answer) }.map { it.message?.id ?: it.activity!!.id })
    }
}
