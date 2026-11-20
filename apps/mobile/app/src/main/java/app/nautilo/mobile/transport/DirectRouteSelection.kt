package app.nautilo.mobile.transport

internal data class NetworkRouteCandidate<T>(val network: T, val active: Boolean, val internet: Boolean,
    val validated: Boolean, val notVpn: Boolean, val wifi: Boolean, val ethernet: Boolean, val cellular: Boolean)

private fun <T> rankedDirectNetworks(candidates: List<NetworkRouteCandidate<T>>) = candidates
    .filter { it.internet && it.notVpn && (it.wifi || it.ethernet || it.cellular) }
    .sortedByDescending { (if (it.validated) 100 else 0) + (if (it.active) 50 else 0) +
        (if (it.ethernet) 30 else if (it.wifi) 20 else 10) }

internal fun <T> selectDirectNetwork(candidates: List<NetworkRouteCandidate<T>>) = rankedDirectNetworks(candidates).firstOrNull()

/** A visible physical network is not necessarily available to this app's UID. */
internal data class DirectRouteSelection<T>(val network: T, val bindPhysical: Boolean, val vpnRestricted: Boolean)

internal fun <T> selectAllowedDirectRoute(candidates: List<NetworkRouteCandidate<T>>, defaultNetwork: T?,
    defaultIsVpn: Boolean, canBind: (T) -> Boolean): DirectRouteSelection<T>? {
    for (candidate in rankedDirectNetworks(candidates)) {
        if (canBind(candidate.network)) return DirectRouteSelection(candidate.network, true, false)
    }
    // Handle 0 in the native transport retains Android's app-specific routing.
    // It does not bypass the VPN or relax the direct-only QUIC STREAM policy.
    return defaultNetwork?.let { DirectRouteSelection(it, false, defaultIsVpn) }
}
