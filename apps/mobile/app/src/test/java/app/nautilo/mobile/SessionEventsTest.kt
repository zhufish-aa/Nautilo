package app.nautilo.mobile

import app.nautilo.mobile.data.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SessionEventsTest {
    private fun event(sequence: Int, type: String, payload: JSONObject) = json("eventId" to "event-$sequence", "sequence" to sequence, "type" to type, "runId" to "run", "timestamp" to "2026-11-14T01:00:00Z", "payload" to payload)

    @Test fun nativePayloadAndCumulativeUsageSurviveProjection() {
        val projection = SessionProjection()
        projection.apply(event(1, "tool.started", json("callId" to "edit", "toolName" to "edit_file", "inputSummary" to "edit main.rs", "fileDiff" to json("path" to "main.rs", "before" to "old", "after" to "new"))))
        projection.apply(event(2, "tool.finished", json("callId" to "edit", "toolName" to "edit_file", "success" to false, "outputSummary" to "permission denied")))
        projection.apply(event(3, "usage.updated", json("inputTokens" to 100, "usageScope" to "turn")))
        projection.apply(event(4, "usage.updated", json("inputTokens" to 140, "usageScope" to "turn")))
        val items = projection.activityList()
        val edit = items.single { it.kind == "tool" }
        assertEquals("old", edit.payload.getJSONObject("fileDiff").text("before"))
        assertEquals(false, edit.payload.getBoolean("success"))
        assertFalse(edit.running)
        assertEquals(140, items.single { it.kind == "usage" }.payload.optInt("inputTokens"))
    }

    @Test fun questionResponseAndLifecycleCardsDoNotVanish() {
        val projection = SessionProjection()
        projection.apply(event(1, "interaction.requested", json("interaction" to json("id" to "q", "title" to "选择", "status" to "pending"))))
        projection.apply(event(2, "interaction.resolved", json("interaction" to json("id" to "q", "title" to "选择", "status" to "cancelled"))))
        projection.apply(event(3, "planner.decision", json("mode" to "plan", "rationale" to "先验证再修改")))
        projection.apply(event(4, "session.checkpoint_reverted", json("checkpointId" to "c", "restored" to JSONArray().put("main.rs"))))
        assertEquals(1, projection.activityList().count { it.kind == "interaction" })
        assertEquals("cancelled", projection.activityList().first { it.kind == "interaction" }.payload.getJSONObject("interaction").text("status"))
        assertTrue(projection.activityList().any { it.kind == "plan" && it.detail == "先验证再修改" })
        assertTrue(projection.activityList().any { it.kind == "checkpoint" })
    }

    @Test fun partialCodeUpdatesRetainEarlierCallsAndTheirInputs() {
        val projection = SessionProjection()
        projection.apply(event(1, "tool.started", json("callId" to "code", "toolName" to "code", "codeExecution" to json("calls" to JSONArray().put(json("callId" to "a", "name" to "pwsh", "input" to "Get-ChildItem", "status" to "running"))))))
        projection.apply(event(2, "tool.updated", json("callId" to "code", "toolName" to "code", "codeExecution" to json("partial" to true, "calls" to JSONArray().put(json("callId" to "a", "output" to "main.rs", "status" to "done")).put(json("callId" to "b", "name" to "read", "status" to "running"))))))
        val calls = projection.activityList().single().payload.getJSONObject("codeExecution").objects("calls")
        assertEquals(2, calls.size)
        assertEquals("Get-ChildItem", calls.first { it.text("callId") == "a" }.text("input"))
        assertEquals("main.rs", calls.first { it.text("callId") == "a" }.text("output"))
    }

    @Test fun answeredQuestionsRemainReadOnlyAndReplaysCannotResurrectThem() {
        val answered = json("id" to "q", "kind" to "question", "status" to "resolved")
        val replay = json("id" to "q", "kind" to "question", "status" to "pending")
        val approval = json("id" to "a", "kind" to "approval", "status" to "resolved")
        val visible = mergeInteractions(listOf(answered), listOf(replay, approval), emptyList())
        assertEquals(listOf("q"), visible.map { it.text("id") })
        assertEquals("resolved", visible.single().text("status"))
    }

    @Test fun nativeSubagentMessagesAndToolsStayInsideTheirDispatchLikePc() {
        val projection = SessionProjection()
        projection.apply(event(1, "tool.started", json("callId" to "dispatch", "toolName" to "spawn_agent", "subagent" to json("agentType" to "研究", "task" to "检查代码", "status" to "running"))))
        projection.apply(event(2, "agent.message_delta", json("messageId" to "child", "text" to "正在检查", "subagentDispatchId" to "dispatch")))
        projection.apply(event(3, "tool.started", json("callId" to "child-tool", "toolName" to "read_file", "subagentDispatchId" to "dispatch")))
        assertTrue(projection.messageList().isEmpty())
        val parent = projection.activityList().single()
        val children = parent.payload.getJSONObject("subagent").objects("activities")
        assertEquals(listOf("message", "tool"), children.map { it.text("kind") })
        assertEquals("正在检查", children.first().text("text"))
        projection.apply(event(4, "tool.finished", json("callId" to "dispatch", "toolName" to "spawn_agent", "success" to true)))
        assertEquals(2, projection.activityList().single().payload.getJSONObject("subagent").objects("activities").size)
    }

    @Test fun approvalResolutionKeepsRequestContextAndDoesNotDuplicateThePendingCard() {
        val projection = SessionProjection()
        projection.apply(event(1, "approval.requested", json("approvalId" to "a", "summary" to "运行 git status", "category" to "command")))
        assertTrue(conversationTimeline(emptyList(), projection.activityList(), emptyList()).isEmpty())
        projection.apply(event(2, "approval.resolved", json("approvalId" to "a", "decision" to "approved", "scope" to "project")))
        val turn = conversationTimeline(emptyList(), projection.activityList(), emptyList()).single() as ConversationItem.Turn
        assertEquals(1, turn.parts.size)
        assertEquals("运行 git status", turn.parts.single().activity!!.detail)
        assertEquals(1L, turn.parts.single().sequence)
        assertTrue(turn.parts.single().alwaysVisible)
    }
}
