package app.nautilo.mobile

import app.nautilo.mobile.transport.*
import org.junit.Assert.*
import org.junit.Test

class DirectNetworkRouteTest {
    private fun candidate(name: String, active: Boolean = false, validated: Boolean = true,
        notVpn: Boolean = true, wifi: Boolean = true, cellular: Boolean = false) =
        NetworkRouteCandidate(name, active, true, validated, notVpn, wifi, false, cellular)

    @Test fun activeVpnDoesNotReplaceThePhysicalRoute() {
        assertEquals("wifi", selectDirectNetwork(listOf(candidate("vpn", active = true, notVpn = false), candidate("wifi")))?.network)
    }
    @Test fun workingCellularWinsOverUnvalidatedWifi() {
        assertEquals("cell", selectDirectNetwork(listOf(candidate("captive", active = true, validated = false),
            candidate("cell", wifi = false, cellular = true)))?.network)
    }
    @Test fun usableActivePhysicalNetworkKeepsItsPriority() {
        assertEquals("cell", selectDirectNetwork(listOf(candidate("wifi"), candidate("cell", active = true, wifi = false, cellular = true)))?.network)
        assertNull(selectDirectNetwork(listOf(candidate("vpn", active = true, notVpn = false))))
    }
    @Test fun secureVpnBindingRejectionKeepsTheDefaultRouteAvailable() {
        val attempted = mutableListOf<String>()
        val route = selectAllowedDirectRoute(listOf(candidate("wifi"), candidate("vpn", active = true, notVpn = false)),
            "vpn", true) { attempted += it; false }
        assertEquals(listOf("wifi"), attempted)
        assertEquals(DirectRouteSelection("vpn", false, true), route)
    }
    @Test fun vpnThatAllowsBypassRetainsPhysicalUdpRouting() {
        val route = selectAllowedDirectRoute(listOf(candidate("wifi")), "vpn", true) { true }
        assertEquals(DirectRouteSelection("wifi", true, false), route)
    }
    @Test fun stalePreferredNetworkDoesNotHideAWorkingAlternative() {
        val attempted = mutableListOf<String>()
        val route = selectAllowedDirectRoute(listOf(candidate("wifi", active = true),
            candidate("cell", wifi = false, cellular = true)), "vpn", true) { attempted += it; it == "cell" }
        assertEquals(listOf("wifi", "cell"), attempted)
        assertEquals(DirectRouteSelection("cell", true, false), route)
    }
    @Test fun defaultNetworkCanWorkWithoutAnExposedPhysicalNetwork() {
        assertEquals(DirectRouteSelection("vpn", false, true), selectAllowedDirectRoute(emptyList(), "vpn", true) { error("No physical network") })
        assertEquals(DirectRouteSelection("default", false, false), selectAllowedDirectRoute(emptyList(), "default", false) { false })
        assertNull(selectAllowedDirectRoute(emptyList(), null as String?, false) { false })
    }
}
