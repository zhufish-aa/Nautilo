package app.nautilo.mobile.data

import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID

fun JSONObject.text(key: String, fallback: String = ""): String = if (isNull(key)) fallback else optString(key, fallback)
fun JSONObject.objects(key: String): List<JSONObject> = (optJSONArray(key) ?: JSONArray()).let { array ->
    (0 until array.length()).mapNotNull { array.optJSONObject(it) }
}
fun JSONObject.strings(key: String): List<String> = (optJSONArray(key) ?: JSONArray()).let { array ->
    (0 until array.length()).map { array.optString(it) }
}
fun json(vararg pairs: Pair<String, Any?>): JSONObject = JSONObject().apply {
    pairs.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) }
}

data class Host(val id: String, val name: String, val endpoint: JSONObject, val pairedAt: Long = System.currentTimeMillis()) {
    fun encode() = json("id" to id, "name" to name, "endpoint" to endpoint, "pairedAt" to pairedAt)
    companion object {
        fun decode(value: JSONObject) = Host(value.getString("id"), value.getString("name"), value.getJSONObject("endpoint"), value.optLong("pairedAt"))
    }
}

data class PairingInvitation(val host: Host, val token: String, val expiresAt: Long) {
    fun verificationCode(phoneId: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("$phoneId:$token".toByteArray())
        val number = ByteBuffer.wrap(digest).int.toLong() and 0xffffffffL
        return (number % 1_000_000).toString().padStart(6, '0')
    }
    companion object {
        fun parse(uri: String, now: Long = System.currentTimeMillis()): PairingInvitation {
            require(uri.length <= 16_384 && uri.startsWith("nautilo://pair#")) { "请扫描 Nautilo 电脑端的配对二维码" }
            val value = JSONObject(String(Base64.getUrlDecoder().decode(uri.substringAfter('#')), Charsets.UTF_8))
            require(value.getInt("v") == 1 && value.getString("transport") == "iroh" && value.getString("alpn") in setOf("nautilo/remote/1", "nautilo/remote/2")) { "配对协议版本不受支持" }
            val endpoint = value.getJSONObject("endpoint")
            val id = endpoint.getString("id")
            require(id.matches(Regex("[0-9a-f]{64}"))) { "设备身份无效" }
            val expiry = value.getLong("expiresAt")
            require(expiry > now) { "二维码已过期，请在电脑上重新生成" }
            val token = value.getString("token")
            require(token.length in 32..128) { "配对凭据无效" }
            return PairingInvitation(Host(id, value.text("name", "我的电脑"), endpoint), token, expiry)
        }
    }
}

data class Project(val id: String, val name: String, val root: String = "")
data class Conversation(
    val id: String, val projectId: String, val title: String, val status: String,
    val updatedAt: String, val model: String = "", val effort: String = "", val provider: String = "", val agentId: String = "", val connectionId: String = "",
    val permissionMode: String = "", val agentMode: String = "", val modeLocked: Boolean = false,
    val teamId: String = "", val teamName: String = "", val parentSessionId: String = ""
) {
    companion object {
        fun decode(v: JSONObject) = Conversation(v.getString("id"), v.text("projectId"), v.text("title", "新会话"), v.text("status"),
            v.text("lastMessageAt", v.text("createdAt")), v.text("model"), v.text("reasoningEffort"), v.text("providerName"), v.text("agentInstanceId"), v.text("connectionId"), v.text("permissionMode"), v.text("agentMode"), v.optBoolean("modeLocked"), v.text("teamId"), v.text("teamName"), v.text("parentSessionId"))
    }
}
data class ChatMessage(val id: String, val sender: String, val text: String, val time: String, val delivery: String = "sent", val runId: String = "", val sequence: Long = 0, val attachmentNames: List<String> = emptyList(), val viewId: String = id, val attachments: List<ChatAttachment> = emptyList(), val kind: String = "chat", val taskId: String = "")
fun running(status: String) = status.isNotBlank() && status !in listOf("completed", "failed", "cancelled", "crashed", "timed_out", "idle")
data class RunInfo(val id: String, val status: String, val startedAt: String, val endedAt: String) {
    companion object {
        fun decode(value: JSONObject) = RunInfo(value.text("id"), value.text("status"), value.text("startedAt"), value.text("endedAt"))
    }
    fun elapsedSeconds(): Long = runCatching {
        val end = endedAt.takeIf(String::isNotBlank)?.let(java.time.Instant::parse) ?: java.time.Instant.now()
        java.time.Duration.between(java.time.Instant.parse(startedAt), end).seconds.coerceAtLeast(0)
    }.getOrDefault(0)
}
data class ActivityItem(val id: String, val kind: String, val title: String, val detail: String = "", val running: Boolean = false, val time: String = "", val runId: String = "", val sequence: Long = 0,
    val eventType: String = "", val payload: JSONObject = JSONObject())
data class PendingCommand(val id: String, val hostId: String, val sessionId: String, val method: String, val params: JSONObject, val createdAt: String) {
    fun encode() = json("id" to id, "hostId" to hostId, "sessionId" to sessionId, "method" to method, "params" to params, "createdAt" to createdAt)
    companion object {
        fun decode(v: JSONObject) = PendingCommand(v.getString("id"), v.getString("hostId"), v.getString("sessionId"), v.getString("method"), v.getJSONObject("params"), v.getString("createdAt"))
        fun stableMessageId(peerId: String, requestId: String): String {
            val bytes = MessageDigest.getInstance("SHA-256").digest("nautilo-remote:$peerId:$requestId".toByteArray())
            val buffer = ByteBuffer.wrap(bytes)
            return UUID(buffer.long, buffer.long).toString()
        }
    }
}

