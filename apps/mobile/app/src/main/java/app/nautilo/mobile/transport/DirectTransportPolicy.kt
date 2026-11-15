package app.nautilo.mobile.transport

import app.nautilo.mobile.data.RemoteFailure

/** The native QUIC packet builder checks this flag on every STREAM packet. */
internal object DirectTransportPolicy {
    private external fun setEnabledNative(enabled: Boolean)
    fun enforce(enabled: Boolean) {
        try { System.loadLibrary("iroh_kmp"); setEnabledNative(enabled) }
        catch (_: UnsatisfiedLinkError) { throw RemoteFailure("MOBILE_TRANSPORT_UPDATE_REQUIRED", "请安装支持跨网直连的新版手机端") }
    }
}
