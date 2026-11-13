package app.nautilo.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.nautilo.mobile.data.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConnectionTest {
    @Test fun nativeEndpointPairsAndReconnectsToDesktop() = runBlocking {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as NautiloApplication
        val peerId = withTimeout(25_000) { app.peer.identity() }
        assertTrue(peerId.matches(Regex("[0-9a-f]{64}")))
        val uri = InstrumentationRegistry.getArguments().getString("invitation") ?: return@runBlocking
        val invite = PairingInvitation.parse(uri)
        val paired = app.peer.call(invite.host, "pair", json("name" to "Android 验证设备", "token" to invite.token))
        assertEquals(invite.verificationCode(peerId), paired.text("code"))
        withTimeout(90_000) {
            while (app.peer.call(invite.host, "pair.status").text("state") != "paired") delay(500)
        }
        val hello = app.peer.call(invite.host, "hello")
        assertEquals("control", hello.getJSONObject("device").text("access"))
        val projects = app.peer.call(invite.host, "projects.list").objects("projects")
        assertTrue(app.peer.call(invite.host, "session.options").has("agents"))
        assertTrue(app.peer.call(invite.host, "project.browse").has("directories"))
        projects.firstOrNull()?.let { project ->
            val sessions = app.peer.call(invite.host, "sessions.list", json("projectId" to project.text("id"))).objects("sessions")
            sessions.firstOrNull()?.let { session ->
                val id = session.text("id")
                val history = app.peer.call(invite.host, "session.history", json("sessionId" to id))
                assertTrue(history.has("sequence") && history.has("epoch"))
                assertTrue(app.peer.call(invite.host, "session.details", json("sessionId" to id)).has("session"))
                assertTrue(app.peer.call(invite.host, "session.workspace", json("sessionId" to id)).has("files"))
            }
        }
        app.store.putHost(invite.host)
        app.peer.disconnect()
        assertEquals(1, app.peer.call(invite.host, "hello").optInt("protocol"))
    }
}