class RemoteFailure(val code: String, message: String) : Exception(message)
fun RemoteFailure.isTransportFailure() = code in setOf("REMOTE_SYNC_TIMEOUT", "CONNECTION_HEALTH_TIMEOUT", "VPN_ROUTE_RESTRICTED", "DIRECT_NETWORK_UNAVAILABLE", "DIRECT_CONNECTION_UNAVAILABLE", "DIRECT_PATH_LOST", "PEER_CONNECTION_TIMEOUT", "TRANSPORT_POLICY_TIMEOUT", "TRANSPORT_START_TIMEOUT", "REMOTE_RESPONSE_TIMEOUT", "DESKTOP_TRANSPORT_UPDATE_REQUIRED", "MOBILE_TRANSPORT_UPDATE_REQUIRED")
fun Throwable.isConnectionFailure() = this !is RemoteFailure || (isTransportFailure() && code !in setOf("REMOTE_SYNC_TIMEOUT", "REMOTE_RESPONSE_TIMEOUT")) || code in setOf("DEVICE_NOT_AUTHORIZED", "REMOTE_DISABLED")
fun readableError(error: Throwable): String = when ((error as? RemoteFailure)?.code) {
    "VPN_ROUTE_RESTRICTED", "DIRECT_NETWORK_UNAVAILABLE", "DIRECT_CONNECTION_UNAVAILABLE", "DIRECT_PATH_LOST" -> error.message.orEmpty()
    "DESKTOP_TRANSPORT_UPDATE_REQUIRED" -> "请更新电脑端以启用跨网直连协议"
    "MOBILE_TRANSPORT_UPDATE_REQUIRED" -> "请安装支持跨网直连的新版手机端"
    "REMOTE_SYNC_TIMEOUT", "CONNECTION_HEALTH_TIMEOUT", "PEER_CONNECTION_TIMEOUT", "TRANSPORT_POLICY_TIMEOUT", "TRANSPORT_START_TIMEOUT", "REMOTE_RESPONSE_TIMEOUT" -> error.message.orEmpty()
    "DEVICE_NOT_AUTHORIZED" -> "这台手机的授权已失效，请重新配对"
    "INVITATION_EXPIRED", "PAIRING_EXPIRED" -> "配对已过期，请重新扫码"
    "REMOTE_DISABLED" -> "电脑端已关闭远程连接"
    "COMMAND_OUTCOME_PENDING" -> "电脑正在确认这条指令的结果，请先查看会话"
    "CURSOR_RESET_REQUIRED" -> "正在重新同步会话"
    "METHOD_NOT_ALLOWED" -> "电脑端暂不支持此操作，请更新电脑端"
    "DIRECTORY_NOT_AVAILABLE", "INVALID_DIRECTORY" -> "此目录无法访问，请选择电脑上存在的目录"
    "INVALID_FOLDER_NAME" -> "请输入有效的文件夹名称，不要包含路径或特殊字符"
    "DIRECTORY_ALREADY_EXISTS" -> "此文件夹已存在，可以直接将它添加为项目"
    "DIRECTORY_CREATE_FAILED" -> "电脑无法创建此文件夹，请选择其他目录"
    "CONNECTION_NOT_AVAILABLE", "HARNESS_NOT_AVAILABLE" -> "所选账号或 Harness 不可用，请检查电脑端配置"
    "CONNECTION_CHANGE_REQUIRES_CONFIRMATION" -> "请确认更换连接对当前会话上下文的影响"
    "MODEL_NOT_AVAILABLE" -> "此连接中没有所选模型，请刷新模型列表后重选"
    "COMPACT_NOT_AVAILABLE" -> "当前 Harness 未提供原生上下文压缩"
    "INVALID_REASONING_EFFORT" -> "所选模型不支持这个推理强度，请重新选择"
    "HARNESS_MODE_LOCKED" -> "原生会话已开始，切换 Harness 模式请新建会话"
    "INVALID_HARNESS_MODE", "INVALID_PERMISSION_MODE" -> "此 Harness 不支持这个模式，请刷新后重选"
    "INVALID_APPROVAL_SCOPE" -> "请选择有效的授权范围"
    "INVALID_TEAM", "TEAM_NOT_AVAILABLE" -> "所选团队已不存在，请刷新团队列表"
    "TEAM_HAS_NO_MEMBERS" -> "此团队没有已启用的成员，请在电脑端配置"
    "TEAM_RUN_NOT_AVAILABLE" -> "此会话尚未开始团队任务"
    "DESKTOP_DISK_FULL" -> "电脑磁盘空间不足，无法保存请求。请清理电脑磁盘后重试。"
    "ATTACHMENT_TOO_LARGE", "ATTACHMENT_CHUNK_TOO_LARGE" -> "附件过大，每个文件最多 20 MB"
    "ATTACHMENT_STORAGE_FULL" -> "电脑端附件存储空间不足，请清理后重试"
    "ATTACHMENTS_REQUIRE_IDLE" -> "请在当前轮结束后发送附件"
    "ATTACHMENT_NOT_AVAILABLE", "ATTACHMENT_INCOMPLETE" -> "附件尚未上传完成，请重试这条消息"
    "DESKTOP_COMMAND_FAILED", "IPC_INVALID_REQUEST", "IPC_INTERNAL_ERROR", "RUN_START_FAILED" -> error.message?.takeIf(String::isNotBlank) ?: "电脑未能完成此操作，请查看会话状态后再试"
    else -> if (error is RemoteFailure) "操作未完成（${error.code}）：${error.message.orEmpty().take(500)}"
        else error.message?.takeIf { it.any { c -> c.code > 127 } } ?: "连接暂时中断，正在尝试重新连接"
}
