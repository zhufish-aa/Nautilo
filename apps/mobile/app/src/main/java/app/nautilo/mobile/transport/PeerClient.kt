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
import org.json.JSONObject

class PeerClient(context: Context, private val store: SecureStore) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val endpointLock = Mutex()
    private val connectionLock = Mutex()
    @Volatile private var endpoint: IrohEndpoint? = null
    @Volatile private var connection: IrohConnection? = null
    @Volatile private var connectedHost: String? = null
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    init {
        connectivity.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { scope.launch { runCatching { endpoint?.networkChange() } } }
            override fun onLost(network: Network) { scope.launch { runCatching { endpoint?.networkChange() } } }
        })
    }
    private suspend fun endpoint(): IrohEndpoint = endpointLock.withLock {
        endpoint ?: withTimeout(20_000) { IrohEndpoint.bind(emptyList(), store.identity()) }.also { endpoint = it }
    }
    suspend fun identity(): String = endpoint().id()
    suspend fun connect(host: Host): IrohConnection = connectionLock.withLock {
        connection?.takeIf { connectedHost == host.id && it.closeReason() == null }?.let { return@withLock it }
        connection?.shutdown(0uL, "Switching computer".toByteArray())
        connection?.close()
        connection = null
        connectedHost = null
        val addresses = host.endpoint.objects("addrs").mapNotNull { it.text("Ip").takeIf(String::isNotEmpty) }
        val relay = host.endpoint.objects("addrs").firstNotNullOfOrNull { it.text("Relay").takeIf(String::isNotEmpty) }
        withTimeout(25_000) {
            endpoint().connectAddr(EndpointAddr(host.id, relay, addresses), "nautilo/remote/1")
        }.also {
            require(it.remoteId() == host.id) { "电脑身份验证失败" }
            connection = it
            connectedHost = host.id
        }
    }
    suspend fun call(host: Host, method: String, params: JSONObject = JSONObject(), id: String = java.util.UUID.randomUUID().toString()): JSONObject {
        val conn = connect(host)
        return withTimeout(if (method == "session.send" || method == "session.create") 120_000 else 35_000) {
            val stream = conn.openBi()
            try {
                val bytes = json("v" to 1, "id" to id, "method" to method, "params" to params).toString().toByteArray()
                require(bytes.size <= 256 * 1024) { "消息过长，请分段发送" }
                stream.sendBytes(bytes)
                stream.finish()
                val response = JSONObject(String(stream.readToEnd(8_388_608u), Charsets.UTF_8))
                require(response.optInt("v") == 1 && response.text("id") == id) { "收到无效的电脑响应" }
                if (!response.optBoolean("ok")) {
                    val error = response.getJSONObject("error")
                    throw RemoteFailure(error.text("code"), error.text("message"))
                }
                // Arrays are wrapped so all consumers have an explicit JSON object.
                val data = response.opt("data")
                data as? JSONObject ?: json("items" to data)
            } finally {
                runCatching { stream.stop(0uL) }
                stream.close()
            }
        }
    }
    fun path(): String = runCatching { connection?.connType() }.getOrNull().orEmpty()
    fun latency(): Long? = runCatching { connection?.rttMs()?.toLong() }.getOrNull()
    suspend fun disconnect() = connectionLock.withLock {
        connection?.shutdown(0uL, "Phone disconnected".toByteArray())
        connection?.close()
        connection = null
        connectedHost = null
    }
}
