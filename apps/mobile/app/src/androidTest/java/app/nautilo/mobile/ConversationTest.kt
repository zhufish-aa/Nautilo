package app.nautilo.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.nautilo.mobile.data.*
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Opt-in live smoke: the runner supplies a disposable root and an existing account. */
@RunWith(AndroidJUnit4::class)
class ConversationTest {
    @Test fun createProjectCreateSessionAndStreamNativeReply() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val root = args.getString("projectRoot") ?: error("Provide a disposable projectRoot")
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as NautiloApplication
        val host = app.store.selectedHost() ?: error("Pair the Android client before this smoke test")
        val folder = "android-" + UUID.randomUUID().toString().take(8)
        val project = app.peer.call(host, "project.create", json("rootPath" to root, "folderName" to folder, "name" to "Android 连接验证"))
        println("Created project " + project.text("id"))
        assertTrue(app.peer.call(host, "projects.list").objects("projects").any { it.text("id") == project.text("id") })
        val input = json("projectId" to project.text("id"), "agentInstanceId" to args.getString("agentId", "harness-deepseek"),
            "connectionId" to args.getString("connectionId"), "model" to args.getString("model", "gpt-6.1-sol"), "title" to "Android 流式验证")
        val session = app.peer.call(host, "session.create", input)
        val sessionId = session.text("id")
        println("Created session " + sessionId)
        val history = app.peer.call(host, "session.history", json("sessionId" to sessionId))
        val projection = SessionProjection().apply { history(history, initialize = true) }
        val params = json("sessionId" to sessionId, "text" to "请用数字 1 到 10 各写一行，每行一句简短的话介绍鹦鹉螺，不调用工具。")
        val requestId = UUID.randomUUID().toString()
        val receipt = app.peer.call(host, "session.send", params, requestId)
        assertEquals(receipt.text("messageId"), PendingCommand.stableMessageId(app.peer.identity(), requestId))
        var streamed = false
        var completed = false
        withTimeout(120_000) {
            while (!completed) {
                // Only acknowledge the native first-use prompt for this disposable
                // directory. Other questions and approvals remain user interactions.
                val questions = app.peer.call(host, "interaction.list", json("sessionId" to sessionId)).objects("items")
                questions.filter { q -> q.objects("options").any { it.text("id") == "authorize-workspace" } }.forEach { q ->
                    app.peer.call(host, "interaction.respond", json("sessionId" to sessionId, "interactionId" to q.text("id"), "outcome" to "selected", "optionId" to "authorize-workspace"))
                }
                val page = app.peer.call(host, "events.wait", json("sessionId" to sessionId, "epoch" to projection.epoch, "afterSequence" to projection.sequence))
                for (event in page.objects("events")) {
                    projection.apply(event)
                    if (event.text("type") == "agent.message_delta" && projection.messageList().any { it.sender == "agent" && it.text.isNotBlank() }) streamed = true
                    if (event.text("type") == "run.failed") error("Native run failed: " + event.optJSONObject("payload")?.text("message"))
                    if (event.text("type") == "run.completed") completed = true
                }
            }
        }
        assertTrue("A text delta must reach Android before completion", streamed)
        projection.history(app.peer.call(host, "session.history", json("sessionId" to sessionId)))
        assertTrue(projection.messageList().any { it.sender == "agent" && it.text.isNotBlank() })
        app.peer.disconnect()
        assertEquals(1, app.peer.call(host, "hello").optInt("protocol"))
        assertTrue(app.peer.call(host, "session.history", json("sessionId" to sessionId)).objects("items").isNotEmpty())
        println("Native reply streamed to Android and survived reconnect")
    }
}
