package app.nautilo.mobile.transport

import app.nautilo.mobile.data.*
import org.json.JSONObject

internal data class TransportPolicy(val directOnly: Boolean, val relayMode: String, val endpoint: JSONObject, val network: JSONObject?) {
    companion object {
        fun decode(packet: ByteArray, nonce: String, hostId: String): TransportPolicy {
            require(packet.size <= 1100) { "连接策略响应过大" }
            val value = JSONObject(String(packet, Charsets.UTF_8))
            require(value.text("type") == "nautilo.transport" && value.optInt("v") == 1 && value.text("nonce") == nonce) { "连接策略响应无效" }
            val mode = value.text("relayMode")
            require(mode in setOf("direct", "automatic", "custom", "lan") && value.opt("directOnly") is Boolean && value.optBoolean("directOnly") == (mode == "direct")) { "连接策略不一致" }
            val endpoint = value.getJSONObject("endpoint")
            require(endpoint.text("id") == hostId) { "电脑身份验证失败" }
            return TransportPolicy(value.optBoolean("directOnly"), mode, endpoint, value.optJSONObject("network"))
        }
    }
    fun failureHint(): String = if (network?.opt("udpV4") == false && network.opt("udpV6") == false)
        "跨网打洞未成功。本轮未获得电脑的 UDP 公网地址，可能是探测失败或网络限制；业务数据未通过中继传输。"
    else "跨网打洞未成功，当前两端未建立可用的 UDP 直连；本次未使用中继传输业务数据。"
}
