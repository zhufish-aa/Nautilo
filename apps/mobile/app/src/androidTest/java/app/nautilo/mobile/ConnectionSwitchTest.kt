package app.nautilo.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.nautilo.mobile.data.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Opt-in: switches only a disposable session, without starting or charging a model turn. */
@RunWith(AndroidJUnit4::class)
class ConnectionSwitchTest {
    @Test fun switchLoginToApiAndBackWithoutChangingSession() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val root = args.getString("projectRoot") ?: error("Provide a disposable projectRoot")
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as NautiloApplication
        val host = app.store.selectedHost() ?: error("Pair Android first")
        val options = app.peer.call(host, "session.options")
        val login = options.objects("connections").first { it.text("kind") == "login" && it.text("harness") == "codex" }
        val api = options.objects("connections").first { it.text("kind") == "api" }
        val agent = options.objects("agents").first { it.text("providerId") == "deepseek" }
        val project = app.peer.call(host, "project.create", json("rootPath" to root, "folderName" to "switch-" + UUID.randomUUID().toString().take(8), "name" to "Android 账号切换验证"))
        println("Switch test project " + project.text("id"))
        val catalog = app.peer.call(host, "session.catalog", json("agentInstanceId" to agent.text("id"), "connectionId" to login.text("id")))
        val originalModel = catalog.objects("models").first()
        val created = app.peer.call(host, "session.create", json("projectId" to project.text("id"), "agentInstanceId" to agent.text("id"), "connectionId" to login.text("id"), "model" to originalModel.text("id"), "title" to "账号切换验证"))
        val id = created.text("id")
        fun detailsInput() = json("sessionId" to id)
        val apiModel = app.peer.call(host, "session.catalog", json("agentInstanceId" to agent.text("id"), "connectionId" to api.text("id"))).objects("models").first()
        val change = json("sessionId" to id, "connectionId" to api.text("id"), "model" to apiModel.text("id"), "reasoningEffort" to apiModel.text("defaultReasoningEffort"))
        try { app.peer.call(host, "session.configure", change); fail("An unacknowledged identity change must be rejected") }
        catch (error: RemoteFailure) { assertEquals("CONNECTION_CHANGE_REQUIRES_CONFIRMATION", error.code) }
        assertEquals(login.text("id"), app.peer.call(host, "session.details", detailsInput()).getJSONObject("session").text("connectionId"))
        change.put("confirmConnectionChange", true)
        app.peer.call(host, "session.configure", change)
        var saved = app.peer.call(host, "session.details", detailsInput()).getJSONObject("session")
        assertEquals(id, saved.text("id")); assertEquals(api.text("id"), saved.text("connectionId"))
        assertTrue(saved.optInt("connectionRevision") > 0)
        app.peer.call(host, "session.configure", json("sessionId" to id, "connectionId" to login.text("id"), "model" to originalModel.text("id"), "reasoningEffort" to originalModel.text("defaultReasoningEffort"), "confirmConnectionChange" to true))
        saved = app.peer.call(host, "session.details", detailsInput()).getJSONObject("session")
        assertEquals(login.text("id"), saved.text("connectionId")); assertEquals(id, saved.text("id"))
        assertEquals(0, app.peer.call(host, "run.list", detailsInput()).objects("items").size)
        println("Login -> API -> login saved and read back on the same native desktop session")
    }
}
