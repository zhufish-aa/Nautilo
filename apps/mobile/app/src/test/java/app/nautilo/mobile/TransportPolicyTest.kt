package app.nautilo.mobile

import app.nautilo.mobile.data.*
import app.nautilo.mobile.transport.TransportPolicy
import org.junit.Assert.*
import org.junit.Test

class TransportPolicyTest {
    private val id = "a".repeat(64)
    private val nonce = "b".repeat(32)
    private fun reply(mode: String = "direct", direct: Boolean = true) = json("type" to "nautilo.transport", "v" to 1,
        "nonce" to nonce, "relayMode" to mode, "directOnly" to direct, "endpoint" to json("id" to id))
    @Test fun authenticatedPolicyCanRequireDirectAcrossNetworks() {
        val policy = TransportPolicy.decode(reply().toString().toByteArray(), nonce, id)
        assertTrue(policy.directOnly)
        assertEquals("direct", policy.relayMode)
        assertTrue(policy.failureHint().contains("未使用中继"))
    }
    @Test fun mismatchedIdentityReplayAndContradictoryPolicyFailClosed() {
        for ((packet, expectedNonce, expectedId) in listOf(
            Triple(reply(), "c".repeat(32), id), Triple(reply(), nonce, "c".repeat(64)),
            Triple(reply("direct", false), nonce, id), Triple(reply("automatic", true), nonce, id),
            Triple(reply("unknown", false), nonce, id)
        )) assertTrue(runCatching { TransportPolicy.decode(packet.toString().toByteArray(), expectedNonce, expectedId) }.isFailure)
    }
    @Test fun transportFailuresKeepOutboxCommandsRetryable() {
        assertTrue(RemoteFailure("DIRECT_CONNECTION_UNAVAILABLE", "failed").isTransportFailure())
        assertTrue(RemoteFailure("DIRECT_PATH_LOST", "lost").isTransportFailure())
        assertTrue(RemoteFailure("REMOTE_RESPONSE_TIMEOUT", "unknown outcome").isTransportFailure())
        assertFalse(RemoteFailure("MODEL_NOT_AVAILABLE", "choose another model").isTransportFailure())
    }
    @Test fun absentProbeFieldsDoNotBlameTheComputersUdpConnectivity() {
        fun policy(network: org.json.JSONObject) = TransportPolicy(true, "direct", json("id" to id), network)
        assertFalse(policy(json()).failureHint().contains("本轮未获得电脑"))
        assertFalse(policy(json("udpV4" to true, "udpV6" to false)).failureHint().contains("本轮未获得电脑"))
        assertTrue(policy(json("udpV4" to false, "udpV6" to false)).failureHint().contains("可能是探测失败或网络限制"))
    }
    @Test fun harnessAndRequestFailuresDoNotPretendTheComputerDisconnected() {
        for (code in listOf("IPC_INVALID_REQUEST", "PLUGIN_BAD_RESPONSE", "RUN_START_FAILED")) {
            val failure = RemoteFailure(code, "Enable the selected account gateway")
            assertFalse(failure.isConnectionFailure())
            assertFalse(readableError(failure).contains("重新连接"))
            assertTrue(readableError(failure).contains("gateway"))
        }
        assertFalse(RemoteFailure("REMOTE_RESPONSE_TIMEOUT", "still waiting").isConnectionFailure())
        assertTrue(RemoteFailure("DIRECT_PATH_LOST", "lost").isConnectionFailure())
        assertTrue(RemoteFailure("DEVICE_NOT_AUTHORIZED", "revoked").isConnectionFailure())
    }
}
