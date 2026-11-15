package app.nautilo.mobile

import android.app.Application
import app.azula.iroh.IrohAndroid
import app.nautilo.mobile.data.SecureStore
import app.nautilo.mobile.transport.PeerClient
import kotlinx.coroutines.flow.MutableStateFlow

class NautiloApplication : Application() {
    val connectionPaused = MutableStateFlow(false)
    lateinit var store: SecureStore
    lateinit var peer: PeerClient
    override fun onCreate() {
        super.onCreate()
        IrohAndroid.installAndroidContext(this)
        store = SecureStore(this)
        peer = PeerClient(this, store)
    }
}
