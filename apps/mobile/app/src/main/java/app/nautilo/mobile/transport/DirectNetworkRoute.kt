package app.nautilo.mobile.transport

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.SystemClock
import app.nautilo.mobile.data.RemoteFailure
import kotlinx.coroutines.*
import java.net.DatagramSocket
import java.io.IOException

/** A per-socket P2P route; never binds the process or changes the user's VPN. */
internal class DirectNetworkRoute(context: Context, private val scope: CoroutineScope, private val changed: suspend () -> Unit) {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private var handle = -1L
    private var resolverHandle = -1L
    private var servers = emptyArray<String>()
    private var resolvedAt = 0L
    private var lookup: Job? = null
    @Volatile private var vpnRestricted = false

    fun networkHint(): String = if (vpnRestricted || (vpnActive() && usingDefaultNative()))
        "当前 UDP 使用系统默认网络（VPN），延迟和可达性取决于 VPN 的 UDP 转发。如需绕过 VPN，请在客户端允许绕过或排除 Nautilo（app.nautilo.mobile）。" else ""

    private fun vpnActive() = manager.getNetworkCapabilities(manager.activeNetwork)
        ?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true

    private fun canBind(network: Network): Boolean = try {
        // No traffic is sent: check the same per-UID permission used by the NDK
        // before creating the long-lived QUIC endpoint.
        DatagramSocket(null).use { network.bindSocket(it) }
        true
    } catch (_: IOException) { false } catch (_: SecurityException) { false }

    init {
        manager.registerNetworkCallback(NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build(),
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = refreshLater()
                override fun onLost(network: Network) = refreshLater()
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = refreshLater()
                private fun refreshLater() { scope.launch { runCatching { if (prepare()) changed() } } }
            })
    }

    @Synchronized fun prepare(): Boolean {
        val candidates = manager.allNetworks.mapNotNull { network ->
            val caps = manager.getNetworkCapabilities(network) ?: return@mapNotNull null
            NetworkRouteCandidate(network, network == manager.activeNetwork,
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN),
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR))
        }
        val selection = selectAllowedDirectRoute(candidates, manager.activeNetwork, vpnActive(), ::canBind)
            ?: throw RemoteFailure("DIRECT_NETWORK_UNAVAILABLE", "手机暂无可用网络，请连接 Wi-Fi 或开启移动数据。")
        val selected = selection.network
        val next = if (selection.bindPhysical) selected.networkHandle else 0L
        val nextResolver = selected.networkHandle
        val routeChanged = handle != next || resolverHandle != nextResolver
        vpnRestricted = selection.vpnRestricted
        if (routeChanged) {
            lookup?.cancel(); lookup = null
            handle = next; resolverHandle = nextResolver; servers = emptyArray(); resolvedAt = 0L
        }
        configure(handle, servers)
        if (lookup?.isActive == true || (resolvedAt > 0 && SystemClock.elapsedRealtime() - resolvedAt < 300_000L)) return routeChanged
        lookup = scope.launch(Dispatchers.IO) {
            // Resolve on the very Network used by QUIC, rather than a VPN's fake-IP DNS.
            val found = supervisorScope {
                listOf("stun.cloudflare.com" to 3478, "stun.l.google.com" to 19302).map { (host, port) -> async {
                    runCatching { selected.getAllByName(host).filter { address ->
                        !address.isAnyLocalAddress && !address.isLoopbackAddress && !address.isLinkLocalAddress &&
                            !address.isMulticastAddress && !address.isSiteLocalAddress &&
                            !(address.address.size == 4 && (address.address[0].toInt() and 255) == 198 && (address.address[1].toInt() and 255) in 18..19)
                    }.take(4).map { address ->
                        if (address.address.size == 16) "[${address.hostAddress}]:$port" else "${address.hostAddress}:$port"
                    } }.getOrDefault(emptyList())
                } }.awaitAll().flatten().distinct().take(8).toTypedArray()
            }
            synchronized(this@DirectNetworkRoute) {
                if (handle != next || resolverHandle != nextResolver || !isActive) return@synchronized
                servers = found
                // Retry an unavailable resolver on the next connection attempt.
                resolvedAt = if (found.isNotEmpty()) SystemClock.elapsedRealtime() else 0L
                configure(handle, servers)
            }
        }
        return routeChanged
    }

    private fun configure(handle: Long, servers: Array<String>) {
        try {
            System.loadLibrary("iroh_kmp")
            check(configureNative(handle, resolverHandle, servers)) { "手机直连网络配置失败" }
        } catch (error: UnsatisfiedLinkError) {
            throw RemoteFailure("MOBILE_TRANSPORT_UPDATE_REQUIRED", "请安装支持独立直连网卡的新版手机端。")
        }
    }
    private external fun configureNative(handle: Long, route: Long, servers: Array<String>): Boolean
    private external fun usingDefaultNative(): Boolean
}
