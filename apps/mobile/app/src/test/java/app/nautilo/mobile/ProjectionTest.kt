package app.nautilo.mobile

import app.nautilo.mobile.data.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class ProjectionTest {
    @Test fun pairingRejectsExpiredLinksAndPinsComputerIdentity() {
        val payload = json("v" to 1, "transport" to "iroh", "alpn" to "nautilo/remote/1", "name" to "我的电脑", "endpoint" to json("id" to "ab".repeat(32)), "token" to "safe-token".repeat(5), "expiresAt" to 2000)
        fun uri() = "nautilo://pair#" + Base64.getUrlEncoder().withoutPadding().encodeToString(payload.toString().toByteArray())
        val invite = PairingInvitation.parse(uri(), 1000)
        assertEquals("ab".repeat(32), invite.host.id)
        assertTrue(invite.verificationCode("cd".repeat(32)).matches(Regex("[0-9]{6}")))
        assertThrows(IllegalArgumentException::class.java) { PairingInvitation.parse(uri(), 3000) }
        payload.put("alpn", "nautilo/remote/2")
        assertEquals("ab".repeat(32), PairingInvitation.parse(uri(), 1000).host.id)
        payload.put("alpn", "other")
        assertThrows(IllegalArgumentException::class.java) { PairingInvitation.parse(uri(), 1000) }
    }
    @Test fun messageIdentityIsStableAndDeviceNamespaced() {
        val first = PendingCommand.stableMessageId("peer-one", "request")
        assertEquals(first, PendingCommand.stableMessageId("peer-one", "request"))
        assertNotEquals(first, PendingCommand.stableMessageId("peer-two", "request"))
        assertEquals("fallback", JSONObject().text("absent", "fallback"))
    }
}
