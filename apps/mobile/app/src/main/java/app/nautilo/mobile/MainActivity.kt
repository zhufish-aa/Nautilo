package app.nautilo.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.viewModels
import androidx.compose.runtime.mutableStateOf
import app.nautilo.mobile.ui.NautiloApp

class MainActivity : ComponentActivity() {
    private val model: MobileViewModel by viewModels()
    private val invitation = mutableStateOf<String?>(null)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
        )
        if (android.os.Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        invitation.value = intent?.dataString
        setContent { NautiloApp(model, invitation.value) { invitation.value = null } }
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        invitation.value = intent.dataString
    }
    override fun onStart() { super.onStart(); model.foreground(true) }
    override fun onStop() { model.saveDraft(); model.foreground(false); super.onStop() }
}
