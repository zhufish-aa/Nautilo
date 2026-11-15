package app.nautilo.mobile.transport

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import app.azula.iroh.EndpointAddr
import app.azula.iroh.IrohConnection
import app.azula.iroh.IrohEndpoint
import app.nautilo.mobile.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

class PeerClient(context: Context, private val store: SecureStore) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val endpointLock = Mutex()
    private val connectionLock = Mutex()
    @Volatile private var endpoint: IrohEndpoint? = null
    @Volatile private var connection: IrohConnection? = null
    @Volatile private var connectedHost: String? = null
    @Volatile private var directOnly = true
    private val mutablePhase = MutableStateFlow("")
    val phase = mutablePhase.asStateFlow()
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    init {
        connectivity.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { scope.launch { runCatching { endpoint?.networkChange() } } }
            override fun onLost(network: Network) { scope.launch { runCatching { endpoint?.networkChange() } } }
        })
    }
    private suspend fun endpoint(): IrohEndpoint = endpointLock.withLock {
        endpoint ?: (withTimeoutOrNull(20_000) { IrohEndpoint.bind(emptyList(), store.identity()) }
            ?: throw RemoteFailure("TRANSPORT_START_TIMEOUT", "手机连接服务启动超时，请重试")).also { endpoint = it }
    }
    suspend fun identity(): String = endpoint().id()
    suspend fun connect(host: Host): IrohConnection = connectionLock.withLock {
        connection?.takeIf { connectedHost == host.id && it.closeReason() == null }?.let { return@withLock it }
        closeConnection("Switching computer")
        connection = null
        connectedHost = null
        DirectTransportPolicy.enforce(true)
        mutablePhase.value = "connecting"
        val address = store.hosts().find { it.id == host.id }?.endpoint ?: host.endpoint
        val addresses = address.objects("addrs").mapNotNull { it.text("Ip").takeIf(String::isNotEmpty) }
        val relay = address.objects("addrs").firstNotNullOfOrNull { it.text("Relay").takeIf(String::isNotEmpty) }
        val conn = try {
            withTimeoutOrNull(25_000) { endpoint().connectAddr(EndpointAddr(host.id, relay, addresses), "nautilo/remote/2") }
                ?: throw RemoteFailure("PEER_CONNECTION_TIMEOUT", "尚未连上电脑的连接辅助通道，请检查电脑是否在线及网络是否可达")
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (error.message.orEmpty().contains("protocol", true)) throw RemoteFailure("DESKTOP_TRANSPORT_UPDATE_REQUIRED", "请更新电脑端以启用跨网直连协议")
            throw error
        }
        try {
            require(conn.remoteId() == host.id) { "电脑身份验证失败" }
            val nonce = java.util.UUID.randomUUID().toString().replace("-", "")
            val policy = coroutineScope {
                val retries = launch { repeat(8) { conn.sendDatagram("nautilo/transport/v1:$nonce".toByteArray()); delay(600) } }
                try {
                    withTimeoutOrNull(6500) { TransportPolicy.decode(conn.readDatagram(), nonce, host.id) }
                        ?: throw RemoteFailure("TRANSPORT_POLICY_TIMEOUT", "电脑未返回连接策略，请检查电脑版本和网络后重试")
                } finally { retries.cancelAndJoin() }
            }
            directOnly = policy.directOnly
            DirectTransportPolicy.enforce(policy.directOnly)
            if (policy.endpoint.objects("addrs").isNotEmpty()) store.hosts().find { it.id == host.id }?.let { store.refreshHost(it.copy(endpoint = policy.endpoint)) }
            if (policy.directOnly) {
                mutablePhase.value = "punching"
                val ready = withTimeoutOrNull(30_000) {
                    while (conn.connType() != "direct") {
                        if (conn.closeReason() != null) throw RemoteFailure("DIRECT_CONNECTION_UNAVAILABLE", policy.failureHint())
                        delay(200)
                    }
                    true
                } == true
                if (!ready) throw RemoteFailure("DIRECT_CONNECTION_UNAVAILABLE", policy.failureHint())
            }
            connection = conn
            connectedHost = host.id
            mutablePhase.value = "ready"
            conn
        } catch (error: Throwable) {
            runCatching { conn.shutdown(4uL, "DIRECT_CONNECTION_UNAVAILABLE".toByteArray()) }
            runCatching { conn.close() }
            mutablePhase.value = "failed"
            throw error
        }
    }
    suspend fun call(host: Host, method: String, params: JSONObject = JSONObject(), id: String = java.util.UUID.randomUUID().toString()): JSONObject {
        val conn = connect(host)
        return withTimeoutOrNull(if (method == "session.send" || method == "session.create") 120_000 else 35_000) {
            val stream = conn.openBi()
            try {
                val bytes = json("v" to 1, "id" to id, "method" to method, "params" to params).toString().toByteArray()
                require(bytes.size <= 256 * 1024) { "消息过长，请分段发送" }
                stream.sendBytes(bytes)
                stream.finish()
                val bytesIn = if (!directOnly) stream.readToEnd(8_388_608u) else supervisorScope {
                    val read = async { stream.readToEnd(8_388_608u) }
                    val watch = async<ByteArray> {
                        var lostAt: Long? = null
                        while (true) {
                            delay(200)
                            if (conn.connType() == "direct") lostAt = null
                            else {
                                val since = lostAt ?: android.os.SystemClock.elapsedRealtime().also { lostAt = it }
                                if (android.os.SystemClock.elapsedRealtime() - since >= 15_000) {
                                    throw RemoteFailure("DIRECT_PATH_LOST", "直连路径已中断，正在重新打洞；业务数据不会回退到中继。")
                                }
                            }
                        }
                        @Suppress("UNREACHABLE_CODE") byteArrayOf()
                    }
                    try { select { read.onAwait { it }; watch.onAwait { it } } }
                    finally { read.cancelAndJoin(); watch.cancelAndJoin() }
                }
                val response = JSONObject(String(bytesIn, Charsets.UTF_8))
                require(response.optInt("v") == 1 && response.text("id") == id) { "收到无效的电脑响应" }
                if (!response.optBoolean("ok")) {
                    val error = response.getJSONObject("error")
                    throw RemoteFailure(error.text("code"), error.text("message"))
                }
                // Arrays are wrapped so all consumers have an explicit JSON object.
                val data = response.opt("data")
                data as? JSONObject ?: json("items" to data)
            } catch (failure: RemoteFailure) {
                if (failure.code == "DIRECT_PATH_LOST") runCatching { conn.shutdown(4uL, "DIRECT_PATH_LOST".toByteArray()) }
                throw failure
            } finally {
                runCatching { stream.stop(0uL) }
                stream.close()
            }
        } ?: throw RemoteFailure("REMOTE_RESPONSE_TIMEOUT", "电脑响应超时，请重试。待发送消息已保留。")
    }
    fun path(): String = runCatching { connection?.connType() }.getOrNull().orEmpty()
    fun latency(): Long? = runCatching { connection?.rttMs()?.toLong() }.getOrNull()
    internal suspend fun awaitConnectionClosed(host: Host) {
        val conn = connect(host)
        conn.closed()
        val owned = connectionLock.withLock {
            if (connection !== conn) false else {
                connection = null; connectedHost = null; mutablePhase.value = "disconnected"; true
            }
        }
        if (owned) runCatching { conn.close() }
    }
    private suspend fun closeConnection(reason: String) {
        connection?.let { conn ->
            conn.shutdown(0uL, reason.toByteArray())
            withTimeoutOrNull(1000) { conn.closed() }
            conn.close()
        }
    }
    suspend fun disconnect() = connectionLock.withLock {
        closeConnection("Phone disconnected")
        connection = null
        connectedHost = null
        mutablePhase.value = ""
    }
}
