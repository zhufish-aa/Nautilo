package app.nautilo.mobile

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import app.nautilo.mobile.transport.ConnectionKeeper
import kotlinx.coroutines.*

/** Keeps the user's desktop messaging transport alive across Activity changes. */
class ConnectionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val app get() = application as NautiloApplication
    private lateinit var keeper: ConnectionKeeper
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "电脑连接", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        keeper = ConnectionKeeper(scope, maintain = { host -> app.peer.awaitConnectionClosed(host) })
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            app.connectionPaused.value = true
            keeper.stop()
            scope.launch { try { app.peer.disconnect() } finally { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() } }
            return START_NOT_STICKY
        }
        val host = app.store.selectedHost() ?: run { stopSelf(); return START_NOT_STICKY }
        app.connectionPaused.value = false
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, ConnectionService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_connection)
            .setContentTitle("Nautilo · 电脑连接").setContentText("保持与 ${host.name} 的后台连接")
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE).setVisibility(Notification.VISIBILITY_PRIVATE)
            .addAction(Notification.Action.Builder(null, "断开", stop).build()).build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        else startForeground(ID, notification)
        keeper.keep(host)
        return START_STICKY
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() { keeper.stop(); scope.cancel(); super.onDestroy() }
    companion object {
        private const val CHANNEL = "desktop_connection"
        private const val ID = 1
        private const val STOP = "app.nautilo.mobile.STOP_CONNECTION"
        fun start(context: Context) { context.startForegroundService(Intent(context, ConnectionService::class.java)) }
        // Pause only the maintainer during pairing; the pairing flow owns closing
        // the old transport, so an asynchronous service shutdown cannot close a new one.
        fun pause(context: Context) { context.stopService(Intent(context, ConnectionService::class.java)) }
    }
}
