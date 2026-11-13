package app.nautilo.mobile

import android.app.Application
import app.azula.iroh.IrohAndroid
import app.nautilo.mobile.data.SecureStore
import app.nautilo.mobile.transport.PeerClient

class NautiloApplication : Application() {
    lateinit var store: SecureStore
    lateinit var peer: PeerClient
    override fun onCreate() {
        super.onCreate()
        IrohAndroid.installAndroidContext(this)
        store = SecureStore(this)
        peer = PeerClient(this, store)
    }
}
